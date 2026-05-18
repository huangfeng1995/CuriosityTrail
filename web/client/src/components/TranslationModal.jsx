import React, { useState } from 'react';
import { Modal, Select, Button, Space, Spin, Typography, Divider, message } from 'antd';
import { TranslationOutlined, CopyOutlined, CheckOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Text, Paragraph } = Typography;
const { Option } = Select;

function TranslationModal({ visible, onCancel, text, title, isDark }) {
  const [targetLang, setTargetLang] = useState('en');
  const [translatedText, setTranslatedText] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleTranslate = async () => {
    if (!text || !text.trim()) {
      message.error('翻译文本不能为空');
      return;
    }

    setLoading(true);
    setTranslatedText('');

    try {
      const res = await axios.post('/api/translate/text', {
        text: text,
        targetLang: targetLang,
      });

      setTranslatedText(res.data.translated);
      message.success('翻译成功');
    } catch (error) {
      message.error(error.response?.data?.error || '翻译失败');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!translatedText) return;

    try {
      await navigator.clipboard.writeText(translatedText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      message.success('已复制到剪贴板');
    } catch (error) {
      message.error('复制失败');
    }
  };

  const handleClose = () => {
    setTranslatedText('');
    setCopied(false);
    onCancel();
  };

  return (
    <Modal
      title={
        <Space>
          <TranslationOutlined />
          <span>{title || '翻译'}</span>
        </Space>
      }
      open={visible}
      onCancel={handleClose}
      footer={null}
      width={700}
      style={{
        top: 100,
      }}
      bodyStyle={{
        background: isDark ? '#1f2937' : '#ffffff',
        padding: 24,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ color: isDark ? '#f9fafb' : '#111827' }}>
          目标语言：
        </Text>
        <Select
          value={targetLang}
          onChange={setTargetLang}
          style={{ width: 200, marginLeft: 12 }}
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
          翻译
        </Button>
      </div>

      <Divider style={{ margin: '16px 0' }} />

      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ color: isDark ? '#f9fafb' : '#111827' }}>
          原文：
        </Text>
        <div
          style={{
            marginTop: 8,
            padding: 16,
            background: isDark ? '#111827' : '#f8f9fa',
            borderRadius: 8,
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          <Paragraph style={{ color: isDark ? '#d1d5db' : '#4b5563', margin: 0 }}>
            {text || '无内容'}
          </Paragraph>
        </div>
      </div>

      <Divider style={{ margin: '16px 0' }} />

      <div>
        <Space style={{ marginBottom: 8 }}>
          <Text strong style={{ color: isDark ? '#f9fafb' : '#111827' }}>
            翻译结果：
          </Text>
          {translatedText && (
            <Button
              size="small"
              icon={copied ? <CheckOutlined /> : <CopyOutlined />}
              onClick={handleCopy}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          )}
        </Space>

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
              正在翻译，请稍候...
            </div>
          </div>
        ) : translatedText ? (
          <div
            style={{
              padding: 16,
              background: isDark ? '#111827' : '#f8f9fa',
              borderRadius: 8,
              maxHeight: 300,
              overflow: 'auto',
            }}
          >
            <Paragraph style={{ color: isDark ? '#f9fafb' : '#111827', margin: 0 }}>
              {translatedText}
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
            选择目标语言后点击"翻译"按钮开始翻译
          </div>
        )}
      </div>
    </Modal>
  );
}

export default TranslationModal;
