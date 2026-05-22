import React, { useState, useEffect, useRef } from 'react';
import { 
  Modal, Form, Input, Button, Space, List, message, Checkbox, Typography,
  Card, Row, Col, Upload, Image, Tooltip, Divider, Select
} from 'antd';
import { 
  SaveOutlined, FileTextOutlined, TranslationOutlined, PlusOutlined,
  DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined, PictureOutlined,
  FontSizeOutlined, AlignLeftOutlined, AlignCenterOutlined, AlignRightOutlined,
  BoldOutlined, ItalicOutlined, UnderlineOutlined, LinkOutlined
} from '@ant-design/icons';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import TranslationModal from './TranslationModal';

const { TextArea } = Input;
const { Title } = Typography;

const BLOCK_TYPES = [
  { type: 'heading', label: '标题', icon: FontSizeOutlined },
  { type: 'paragraph', label: '正文', icon: FileTextOutlined },
  { type: 'image', label: '图片', icon: PictureOutlined },
  { type: 'reference', label: '文献参考', icon: LinkOutlined },
];

const FONT_SIZES = [
  { value: 12, label: '12px' },
  { value: 14, label: '14px' },
  { value: 16, label: '16px' },
  { value: 18, label: '18px' },
  { value: 20, label: '20px' },
  { value: 24, label: '24px' },
  { value: 32, label: '32px' },
];

