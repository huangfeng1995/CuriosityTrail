import React, { useEffect, useState } from 'react';
import { Input, Button, Form, message, Empty, Collapse } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 作品信息面板。
 *
 * 题材、简介、大纲三个字段是 AI 上下文装配器的第一层输入——
 * 后端早就支持写入，但此前前端没有入口，等于这个能力一直是关着的。
 * 作者把"这是个悬疑，主角是个连环杀手"写在这里，AI 才知道往哪个方向写。
 */
export default function WorkInfoPanel({ work, onSaved }) {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!work) return;
    form.setFieldsValue({
      title: work.title || '',
      genre: work.genre || '',
      synopsis: work.synopsis || '',
      outline: work.outline || '',
    });
  }, [work, form]);

  const save = async () => {
    if (!work) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.put(`/works/${work.id}`, values);
      message.success('已保存');
      onSaved?.(res.data);
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!work) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <Form form={form} layout="vertical" size="small" requiredMark={false}>
        <Form.Item name="title" label="书名" rules={[{ required: true, message: '书名不能为空' }]}>
          <Input placeholder="书名" />
        </Form.Item>
        <Form.Item name="genre" label="题材">
          <Input placeholder="悬疑 / 都市 / 玄幻" />
        </Form.Item>
        <Form.Item name="synopsis" label="简介">
          <Input.TextArea
            rows={3}
            placeholder="一句话说清这部小说讲什么。AI 每次都会看到它。"
          />
        </Form.Item>
        <Form.Item name="outline" label="大纲">
          <Input.TextArea
            rows={6}
            placeholder="主线、关键转折、结局走向。写在这里，AI 续写时不会跑偏。"
          />
        </Form.Item>
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          loading={saving}
          onClick={save}
          block
        >
          保存作品信息
        </Button>
      </Form>
    </div>
  );
}
