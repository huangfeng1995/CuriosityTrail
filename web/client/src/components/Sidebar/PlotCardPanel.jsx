import React, { useCallback, useEffect, useState } from 'react';
import {
  Input,
  Modal,
  Form,
  Select,
  message,
  Empty,
  Segmented,
  Tooltip,
  Popconfirm,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 情节卡。
 *
 * 写长篇最怕的不是写不动，是写着写着忘了自己埋过什么。
 * 卡片把关键节点摊开：这一章要发生什么、谁出场、什么伏笔要收。
 *
 * 卡片有两种归属：挂在作品上（全书主线）或挂在某一章上（本章要点）。
 * 这里默认按章节分组显示，作者一眼能看出哪一章还欠着什么。
 */

const KIND_OPTIONS = [
  { value: 'plot', label: '情节' },
  { value: 'character', label: '人物' },
  { value: 'setting', label: '设定' },
  { value: 'conflict', label: '冲突' },
  { value: 'foreshadow', label: '伏笔' },
];

const KIND_LABEL = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label]));

const STATUS_OPTIONS = [
  { value: 'todo', label: '待写' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

export default function PlotCardPanel({ workId, chapters = [] }) {
  const [cards, setCards] = useState([]);
  const [scope, setScope] = useState('chapter');
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const load = useCallback(async () => {
    if (!workId) return;
    try {
      const res = await api.get(`/plot-cards/work/${workId}`);
      setCards(res.data || []);
    } catch (e) {
      message.error('情节卡加载失败');
    }
  }, [workId]);

  useEffect(() => {
    load();
  }, [load]);

  const openEditor = (card) => {
    setEditing(card || {});
    form.setFieldsValue(
      card || {
        title: '',
        kind: 'plot',
        status: 'todo',
        content: '',
        chapterId: undefined,
      }
    );
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/plot-cards/${editing.id}`, values);
      } else {
        await api.post(`/plot-cards/work/${workId}`, values);
      }
      setEditing(null);
      message.success('已保存');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = async (card) => {
    try {
      await api.delete(`/plot-cards/${card.id}`);
      message.success('已删除');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '删除失败');
    }
  };

  /**
   * 点状态标签就切换状态。
   * 卡片是给自己看的进度条，随手一点就能推进，比打开弹窗改省事。
   */
  const cycleStatus = async (card) => {
    const order = ['todo', 'doing', 'done'];
    const next = order[(order.indexOf(card.status) + 1) % order.length];
    try {
      await api.put(`/plot-cards/${card.id}`, { status: next });
      load();
    } catch (e) {
      message.error('更新失败');
    }
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  // 按章节分组：没挂章节的卡片归到"全书"
  const groups = [];
  const loose = cards.filter((c) => !c.chapter_id);
  if (loose.length) groups.push({ key: '__all__', title: '全书', cards: loose });
  for (const ch of chapters) {
    const list = cards.filter((c) => c.chapter_id === ch.id);
    if (list.length) groups.push({ key: ch.id, title: ch.title, cards: list });
  }

  const shown =
    scope === 'chapter' ? groups : [{ key: '__flat__', title: '全部', cards }];

  return (
    <div className="ct-panel">
      <Segmented
        size="small"
        block
        value={scope}
        onChange={setScope}
        options={[
          { value: 'chapter', label: '按章节' },
          { value: 'all', label: '全部' },
        ]}
        style={{ marginBottom: 10 }}
      />

      <button type="button" className="ct-add-btn" onClick={() => openEditor(null)}>
        <PlusOutlined />
        新建情节卡
      </button>

      {shown.map((group) => (
        <div key={group.key}>
          <div className="ct-group-label">
            {group.title}（{group.cards.length}）
          </div>
          {group.cards.map((card) => (
            <div
              key={card.id}
              className={`ct-item${
                card.status === 'done' ? ' is-done' : ' is-pending'
              }`}
            >
              <button
                type="button"
                className="ct-item-main"
                onClick={() => openEditor(card)}
                title={`编辑「${card.title}」`}
              >
                <span className="ct-item-title">{card.title}</span>
                <span className="ct-badge">{KIND_LABEL[card.kind] || '情节'}</span>
                {card.content && <div className="ct-item-note">{card.content}</div>}
              </button>
              <div className="ct-item-actions">
                <Tooltip title="点击切换状态">
                  <button
                    type="button"
                    className={`ct-item-act ct-status status-${card.status}`}
                    onClick={() => cycleStatus(card)}
                  >
                    {STATUS_OPTIONS.find((s) => s.value === card.status)?.label || '待写'}
                  </button>
                </Tooltip>
                <button
                  type="button"
                  className="ct-item-act"
                  title="编辑"
                  aria-label={`编辑 ${card.title}`}
                  onClick={() => openEditor(card)}
                >
                  <EditOutlined />
                </button>
                <Popconfirm title="删除这张卡片？" onConfirm={() => remove(card)}>
                  <button
                    type="button"
                    className="ct-item-act is-danger"
                    title="删除"
                    aria-label={`删除 ${card.title}`}
                  >
                    <DeleteOutlined />
                  </button>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      ))}

      {cards.length === 0 && (
        <p className="ct-hint">
          还没有情节卡。动笔前先把关键节点列出来，写着写着就不会忘了自己埋过什么。
        </p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑情节卡' : '新建情节卡'}
        okText="保存"
        cancelText="取消"
        width={520}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
            <Input placeholder="例：陈默在档案室发现第三份验尸报告" />
          </Form.Item>
          <Form.Item name="kind" label="类型">
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select options={STATUS_OPTIONS} />
          </Form.Item>
          <Form.Item name="chapterId" label="所属章节" help="不选则算全书级卡片。">
            <Select
              allowClear
              placeholder="全书"
              options={chapters.map((c) => ({ value: c.id, label: c.title }))}
            />
          </Form.Item>
          <Form.Item name="content" label="备注">
            <Input.TextArea rows={4} placeholder="细节、伏笔、注意事项" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
