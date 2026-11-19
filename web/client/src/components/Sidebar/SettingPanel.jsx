import React, { useEffect, useMemo, useState } from 'react';
import { Input, Modal, Form, message, Select, Empty } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, AimOutlined } from '@ant-design/icons';
import api from '../../api/client';
import Markdown from '../Markdown';
import { useWorkspace } from '../../store/workspace';
import useCardOccurrences from './useCardOccurrences';
import { CardHitBadge, CardHitList } from './CardOccurrences';
import SettingTable from './SettingTable';
import { EMPTY_TABLE, mergeTable, splitContent } from './tableModel';

export const SETTING_CATEGORIES = ['地理', '历史', '组织', '规则', '物品', '种族', '其他'];

/**
 * 世界观设定面板。
 *
 * importance 决定 AI 什么时候会带上这条设定：
 * 3 及以上无条件注入，1-2 只在正文提到设定名时注入。
 *
 * 每条设定还会显示「正文里出现过几章几处」：设定不是写完就完事的东西，
 * 作者需要知道这个名字到底在稿子里扎了多深，后续改动影响面有多大。
 */
export default function SettingPanel({ workId }) {
  const { chapter, loadChapter, dispatch } = useWorkspace();
  const [settings, setSettings] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  // 文字 / 表格两种填法，写的是同一个 content：表格只是它的可视化。
  const [mode, setMode] = useState('text');
  // 预览跟着输入框实时走：作者一边写表一边就能看到表格长什么样，
  // 不用先保存再回头翻。
  const contentValue = Form.useWatch('content', form) || '';
  const tableValue = useMemo(() => splitContent(contentValue).table, [contentValue]);

  // 网格改动写回同一份 content：换成文字模式重新打开也能看到表格本身。
  const handleTable = (next) => {
    form.setFieldValue('content', mergeTable(contentValue, next));
  };

  // 每张卡的检索词就是设定名本身
  const cards = useMemo(
    () => settings.map((s) => ({ id: s.id, label: s.name, words: [s.name] })),
    [settings]
  );
  const { stats, selectedId, toggle, goto } = useCardOccurrences(workId, cards);

  const load = async () => {
    if (!workId) return;
    try {
      const res = await api.get(`/settings?workId=${workId}`);
      setSettings(res.data);
    } catch (e) {
      message.error('设定加载失败');
    }
  };

  useEffect(() => {
    load();
  }, [workId]);

  const openEditor = (setting) => {
    setEditing(setting || {});
    setMode('text');
    form.setFieldsValue(
      setting || { name: '', category: '其他', content: '', importance: 3 }
    );
  };

  /**
   * 改名后问一句要不要连正文一起改。
   *
   * 不问就自动改是越权——作者可能只是想给卡片换个叫法，
   * 正文里那个旧名是某个角色的口头称呼，不该动。
   */
  const offerRenameInText = async (settingId, from, to, before) => {
    // 出现统计是异步扫的：刚打开面板就改名时 stats 可能还是空的，
    // 直接 return 会让「全文一起改」悄悄不出现，作者以为功能没做。
    // 这里现扫一次旧名，确认正文里到底有没有。
    let known = before;
    if (!known?.total) {
      try {
        const res = await api.post('/occurrences/scan', {
          workId,
          items: [{ key: 'rename', words: [from] }],
        });
        const hit = res.data?.rename;
        if (hit?.total) known = hit;
      } catch (e) {
        // 扫描失败就当没出现：不能因为一个统计把改名本身卡住
      }
    }
    if (!known?.total) return;
    const hits = known;
    Modal.confirm({
      title: '正文里的旧名要一起改吗？',
      content: (
        <div>
          <p style={{ marginBottom: 6 }}>
            正文里有 <b>{hits.total}</b> 处「{from}」，分布在 {hits.chapters.length} 章。
          </p>
          <p style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            一并替换会直接改写正文，每章都会留一份自动版本，可在版本历史里回滚。
          </p>
        </div>
      ),
      okText: `全部替换（${hits.total} 处）`,
      cancelText: '只改卡片',
      onOk: async () => {
        try {
          const res = await api.post('/occurrences/replace', {
            workId,
            words: [from],
            replacement: to,
          });
          message.success(`已替换 ${res.data.replaced} 处`);
          // 改动明细留在 AI 侧栏：弹窗一关、章节一切，只看 toast 就找不回来了。
          dispatch({
            type: 'message/add',
            message: {
              id: `chg-${Date.now()}`,
              role: 'system',
              content: `已把正文里的「${from}」改成「${to}」，共 ${res.data.replaced} 处`,
              items: res.data.chapters || [],
            },
          });
          // 当前正在看的那章被改过就重新拉一次，否则屏幕上还是旧字。
          // 接口返回的字段名是 chapterId，不是 id——写成 c.id 永远匹配不上，
          // 表现就是「替换成功了，但屏幕上的字没变」。
          if (res.data.chapters?.some((c) => c.chapterId === chapter?.id)) {
            await loadChapter(chapter.id);
          }
          await load();
        } catch (e) {
          message.error(e.response?.data?.error || '替换失败');
        }
      },
    });
  };

  const save = async () => {
    const values = await form.validateFields();
    const oldName = editing?.id ? editing.name : '';
    const newName = String(values.name || '').trim();
    // 改名前的出现统计要现在就取：保存后重扫的是新名字
    const before = editing?.id ? stats[editing.id] : null;
    try {
      if (editing?.id) {
        await api.put(`/settings/${editing.id}`, values);
      } else {
        await api.post('/settings', { ...values, workId });
      }
      setEditing(null);
      message.success('已保存');
      await load();
      if (oldName && newName && newName !== oldName) {
        await offerRenameInText(editing.id, oldName, newName, before);
      }
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = (setting) => {
    Modal.confirm({
      title: `删除设定「${setting.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/settings/${setting.id}`);
        load();
      },
    });
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  return (
    <div className="ct-panel">
      <button type="button" className="ct-add-btn" onClick={() => openEditor(null)}>
        <PlusOutlined />
        新建设定
      </button>

      {settings.map((s) => {
        const active = selectedId === s.id;
        return (
          <div key={s.id} className={`ct-card-item${active ? ' is-selected' : ''}`}>
            <div className="ct-item">
              <button
                type="button"
                className="ct-item-main"
                onClick={() => openEditor(s)}
                title={`编辑「${s.name}」`}
              >
                <span className="ct-item-title">{s.name}</span>
                <span className="ct-item-meta">{s.category}</span>
                {s.importance >= 3 && <span className="ct-badge">常驻</span>}
                <CardHitBadge stat={stats[s.id]} />
              </button>
              <div className="ct-item-actions">
                <button
                  type="button"
                  className={`ct-item-act${active ? ' is-on' : ''}`}
                  title={active ? '取消正文标黄' : '在正文中标出这条设定'}
                  aria-label={`定位 ${s.name}`}
                  onClick={() => toggle(cards.find((c) => c.id === s.id))}
                >
                  <AimOutlined />
                </button>
                <button
                  type="button"
                  className="ct-item-act"
                  title="编辑"
                  aria-label={`编辑 ${s.name}`}
                  onClick={() => openEditor(s)}
                >
                  <EditOutlined />
                </button>
                <button
                  type="button"
                  className="ct-item-act is-danger"
                  title="删除"
                  aria-label={`删除 ${s.name}`}
                  onClick={() => remove(s)}
                >
                  <DeleteOutlined />
                </button>
              </div>
            </div>

            {active && (
              <CardHitList stat={stats[s.id]} onGoto={goto} />
            )}
          </div>
        );
      })}

      {settings.length === 0 && (
        <p className="ct-hint">还没有设定。</p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑设定' : '新建设定'}
        okText="保存"
        cancelText="取消"
        width={720}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="name" label="设定名" rules={[{ required: true, message: '请输入设定名' }]}>
            <Input placeholder="临江城" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select options={SETTING_CATEGORIES.map((c) => ({ value: c, label: c }))} />
          </Form.Item>
          <Form.Item
            name="importance"
            label="重要度"
            help="3 及以上 AI 每次都会带上；1-2 只在正文提到设定名时才带。"
          >
            <Select
              options={[
                { value: 1, label: '1 · 偶尔相关' },
                { value: 2, label: '2 · 按需' },
                { value: 3, label: '3 · 常驻' },
                { value: 4, label: '4 · 重要' },
                { value: 5, label: '5 · 核心设定' },
              ]}
            />
          </Form.Item>
          <div className="ct-set-mode">
            <span className="ct-set-mode-label">内容</span>
            <div className="ct-set-seg" role="group" aria-label="内容的填写方式">
              <button
                type="button"
                className={mode === 'text' ? 'is-on' : ''}
                onClick={() => setMode('text')}
              >
                文字
              </button>
              <button
                type="button"
                className={mode === 'table' ? 'is-on' : ''}
                onClick={() => setMode('table')}
              >
                表格
              </button>
            </div>
          </div>

          {/* 两个模式共用 name="content"：表格改动最终仍写回这段正文。
              文字框保持挂载、只做视觉隐藏，切换模式时表单值不会断。 */}
          <Form.Item
            name="content"
            className={mode === 'table' ? 'ct-set-hidden' : ''}
          >
            <Input.TextArea
              rows={7}
              placeholder="设定正文。写给 AI 看，不用太文学化，说清楚规则和边界即可。"
            />
          </Form.Item>

          {mode === 'table' && (
            <SettingTable table={tableValue || EMPTY_TABLE} onChange={handleTable} />
          )}

          {mode === 'text' && (
            <div className="ct-md-preview">
              <div className="ct-md-preview-head">
                <span>预览</span>
              </div>
              <div className="ct-md-preview-body">
                {contentValue.trim() ? (
                  <Markdown>{contentValue}</Markdown>
                ) : (
                  <p className="ct-hint">内容里写的表格会在这里按表格显示。</p>
                )}
              </div>
            </div>
          )}
        </Form>
      </Modal>
    </div>
  );
}
