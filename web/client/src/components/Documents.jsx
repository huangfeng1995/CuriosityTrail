import React, { useState, useEffect } from 'react';
import {
  List,
  Button,
  Space,
  Input,
  Select,
  Modal,
  Form,
  message,
  Popconfirm,
  Typography,
  Empty,
} from 'antd';
import {
  UploadOutlined,
  FolderOpenOutlined,
  EditOutlined,
  DeleteOutlined,
  FilePdfOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';

const { Option } = Select;
const { Title, Text } = Typography;

function Documents({ searchText }) {
  const [documents, setDocuments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [form] = Form.useForm();
  const [localSearch, setLocalSearch] = useState('');
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setIsDark(savedTheme === 'dark');
    }
  }, []);

  const fetchData = async (search = '') => {
    setLoading(true);
    try {
      const [docsRes, catsRes] = await Promise.all([
        axios.get('/api/documents', { params: { search: search || undefined, category_id: selectedCategory } }),
        axios.get('/api/categories'),
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
      fetchData(searchText !== undefined ? searchText : localSearch);
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
        headers: { 'Content-Type': 'multipart/form-data' },
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
    <div>
      {/* 标题和操作区 */}
      <div style={{
        display: 'flex',
        flexDirection: window.innerWidth < 768 ? 'column' : 'row',
        justifyContent: 'space-between',
        alignItems: window.innerWidth < 768 ? 'flex-start' : 'center',
        gap: window.innerWidth < 768 ? 12 : 0,
        marginBottom: 28,
      }}>
        <Title level={2} style={{
          margin: 0,
          fontSize: 24,
          fontWeight: 700,
          color: isDark ? '#f1f5f9' : '#111827',
        }}>
          文献库
        </Title>
        <Space wrap style={{ justifyContent: 'flex-start' }}>
          <Select
            style={{ width: 150 }}
            placeholder="筛选分类"
            allowClear
            value={selectedCategory}
            onChange={setSelectedCategory}
          >
            {categories.map(cat => (
              <Option key={cat.id} value={cat.id}>{cat.name}</Option>
            ))}
          </Select>
          <Upload
            beforeUpload={handleUpload}
            accept=".pdf"
            showUploadList={false}
            multiple
          >
            <Button type="primary" size="large" icon={<UploadOutlined />}>
              上传 PDF
            </Button>
          </Upload>
        </Space>
      </div>

      {/* 搜索栏 */}
      {searchText === undefined && (
        <div style={{ marginBottom: 20 }}>
          <Input
            placeholder="搜索文献..."
            prefix={<span style={{ color: isDark ? '#64748b' : '#9ca3af' }}>🔍</span>}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
          />
        </div>
      )}

      {/* 文献列表 */}
      {documents.length === 0 ? (
        <Empty
          description="还没有文献，点击上方按钮上传"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ margin: '60px 0' }}
        />
      ) : (
        <List
          grid={{
            gutter: [20, 20],
            xs: 1,
            sm: 1,
            md: 2,
            lg: 3,
            xl: 3,
            xxl: 4,
          }}
          loading={loading}
          dataSource={documents}
          renderItem={(item) => (
            <List.Item style={{ display: 'block' }}>
              <div
                style={{
                  background: isDark ? '#0f172a' : '#ffffff',
                  borderRadius: 14,
                  padding: 20,
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
                  boxShadow: isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.06)',
                  height: '100%',
                }}
                onClick={() => openDocument(item)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = isDark ? '0 10px 25px -15px rgba(0,0,0,0.5)' : '0 10px 25px -15px rgba(0,0,0,0.12)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.06)';
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
                  {/* PDF 图标 */}
                  <div style={{
                    background: isDark ? '#1e293b' : '#fef3c7',
                    width: 52,
                    height: 68,
                    borderRadius: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <FilePdfOutlined style={{
                      fontSize: 26,
                      color: isDark ? '#eab308' : '#d97706',
                    }} />
                  </div>

                  {/* 信息区 */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 15,
                      fontWeight: 600,
                      marginBottom: 6,
                      color: isDark ? '#f1f5f9' : '#111827',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {item.name}
                    </div>
                    <div style={{
                      fontSize: 12,
                      color: isDark ? '#64748b' : '#9ca3af',
                      marginBottom: 14,
                    }}>
                      {item.category_name || '未分类'} • {dayjs(item.created_at).format('MM月DD日')}
                    </div>

                    <Space size="small" onClick={(e) => e.stopPropagation()}>
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
                        title="确定删除？"
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
                    </Space>
                  </div>
                </div>
              </div>
            </List.Item>
          )}
        />
      )}

      {/* 编辑弹窗 */}
      <Modal
        title="编辑文献"
        open={editModalVisible}
        onOk={handleEdit}
        onCancel={() => setEditModalVisible(false)}
        centered
        width={window.innerWidth < 768 ? '90%' : 480}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="文献名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="请输入名称" size="large" />
          </Form.Item>
          <Form.Item name="category_id" label="分类">
            <Select placeholder="请选择分类">
              {categories.map(cat => (
                <Option key={cat.id} value={cat.id}>{cat.name}</Option>
              ))}
            </Select>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default Documents;
