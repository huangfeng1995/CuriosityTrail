import React, { useEffect, useState } from 'react';
import { Input, Modal, Form, message, Select, Empty } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '../../api/client';

const CATEGORIES = ['地理', '历史', '组织', '规则', '物品', '种族', '其他'];

/**
 * 世界观设定面板。
 *
 * importance 决定 AI 什么时候会带上这条设定：
 * 3 及以上无条件注入，1-2 只在正文提到设定名时注入。
 */
export default function SettingPanel({ workId }) {
  const [settings, setSettings] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

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
    form.setFieldsValue(
      setting || { name: '', category: '其他', content: '', importance: 3 }
    );
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/settings/${editing.id}`, values);
      } else {
        await api.post('/settings', { ...values, workId });
      }
      setEditing(null);
      message.success('已保存');
      load();
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

      {settings.map((s) => (
        <div key={s.id} className="ct-item">
          <button
            type="button"
            className="ct-item-main"
            onClick={() => openEditor(s)}
            title={`编辑「${s.name}」`}
          >
            <span className="ct-item-title">{s.name}</span>
            <span className="ct-item-meta">{s.category}</span>
            {s.importance >= 3 && <span className="ct-badge">常驻</span>}
          </button>
          <div className="ct-item-actions">
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
      ))}

      {settings.length === 0 && (
        <p className="ct-hint">还没有设定。地理、规则、组织——这些是 AI 不写崩的前提。</p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑设定' : '新建设定'}
        okText="保存"
        cancelText="取消"
        width={520}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="name" label="设定名" rules={[{ required: true, message: '请输入设定名' }]}>
            <Input placeholder="临江城" />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select options={CATEGORIES.map((c) => ({ value: c, label: c }))} />
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
          <Form.Item name="content" label="内容">
            <Input.TextArea rows={6} placeholder="设定正文。写给 AI 看，不用太文学化，说清楚规则和边界即可。" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
