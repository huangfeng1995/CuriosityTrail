import React, { useState, useEffect } from 'react';
import {
  List,
  Button,
  Space,
  Upload,
  Modal,
  Form,
  Input,
  Select,
  message,
  Popconfirm,
  Empty
} from 'antd';
import {
  UploadOutlined,
  FolderOpenOutlined,
  EditOutlined,
  DeleteOutlined,
  FilePdfOutlined,
  SearchOutlined,
  InboxOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';

const { Option } = Select;
const { Dragger } = Upload;

function Documents({ searchText }) {
  const [documents, setDocuments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [form] = Form.useForm();
  const [localSearch, setLocalSearch] = useState('');

  const fetchData = async (search = '') => {
    setLoading(true);
    try {
      const [docsRes, catsRes] = await Promise.all([
        axios.get('/api/documents', { params: { search: search || undefined, category_id: selectedCategory } }),
        axios.get('/api/categories')
      ]);
      setDocuments(docsRes.data);
      setCategories(catsRes.data);
    } catch (err) {
      message.error('获取数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchData(searchText !== false ? searchText : localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [selectedCategory, searchText]);

  const handleUpload = async (file) => {
    const formData = new FormData();
    formData.append('files', file);
    if (selectedCategory) {
      formData.append('category_id', selectedCategory);
    }

    try {
      await axios.post('/api/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      message.success('上传成功');
      fetchData();
    } catch (err) {
      message.error('上传失败');
    }
    return false;
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(`/api/documents/${id}`);
      message.success('删除成功');
      fetchData();
    } catch (err) {
      message.error('删除失败');
    }
  };

  const openEditModal = (doc) => {
    setCurrentDoc(doc);
    form.setFieldsValue({ name: doc.name, category_id: doc.category_id });
    setEditModalVisible(true);
  };

  const handleEdit = async () => {
    try {
      const values = await form.validateFields();
      await axios.put(`/api/documents/${currentDoc.id}`, values);
      message.success('更新成功');
      setEditModalVisible(false);
      fetchData();
    } catch (err) {
      message.error('更新失败');
    }
  };

  const openDocument = (doc) => {
    window.open(`/api/documents/${doc.id}/file`, '_blank');
  };

  return (
    <>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div style={{
          display: 'flex',
          flexDirection: window.innerWidth < 768 ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: window.innerWidth < 768 ? 'stretch' : 'center',
          gap: 12
        }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            📚 文献库
            <span style={{ fontSize: 14, color: '#999', fontWeight: 'normal' }}>
              ({documents.length})
            </span>
          </h2>
          <Upload
            beforeUpload={handleUpload}
            accept=".pdf"
            showUploadList={false}
            multiple
          >
            <Button type="primary" icon={<UploadOutlined />}>
              上传 PDF
            </Button>
          </Upload>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Input
            placeholder="搜索文献..."
            prefix={<SearchOutlined />}
            style={{ flex: 1, minWidth: 200 }}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
          />
          <Select
            style={{ width: 160 }}
            placeholder="筛选分类"
            allowClear
            value={selectedCategory}
            onChange={setSelectedCategory}
          >
            {categories.map(cat => (
              <Option key={cat.id} value={cat.id}>
                {cat.name}
              </Option>
            ))}
          </Select>
        </div>

        {documents.length === 0 ? (
          <Empty description="暂无文献，点击上方按钮上传 PDF" />
        ) : (
          <List
            grid={{ gutter: 16, xs: 1, sm: 2, md: 2, lg: 3, xl: 3, xxl: 4 }}
            loading={loading}
            dataSource={documents}
            renderItem={(item) => (
              <List.Item>
                <div
                  style={{
                    background: 'white',
                    borderRadius: 12,
                    padding: 16,
                    cursor: 'pointer',
                    transition: 'all 0.3s',
                    border: '1px solid #f0f0f0',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
                  }}
                  onClick={() => openDocument(item)}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <FilePdfOutlined style={{ fontSize: 32, color: '#faad14' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: 600,
                        marginBottom: 8,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {item.name}
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 4 }}>
                        {item.category_name || '未分类'}
                      </div>
                      <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
                        {dayjs(item.created_at).format('YYYY-MM-DD')}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }} onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="small"
                          icon={<FolderOpenOutlined />}
                          onClick={() => openDocument(item)}
                        >
                          打开
                        </Button>
                        <Button
                          size="small"
                          icon={<EditOutlined />}
                          onClick={() => openEditModal(item)}
                        >
                          编辑
                        </Button>
                        <Popconfirm
                          title="确定要删除吗？"
                          onConfirm={() => handleDelete(item.id)}
                          okText="确定"
                          cancelText="取消"
                        >
                          <Button
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                          />
                        </Popconfirm>
                      </div>
                    </div>
                  </div>
                </div>
              </List.Item>
            )}
          />
        )}
      </Space>

      <Modal
        title="编辑文献"
        open={editModalVisible}
        onOk={handleEdit}
        onCancel={() => setEditModalVisible(false)}
        width={window.innerWidth < 768 ? '95%' : 500}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="文献名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="请输入文献名称" />
          </Form.Item>
          <Form.Item name="category_id" label="分类">
            <Select placeholder="请选择分类">
              {categories.map(cat => (
                <Option key={cat.id} value={cat.id}>
                  {cat.name}
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export default Documents;
