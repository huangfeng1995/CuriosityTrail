import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input, Modal, Select, Tooltip, message } from 'antd';
import {
  BulbOutlined,
  DownOutlined,
  ReloadOutlined,
  UpOutlined,
} from '@ant-design/icons';
import api from '../../api/client';
import useInspirationPromptPrefs from '../../hooks/useInspirationPromptPrefs';
import { SETTING_CATEGORIES } from './SettingPanel';
import {
  clipTitle,
  collectExclude,
  countPrompts,
  readCache,
  writeCache,
} from './inspirationPromptModel';

const IMPORTANCE_OPTIONS = [
  { value: 1, label: '1 · 偶尔相关' },
  { value: 2, label: '2 · 按需' },
  { value: 3, label: '3 · 常驻' },
  { value: 4, label: '4 · 重要' },
  { value: 5, label: '5 · 核心设定' },
];

/**
 * 灵感面板顶部的「灵感方向」。
 *
 * 它不是新的资料面板：只负责把 agent 生成的一组候选摆在作者手边。
 * 候选只是候选——留作灵感、转情节卡、转设定都要作者亲手点。
 */
export default function InspirationSuggestions({
  workId,
  chapterId,
  chapters = [],
  onSaved,
}) {
  const { prefs } = useInspirationPromptPrefs();
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(true);
  const [groups, setGroups] = useState([]);
  const [activeDimension, setActiveDimension] = useState('');
  const [generatedAt, setGeneratedAt] = useState('');
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [dismissed, setDismissed] = useState([]);
  // promptId -> 'saved' | 'plot' | 'setting'
  const [handled, setHandled] = useState({});
  const [plotDraft, setPlotDraft] = useState(null);
  const [settingDraft, setSettingDraft] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const requestRef = useRef(0);
  const autoKeyRef = useRef('');
  const generateRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api
      .get('/inspirations/suggestions/options')
      .then((res) => {
        if (alive) setOptions(res.data?.dimensions || []);
      })
      .catch(() => {
        // 维度清单拿不到时仍可用「综合」，生成结果自己带 label
      });
    return () => {
      alive = false;
    };
  }, []);

  const generate = useCallback(
    async (dimension = '') => {
      if (!workId) return;
      const seq = requestRef.current + 1;
      requestRef.current = seq;
      setLoading(true);
      setNotice('');

      try {
        const res = await api.post('/inspirations/suggestions', {
          workId,
          chapterId: chapterId || '',
          dimension,
          count: prefs.count,
          dimensions: prefs.dimensions || undefined,
          exclude: collectExclude(groups, dismissed),
        });
        if (seq !== requestRef.current) return;

        const data = res.data || {};
        if (!Array.isArray(data.groups) || data.groups.length === 0) {
          setNotice(data.reason || '这次没有生成可用的方向，可以再试一次。');
          return;
        }

        setGroups(data.groups);
        setActiveDimension(dimension);
        setGeneratedAt(data.generatedAt || new Date().toISOString());
        if (data.degraded) {
          setNotice(data.reason || '这次用了备用模型，结果可能不够稳。');
        }
        writeCache(workId, chapterId, {
          dimension,
          groups: data.groups,
          generatedAt: data.generatedAt || '',
        });
      } catch (e) {
        if (seq !== requestRef.current) return;
        setNotice(e.response?.data?.error || '生成失败，请稍后再试。');
      } finally {
        if (seq === requestRef.current) setLoading(false);
      }
    },
    [workId, chapterId, prefs.count, prefs.dimensions, groups, dismissed]
  );

  useEffect(() => {
    generateRef.current = generate;
  }, [generate]);

  // 打开面板 / 换章时先读本作品本章的缓存；没有缓存且开着自动生成才请求。
  // autoKeyRef 防止 StrictMode 的双重挂载把同一组请求打两次。
  useEffect(() => {
    if (!workId) {
      setGroups([]);
      setGeneratedAt('');
      setActiveDimension('');
      return;
    }

    const autoKey = `${workId}:${chapterId || ''}:${prefs.enabled}:${prefs.auto}`;
    if (autoKeyRef.current === autoKey) return;
    autoKeyRef.current = autoKey;

    setHandled({});
    setDismissed([]);

    const cached = readCache(workId, chapterId);
    if (cached) {
      setGroups(Array.isArray(cached.groups) ? cached.groups : []);
      setGeneratedAt(cached.generatedAt || '');
      setActiveDimension(cached.dimension || '');
      setNotice('');
      return;
    }

    setGroups([]);
    setGeneratedAt('');
    setActiveDimension('');
    setNotice('');
    if (prefs.enabled && prefs.auto) generateRef.current?.('');
  }, [workId, chapterId, prefs.enabled, prefs.auto]);

  const saveAsInspiration = async (group, prompt) => {
    if (!workId || handled[prompt.id]) return;
    try {
      await api.post('/inspirations', {
        text: prompt.text,
        tags: `灵感提示，${group.label}`,
      });
      setHandled((prev) => ({ ...prev, [prompt.id]: 'saved' }));
      onSaved?.();
      message.success('已收进灵感列表');
    } catch (e) {
      message.error(e.response?.data?.error || '没存上，请重试');
    }
  };

  const openPlotDraft = (group, prompt) => {
    setPlotDraft({
      promptId: prompt.id,
      groupLabel: group.label,
      title: clipTitle(prompt.text),
      content: prompt.text,
      chapterId: chapterId || undefined,
    });
  };

  const submitPlot = async () => {
    if (!plotDraft) return;
    const title = String(plotDraft.title || '').trim();
    if (!title) {
      message.warning('先给情节卡一个标题');
      return;
    }

    setSubmitting(true);
    try {
      await api.post(`/plot-cards/work/${workId}`, {
        title,
        content: String(plotDraft.content || '').trim(),
        chapterId: plotDraft.chapterId || undefined,
        kind: 'plot',
        status: 'todo',
      });
      window.dispatchEvent(new CustomEvent('ct:cards-changed'));
      setHandled((prev) => ({ ...prev, [plotDraft.promptId]: 'plot' }));
      setPlotDraft(null);
      message.success('已转成情节卡');
    } catch (e) {
      message.error(e.response?.data?.error || '转情节卡失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openSettingDraft = (group, prompt) => {
    setSettingDraft({
      promptId: prompt.id,
      groupLabel: group.label,
      name: clipTitle(prompt.text),
      category: '其他',
      importance: 3,
      content: prompt.text,
    });
  };

  const submitSetting = async () => {
    if (!settingDraft) return;
    const name = String(settingDraft.name || '').trim();
    if (!name) {
      message.warning('先给设定一个名称');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/settings', {
        workId,
        name,
        category: settingDraft.category || '其他',
        importance: Number(settingDraft.importance) || 3,
        content: String(settingDraft.content || '').trim(),
      });
      setHandled((prev) => ({ ...prev, [settingDraft.promptId]: 'setting' }));
      setSettingDraft(null);
      message.success('已转成设定');
    } catch (e) {
      message.error(e.response?.data?.error || '转设定失败');
    } finally {
      setSubmitting(false);
    }
  };

  const dismiss = (prompt) => {
    setDismissed((prev) => [...prev, prompt.text].slice(-40));
    setGroups((prev) =>
      prev
        .map((group) => ({
          ...group,
          prompts: group.prompts.filter((p) => p.id !== prompt.id),
        }))
        .filter((group) => group.prompts.length > 0)
    );
  };

  if (!prefs.enabled || !workId) return null;

  const total = countPrompts(groups);
  const chapterOptions = (chapters || []).map((chapter) => ({
    value: chapter.id,
    label: chapter.title,
  }));

  return (
    <section className="ct-insp-hint" aria-label="灵感方向">
      <div className="ct-insp-head">
        <span className="ct-insp-title">
          <BulbOutlined />
          灵感方向
          {total > 0 && <em className="ct-insp-meta">{total} 条</em>}
        </span>
        <div className="ct-insp-head-acts">
          {open && (
            <Tooltip title={loading ? '正在生成' : '按当前维度重新生成'}>
              <button
                type="button"
                className="ct-insp-refresh"
                onClick={() => generate(activeDimension)}
                disabled={loading}
              >
                <ReloadOutlined spin={loading} />
                换一组
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            className="ct-insp-icon-btn"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? '收起灵感方向' : '展开灵感方向'}
            title={open ? '收起' : '展开'}
          >
            {open ? <UpOutlined /> : <DownOutlined />}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="ct-insp-dims">
            <button
              type="button"
              className={`ct-insp-dim${activeDimension ? '' : ' is-on'}`}
              onClick={() => generate('')}
              disabled={loading}
            >
              综合
            </button>
            {options.map((dimension) => (
              <button
                key={dimension.key}
                type="button"
                className={`ct-insp-dim${activeDimension === dimension.key ? ' is-on' : ''}`}
                title={dimension.description}
                onClick={() => generate(dimension.key)}
                disabled={loading}
              >
                {dimension.label}
              </button>
            ))}
          </div>

          {loading && groups.length === 0 && (
            <div className="ct-insp-loading">正在读人物、大纲和前情…</div>
          )}

          {notice && (
            <div className="ct-insp-notice">
              <span>{notice}</span>
              <button
                type="button"
                onClick={() => generate(activeDimension)}
                disabled={loading}
              >
                重试
              </button>
            </div>
          )}

          {!loading && groups.length === 0 && !notice && (
            <button
              type="button"
              className="ct-insp-empty"
              onClick={() => generate('')}
            >
              生成一组方向
            </button>
          )}

          {groups.map((group) => (
            <div key={group.dimension} className="ct-insp-group">
              <div className="ct-insp-group-head">
                <span>{group.label}</span>
                <span>{group.prompts.length} 条</span>
              </div>
              {group.prompts.map((prompt) => {
                const state = handled[prompt.id];
                return (
                  <article key={prompt.id} className="ct-insp-card">
                    <p className="ct-insp-text">{prompt.text}</p>
                    <p className="ct-insp-why">
                      接「{prompt.anchor}」 · {prompt.reason}
                    </p>
                    <div className="ct-insp-acts">
                      <button
                        type="button"
                        className="ct-insp-act is-primary"
                        disabled={Boolean(state)}
                        onClick={() => saveAsInspiration(group, prompt)}
                      >
                        {state === 'saved' ? '已记入灵感' : '留作灵感'}
                      </button>
                      <button
                        type="button"
                        className="ct-insp-act"
                        disabled={Boolean(state)}
                        onClick={() => openPlotDraft(group, prompt)}
                      >
                        {state === 'plot' ? '已转情节卡' : '转情节卡'}
                      </button>
                      <button
                        type="button"
                        className="ct-insp-act"
                        disabled={Boolean(state)}
                        onClick={() => openSettingDraft(group, prompt)}
                      >
                        {state === 'setting' ? '已转设定' : '转设定'}
                      </button>
                      {!state && (
                        <button
                          type="button"
                          className="ct-insp-act"
                          onClick={() => dismiss(prompt)}
                        >
                          忽略
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          ))}

          {generatedAt && groups.length > 0 && (
            <div className="ct-insp-foot">
              <span>针对当前作品生成</span>
            </div>
          )}
        </>
      )}

      <Modal
        open={Boolean(plotDraft)}
        title="转成情节卡"
        okText="建卡"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={submitPlot}
        onCancel={() => setPlotDraft(null)}
        width={460}
      >
        {plotDraft && (
          <div className="ct-insp-form">
            <label className="ct-insp-field">
              <span>标题</span>
              <Input
                value={plotDraft.title}
                onChange={(e) =>
                  setPlotDraft((prev) => ({ ...prev, title: e.target.value }))
                }
                placeholder="情节卡标题"
              />
            </label>
            <label className="ct-insp-field">
              <span>内容</span>
              <Input.TextArea
                rows={5}
                value={plotDraft.content}
                onChange={(e) =>
                  setPlotDraft((prev) => ({ ...prev, content: e.target.value }))
                }
              />
            </label>
            <label className="ct-insp-field">
              <span>挂到章节</span>
              <Select
                allowClear
                value={plotDraft.chapterId}
                onChange={(value) =>
                  setPlotDraft((prev) => ({ ...prev, chapterId: value }))
                }
                options={chapterOptions}
                placeholder="不挂章节则归到全书"
              />
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(settingDraft)}
        title="转成设定"
        okText="建设定"
        cancelText="取消"
        confirmLoading={submitting}
        onOk={submitSetting}
        onCancel={() => setSettingDraft(null)}
        width={460}
      >
        {settingDraft && (
          <div className="ct-insp-form">
            <label className="ct-insp-field">
              <span>名称</span>
              <Input
                value={settingDraft.name}
                onChange={(e) =>
                  setSettingDraft((prev) => ({ ...prev, name: e.target.value }))
                }
                placeholder="设定名称"
              />
            </label>
            <label className="ct-insp-field">
              <span>分类</span>
              <Select
                value={settingDraft.category}
                onChange={(value) =>
                  setSettingDraft((prev) => ({ ...prev, category: value }))
                }
                options={SETTING_CATEGORIES.map((category) => ({
                  value: category,
                  label: category,
                }))}
              />
            </label>
            <label className="ct-insp-field">
              <span>重要度</span>
              <Select
                value={settingDraft.importance}
                onChange={(value) =>
                  setSettingDraft((prev) => ({ ...prev, importance: value }))
                }
                options={IMPORTANCE_OPTIONS}
              />
            </label>
            <label className="ct-insp-field">
              <span>内容</span>
              <Input.TextArea
                rows={5}
                value={settingDraft.content}
                onChange={(e) =>
                  setSettingDraft((prev) => ({ ...prev, content: e.target.value }))
                }
              />
            </label>
          </div>
        )}
      </Modal>
    </section>
  );
}
