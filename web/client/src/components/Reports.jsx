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
  Tag 
} from 'antd';
import { 
  PlusOutlined, 
  EditOutlined, 
  EyeOutlined, 
  DeleteOutlined, 
  FileTextOutlined, 
  FilePdfOutlined 
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
    fetchReports(searchText);
  }, [searchText, sortBy]);

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
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>📝 探索报告</h2>
          <Space>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalVisible(true)}>
              新建模板报告
            </Button>
            <Button onClick={() => { form.setFieldsValue({ useTemplate: false }); setCreateModalVisible(true); }}>
              新建空白报告
            </Button>
          </Space>
        </div>

        <Select
          style={{ width: 150 }}
          value={sortBy}
          onChange={setSortBy}
        >
          <Option value="modified_at">按修改时间</Option>
          <Option value="created_at">按创建时间</Option>
          <Option value="title">按标题</Option>
        </Select>

        <List
          grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3, xxl: 3 }}
          loading={loading}
          dataSource={reports}
          renderItem={(item) => (
            <List.Item>
              <Card
                hoverable
                actions={[
                  <EyeOutlined key="view" onClick={() => openEditor(item, 'view')} />,
                  <EditOutlined key="edit" onClick={() => openEditor(item, 'edit')} />,
                  <FileTextOutlined key="txt" onClick={() => handleExport(item, 'txt')} />,
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
                  title={item.title}
                  description={
                    <>
                      <div style={{ marginBottom: 8 }}>
                        创建: {dayjs(item.created_at).format('YYYY-MM-DD HH:mm')}
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        修改: {dayjs(item.modified_at).format('YYYY-MM-DD HH:mm')}
                      </div>
                      <Tag color="blue">
                        <FilePdfOutlined /> {item.document_count} 篇关联文献
                      </Tag>
                    </>
                  }
                />
              </Card>
            </List.Item>
          )}
        />
      </Space>

      <Modal
        title="新建报告"
        open={createModalVisible}
        onOk={() => handleCreate(true)}
        onCancel={() => setCreateModalVisible(false)}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="报告标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input placeholder="请输入报告标题" />
          </Form.Item>
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
