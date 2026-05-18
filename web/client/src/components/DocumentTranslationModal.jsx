import React, { useState } from 'react';
import { Modal, Select, Button, Space, Spin, Typography, Divider, message, Alert } from 'antd';
import { TranslationOutlined, FileTextOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Text, Paragraph } = Typography;
const { Option } = Select;

function DocumentTranslationModal({ visible, onCancel, document, isDark }) {
  const [targetLang, setTargetLang] = useState('zh');
  const [translatedContent, setTranslatedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleTranslate = async () => {
    if (!document) {
      message.error('文档不存在');
      return;
    }

    setLoading(true);
    setError('');
    setTranslatedContent('');

    try {
      const res = await axios.post('/api/translate/document', {
        documentId: document.id,
        targetLang: targetLang,
      });

      setTranslatedContent(res.data.translatedContent);
      message.success('文档翻译成功');
    } catch (err) {
      const errorMsg = err.response?.data?.error || '翻译失败';
      setError(errorMsg);
      message.error(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setTranslatedContent('');
    setError('');
    onCancel();
  };

  if (!document) return null;

  return (
    <Modal
      title={
        <Space>
          <TranslationOutlined />
          <span>翻译文档</span>
        </Space>
      }
      open={visible}
      onCancel={handleClose}
      footer={null}
      width={800}
      style={{ top: 100 }}
      bodyStyle={{
        background: isDark ? '#1f2937' : '#ffffff',
        padding: 24,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ color: isDark ? '#f9fafb' : '#111827' }}>
          文档：{document.name}
        </Text>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ color: isDark ? '#f9fafb' : '#111827', marginRight: 12 }}>
          目标语言：
        </Text>
        <Select
          value={targetLang}
          onChange={setTargetLang}
          style={{ width: 200 }}
          size="large"
        >
          <Option value="zh">中文</Option>
          <Option value="en">English (英文)</Option>
          <Option value="ja">日本語 (日文)</Option>
          <Option value="ko">한국어 (韩文)</Option>
          <Option value="fr">Français (法文)</Option>
          <Option value="de">Deutsch (德文)</Option>
          <Option value="es">Español (西班牙文)</Option>
          <Option value="ru">Русский (俄文)</Option>
        </Select>

        <Button
          type="primary"
          onClick={handleTranslate}
          loading={loading}
          style={{ marginLeft: 12 }}
          size="large"
          icon={<TranslationOutlined />}
        >
          开始翻译
        </Button>
      </div>

      {error && (
        <Alert
          message="翻译失败"
          description={error}
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Divider style={{ margin: '16px 0' }} />

      <div>
        <Text strong style={{ color: isDark ? '#f9fafb' : '#111827' }}>
          翻译结果：
        </Text>

        {loading ? (
          <div
            style={{
              padding: 32,
              background: isDark ? '#111827' : '#f8f9fa',
              borderRadius: 8,
              textAlign: 'center',
            }}
          >
            <Spin size="large" />
            <div style={{ marginTop: 12, color: isDark ? '#9ca3af' : '#6b7280' }}>
              正在翻译文档，请稍候...
            </div>
          </div>
        ) : translatedContent ? (
          <div
            style={{
              padding: 16,
              background: isDark ? '#111827' : '#f8f9fa',
              borderRadius: 8,
              maxHeight: 400,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            <Paragraph style={{ color: isDark ? '#f9fafb' : '#111827', margin: 0 }}>
              {translatedContent}
            </Paragraph>
          </div>
        ) : (
          <div
            style={{
              padding: 32,
              background: isDark ? '#111827' : '#f8f9fa',
              borderRadius: 8,
              textAlign: 'center',
              color: isDark ? '#6b7280' : '#9ca3af',
            }}
          >
            点击"开始翻译"按钮翻译文档内容
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Button onClick={handleClose}>关闭</Button>
      </div>
    </Modal>
  );
}

export default DocumentTranslationModal;
