import React, { useEffect, useState } from 'react';
import { Input, Modal, Form, message, Empty } from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 人物卡面板。
 *
 * 人物卡是 AI 知道"这个人是谁"的唯一来源，因此字段要跟写作决策对齐：
 * 说话风格（对白辨识度）、核心目标（行为动机）、成长弧（转变铺垫）。
 */
export default function CharacterPanel({ workId }) {
  const [characters, setCharacters] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const load = async () => {
    if (!workId) return;
    try {
      const res = await api.get(`/characters?workId=${workId}`);
      setCharacters(res.data);
    } catch (e) {
      message.error('人物卡加载失败');
    }
  };

  useEffect(() => {
    load();
  }, [workId]);

  const openEditor = (character) => {
    setEditing(character || {});
    form.setFieldsValue(
      character || {
        name: '',
        aliases: '',
        role: '',
        identity: '',
        personality: '',
        speech: '',
        goal: '',
        arc: '',
        notes: '',
      }
    );
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/characters/${editing.id}`, values);
      } else {
        await api.post('/characters', { ...values, workId });
      }
      setEditing(null);
      message.success('已保存');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = (character) => {
    Modal.confirm({
      title: `删除人物「${character.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/characters/${character.id}`);
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
        新建人物卡
      </button>

      {characters.map((c) => (
        <div key={c.id} className="ct-item">
          <button
            type="button"
            className="ct-item-main"
            onClick={() => openEditor(c)}
            title={`编辑「${c.name}」`}
          >
            <span className="ct-item-title">{c.name}</span>
            {c.role && <span className="ct-item-meta">{c.role}</span>}
          </button>
          <div className="ct-item-actions">
            <button
              type="button"
              className="ct-item-act"
              title="编辑"
              aria-label={`编辑 ${c.name}`}
              onClick={() => openEditor(c)}
            >
              <EditOutlined />
            </button>
            <button
              type="button"
              className="ct-item-act is-danger"
              title="删除"
              aria-label={`删除 ${c.name}`}
              onClick={() => remove(c)}
            >
              <DeleteOutlined />
            </button>
          </div>
        </div>
      ))}

      {characters.length === 0 && (
        <p className="ct-hint">还没有人物卡。AI 写对白时靠它区分说话人。</p>
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑人物' : '新建人物'}
        okText="保存"
        cancelText="取消"
        width={520}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input placeholder="陈默" />
          </Form.Item>
          <Form.Item name="aliases" label="别名 / 称呼" help="用逗号分隔。正文里出现任一称呼，AI 都会带上这张卡。">
            <Input placeholder="老陈，小默" />
          </Form.Item>
          <Form.Item name="role" label="身份">
            <Input placeholder="刑侦支队队长" />
          </Form.Item>
          <Form.Item name="identity" label="背景">
            <Input.TextArea rows={2} placeholder="出身、经历、关键事件" />
          </Form.Item>
          <Form.Item name="personality" label="性格">
            <Input.TextArea rows={2} placeholder="沉稳、多疑、护短" />
          </Form.Item>
          <Form.Item name="speech" label="说话风格" help="这是对白辨识度的关键。">
            <Input.TextArea rows={2} placeholder="话少，句子短，不用形容词" />
          </Form.Item>
          <Form.Item name="goal" label="核心目标" help="他当下最想达成什么，AI 靠它推演行为。">
            <Input placeholder="查清三年前那桩旧案" />
          </Form.Item>
          <Form.Item name="arc" label="成长弧" help="从什么状态变成什么状态。">
            <Input placeholder="从独来独往到愿意信任搭档" />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={2} placeholder="禁忌、习惯、小动作" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
