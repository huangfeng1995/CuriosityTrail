import React, { useState, useEffect, useCallback } from 'react';
import { Modal, Form, Input, Button, Space, List, message, Checkbox, Typography } from 'antd';
import { X, Clock } from 'lucide-react';
import { SaveOutlined, FileTextOutlined } from '@ant-design/icons';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const { TextArea } = Input;
const { Title } = Typography;

function ReportEditor({ visible, onCancel, report, mode, isDark, onSave }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [linkedDocuments, setLinkedDocuments] = useState([]);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [lastSaved, setLastSaved] = useState(null);
  const [showPreview, setShowPreview] = useState(false);

  const isView = mode === 'view';

  useEffect(() => {
    if (visible && report) {
      loadReportData();
      loadAllDocuments();
    }
  }, [visible, report]);

  useEffect(() => {
    let timeout;
    const handleAutoSave = async () => {
      if (!isView && report) {
        try {
          const values = form.getFieldsValue();
          if (values.title || values.content) {
            setSaveStatus('saving');
            await axios.put(`/api/reports/${report.id}`, values);
            setSaveStatus('saved');
            setLastSaved(new Date());
          }
        } catch (err) {
          setSaveStatus('saved');
        }
      }
    };

    form.watch(() => {
      clearTimeout(timeout);
      timeout = setTimeout(handleAutoSave, 2000);
    });

    return () => clearTimeout(timeout);
  }, [form, isView, report]);

  const loadReportData = async () => {
    try {
      const res = await axios.get(`/api/reports/${report.id}`);
      form.setFieldsValue({
        title: res.data.title,
        content: res.data.content,
      });
      setLinkedDocuments(res.data.documents || []);
      setLastSaved(new Date(res.data.modified_at));
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
      setSaveStatus('saved');
      setLastSaved(new Date());
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
      link.setAttribute('download', `${form.getFieldValue('title') || 'report'}.${type}`);
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

  const WORD_COUNT = form.getFieldValue('content')?.length || 0;
  const READ_TIME = Math.ceil(WORD_COUNT / 300);

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <Title level={3} style={{ 
            margin: 0, 
            fontSize: 18,
            color: isDark ? '#f9fafb' : '#111827',
            fontFamily: 'Noto Serif SC, serif',
          }}>
            {isView ? '查看报告' : '编辑报告'}
          </Title>
          {!isView && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {window.innerWidth > 768 && (
                <Button
                  type={showPreview ? 'primary' : 'text'}
                  size="small"
                  onClick={() => setShowPreview(!showPreview)}
                  style={{
                    color: showPreview ? (isDark ? '#f9fafb' : '#ffffff') : (isDark ? '#9ca3af' : '#6b7280'),
                  }}
                >
                  {showPreview ? '编辑' : '预览'}
                </Button>
              )}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: saveStatus === 'saving' ? '#f59e0b' : (isDark ? '#6b7280' : '#9ca3af'),
              }}>
                {saveStatus === 'saving' ? (
                  <>
                    <Clock size={12} style={{ animation: 'spin 1s linear infinite' }} />
                    <span>保存中...</span>
                  </>
                ) : lastSaved ? (
                  <>
                    <span>✓ 已保存</span>
                    <span style={{ color: isDark ? '#4b5563' : '#d1d5db' }}>
                      {lastSaved.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      }
      open={visible}
      onCancel={onCancel}
      width={window.innerWidth < 768 ? '95%' : 900}
      footer={isView ? null : [
        <Button key="cancel" onClick={onCancel}>取消</Button>,
        <Button key="save" type="primary" icon={<SaveOutlined size={16} />} onClick={handleSave} loading={loading}>
          保存更改
        </Button>,
      ]}
      style={{ borderRadius: 12 }}
    >
      <div style={{ background: isDark ? '#0f172a' : '#f8f9fa', borderRadius: 12, padding: window.innerWidth < 768 ? 16 : 24 }}>
        <Form form={form} layout="vertical">
          <Form.Item
            name="title"
            label="报告标题"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input 
              placeholder="请输入标题" 
              disabled={isView} 
              size="large"
              style={{
                borderRadius: 8,
                background: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                fontSize: 16,
                fontWeight: 600,
                fontFamily: 'Noto Serif SC, serif',
              }}
            />
          </Form.Item>

          {!isView && !showPreview && (
            <div style={{ marginBottom: 16, fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af' }}>
              {WORD_COUNT} 字 · 约 {READ_TIME} 分钟阅读
            </div>
          )}

          <Form.Item name="content" label={!isView && !showPreview ? '报告内容' : null}>
            {isView || showPreview ? (
              <div 
                style={{
                  minHeight: 400,
                  background: isDark ? '#1f2937' : '#ffffff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: 8,
                  padding: 20,
                  fontSize: 15,
                  lineHeight: 1.8,
                  color: isDark ? '#f9fafb' : '#111827',
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {form.getFieldValue('content') || '*暂无内容*'}
                </ReactMarkdown>
              </div>
            ) : (
              <TextArea
                rows={18}
                placeholder="请输入报告内容，支持 Markdown 格式...

**科学探究模板：**

1. 探索主题
2. 背景介绍
3. 提出问题
4. 猜想与假设
5. 实验材料与工具
6. 实验步骤
7. 实验数据与现象
8. 分析与结论
9. 反思与改进
10. 参考文献"
                disabled={isView}
                style={{ 
                  resize: 'none', 
                  fontSize: 14,
                  lineHeight: 1.6,
                  borderRadius: 8,
                  background: isDark ? '#1f2937' : '#ffffff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                }}
              />
            )}
          </Form.Item>

          {!isView && (
            <Form.Item label="关联文献">
              {documents.length === 0 ? (
                <div style={{ 
                  padding: 16, 
                  background: isDark ? '#1f2937' : '#f8f9fa',
                  borderRadius: 8,
                  textAlign: 'center',
                  color: isDark ? '#6b7280' : '#9ca3af',
                  fontSize: 13,
                }}>
                  暂无文献，请先在文献库上传 PDF
                </div>
              ) : (
                <div style={{ 
                  maxHeight: 220, 
                  overflow: 'auto', 
                  background: isDark ? '#1f2937' : '#ffffff',
                  borderRadius: 8,
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  padding: 8,
                }}>
                  <List
                    size="small"
                    dataSource={documents}
                    renderItem={(item) => (
                      <List.Item style={{ padding: '6px 12px', borderRadius: 6 }}>
                        <Checkbox
                          checked={isDocLinked(item.id)}
                          onChange={() => toggleDocument(item)}
                          style={{ color: isDark ? '#d1d5db' : '#374151' }}
                        >
                          <span style={{ 
                            color: isDark ? '#d1d5db' : '#374151',
                            fontSize: 14,
                          }}>
                            {item.name}
                          </span>
                        </Checkbox>
                      </List.Item>
                    )}
                  />
                </div>
              )}
            </Form.Item>
          )}

          {isView && linkedDocuments.length > 0 && (
            <Form.Item label="关联文献">
              <div style={{ 
                maxHeight: 220, 
                overflow: 'auto', 
                background: isDark ? '#1f2937' : '#ffffff',
                borderRadius: 8,
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                padding: 8,
              }}>
                <List
                  size="small"
                  dataSource={linkedDocuments}
                  renderItem={(item) => (
                    <List.Item style={{ padding: '6px 12px' }}>
                      <a 
                        href={`/api/documents/${item.id}/file`} 
                        target="_blank" 
                        rel="noreferrer"
                        style={{ 
                          color: isDark ? '#60a5fa' : '#1e3a5f',
                          textDecoration: 'none',
                          fontSize: 14,
                        }}
                      >
                        <FileTextOutlined size={14} style={{ marginRight: 8 }} />
                        {item.name}
                      </a>
                    </List.Item>
                  )}
                />
              </div>
            </Form.Item>
          )}

          {!isView && (
            <Form.Item style={{ marginTop: 8 }}>
              <Space wrap>
                <Button 
                  icon={<FileTextOutlined size={16} />} 
                  onClick={() => handleExport('txt')}
                  style={{ borderRadius: 6 }}
                >
                  导出 TXT
                </Button>
                <Button 
                  icon={<FileTextOutlined size={16} />} 
                  onClick={() => handleExport('docx')}
                  style={{ borderRadius: 6 }}
                >
                  导出 DOCX
                </Button>
              </Space>
            </Form.Item>
          )}
        </Form>
      </div>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Modal>
  );
}

export default ReportEditor;
