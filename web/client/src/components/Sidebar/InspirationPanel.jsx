import React, { useEffect, useState } from 'react';
import { Input, Modal, Form, message, Empty, Tooltip, Button } from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  CheckOutlined,
  PartitionOutlined,
} from '@ant-design/icons';
import api from '../../api/client';
import MindMapModal from './MindMapModal';
import { countNodes, isOutline, linesToOutline, parseOutline, toRoot } from './outlineModel';

/**
 * 灵感速记面板。
 *
 * 作者随手记下的念头，AI 看不到素材库以外的东西——但这些恰恰是最个人的素材。
 * 灵感师角色会优先消费这里的内容（上下文装配器的"灵感层"）。
 *
 * 「已用」标记是作者的判断，不是 AI 的：AI 提了方向，作者采纳了才勾。
 *
 * 一条灵感如果写成缩进大纲，就按脑图打开：发散的念头先在树上铺开，
 * 想清楚了可以一键转成设定（一个分支一条，或收成一张对照表）。
 */
export default function InspirationPanel({ workId }) {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  // undefined = 关着；null = 新建；对象 = 编辑这一条
  const [mindItem, setMindItem] = useState(undefined);
  const [form] = Form.useForm();
  const textValue = Form.useWatch('text', form) || '';

  // 多行灵感可以就地摊成一层脑图：第一行当中心，其余行当分支。
  // 只在已经存在的条目上给这个入口，新写的几条走「画脑图」。
  const canSpread = Boolean(editing?.id) &&
    textValue.split('\n').filter((line) => line.trim()).length >= 2;

  const spreadToMindMap = () => {
    const text = String(form.getFieldValue('text') || '');
    setEditing(null);
    setMindItem({ ...editing, text: linesToOutline(text) });
  };

  const load = async () => {
    try {
      const res = await api.get('/inspirations');
      setItems(res.data);
    } catch (e) {
      message.error('灵感加载失败');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openEditor = (item) => {
    setEditing(item || {});
    form.setFieldsValue(item || { text: '', tags: '' });
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/inspirations/${editing.id}`, values);
      } else {
        await api.post('/inspirations', values);
      }
      setEditing(null);
      message.success('已保存');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = (item) => {
    Modal.confirm({
      title: '删除这条灵感？',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/inspirations/${item.id}`);
        load();
      },
    });
  };

  /**
   * 切换「已用」状态。已用的灵感不再注入 AI 上下文。
   */
  const toggleConsumed = async (item) => {
    try {
      await api.put(`/inspirations/${item.id}`, { consumed: item.consumed ? 0 : 1 });
      load();
    } catch (e) {
      message.error('更新失败');
    }
  };

  const pending = items.filter((i) => !i.consumed);
  const used = items.filter((i) => i.consumed);

  const renderItem = (item) => {
    const outline = isOutline(item.text);
    const title = outline
      ? item.text.split('\n').find((line) => line.trim())?.trim()
      : item.text;
    const branchCount = outline ? countNodes(toRoot(parseOutline(item.text))) - 1 : 0;
    const openItem = () => (outline ? setMindItem(item) : openEditor(item));

    return (
      <div
        key={item.id}
        className={`ct-item${item.consumed ? ' is-consumed is-done' : ' is-pending'}`}
      >
        <button
          type="button"
          className="ct-item-main"
          onClick={openItem}
          style={outline ? undefined : { whiteSpace: 'pre-wrap' }}
          title={outline ? '打开脑图' : undefined}
        >
          <span className="ct-item-title">{title}</span>
          {outline ? (
            <span className="ct-item-meta">脑图 · {branchCount} 项</span>
          ) : (
            item.tags && <span className="ct-item-meta">{item.tags}</span>
          )}
        </button>
        <div className="ct-item-actions">
          <Tooltip title={item.consumed ? '标记为未用' : '标记为已用'}>
            <button
              type="button"
              className={`ct-item-act${item.consumed ? ' is-on' : ''}`}
              aria-label={item.consumed ? '标记为未用' : '标记为已用'}
              onClick={() => toggleConsumed(item)}
            >
              <CheckOutlined />
            </button>
          </Tooltip>
          <button
            type="button"
            className="ct-item-act"
            title={outline ? '编辑脑图' : '编辑'}
            aria-label={outline ? '编辑脑图' : '编辑灵感'}
            onClick={openItem}
          >
            {outline ? <PartitionOutlined /> : <EditOutlined />}
          </button>
          <button
            type="button"
            className="ct-item-act is-danger"
            title="删除"
            aria-label="删除灵感"
            onClick={() => remove(item)}
          >
            <DeleteOutlined />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="ct-panel">
      <div className="ct-add-row">
        <button type="button" className="ct-add-btn" onClick={() => openEditor(null)}>
          <PlusOutlined />
          记一条灵感
        </button>
        <button
          type="button"
          className="ct-add-btn is-plain"
          onClick={() => setMindItem(null)}
          title="用脑图铺开一个想法，想清楚后可以直接转成设定"
        >
          <PartitionOutlined />
          画脑图
        </button>
      </div>

      {pending.map(renderItem)}

      {used.length > 0 && (
        <div>
          <div className="ct-group-label">已用（{used.length}）</div>
          {used.map(renderItem)}
        </div>
      )}

      {items.length === 0 && (
        <p className="ct-hint">还没有灵感。</p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑灵感' : '记一条灵感'}
        okText="保存"
        cancelText="取消"
        width={480}
        onOk={save}
        onCancel={() => setEditing(null)}
        footer={
          <div className="ct-modal-foot">
            {canSpread ? (
              <Button type="text" icon={<PartitionOutlined />} onClick={spreadToMindMap}>
                整理成脑图
              </Button>
            ) : (
              <span />
            )}
            <div className="ct-modal-foot-right">
              <Button onClick={() => setEditing(null)}>取消</Button>
              <Button type="primary" onClick={save}>
                保存
              </Button>
            </div>
          </div>
        }
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="text" label="内容" rules={[{ required: true, message: '内容不能为空' }]}>
            <Input.TextArea
              rows={4}
              placeholder="一个画面、一句对白、一个反转的可能。写多碎都行。"
            />
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Input placeholder="用逗号分隔，例如：第二卷，伏笔" />
          </Form.Item>
        </Form>
      </Modal>

      <MindMapModal
        item={mindItem}
        workId={workId}
        onClose={() => setMindItem(undefined)}
        onSaved={load}
      />
    </div>
  );
}
