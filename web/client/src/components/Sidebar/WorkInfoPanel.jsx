import React, { useEffect, useState } from 'react';
import { Input, Button, Form, message, Empty, InputNumber, Select, Spin } from 'antd';
import { SaveOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 作品信息表单。
 *
 * 题材、简介、大纲三个字段是 AI 上下文装配器的第一层输入——
 * 作者把"这是个悬疑，主角是个连环杀手"写在这里，AI 才知道往哪个方向写。
 *
 * 这些是「配置一次」的东西，不是写作当下要看的，所以入口在设置页「作品」，
 * 写作页左栏不再挂这个面板。组件按 workId 自己取数，不依赖工作区的 store。
 */
export default function WorkInfoPanel({ workId, onSaved }) {
  const [form] = Form.useForm();
  const [work, setWork] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!workId) {
      setWork(null);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    api
      .get(`/works/${workId}`)
      .then((res) => {
        if (alive) setWork(res.data);
      })
      .catch(() => {
        if (alive) message.error('作品信息加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workId]);

  useEffect(() => {
    if (!work) return;
    form.setFieldsValue({
      title: work.title || '',
      genre: work.genre || '',
      synopsis: work.synopsis || '',
      outline: work.outline || '',
      targetWords: work.target_words || 0,
      // 未启用一律落成空串，不在新建/编辑时替作者打开流水线。
      template: work.template || '',
    });
  }, [work, form]);

  const save = async () => {
    if (!work) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      const res = await api.put(`/works/${work.id}`, values);
      setWork((prev) => ({ ...prev, ...res.data }));
      message.success('已保存');
      onSaved?.(res.data);
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  if (loading && !work) {
    return (
      <div className="ct-loading">
        <Spin />
      </div>
    );
  }

  if (!work) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="作品打不开" />;
  }

  return (
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
      <Form.Item
        name="targetWords"
        label="目标字数"
        help="设了之后「进度」会显示完成度。"
      >
        <InputNumber min={0} step={10000} style={{ width: '100%' }} placeholder="未设定" />
      </Form.Item>
      <Form.Item
        name="template"
        label="创作模板"
        help="启用后 AI 会遵守锚点与本章知情边界。锚点库、待确认在设置 → 历史悬疑里。"
      >
        <Select
          options={[
            { value: '', label: '不启用' },
            { value: 'history_thriller', label: '历史悬疑' },
          ]}
        />
      </Form.Item>
      <Button
        type="primary"
        size="small"
        icon={<SaveOutlined />}
        loading={saving}
        onClick={save}
      >
        保存作品信息
      </Button>
    </Form>
  );
}
