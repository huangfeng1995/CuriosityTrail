import React, { useState, useEffect } from 'react';
import {
  List,
  Button,
  Space,
  Input,
  Select,
  Card,
  Modal,
  Form,
  message,
  Popconfirm,
  Tag,
  Empty
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  EyeOutlined,
  DeleteOutlined,
  FileTextOutlined,
  FilePdfOutlined,
  SearchOutlined
} from '@ant-design/icons';
import dayjs from 'dayjs';
import axios from 'axios';
import ReportEditor from './ReportEditor';

const { Option } = Select;

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
      fetchReports(searchText !== false ? searchText : localSearch);
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
            📝 探索报告
            <span style={{ fontSize: 14, color: '#999', fontWeight: 'normal' }}>
              ({reports.length})
            </span>
          </h2>
          <Space wrap style={{ justifyContent: window.innerWidth < 768 ? 'center' : 'flex-end' }}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalVisible(true)}>
              新建报告
            </Button>
          </Space>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Input
            placeholder="搜索报告..."
            prefix={<SearchOutlined />}
            style={{ flex: 1, minWidth: 200 }}
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            allowClear
          />
          <Select
            style={{ width: 140 }}
            value={sortBy}
            onChange={setSortBy}
          >
            <Option value="modified_at">修改时间</Option>
            <Option value="created_at">创建时间</Option>
            <Option value="title">标题</Option>
          </Select>
        </div>

        {reports.length === 0 ? (
          <Empty description="暂无报告，点击上方按钮创建" />
        ) : (
          <List
            grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 3 }}
            loading={loading}
            dataSource={reports}
            renderItem={(item) => (
              <List.Item style={{ display: 'block' }}>
                <Card
                  hoverable
                  style={{ height: '100%' }}
                  actions={[
                    <EyeOutlined key="view" onClick={() => openEditor(item, 'view')} />,
                    <EditOutlined key="edit" onClick={() => openEditor(item, 'edit')} />,
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
                    title={
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1
                        }}>{item.title}</span>
                      </div>
                    }
                    description={
                      <>
                        <div style={{ fontSize: 12, color: '#999', marginBottom: 8 }}>
                          {dayjs(item.modified_at).format('YYYY-MM-DD HH:mm')}
                        </div>
                        <Tag color="blue" icon={<FilePdfOutlined />}>
                          {item.document_count} 篇关联
                        </Tag>
                      </>
                    }
                  />
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    <Button size="small" icon={<FileTextOutlined />} onClick={() => handleExport(item, 'txt')}>
                      TXT
                    </Button>
                    <Button size="small" icon={<FileTextOutlined />} onClick={() => handleExport(item, 'docx')}>
                      DOCX
                    </Button>
                  </div>
                </Card>
              </List.Item>
            )}
          />
        )}
      </Space>

      <Modal
        title="新建报告"
        open={createModalVisible}
        onOk={() => handleCreate(true)}
        onCancel={() => setCreateModalVisible(false)}
        width={window.innerWidth < 768 ? '95%' : 500}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="报告标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input placeholder="请输入报告标题" />
          </Form.Item>
          <div style={{ fontSize: 12, color: '#999' }}>
            点击确定将使用科学探究模板创建报告
          </div>
        </Form>
      </Modal>

      <ReportEditor
        visible={editorVisible}
        onCancel={() => setEditorVisible(false)}
        report={selectedReport}
        mode={editorMode}
        onSave={() => { setEditorVisible(false); fetchReports(); }}
      />
    </>
  );
}

export default Reports;
