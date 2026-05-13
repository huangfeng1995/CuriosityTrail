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
  Card 
} from 'antd';
import { 
  UploadOutlined, 
  FolderOpenOutlined, 
  EditOutlined, 
  DeleteOutlined, 
  FilePdfOutlined 
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';

const { Option } = Select;

function Documents({ searchText }) {
  const [documents, setDocuments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [form] = Form.useForm();

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
    fetchData(searchText);
  }, [searchText, selectedCategory]);

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
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>📚 文献库</h2>
          <Space>
            <Select
              style={{ width: 180 }}
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
            <Upload
              beforeUpload={handleUpload}
              accept=".pdf"
              showUploadList={false}
            >
              <Button type="primary" icon={<UploadOutlined />}>
                上传 PDF
              </Button>
            </Upload>
          </Space>
        </div>

        <List
          grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 3, xl: 3, xxl: 4 }}
          loading={loading}
          dataSource={documents}
          renderItem={(item) => (
            <List.Item>
              <Card
                hoverable
                onClick={() => openDocument(item)}
                actions={[
                  <FolderOpenOutlined key="open" onClick={() => openDocument(item)} />,
                  <EditOutlined key="edit" onClick={(e) => { e.stopPropagation(); openEditModal(item); }} />,
                  <Popconfirm
                    key="delete"
                    title="确定要删除吗？"
                    onConfirm={() => handleDelete(item.id)}
                    okText="确定"
                    cancelText="取消"
                  >
                    <DeleteOutlined />
                  </Popconfirm>,
                ]}
              >
                <Card.Meta
                  avatar={<FilePdfOutlined style={{ fontSize: '32px', color: '#faad14' }} />}
                  title={item.name}
                  description={
                    <>
                      <div>分类: {item.category_name || '未分类'}</div>
                      <div>上传: {dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}</div>
                    </>
                  }
                />
              </Card>
            </List.Item>
          )}
        />
      </Space>

      <Modal
        title="编辑文献"
        open={editModalVisible}
        onOk={handleEdit}
        onCancel={() => setEditModalVisible(false)}
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
