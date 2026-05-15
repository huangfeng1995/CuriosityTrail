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
  Card,
  Switch,
} from 'antd';
import { Calendar } from 'lucide-react';
import {
  PlusOutlined,
  EditOutlined,
  EyeOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FilePdfOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import ReportEditor from './ReportEditor';

const { Option } = Select;
const { Title, Text } = Typography;

function Reports({ searchText, isDark }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sortBy, setSortBy] = useState('modified_at');
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const [editorVisible, setEditorVisible] = useState(false);
  const [editorMode, setEditorMode] = useState('view');
  const [form] = Form.useForm();
  const [localSearch, setLocalSearch] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('scientific');

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

  const handleCreate = async () => {
    try {
      const values = await form.validateFields();
      await axios.post('/api/reports', { title: values.title, template: selectedTemplate });
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
            fontFamily: 'Noto Serif SC, serif',
          }}>
            探索报告
          </Title>
          <div style={{
            fontSize: 14,
            color: isDark ? '#6b7280' : '#9ca3af',
            marginTop: 4,
          }}>
            共 {reports.length} 篇报告
          </div>
        </div>
        <Space wrap style={{ justifyContent: 'flex-start' }}>
          <Select
            style={{ width: 140 }}
            value={sortBy}
            onChange={setSortBy}
            variant="borderless"
            styles={{
              popup: {
                background: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              },
            }}
          >
            <Option value="modified_at">修改时间</Option>
            <Option value="created_at">创建时间</Option>
            <Option value="title">标题</Option>
          </Select>
          <Button 
            type="primary" 
            size="large" 
            icon={<PlusOutlined size={18} />}
            onClick={() => setCreateModalVisible(true)}
            data-create-report
            style={{ 
              borderRadius: 8,
              fontWeight: 600,
              padding: '8px 20px',
            }}
          >
            新建报告
          </Button>
        </Space>
      </div>

      {searchText === undefined && (
        <div style={{ marginBottom: 20 }}>
          <Input
            placeholder="搜索报告..."
            prefix={<span style={{ color: isDark ? '#6b7280' : '#9ca3af', marginRight: 8 }}>🔍</span>}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
            style={{
              borderRadius: 10,
              height: 42,
              background: isDark ? '#1f2937' : '#ffffff',
              border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
            }}
          />
        </div>
      )}

      {reports.length === 0 ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '60px 0',
        }}>
          <div style={{
            width: 100,
            height: 100,
            borderRadius: 20,
            background: isDark ? '#1f2937' : '#f8f9fa',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
          }}>
            <FileTextOutlined size={40} style={{ color: isDark ? '#4b5563' : '#d1d5db' }} />
          </div>
          <Title level={4} style={{
            margin: 0,
            color: isDark ? '#9ca3af' : '#6b7280',
            fontSize: 18,
            fontWeight: 500,
          }}>
            暂无报告
          </Title>
          <Text style={{
            color: isDark ? '#6b7280' : '#9ca3af',
            marginTop: 8,
          }}>
            点击上方按钮创建第一篇探索报告
          </Text>
        </div>
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
              <Card
                hoverable
                onClick={() => openEditor(item, 'view')}
                style={{
                  background: isDark ? '#1f2937' : '#ffffff',
                  borderRadius: 12,
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  boxShadow: isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.04)',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                bodyStyle={{ padding: 20 }}
              >
                <div style={{
                  fontSize: 16,
                  fontWeight: 600,
                  marginBottom: 12,
                  color: isDark ? '#f9fafb' : '#111827',
                  fontFamily: 'Noto Serif SC, serif',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {item.title}
                </div>

                <div style={{
                  fontSize: 14,
                  color: isDark ? '#9ca3af' : '#6b7280',
                  lineHeight: 1.6,
                  marginBottom: 16,
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  minHeight: '44px',
                }}>
                  {item.content ? item.content.substring(0, 100) + (item.content.length > 100 ? '...' : '') : '还没有内容...'}
                </div>

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingTop: 12,
                  borderTop: `1px solid ${isDark ? '#374151' : '#f3f4f6'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Calendar size={14} style={{ color: isDark ? '#6b7280' : '#9ca3af' }} />
                      <span style={{
                        fontSize: 12,
                        color: isDark ? '#6b7280' : '#9ca3af',
                      }}>
                        {dayjs(item.modified_at).format('YYYY-MM-DD')}
                      </span>
                    </div>
                    {item.document_count > 0 && (
                      <Tag color={isDark ? 'blue' : 'indigo'} style={{
                        fontSize: 11,
                        borderRadius: 6,
                        padding: '2px 8px',
                      }}>
                        <FilePdfOutlined size={12} style={{ marginRight: 4 }} />
                        {item.document_count}
                      </Tag>
                    )}
                  </div>

                  <Space size="small" onClick={(e) => e.stopPropagation()}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EyeOutlined size={14} />}
                      onClick={() => openEditor(item, 'view')}
                      style={{ 
                        color: isDark ? '#9ca3af' : '#6b7280',
                        padding: '4px 10px',
                      }}
                    />
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined size={14} />}
                      onClick={() => openEditor(item, 'edit')}
                      style={{ 
                        color: isDark ? '#9ca3af' : '#6b7280',
                        padding: '4px 10px',
                      }}
                    />
                    <Popconfirm
                      title="确定删除？"
                      onConfirm={() => handleDelete(item.id)}
                      okText="确定"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined size={14} />}
                        style={{ padding: '4px 10px' }}
                      />
                    </Popconfirm>
                  </Space>
                </div>
              </Card>
            </List.Item>
          )}
        />
      )}

      <Modal
        title="创建新报告"
        open={createModalVisible}
        onOk={handleCreate}
        onCancel={() => setCreateModalVisible(false)}
        centered
        width={window.innerWidth < 768 ? '90%' : 520}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="报告标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input 
              placeholder="例如：植物生长观察报告" 
              size="large"
              style={{ borderRadius: 8 }}
            />
          </Form.Item>
          <Form.Item
            name="template"
            label="选择模板"
          >
            <Select
              value={selectedTemplate}
              onChange={setSelectedTemplate}
              size="large"
              style={{ borderRadius: 8, width: '100%' }}
            >
              <Option value="none">空白模板</Option>
              <Option value="scientific">科学探究模板</Option>
              <Option value="synthesis">综合调研模板</Option>
            </Select>
          </Form.Item>
          <Form.Item>
            <div style={{
              fontSize: 12,
              color: isDark ? '#6b7280' : '#9ca3af',
            }}>
              {selectedTemplate === 'scientific' && (
                <span>科学探究模板包含：探索主题、背景介绍、关键概念定义、提出问题、猜想与假设、实验材料与工具、实验步骤、实验数据与现象、分析与结论、边界条件与适用范围、反例与例外、反思与改进、参考文献</span>
              )}
              {selectedTemplate === 'synthesis' && (
                <span>综合调研模板包含：初级调研（读懂对象）、中级调研（读懂争论）、高级调研（读出新问题）、所以呢？（结论与行动指南）</span>
              )}
              {selectedTemplate === 'none' && (
                <span>从空白开始撰写报告</span>
              )}
            </div>
          </Form.Item>
        </Form>
      </Modal>

      <ReportEditor
        visible={editorVisible}
        onCancel={() => setEditorVisible(false)}
        report={selectedReport}
        mode={editorMode}
        isDark={isDark}
        onSave={() => { setEditorVisible(false); fetchReports(); }}
      />
    </div>
  );
}

export default Reports;
