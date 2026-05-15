import React, { useState, useEffect, useRef } from 'react';
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
  Card,
  Upload,
  Progress,
} from 'antd';
import { Calendar, X } from 'lucide-react';
import {
  UploadOutlined,
  FolderOpenOutlined,
  EditOutlined,
  DeleteOutlined,
  FileTextOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';

const { Option } = Select;
const { Title, Text } = Typography;

function Documents({ searchText, isDark }) {
  const [documents, setDocuments] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [currentDoc, setCurrentDoc] = useState(null);
  const [form] = Form.useForm();
  const [localSearch, setLocalSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadQueue, setUploadQueue] = useState([]);
  const dropRef = useRef(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
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

  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault();
      if (dropRef.current) {
        dropRef.current.style.borderColor = isDark ? '#60a5fa' : '#1e3a5f';
        dropRef.current.style.background = isDark ? 'rgba(96, 165, 250, 0.1)' : 'rgba(30, 58, 95, 0.05)';
      }
    };

    const handleDragLeave = () => {
      if (dropRef.current) {
        dropRef.current.style.borderColor = isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)';
        dropRef.current.style.background = isDark ? 'rgba(31, 41, 55, 0.3)' : 'rgba(255, 255, 255, 0.5)';
      }
    };

    const handleDrop = async (e) => {
      e.preventDefault();
      if (dropRef.current) {
        dropRef.current.style.borderColor = isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)';
        dropRef.current.style.background = isDark ? 'rgba(31, 41, 55, 0.3)' : 'rgba(255, 255, 255, 0.5)';
      }

      const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
      if (files.length === 0) {
        message.warning('请上传 PDF 文件');
        return;
      }

      await uploadFiles(files);
    };

    const dropZone = dropRef.current;
    if (dropZone) {
      dropZone.addEventListener('dragover', handleDragOver);
      dropZone.addEventListener('dragleave', handleDragLeave);
      dropZone.addEventListener('drop', handleDrop);
    }

    return () => {
      if (dropZone) {
        dropZone.removeEventListener('dragover', handleDragOver);
        dropZone.removeEventListener('dragleave', handleDragLeave);
        dropZone.removeEventListener('drop', handleDrop);
      }
    };
  }, [isDark]);

  const uploadFiles = async (files) => {
    setUploading(true);
    setUploadQueue(files.map(f => ({ name: f.name, progress: 0 })));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('files', file);
      if (selectedCategory) {
        formData.append('category_id', selectedCategory);
      }

      try {
        const config = {
          onUploadProgress: (progressEvent) => {
            const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
            setUploadQueue(prev => prev.map((item, idx) => 
              idx === i ? { ...item, progress: percent } : item
            ));
            setUploadProgress(Math.round(((i + (percent / 100)) / files.length) * 100));
          },
        };

        await axios.post('/api/documents/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
          ...config,
        });
      } catch (err) {
        message.error(`上传 ${file.name} 失败`);
      }
    }

    setUploading(false);
    setUploadProgress(100);
    message.success(`成功上传 ${files.length} 个文件`);
    fetchData();
    
    setTimeout(() => {
      setUploadQueue([]);
      setUploadProgress(0);
    }, 2000);
  };

  const handleUpload = async (file) => {
    await uploadFiles([file]);
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
      <div style={{
        display: 'flex',
        flexDirection: window.innerWidth < 768 ? 'column' : 'row',
        justifyContent: 'space-between',
        alignItems: window.innerWidth < 768 ? 'flex-start' : 'center',
        gap: window.innerWidth < 768 ? 12 : 0,
        marginBottom: 28,
      }}>
        <div>
          <Title level={2} style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}>
            文献库
          </Title>
          <div style={{
            fontSize: 14,
            color: isDark ? '#6b7280' : '#9ca3af',
            marginTop: 4,
          }}>
            共 {documents.length} 篇文献
          </div>
        </div>
        <Space wrap style={{ justifyContent: 'flex-start' }}>
          <Select
            style={{ width: 160 }}
            placeholder="筛选分类"
            allowClear
            value={selectedCategory}
            onChange={setSelectedCategory}
            variant="borderless"
            styles={{
              popup: {
                background: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
                borderRadius: 12,
              },
            }}
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
            <Button 
              type="primary" 
              size="large" 
              icon={<UploadOutlined size={18} />}
              style={{ 
                borderRadius: 8,
                fontWeight: 600,
                padding: '8px 20px',
                boxShadow: isDark ? '0 4px 12px rgba(96, 165, 250, 0.3)' : '0 4px 12px rgba(30, 58, 95, 0.2)',
                transition: 'all 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
              }}
            >
              上传 PDF
            </Button>
          </Upload>
        </Space>
      </div>

      {searchText === undefined && (
        <div style={{ marginBottom: 20 }}>
          <Input
            placeholder="搜索文献..."
            prefix={<span style={{ color: isDark ? '#6b7280' : '#9ca3af', marginRight: 8 }}>🔍</span>}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
            style={{
              borderRadius: 10,
              height: 42,
              background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255, 255, 255, 0.8)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
              border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
            }}
          />
        </div>
      )}

      {uploadQueue.length > 0 && (
        <div style={{
          marginBottom: 20,
          padding: 16,
          background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255, 255, 255, 0.8)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: 12,
          border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
          boxShadow: isDark ? '0 4px 20px rgba(0, 0, 0, 0.2)' : '0 4px 20px rgba(30, 58, 95, 0.08)',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <UploadOutlined size={16} style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />
              <span style={{
                fontSize: 14,
                fontWeight: 500,
                color: isDark ? '#f9fafb' : '#111827',
              }}>
                上传中...
              </span>
            </div>
            <span style={{
              fontSize: 12,
              color: isDark ? '#6b7280' : '#9ca3af',
            }}>
              {uploadProgress}%
            </span>
          </div>
          <Progress
            percent={uploadProgress}
            strokeColor={isDark ? '#60a5fa' : '#1e3a5f'}
            strokeWidth={3}
            style={{ marginBottom: 12 }}
          />
          <div style={{ maxHeight: 100, overflowY: 'auto' }}>
            {uploadQueue.map((item, index) => (
              <div key={index} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: isDark ? '#9ca3af' : '#6b7280',
                marginBottom: 4,
              }}>
                <FileTextOutlined size={12} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </span>
                <span>{item.progress}%</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div 
        ref={dropRef}
        style={{
          marginBottom: 20,
          padding: 32,
          border: `2px dashed ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
          borderRadius: 12,
          background: isDark ? 'rgba(31, 41, 55, 0.3)' : 'rgba(255, 255, 255, 0.5)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          transition: 'all 0.2s cubic-bezier(0.22, 1, 0.36, 1)',
          textAlign: 'center',
        }}
      >
        <UploadOutlined size={32} style={{ color: isDark ? '#6b7280' : '#9ca3af', marginBottom: 12 }} />
        <div style={{
          fontSize: 14,
          fontWeight: 500,
          color: isDark ? '#d1d5db' : '#374151',
          marginBottom: 4,
        }}>
          拖拽 PDF 文件到这里上传
        </div>
        <div style={{
          fontSize: 12,
          color: isDark ? '#6b7280' : '#9ca3af',
        }}>
          支持批量上传，仅限 PDF 格式
        </div>
      </div>

      {documents.length === 0 ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 0',
        }}>
          <div style={{
            width: 100,
            height: 100,
            borderRadius: 20,
            background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(248, 249, 250, 0.8)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
            boxShadow: isDark ? '0 4px 20px rgba(0, 0, 0, 0.2)' : '0 4px 20px rgba(30, 58, 95, 0.08)',
          }}>
            <FileTextOutlined size={40} style={{ color: isDark ? '#4b5563' : '#d1d5db' }} />
          </div>
          <Title level={4} style={{
            margin: 0,
            color: isDark ? '#9ca3af' : '#6b7280',
            fontSize: 18,
            fontWeight: 500,
          }}>
            暂无文献
          </Title>
          <Text style={{
            color: isDark ? '#6b7280' : '#9ca3af',
            marginTop: 8,
          }}>
            上传 PDF 文件开始管理你的文献库
          </Text>
        </div>
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
                onClick={() => openDocument(item)}
                style={{
                  background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255, 255, 255, 0.8)',
                  backdropFilter: 'blur(20px)',
                  WebkitBackdropFilter: 'blur(20px)',
                  borderRadius: 12,
                  border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
                  padding: 16,
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
                  boxShadow: isDark ? '0 4px 20px rgba(0, 0, 0, 0.2)' : '0 4px 20px rgba(30, 58, 95, 0.08)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-4px)';
                  e.currentTarget.style.boxShadow = isDark ? '0 12px 40px rgba(0, 0, 0, 0.3)' : '0 12px 40px rgba(30, 58, 95, 0.12)';
                  e.currentTarget.style.borderColor = isDark ? 'rgba(96, 165, 250, 0.5)' : 'rgba(30, 58, 95, 0.3)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = isDark ? '0 4px 20px rgba(0, 0, 0, 0.2)' : '0 4px 20px rgba(30, 58, 95, 0.08)';
                  e.currentTarget.style.borderColor = isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)';
                }}
              >
                <div style={{ display: 'flex', gap: 14 }}>
                  <div style={{
                    width: 56,
                    height: 72,
                    borderRadius: 8,
                    background: isDark ? 'linear-gradient(135deg, rgba(30, 58, 95, 0.6), rgba(96, 165, 250, 0.3))' : 'linear-gradient(135deg, rgba(254, 243, 199, 0.8), rgba(217, 119, 6, 0.1))',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    boxShadow: isDark ? '0 4px 12px rgba(0, 0, 0, 0.2)' : '0 4px 12px rgba(217, 119, 6, 0.1)',
                    transition: 'all 0.2s ease',
                  }}>
                    <FileTextOutlined size={28} style={{ color: isDark ? '#60a5fa' : '#d97706' }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 15,
                      fontWeight: 600,
                      marginBottom: 6,
                      color: isDark ? '#f9fafb' : '#111827',
                      fontFamily: 'Inter, system-ui, sans-serif',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {item.name}
                    </div>
                    <div style={{
                      fontSize: 12,
                      color: isDark ? '#6b7280' : '#9ca3af',
                      marginBottom: 12,
                    }}>
                      {item.category_name || '未分类'}
                      <span style={{ margin: '0 6px' }}>•</span>
                      {dayjs(item.created_at).format('YYYY-MM-DD')}
                    </div>

                    <Space size="small" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="small"
                        icon={<FolderOpenOutlined size={12} />}
                        onClick={() => openDocument(item)}
                        style={{
                          padding: '4px 10px',
                          fontSize: 12,
                          borderRadius: 6,
                          transition: 'all 0.2s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = isDark ? 'rgba(96, 165, 250, 0.1)' : 'rgba(30, 58, 95, 0.05)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        打开
                      </Button>
                      <Button
                        size="small"
                        icon={<EditOutlined size={12} />}
                        onClick={() => openEditModal(item)}
                        style={{
                          padding: '4px 10px',
                          fontSize: 12,
                          borderRadius: 6,
                          transition: 'all 0.2s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = isDark ? 'rgba(96, 165, 250, 0.1)' : 'rgba(30, 58, 95, 0.05)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        编辑
                      </Button>
                      <Popconfirm
                        title="确定删除？"
                        onConfirm={() => handleDelete(item.id)}
                        okText="确定"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                      >
                        <Button
                          size="small"
                          danger
                          icon={<DeleteOutlined size={12} />}
                          style={{ 
                            padding: '4px 10px', 
                            fontSize: 12,
                            borderRadius: 6,
                            transition: 'all 0.2s ease',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                          }}
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

      <Modal
        title="编辑文献"
        open={editModalVisible}
        onOk={handleEdit}
        onCancel={() => setEditModalVisible(false)}
        centered
        width={window.innerWidth < 768 ? '90%' : 480}
        styles={{
          mask: {
            backdropFilter: 'blur(4px)',
          },
          content: {
            background: isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: 12,
            border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
          },
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="name"
            label="文献名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input 
              placeholder="请输入名称" 
              size="large"
              style={{ borderRadius: 8 }}
            />
          </Form.Item>
          <Form.Item name="category_id" label="分类">
            <Select 
              placeholder="请选择分类"
              style={{ width: '100%', borderRadius: 8 }}
            >
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
