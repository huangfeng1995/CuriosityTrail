import React, { useState, useEffect } from 'react';
import { Card, Tabs, Form, Input, Select, Button, Switch, Space, Tag, message, Divider, Typography } from 'antd';
import { TranslationOutlined, CloudOutlined, DesktopOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import axios from 'axios';

const { Title, Text } = Typography;
const { Option } = Select;

function TranslationSettings({ isDark }) {
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('minimax');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serviceStatus, setServiceStatus] = useState({
    minimax: { available: false },
    ollama: { available: false },
  });

  useEffect(() => {
    loadSettings();
    checkServicesStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await axios.get('/api/translate/settings');
      form.setFieldsValue({
        service: res.data.service,
        minimaxApiKey: res.data.minimax?.apiKey || '',
        minimaxGroupId: res.data.minimax?.groupId || '',
        ollamaBaseUrl: res.data.ollama?.baseUrl || 'http://localhost:11434',
        ollamaModel: res.data.ollama?.model || 'llama3.2:3b',
        defaultTargetLang: res.data.defaultTargetLang || 'zh',
      });
    } catch (error) {
      console.error('加载翻译设置失败:', error);
    }
  };

  const checkServicesStatus = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/translate/status');
      setServiceStatus(res.data.services || {});
    } catch (error) {
      console.error('检查服务状态失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      const values = await form.validateFields();

      await axios.post('/api/translate/settings', {
        service: values.service,
        minimax: {
          apiKey: values.minimaxApiKey,
          groupId: values.minimaxGroupId,
        },
        ollama: {
          baseUrl: values.ollamaBaseUrl,
          model: values.ollamaModel,
        },
        defaultTargetLang: values.defaultTargetLang,
      });

      message.success('翻译设置保存成功');
      checkServicesStatus();
    } catch (error) {
      message.error(error.response?.data?.error || '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const renderServiceStatus = (service, status) => {
    if (loading) {
      return <Tag>检查中...</Tag>;
    }

    if (status.available) {
      return (
        <Tag color="success" icon={<CheckCircleOutlined />}>
          已连接
        </Tag>
      );
    }

    return (
      <Tag color="error" icon={<CloseCircleOutlined />}>
        未连接 {status.error && `: ${status.error}`}
      </Tag>
    );
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <Card
        style={{
          background: isDark ? '#1f2937' : '#ffffff',
          borderColor: isDark ? '#374151' : '#e5e7eb',
        }}
      >
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'minimax',
              label: (
                <span>
                  <CloudOutlined />
                  MiniMax API
                </span>
              ),
              children: (
                <Form
                  form={form}
                  layout="vertical"
                  initialValues={{
                    service: 'minimax',
                    defaultTargetLang: 'zh',
                  }}
                >
                  <Form.Item
                    name="minimaxApiKey"
                    label="API Key"
                    tooltip="在 MiniMax 开放平台获取"
                  >
                    <Input.Password
                      placeholder="输入 MiniMax API Key"
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="minimaxGroupId"
                    label="Group ID"
                    tooltip="在 MiniMax 开放平台获取"
                  >
                    <Input
                      placeholder="输入 MiniMax Group ID"
                      size="large"
                    />
                  </Form.Item>

                  <Divider />

                  <Space>
                    <Text strong>服务状态：</Text>
                    {renderServiceStatus('minimax', serviceStatus.minimax)}
                  </Space>
                </Form>
              ),
            },
            {
              key: 'ollama',
              label: (
                <span>
                  <DesktopOutlined />
                  Ollama 本地模型
                </span>
              ),
              children: (
                <Form
                  form={form}
                  layout="vertical"
                  initialValues={{
                    service: 'ollama',
                    ollamaBaseUrl: 'http://localhost:11434',
                    ollamaModel: 'llama3.2:3b',
                  }}
                >
                  <Form.Item
                    name="ollamaBaseUrl"
                    label="Ollama 服务地址"
                    tooltip="Ollama 服务的 URL 地址"
                  >
                    <Input
                      placeholder="http://localhost:11434"
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="ollamaModel"
                    label="翻译模型"
                    tooltip="选择用于翻译的 Ollama 模型"
                  >
                    <Select size="large">
                      <Option value="llama3.2:3b">llama3.2:3b (推荐)</Option>
                      <Option value="llama3.2:1b">llama3.2:1b (更快)</Option>
                      <Option value="llama3:8b">llama3:8b (更高质量)</Option>
                      <Option value="qwen:7b">Qwen:7b</Option>
                      <Option value="qwen:14b">Qwen:14b</Option>
                      <Option value="mistral:7b">Mistral:7b</Option>
                    </Select>
                  </Form.Item>

                  <Divider />

                  <Space>
                    <Text strong>服务状态：</Text>
                    {renderServiceStatus('ollama', serviceStatus.ollama)}
                    <Button
                      size="small"
                      onClick={checkServicesStatus}
                      loading={loading}
                    >
                      刷新状态
                    </Button>
                  </Space>
                </Form>
              ),
            },
          ]}
        />

        <Divider style={{ margin: '24px 0' }} />

        <Form
          form={form}
          layout="vertical"
          initialValues={{
            defaultTargetLang: 'zh',
          }}
        >
          <Form.Item
            name="defaultTargetLang"
            label="默认目标语言"
            tooltip="翻译时的默认目标语言"
          >
            <Select size="large">
              <Option value="zh">中文</Option>
              <Option value="en">English (英文)</Option>
              <Option value="ja">日本語 (日文)</Option>
              <Option value="ko">한국어 (韩文)</Option>
              <Option value="fr">Français (法文)</Option>
              <Option value="de">Deutsch (德文)</Option>
              <Option value="es">Español (西班牙文)</Option>
              <Option value="ru">Русский (俄文)</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="service"
            label="使用的翻译服务"
            tooltip="选择默认使用的翻译服务"
          >
            <Select size="large">
              <Option value="minimax">MiniMax API</Option>
              <Option value="ollama">Ollama 本地模型</Option>
            </Select>
          </Form.Item>
        </Form>

        <div style={{ marginTop: 24 }}>
          <Button
            type="primary"
            size="large"
            onClick={handleSave}
            loading={saving}
            style={{ minWidth: 120 }}
          >
            保存设置
          </Button>
        </div>
      </Card>
    </div>
  );
}

export default TranslationSettings;
