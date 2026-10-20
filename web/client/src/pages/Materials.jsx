import React, { useEffect, useState } from 'react';
import {
  Button,
  Input,
  Modal,
  Form,
  message,
  Upload,
  List,
  Empty,
  Typography,
  Popconfirm,
} from 'antd';
import { PlusOutlined, DeleteOutlined, EditOutlined, UploadOutlined } from '@ant-design/icons';
import api from '../api/client';

const { Text } = Typography;

/**
 * 素材库。
 *
 * 素材是 AI 检索的本地语料库：作者自己的积累，比外部搜索更贴合他的风格。
 */
export default function Materials() {
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();

  const load = async (keyword = '') => {
    try {
      const res = await api.get(
        keyword ? `/materials?search=${encodeURIComponent(keyword)}` : '/materials'
      );
      setItems(res.data);
    } catch (e) {
      message.error('素材加载失败');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openEditor = (item) => {
    setEditing(item || {});
    form.setFieldsValue(
      item || { title: '', body: '', source: '手记', sourceUrl: '', tags: '' }
    );
  };

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/materials/${editing.id}`, values);
      } else {
        await api.post('/materials', values);
      }
      setEditing(null);
      message.success('已保存');
      load(search);
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = async (item) => {
    await api.delete(`/materials/${item.id}`);
    message.success('已删除');
    load(search);
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 20,
        }}
      >
        <Input.Search
          placeholder="搜索素材标题、正文、标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={load}
          allowClear
          style={{ maxWidth: 320 }}
        />
        <span style={{ flex: 1 }} />
        <Upload
          multiple
          accept=".pdf,.txt,.md,.markdown"
          showUploadList={false}
          customRequest={async ({ file, onSuccess, onError }) => {
            const formData = new FormData();
            formData.append('files', file);
            try {
              await api.post('/materials/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
              });
              message.success(`已导入 ${file.name}`);
              load(search);
              onSuccess?.();
            } catch (err) {
              message.error('导入失败');
              onError?.(err);
            }
          }}
        >
          <Button icon={<UploadOutlined />}>导入文件</Button>
        </Upload>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
          新建素材
        </Button>
      </div>

      {items.length === 0 ? (
        <Empty description="素材库还是空的。导入一些参考材料，AI 检索时会用到它们。" />
      ) : (
        <List
          bordered
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              actions={[
                <EditOutlined key="edit" onClick={() => openEditor(item)} />,
                <Popconfirm
                  key="del"
                  title="删除这条素材？"
                  onConfirm={() => remove(item)}
                >
                  <DeleteOutlined />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <span>
                    {item.title}
                    <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                      {item.source}
                    </Text>
                  </span>
                }
                description={
                  <div>
                    <div
                      style={{
                        fontSize: 13,
                        opacity: 0.75,
                        lineHeight: 1.7,
                        maxHeight: 90,
                        overflow: 'hidden',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {item.body || '（无正文）'}
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.5, marginTop: 4 }}>
                      {item.char_count || 0} 字
                      {item.tags ? ` · ${item.tags}` : ''}
                    </div>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑素材' : '新建素材'}
        okText="保存"
        cancelText="取消"
        width={640}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="雨夜巷子的描写" />
          </Form.Item>
          <Form.Item name="source" label="来源">
            <Input placeholder="手记 / 书籍 / 网页" />
          </Form.Item>
          <Form.Item name="sourceUrl" label="来源链接">
            <Input placeholder="https://…" />
          </Form.Item>
          <Form.Item name="tags" label="标签" help="用逗号分隔，便于检索。">
            <Input placeholder="环境描写，悬疑" />
          </Form.Item>
          <Form.Item name="body" label="正文">
            <Input.TextArea rows={10} placeholder="素材内容。AI 检索时会从这里取片段。" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
