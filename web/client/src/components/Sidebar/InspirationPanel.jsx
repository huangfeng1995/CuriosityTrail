import React, { useEffect, useState } from 'react';
import { Button, Input, Modal, Form, message, Empty, Tooltip, Tag } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, CheckOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 灵感速记面板。
 *
 * 作者随手记下的念头，AI 看不到素材库以外的东西——但这些恰恰是最个人的素材。
 * 灵感师角色会优先消费这里的内容（上下文装配器的"灵感层"）。
 *
 * 「已用」标记是作者的判断，不是 AI 的：AI 提了方向，作者采纳了才勾。
 */
export default function InspirationPanel() {
  const [items, setItems] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

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

  const renderItem = (item) => (
    <div
      key={item.id}
      style={{
        padding: '7px 6px',
        borderRadius: 6,
        opacity: item.consumed ? 0.45 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <span
          onClick={() => openEditor(item)}
          style={{ flex: 1, fontSize: 13, lineHeight: 1.7, cursor: 'pointer', whiteSpace: 'pre-wrap' }}
        >
          {item.text}
          {item.tags ? (
            <Tag style={{ marginLeft: 6, marginTop: 2 }}>{item.tags}</Tag>
          ) : null}
        </span>
        <Tooltip title={item.consumed ? '标记为未用' : '标记为已用'}>
          <CheckOutlined
            style={{
              fontSize: 13,
              marginTop: 3,
              color: item.consumed ? '#10b981' : 'rgba(128,128,128,0.35)',
              cursor: 'pointer',
            }}
            onClick={() => toggleConsumed(item)}
          />
        </Tooltip>
        <EditOutlined
          style={{ fontSize: 12, opacity: 0.4, marginTop: 3, cursor: 'pointer' }}
          onClick={() => openEditor(item)}
        />
        <DeleteOutlined
          style={{ fontSize: 12, opacity: 0.4, marginTop: 3, cursor: 'pointer' }}
          onClick={() => remove(item)}
        />
      </div>
    </div>
  );

  return (
    <div style={{ padding: '4px 8px' }}>
      <Button
        type="text"
        size="small"
        icon={<PlusOutlined />}
        block
        onClick={() => openEditor(null)}
        style={{ textAlign: 'left', fontSize: 12, paddingLeft: 4 }}
      >
        记一条灵感
      </Button>

      {pending.map(renderItem)}

      {used.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, opacity: 0.4, padding: '4px 6px' }}>
            已用（{used.length}）
          </div>
          {used.map(renderItem)}
        </div>
      )}

      {items.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.45, padding: '8px 6px', lineHeight: 1.7 }}>
          还没有灵感。想到什么随手记一条，灵感师会用它来提方向。
        </div>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑灵感' : '记一条灵感'}
        okText="保存"
        cancelText="取消"
        width={480}
        onOk={save}
        onCancel={() => setEditing(null)}
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
    </div>
  );
}
