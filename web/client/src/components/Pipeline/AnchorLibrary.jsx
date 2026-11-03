import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Input, Spin, message } from 'antd';
import { ImportOutlined, ThunderboltOutlined } from '@ant-design/icons';
import api from '../../api/client';
import {
  TIERS,
  anchorBlockReason,
  buildImportPayload,
  groupCandidates,
  isSelectable,
} from './anchorDraft';

const KIND_LABELS = {
  event: '事件',
  person: '人物',
  time: '时间',
  place: '地点',
  office: '官职',
  custom: '其他',
};

const CONFIDENCE_LABELS = {
  sourced: '有出处',
  inferable: '可推定',
  blank: '纯空白',
};

const STATUS_TABS = [
  { key: 'pending', label: '待确认' },
  { key: 'active', label: '已启用' },
  { key: 'rejected', label: '已驳回' },
];

const SOURCE_LABELS = {
  sourced: '出处',
  inferable: '推定依据',
  blank: '空白说明',
};

/**
 * 一条候选锚点。
 *
 * 可勾选与否由 anchorBlockReason 决定：缺书名的「有出处」整条标红，
 * 并写明为什么不能入库——这是作者唯一的人工闸门，不能只靠一个灰勾。
 */
function CandidateCard({ anchor, index, checked, onToggle }) {
  const blocked = anchorBlockReason(anchor);
  const selectable = isSelectable(anchor);
  const sourceTitle = String(anchor.source_title || '').trim();
  const sourceLocator = String(anchor.source_locator || '').trim();
  const sourceLabel = SOURCE_LABELS[anchor.confidence] || '出处';

  return (
    <div
      className={`ct-anchor-card${blocked ? ' is-blocked' : ''}${
        anchor.confidence === 'blank' ? ' is-blank' : ''
      }`}
      onClick={selectable ? () => onToggle(index) : undefined}
      role={selectable ? 'checkbox' : undefined}
      aria-checked={selectable ? checked : undefined}
      tabIndex={selectable ? 0 : -1}
      onKeyDown={
        selectable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle(index);
              }
            }
          : undefined
      }
    >
      <Checkbox
        checked={!!checked}
        disabled={!selectable}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(index)}
      />
      <div className="ct-anchor-main">
        <div className="ct-anchor-head">
          <span className="ct-anchor-subject">{anchor.subject || '（无主实体）'}</span>
          <span className="ct-badge">{KIND_LABELS[anchor.kind] || anchor.kind || '其他'}</span>
          <span className={`ct-anchor-conf is-${anchor.confidence || 'invalid'}`}>
            {CONFIDENCE_LABELS[anchor.confidence] || '未标注'}
          </span>
        </div>
        <p className="ct-anchor-claim">{anchor.claim || '（无断言）'}</p>
        {(sourceTitle || sourceLocator) && (
          <p className="ct-anchor-source">
            {sourceLabel}：《{sourceTitle || '未给书名'}》{sourceLocator ? ` · ${sourceLocator}` : ''}
          </p>
        )}
        {anchor.source_quote && <p className="ct-anchor-quote">原文：{anchor.source_quote}</p>}
        {!selectable && <p className="ct-anchor-error">不可勾选：{blocked}</p>}
        {selectable && anchor.warnings?.length > 0 && (
          <p className="ct-anchor-warning">{anchor.warnings.join('；')}</p>
        )}
      </div>
    </div>
  );
}

