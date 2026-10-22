import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Form,
  Select,
  message,
  Empty,
  Tag,
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

/** 类型对应的颜色，让卡片列表一眼能分辨 */
const KIND_COLOR = {
  plot: 'blue',
  character: 'purple',
  setting: 'cyan',
  conflict: 'red',
  foreshadow: 'gold',
};

const STATUS_OPTIONS = [
  { value: 'todo', label: '待写' },
  { value: 'doing', label: '进行中' },
  { value: 'done', label: '已完成' },
];

const STATUS_COLOR = {
  todo: 'default',
  doing: 'processing',
  done: 'success',
};

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
    <div style={{ padding: '4px 8px' }}>
      <Segmented
        size="small"
        block
        value={scope}
        onChange={setScope}
        options={[
          { value: 'chapter', label: '按章节' },
          { value: 'all', label: '全部' },
        ]}
        style={{ marginBottom: 8 }}
      />

      <Button
        type="text"
        size="small"
        icon={<PlusOutlined />}
        block
        onClick={() => openEditor(null)}
        style={{ textAlign: 'left', fontSize: 12, paddingLeft: 4 }}
      >
        新建情节卡
      </Button>

      {shown.map((group) => (
        <div key={group.key} style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, opacity: 0.45, padding: '4px 6px' }}>
            {group.title}（{group.cards.length}）
          </div>
          {group.cards.map((card) => (
            <div
              key={card.id}
              style={{
                padding: '6px 6px',
                borderRadius: 6,
                borderLeft: `2px solid ${
                  card.status === 'done' ? '#10b981' : 'rgba(128,128,128,0.3)'
                }`,
                marginBottom: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                <span
                  onClick={() => openEditor(card)}
                  style={{ flex: 1, fontSize: 13, cursor: 'pointer', lineHeight: 1.6 }}
                >
                  {card.title}
                  <Tag
                    color={KIND_COLOR[card.kind] || 'default'}
                    style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px' }}
                  >
                    {KIND_LABEL[card.kind] || '情节'}
                  </Tag>
                </span>
                <Tooltip title="点击切换状态">
                  <Tag
                    color={STATUS_COLOR[card.status] || 'default'}
                    style={{ fontSize: 10, lineHeight: '16px', marginRight: 0, cursor: 'pointer' }}
                    onClick={() => cycleStatus(card)}
                  >
                    {STATUS_OPTIONS.find((s) => s.value === card.status)?.label || '待写'}
                  </Tag>
                </Tooltip>
                <EditOutlined
                  style={{ fontSize: 12, opacity: 0.4, cursor: 'pointer' }}
                  onClick={() => openEditor(card)}
                />
                <Popconfirm title="删除这张卡片？" onConfirm={() => remove(card)}>
                  <DeleteOutlined style={{ fontSize: 12, opacity: 0.4, cursor: 'pointer' }} />
                </Popconfirm>
              </div>
              {card.content && (
                <div
                  style={{
                    fontSize: 11,
                    opacity: 0.55,
                    lineHeight: 1.6,
                    marginTop: 2,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {card.content}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}

      {cards.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.45, padding: '8px 6px', lineHeight: 1.7 }}>
          还没有情节卡。动笔前先把关键节点列出来，写着写着就不会忘了自己埋过什么。
        </div>
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
