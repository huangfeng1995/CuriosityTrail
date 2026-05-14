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
  Tag,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  EyeOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FilePdfOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import ReportEditor from './ReportEditor';

const { Option } = Select;
const { Title, Text } = Typography;

function Reports({ searchText }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState('modified_at');
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorMode, setEditorMode] = useState('view');
  const [form] = Form.useForm();
  const [localSearch, setLocalSearch] = useState('');
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setIsDark(savedTheme === 'dark');
    }
  }, []);

  const fetchReports = async (search = '') => {
    setLoading(true);
    try {
      const res = await axios.get('/api/reports', { params: { search: search || undefined, sort_by: sortBy } });
      setReports(res.data);
    } catch (err) {
      message.error('获取报告列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchReports(searchText !== undefined ? searchText : localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [sortBy, searchText]);

  const handleCreate = async (useTemplate) => {
    try {
      const values = await form.validateFields();
      await axios.post('/api/reports', { title: values.title, use_template: useTemplate });
      message.success('创建成功');
      setCreateModalVisible(false);
      form.resetFields();
      fetchReports();
    } catch (err) {
      message.error(err.response?.data?.error || '创建失败');
    }
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(`/api/reports/${id}`);
      message.success('删除成功');
      fetchReports();
    } catch (err) {
      message.error('删除失败');
    }
  };

  const openEditor = (report, mode) => {
    setSelectedReport(report);
    setEditorMode(mode);
    setEditorVisible(true);
  };

  const handleExport = async (report, type) => {
    try {
      const res = await axios.get(`/api/export/report/${report.id}/${type}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${report.title}.${type}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      message.success('导出成功');
    } catch (err) {
      message.error('导出失败');
    }
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
          探索报告
        </Title>
        <Space wrap style={{ justifyContent: 'flex-start' }}>
          <Select
            style={{ width: 130 }}
            value={sortBy}
            onChange={setSortBy}
          >
            <Option value="modified_at">修改时间</Option>
            <Option value="created_at">创建时间</Option>
            <Option value="title">标题</Option>
          </Select>
          <Button type="primary" size="large" icon={<PlusOutlined />} onClick={() => setCreateModalVisible(true)}>
            新建报告
          </Button>
        </Space>
      </div>

      {/* 搜索栏 */}
      {searchText === undefined && (
        <div style={{ marginBottom: 20 }}>
          <Input
            placeholder="搜索报告..."
            prefix={<span style={{ color: isDark ? '#64748b' : '#9ca3af' }}>🔍</span>}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
          />
        </div>
      )}

      {/* 卡片列表 */}
      {reports.length === 0 ? (
        <Empty
          description="还没有报告，点击上方按钮创建"
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
            lg: 2,
            xl: 3,
            xxl: 3,
          }}
          loading={loading}
          dataSource={reports}
          renderItem={(item) => (
            <List.Item style={{ display: 'block' }}>
              {/* 新的卡片设计 */}
              <div
                style={{
                  background: isDark ? '#0f172a' : '#ffffff',
                  borderRadius: 14,
                  padding: 20,
                  cursor: 'pointer',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                  border: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
                  boxShadow: isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.06)',
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                }}
                onClick={() => openEditor(item, 'view')}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = isDark ? '0 10px 25px -15px rgba(0,0,0,0.5)' : '0 10px 25px -15px rgba(0,0,0,0.12)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.06)';
                }}
              >
                {/* 标题 */}
                <div style={{
                  fontSize: 16,
                  fontWeight: 600,
                  marginBottom: 10,
                  color: isDark ? '#f1f5f9' : '#111827',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {item.title}
                </div>

                {/* 预览内容 */}
                <div style={{
                  fontSize: 13,
                  color: isDark ? '#94a3b8' : '#6b7280',
                  marginBottom: 16,
                  lineHeight: 1.5,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  flex: 1,
                }}>
                  {item.content || '还没有内容...'}
                </div>

                {/* 底部信息 */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: 'auto',
                }}>
                  <div style={{
                    fontSize: 12,
                    color: isDark ? '#64748b' : '#9ca3af',
                  }}>
                    {dayjs(item.modified_at).format('MM月DD日')}
                  </div>

                  {/* 标签和操作 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {item.document_count > 0 && (
                      <Tag color={isDark ? 'blue' : 'indigo'} style={{
                        fontSize: 11,
                        borderRadius: 6,
                        paddingInline: 8,
                      }}>
                        <FilePdfOutlined /> {item.document_count}
                      </Tag>
                    )}

                    <Space size="small" onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EyeOutlined />}
                        style={{ color: isDark ? '#94a3b8' : '#6b7280' }}
                        onClick={() => openEditor(item, 'view')}
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        style={{ color: isDark ? '#94a3b8' : '#6b7280' }}
                        onClick={() => openEditor(item, 'edit')}
                      />
                      <Popconfirm
                        title="确定删除？"
                        onConfirm={() => handleDelete(item.id)}
                        okText="确定"
                        cancelText="取消"
                      >
                        <Button
                          type="text"
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

      {/* 创建弹窗 */}
      <Modal
        title="创建新报告"
        open={createModalVisible}
        onOk={() => handleCreate(true)}
        onCancel={() => setCreateModalVisible(false)}
        centered
        width={window.innerWidth < 768 ? '90%' : 480}
        okText="使用模板创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="报告标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input placeholder="例如：植物生长观察" size="large" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑器 */}
      <ReportEditor
        visible={editorVisible}
        onCancel={() => setEditorVisible(false)}
        report={selectedReport}
        mode={editorMode}
        onSave={() => { setEditorVisible(false); fetchReports(); }}
      />
    </div>
  );
}

export default Reports;