export default function AnchorLibrary({ workId }) {
  const [topic, setTopic] = useState('');
  const [era, setEra] = useState('');
  const [hint, setHint] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState({});
  const [status, setStatus] = useState('pending');
  const [anchors, setAnchors] = useState([]);
  const [loadingList, setLoadingList] = useState(false);

  const loadList = useCallback(
    async (nextStatus = status) => {
      if (!workId) return;
      setLoadingList(true);
      try {
        const res = await api.get(`/pipeline/${workId}/anchors`, {
          params: { status: nextStatus },
        });
        setAnchors(res.data || []);
      } catch (e) {
        message.error(e.response?.data?.error || '锚点列表加载失败');
      } finally {
        setLoadingList(false);
      }
    },
    [workId, status]
  );

  useEffect(() => {
    loadList(status);
  }, [workId, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const draftCandidates = async () => {
    if (!topic.trim()) {
      message.warning('先写整理主题');
      return;
    }
    setDrafting(true);
    try {
      const res = await api.post(`/pipeline/${workId}/anchors/draft`, {
        topic: topic.trim(),
        era: era.trim(),
        hint: hint.trim(),
      });
      const data = res.data || {};
      setDraft(data);
      setSelected({});
      if (!(data.anchors || []).length) {
        message.info(data.notice || '这次没有整理出候选锚点');
      }
    } catch (e) {
      message.error(e.response?.data?.error || '锚点整理失败');
    } finally {
      setDrafting(false);
    }
  };

  const toggle = (index) => {
    setSelected((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const groups = groupCandidates(draft?.anchors || []);
  const payload = buildImportPayload(draft?.anchors || [], selected);

  const runImport = async () => {
    if (!payload.length) {
      message.warning('先勾选至少一条可入库的锚点');
      return;
    }
    setImporting(true);
    try {
      const res = await api.post(`/pipeline/${workId}/anchors/import`, {
        candidates: payload,
      });
      message.success(
        `已导入 ${res.data?.imported || 0} 条锚点${
          res.data?.blankAreas ? `，另记 ${res.data.blankAreas} 个空白区` : ''
        }，待确认后才生效`
      );
      setDraft(null);
      setSelected({});
      setStatus('pending');
      loadList('pending');
    } catch (e) {
      message.error(e.response?.data?.error || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const changeStatus = async (anchor, action) => {
    try {
      await api.post(`/pipeline/${workId}/anchors/${anchor.id}/${action}`);
      message.success(action === 'activate' ? '已启用' : '已驳回');
      loadList();
    } catch (e) {
      message.error(e.response?.data?.error || '操作失败');
    }
  };

  const renderTier = (tier) => {
    const items = groups[tier.key];
    if (!items.length) return null;
    return (
      <section
        key={tier.key}
        className={`ct-anchor-tier${tier.key === 'blank' ? ' is-blank' : ''}`}
      >
        <div className="ct-anchor-tier-head">
          <span className="ct-anchor-tier-title">{tier.label}</span>
          <span className="ct-anchor-tier-count">{items.length} 条</span>
          <span className="ct-anchor-tier-hint">{tier.hint}</span>
        </div>
        {items.map(({ anchor, index }) => (
          <CandidateCard
            key={index}
            anchor={anchor}
            index={index}
            checked={!!selected[index]}
            onToggle={toggle}
          />
        ))}
      </section>
    );
  };

  return (
    <div className="ct-anchor-library">
      <section className="ct-anchor-draft">
        <div className="ct-anchor-draft-fields">
          <label className="ct-anchor-field">
            <span>时代</span>
            <Input
              size="small"
              value={era}
              onChange={(e) => setEra(e.target.value)}
              placeholder="东汉末年 / 建安年间"
            />
          </label>
          <label className="ct-anchor-field is-grow">
            <span>主题</span>
            <Input
              size="small"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="曹操与司马懿的早年交往"
            />
          </label>
        </div>
        <label className="ct-anchor-field">
          <span>补充提示（可选）</span>
          <Input
            size="small"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            placeholder="只取正史有载的部分；空白处单独标出来"
          />
        </label>
        <div className="ct-anchor-draft-actions">
          <Button
            size="small"
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={drafting}
            onClick={draftCandidates}
          >
            整理候选
          </Button>
          <Button
            size="small"
            icon={<ImportOutlined />}
            loading={importing}
            disabled={!payload.length}
            onClick={runImport}
          >
            导入选中（{payload.length}）
          </Button>
          {draft && (
            <Button size="small" type="text" onClick={() => setDraft(null)}>
              清空候选
            </Button>
          )}
        </div>
        <p className="ct-hint">
          AI 只负责整理候选。勾选前请核对出处；缺书名的「有出处」条目会整条标红，不能导入。
        </p>
      </section>

      {draft && (
        <div className="ct-anchor-candidates">
          {TIERS.map(renderTier)}
          {groups.invalid.length > 0 && (
            <section className="ct-anchor-tier is-invalid">
              <div className="ct-anchor-tier-head">
                <span className="ct-anchor-tier-title">不可用候选</span>
                <span className="ct-anchor-tier-count">{groups.invalid.length} 条</span>
                <span className="ct-anchor-tier-hint">置信度缺失或格式不对，不能入库</span>
              </div>
              {groups.invalid.map(({ anchor, index }) => (
                <CandidateCard
                  key={index}
                  anchor={anchor}
                  index={index}
                  checked={false}
                  onToggle={() => {}}
                />
              ))}
            </section>
          )}
          {(draft.blankAreas || []).length > 0 && (
            <aside className="ct-anchor-blank-areas">
              <div className="ct-anchor-tier-head">
                <span className="ct-anchor-tier-title">AI 另标注的空白区</span>
                <span className="ct-anchor-tier-hint">仅作参考，不随本次勾选入库</span>
              </div>
              {draft.blankAreas.map((area, index) => (
                <div key={index} className="ct-anchor-blank-area">
                  <span className="ct-anchor-subject">{area.topic}</span>
                  {area.why_blank && <p className="ct-anchor-source">无载：{area.why_blank}</p>}
                  {area.usable_for && (
                    <p className="ct-anchor-source">可虚构：{area.usable_for}</p>
                  )}
                </div>
              ))}
            </aside>
          )}
        </div>
      )}

      <section className="ct-anchor-list">
        <div className="ct-anchor-list-head">
          <span className="ct-anchor-list-title">锚点库</span>
          <div className="ct-anchor-status-tabs">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`ct-anchor-status-tab${status === tab.key ? ' is-active' : ''}`}
                onClick={() => setStatus(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {loadingList && (
          <div className="ct-loading">
            <Spin size="small" />
          </div>
        )}

        {!loadingList && anchors.length === 0 && (
          <p className="ct-hint">
            {status === 'pending'
              ? '没有待确认的锚点。先从上方整理一批候选。'
              : '这一栏还没有锚点。'}
          </p>
        )}

        {anchors.map((anchor) => (
          <div key={anchor.id} className="ct-anchor-row">
            <div className="ct-anchor-main">
              <div className="ct-anchor-head">
                <span className="ct-anchor-subject">{anchor.subject}</span>
                <span className="ct-badge">{KIND_LABELS[anchor.kind] || anchor.kind}</span>
                <span className={`ct-anchor-conf is-${anchor.confidence}`}>
                  {CONFIDENCE_LABELS[anchor.confidence] || anchor.confidence}
                </span>
                {anchor.immutable && <span className="ct-badge">不可变</span>}
              </div>
              <p className="ct-anchor-claim">{anchor.claim}</p>
              {(anchor.sourceTitle || anchor.sourceLocator) && (
                <p className="ct-anchor-source">
                  {SOURCE_LABELS[anchor.confidence] || '出处'}：《
                  {anchor.sourceTitle || '未给书名'}》
                  {anchor.sourceLocator ? ` · ${anchor.sourceLocator}` : ''}
                </p>
              )}
            </div>
            <div className="ct-anchor-row-actions">
              {anchor.status === 'pending' && (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={() => changeStatus(anchor, 'activate')}
                >
                  启用
                </Button>
              )}
              {anchor.status !== 'rejected' && (
                <Button size="small" danger onClick={() => changeStatus(anchor, 'reject')}>
                  驳回
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