function ReportEditor({ visible, onCancel, report, mode, isDark, onSave }) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [linkedDocuments, setLinkedDocuments] = useState([]);
  const [showPreview, setShowPreview] = useState(false);
  const [translationModalVisible, setTranslationModalVisible] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [blocks, setBlocks] = useState([]);
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [columnLayout, setColumnLayout] = useState('single'); // single, double
  const [showDocSelector, setShowDocSelector] = useState(false);
  const [currentRefBlockId, setCurrentRefBlockId] = useState(null);
  const fileInputRef = useRef(null);

  const isView = mode === 'view';

  useEffect(() => {
    if (visible && report) {
      loadReportData();
      loadAllDocuments();
    }
  }, [visible, report]);

  useEffect(() => {
    if (blocks.length === 0 && !isView) {
      setBlocks([
        { id: '1', type: 'heading', content: '报告标题', fontSize: 24, fontWeight: 'bold' },
        { id: '2', type: 'paragraph', content: '开始编写你的报告内容...', fontSize: 14 },
      ]);
    }
  }, [visible]);

  const loadReportData = async () => {
    try {
      const res = await axios.get(`/api/reports/${report.id}`);
      form.setFieldsValue({
        title: res.data.title,
      });
      setLinkedDocuments(res.data.documents || []);
      
      if (res.data.blocks) {
        setBlocks(res.data.blocks);
      } else if (res.data.content) {
        setBlocks([
          { id: '1', type: 'paragraph', content: res.data.content, fontSize: 14 },
        ]);
      }
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
      await axios.put(`/api/reports/${report.id}`, {
        ...values,
        blocks: blocks,
        content: blocks.map(b => b.content).join('\n\n'),
      });
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

  const addBlock = (type, afterId = null) => {
    const newId = Date.now().toString();
    const newBlock = {
      id: newId,
      type: type,
      content: '',
      fontSize: type === 'heading' ? 20 : 14,
      fontWeight: type === 'heading' ? 'bold' : 'normal',
      textAlign: 'left',
    };
    
    if (afterId) {
      const index = blocks.findIndex(b => b.id === afterId);
      const newBlocks = [...blocks];
      newBlocks.splice(index + 1, 0, newBlock);
      setBlocks(newBlocks);
    } else {
      setBlocks([...blocks, newBlock]);
    }
    setSelectedBlockId(newId);
  };

  const updateBlock = (id, updates) => {
    setBlocks(blocks.map(b => b.id === id ? { ...b, ...updates } : b));
  };

  const deleteBlock = (id) => {
    if (blocks.length <= 1) {
      message.warning('至少保留一个内容块');
      return;
    }
    setBlocks(blocks.filter(b => b.id !== id));
    if (selectedBlockId === id) {
      setSelectedBlockId(null);
    }
  };

  const moveBlock = (id, direction) => {
    const index = blocks.findIndex(b => b.id === id);
    if (direction === 'up' && index > 0) {
      const newBlocks = [...blocks];
      [newBlocks[index], newBlocks[index - 1]] = [newBlocks[index - 1], newBlocks[index]];
      setBlocks(newBlocks);
    } else if (direction === 'down' && index < blocks.length - 1) {
      const newBlocks = [...blocks];
      [newBlocks[index], newBlocks[index + 1]] = [newBlocks[index + 1], newBlocks[index]];
      setBlocks(newBlocks);
    }
  };

  const handleImageUpload = async (e, blockId) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('image', file);

    try {
      setLoading(true);
      const res = await axios.post('/api/upload/image', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      updateBlock(blockId, { content: res.data.url, imageName: file.name });
      message.success('图片上传成功');
    } catch (err) {
      message.error('图片上传失败');
    } finally {
      setLoading(false);
      e.target.value = '';
    }
  };

  const generateMarkdown = () => {
    return blocks.map(block => {
      if (block.type === 'heading') {
        const level = Math.min(Math.floor(block.fontSize / 8), 6);
        return `${'#'.repeat(level)} ${block.content}`;
      } else if (block.type === 'image') {
        return `![${block.imageName || '图片'}](${block.content})`;
      } else if (block.type === 'reference' && block.content) {
        const doc = documents.find(d => d.id === block.content);
        return `[^${block.id}]: ${doc?.name || block.content}`;
      }
      return block.content;
    }).join('\n\n');
  };

  const renderBlock = (block, index) => {
    const isSelected = selectedBlockId === block.id;
    
    return (
      <div
        key={block.id}
        onClick={() => !isView && setSelectedBlockId(block.id)}
        style={{
          marginBottom: 16,
          padding: isSelected ? 12 : 0,
          backgroundColor: isSelected && !isView ? (isDark ? '#334155' : '#e0f2fe') : 'transparent',
          borderRadius: isSelected ? 8 : 0,
          cursor: !isView ? 'pointer' : 'default',
        }}
      >
        <Row gutter={8}>
          {!isView && (
            <Col span={24}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: 8, 
                marginBottom: 8,
                opacity: isSelected ? 1 : 0.4
              }}>
                <Tooltip title="上移">
                  <Button 
                    icon={<ArrowUpOutlined />} 
                    size="small"
                    onClick={(e) => { e.stopPropagation(); moveBlock(block.id, 'up'); }}
                    disabled={index === 0}
                  />
                </Tooltip>
                <Tooltip title="下移">
                  <Button 
                    icon={<ArrowDownOutlined />} 
                    size="small"
                    onClick={(e) => { e.stopPropagation(); moveBlock(block.id, 'down'); }}
                    disabled={index === blocks.length - 1}
                  />
                </Tooltip>
                <Tooltip title="删除">
                  <Button 
                    icon={<DeleteOutlined />} 
                    size="small"
                    danger
                    onClick={(e) => { e.stopPropagation(); deleteBlock(block.id); }}
                  />
                </Tooltip>
                <Divider type="vertical" style={{ margin: '0 4px' }} />
                <Space>
                  {BLOCK_TYPES.map(({ type, label }) => (
                    <Button
                      key={type}
                      size="small"
                      type={block.type === type ? 'primary' : 'default'}
                      onClick={(e) => { e.stopPropagation(); updateBlock(block.id, { type }); }}
                    >
                      {label}
                    </Button>
                  ))}
                </Space>
              </div>
            </Col>
          )}
          
          <Col span={24}>
            {block.type === 'heading' ? (
              <Input
                value={block.content}
                onChange={(e) => updateBlock(block.id, { content: e.target.value })}
                disabled={isView}
                placeholder="输入标题..."
                style={{
                  fontSize: block.fontSize,
                  fontWeight: block.fontWeight,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  color: isDark ? '#f9fafb' : '#111827',
                  fontFamily: 'Noto Serif SC, serif',
                }}
              />
            ) : block.type === 'paragraph' ? (
              <TextArea
                value={block.content}
                onChange={(e) => updateBlock(block.id, { content: e.target.value })}
                disabled={isView}
                placeholder="输入正文内容..."
                autoSize={{ minRows: 3, maxRows: 6 }}
                style={{
                  fontSize: block.fontSize,
                  fontWeight: block.fontWeight,
                  fontStyle: block.fontStyle,
                  textDecoration: block.textDecoration,
                  textAlign: block.textAlign,
                  border: 'none',
                  outline: 'none',
                  resize: 'none',
                  background: 'transparent',
                  color: isDark ? '#d1d5db' : '#374151',
                  lineHeight: 1.8,
                }}
              />
            ) : block.type === 'image' ? (
              <div style={{ textAlign: 'center' }}>
                {block.content ? (
                  <Image
                    src={block.content}
                    alt={block.imageName}
                    style={{ maxWidth: '100%', borderRadius: 8 }}
                  />
                ) : (
                  <Card
                    size="small"
                    style={{ border: `2px dashed ${isDark ? '#4b5563' : '#d1d5db'}` }}
                    bodyStyle={{ textAlign: 'center', padding: 32 }}
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  >
                    <PictureOutlined style={{ fontSize: 48, color: isDark ? '#6b7280' : '#9ca3af' }} />
                    <p style={{ marginTop: 12, color: isDark ? '#9ca3af' : '#6b7280' }}>
                      点击上传图片
                    </p>
                    <input
                      ref={(el) => { if (el) fileInputRef.current = el; }}
                      type="file"
                      accept="image/*"
                      onChange={(e) => handleImageUpload(e, block.id)}
                      style={{ display: 'none' }}
                    />
                  </Card>
                )}
              </div>
            ) : block.type === 'reference' ? (
              <div style={{
                padding: 12,
                background: isDark ? '#1f2937' : '#f8f9fa',
                borderRadius: 8,
                borderLeft: `3px solid ${isDark ? '#60a5fa' : '#1e40af'}`,
              }}>
                {block.content ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <FileTextOutlined style={{ color: isDark ? '#60a5fa' : '#1e40af' }} />
                    <span style={{ color: isDark ? '#d1d5db' : '#374151' }}>
                      {documents.find(d => d.id === block.content)?.name || '文献'}
                    </span>
                    {!isView && (
                      <Button size="small" onClick={(e) => { e.stopPropagation(); setCurrentRefBlockId(block.id); setShowDocSelector(true); }}>
                        更换
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button onClick={(e) => { e.stopPropagation(); setCurrentRefBlockId(block.id); setShowDocSelector(true); }}>
                    选择文献
                  </Button>
                )}
              </div>
            ) : null}
          </Col>
        </Row>
      </div>
    );
  };

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
            <Space>
              <Select
                value={columnLayout}
                onChange={setColumnLayout}
                style={{ width: 120 }}
                size="small"
              >
                <option value="single">单栏</option>
                <option value="double">双栏</option>
              </Select>
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
            </Space>
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
            <div style={{ marginBottom: 16 }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between',
                marginBottom: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Button 
                    icon={<PlusOutlined />} 
                    onClick={() => addBlock('paragraph')}
                    style={{ borderRadius: 6 }}
                  >
                    添加内容块
                  </Button>
                  <Space>
                    {BLOCK_TYPES.map(({ type, label, icon: Icon }) => (
                      <Tooltip key={type} title={label}>
                        <Button
                          icon={<Icon />}
                          onClick={() => addBlock(type)}
                          size="small"
                          style={{ borderRadius: 6 }}
                        />
                      </Tooltip>
                    ))}
                  </Space>
                </div>
                <Space>
                  <Tooltip title="加粗">
                    <Button 
                      icon={<BoldOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { fontWeight: 'bold' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Tooltip title="斜体">
                    <Button 
                      icon={<ItalicOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { fontStyle: 'italic' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Tooltip title="下划线">
                    <Button 
                      icon={<UnderlineOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { textDecoration: 'underline' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Divider type="vertical" style={{ margin: '0 4px' }} />
                  <Tooltip title="左对齐">
                    <Button 
                      icon={<AlignLeftOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { textAlign: 'left' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Tooltip title="居中">
                    <Button 
                      icon={<AlignCenterOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { textAlign: 'center' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Tooltip title="右对齐">
                    <Button 
                      icon={<AlignRightOutlined />} 
                      size="small" 
                      onClick={() => selectedBlockId && updateBlock(selectedBlockId, { textAlign: 'right' })}
                      disabled={!selectedBlockId}
                    />
                  </Tooltip>
                  <Divider type="vertical" style={{ margin: '0 4px' }} />
                  <Select
                    value={blocks.find(b => b.id === selectedBlockId)?.fontSize || 14}
                    onChange={(value) => selectedBlockId && updateBlock(selectedBlockId, { fontSize: value })}
                    style={{ width: 80 }}
                    size="small"
                    disabled={!selectedBlockId}
                  >
                    {FONT_SIZES.map(size => (
                      <option key={size.value} value={size.value}>{size.label}</option>
                    ))}
                  </Select>
                </Space>
              </div>
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
                  {generateMarkdown() || '*暂无内容*'}
                </ReactMarkdown>
              </div>
            ) : (
              <div style={{
                background: isDark ? '#1f2937' : '#ffffff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: 8,
                padding: 16,
                minHeight: 400,
              }}>
                {columnLayout === 'double' ? (
                  <Row gutter={16}>
                    <Col span={12}>
                      {blocks.filter((_, i) => i % 2 === 0).map((block, i) => renderBlock(block, i))}
                    </Col>
                    <Col span={12}>
                      {blocks.filter((_, i) => i % 2 === 1).map((block, i) => renderBlock(block, i))}
                    </Col>
                  </Row>
                ) : (
                  blocks.map((block, index) => renderBlock(block, index))
                )}
              </div>
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
                  icon={<TranslationOutlined size={16} />}
                  onClick={() => {
                    setSelectedText(blocks.map(b => b.content).join('\n\n'));
                    setTranslationModalVisible(true);
                  }}
                  style={{ borderRadius: 6 }}
                >
                  翻译全文
                </Button>
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

      <TranslationModal
        visible={translationModalVisible}
        onCancel={() => setTranslationModalVisible(false)}
        text={selectedText}
        title="翻译报告"
        isDark={isDark}
      />

      <Modal
        title="选择文献"
        open={showDocSelector}
        onCancel={() => setShowDocSelector(false)}
        footer={[
          <Button key="cancel" onClick={() => setShowDocSelector(false)}>取消</Button>,
        ]}
        width={500}
      >
        <div style={{ maxHeight: 300, overflow: 'auto' }}>
          <List
            size="small"
            dataSource={documents}
            renderItem={(item) => (
              <List.Item 
                style={{ 
                  padding: '12px', 
                  borderRadius: 8,
                  cursor: 'pointer',
                  hover: { background: isDark ? '#334155' : '#f1f5f9' }
                }}
                onClick={() => {
                  updateBlock(currentRefBlockId, { content: item.id });
                  setShowDocSelector(false);
                }}
              >
                <FileTextOutlined style={{ marginRight: 12, color: isDark ? '#60a5fa' : '#1e40af' }} />
                <span style={{ color: isDark ? '#d1d5db' : '#374151' }}>
                  {item.name}
                </span>
              </List.Item>
            )}
          />
        </div>
      </Modal>
    </Modal>
  );
}

export default ReportEditor;
