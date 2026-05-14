import React, { useState, useEffect } from 'react';
import { Modal, Form, Input, Button, Space, List, message, Checkbox } from 'antd';
import { SaveOutlined, FileTextOutlined } from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;

function ReportEditor({ visible, onCancel, report, mode, onSave }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [linkedDocuments, setLinkedDocuments] = useState([]);

  const isView = mode === 'view';

  useEffect(() => {
    if (visible && report) {
      loadReportData();
      loadAllDocuments();
    }
  }, [visible, report]);

  const loadReportData = async () => {
    try {
      const res = await axios.get(`/api/reports/${report.id}`);
      form.setFieldsValue({
        title: res.data.title,
        content: res.data.content,
      });
      setLinkedDocuments(res.data.documents || []);
    } catch (err) {
      message.error('加载报告失败');
    }
  };

  const loadAllDocuments = async () => {
    try {
      const res = await axios.get('/api/documents');
      setDocuments(res.data);
    } catch (err) {
      message.error('加载文献失败');
    }
  };

  const handleSave = async () => {
    try {
      setLoading(true);
      const values = await form.validateFields();
      await axios.put(`/api/reports/${report.id}`, values);
      await axios.post(`/api/reports/${report.id}/documents`, {
        document_ids: linkedDocuments.map(d => d.id),
      });
      message.success('保存成功');
      onSave();
    } catch (err) {
      message.error(err.response?.data?.error || '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (type) => {
    try {
      const res = await axios.get(`/api/export/report/${report.id}/${type}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `${form.getFieldValue('title')}.${type}`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      message.success('导出成功');
    } catch (err) {
      message.error('导出失败');
    }
  };

  const toggleDocument = (doc) => {
    const isLinked = linkedDocuments.some(d => d.id === doc.id);
    if (isLinked) {
      setLinkedDocuments(linkedDocuments.filter(d => d.id !== doc.id));
    } else {
      setLinkedDocuments([...linkedDocuments, doc]);
    }
  };

  const isDocLinked = (docId) => linkedDocuments.some(d => d.id === docId);

  return (
    <Modal
      title={isView ? '查看报告' : '编辑报告'}
      open={visible}
      onCancel={onCancel}
      width={window.innerWidth < 768 ? '95%' : 800}
      footer={isView ? null : [
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="save" type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={loading}>
          保存
        </Button>,
      ]}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="title"
          label="报告标题"
          rules={[{ required: true, message: '请输入标题' }]}
        >
          <Input placeholder="请输入标题" disabled={isView} size="large" />
        </Form.Item>

        <Form.Item name="content" label="报告内容">
          <TextArea
            rows={window.innerWidth < 768 ? 12 : 15}
            placeholder="请输入报告内容"
            disabled={isView}
            style={{ resize: 'none', fontSize: 14 }}
          />
        </Form.Item>

        {!isView && (
          <Form.Item label="关联文献">
            {documents.length === 0 ? (
              <div style={{ color: '#999', fontSize: 12 }}>
                暂无文献，请先在文献库上传 PDF
              </div>
            ) : (
              <List
                size="small"
                dataSource={documents}
                style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}
                renderItem={(item) => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Checkbox
                      checked={isDocLinked(item.id)}
                      onChange={() => toggleDocument(item)}
                    >
                      {item.name}
                    </Checkbox>
                  </List.Item>
                )}
              />
            )}
          </Form.Item>
        )}

        {isView && linkedDocuments.length > 0 && (
          <Form.Item label="关联文献">
            <List
              size="small"
              dataSource={linkedDocuments}
              style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 8, padding: 8 }}
              renderItem={(item) => (
                <List.Item style={{ padding: '4px 0' }}>
                  <a href={`/api/documents/${item.id}/file`} target="_blank" rel="noreferrer">
                    📄 {item.name}
                  </a>
                </List.Item>
              )}
            />
          </Form.Item>
        )}

        {!isView && (
          <Form.Item>
            <Space wrap>
              <Button icon={<FileTextOutlined />} onClick={() => handleExport('txt')}>
                导出 TXT
              </Button>
              <Button icon={<FileTextOutlined />} onClick={() => handleExport('docx')}>
                导出 DOCX
              </Button>
            </Space>
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

export default ReportEditor;
