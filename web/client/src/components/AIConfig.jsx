import React, { useState, useEffect } from 'react';
import {
  Card,
  Tabs,
  Form,
  Input,
  InputNumber,
  Select,
  Button,
  Switch,
  Space,
  Tag,
  message,
  Divider,
  Typography,
  Tooltip,
  Alert,
  Descriptions
} from 'antd';
import {
  CloudServerOutlined,
  DesktopOutlined,
  FileTextOutlined,
  GlobalOutlined,
  SettingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  InfoCircleOutlined,
  QuestionCircleOutlined
} from '@ant-design/icons';
import axios from 'axios';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;
const { Option } = Select;

function AIConfig({ isDark }) {
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('services');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    loadConfig();
    checkStatus();
  }, []);

  const loadConfig = async () => {
    try {
      const res = await axios.get('/api/ai-config/config');
      setConfig(res.data);
      form.setFieldsValue({
        chatService: res.data.chatService,
        translationService: res.data.translationService,
        minimaxApiKey: res.data.minimax?.apiKey || '',
        minimaxGroupId: res.data.minimax?.groupId || '',
        minimaxBaseUrl: res.data.minimax?.baseUrl || 'https://api.minimax.chat/v1',
        ollamaBaseUrl: res.data.ollama?.baseUrl || 'http://localhost:11434',
        ollamaModel: res.data.ollama?.model || 'llama3.2:3b',
        ollamaTemperature: res.data.ollama?.temperature || 0.7,
        llamacppModelPath: res.data.llamacpp?.modelPath || '',
        llamacppTemperature: res.data.llamacpp?.temperature || 0.3,
        llamacppCtxSize: res.data.llamacpp?.ctxSize || 4096,
        llamacppGpuLayers: res.data.llamacpp?.gpuLayers || -1,
        defaultTargetLang: res.data.translation?.defaultTargetLang || 'zh',
        defaultSourceLang: res.data.translation?.defaultSourceLang || 'auto',
        useSameServiceForTranslation: res.data.translation?.useSameServiceForTranslation || true,
        maxTokens: res.data.chat?.maxTokens || 2048,
        systemPrompt: res.data.chat?.systemPrompt || ''
      });
    } catch (error) {
      message.error('加载配置失败: ' + error.message);
    }
  };

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/ai-config/status');
      setStatus(res.data);
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
      
      await axios.post('/api/ai-config/config', {
        chatService: values.chatService,
        translationService: values.translationService,
        minimax: {
          apiKey: values.minimaxApiKey,
          groupId: values.minimaxGroupId,
          baseUrl: values.minimaxBaseUrl
        },
        ollama: {
          baseUrl: values.ollamaBaseUrl,
          model: values.ollamaModel,
          temperature: values.ollamaTemperature
        },
        llamacpp: {
          modelPath: values.llamacppModelPath,
          temperature: values.llamacppTemperature,
          ctxSize: values.llamacppCtxSize,
          gpuLayers: values.llamacppGpuLayers
        },
        translation: {
          defaultTargetLang: values.defaultTargetLang,
          defaultSourceLang: values.defaultSourceLang,
          useSameServiceForTranslation: values.useSameServiceForTranslation
        },
        chat: {
          maxTokens: values.maxTokens,
          systemPrompt: values.systemPrompt
        }
      });

      message.success('配置保存成功！');
      await loadConfig();
      await checkStatus();
    } catch (error) {
      message.error('保存配置失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      setSaving(true);
      await axios.post('/api/ai-config/reset');
      message.success('已重置为默认配置');
      await loadConfig();
      await checkStatus();
    } catch (error) {
      message.error('重置配置失败: ' + error.message);
    } finally {
      setSaving(false);
    }
  };

  const renderServiceStatus = (serviceName, serviceStatus) => {
    if (!serviceStatus) return null;
    
    const isAvailable = serviceStatus.available;
    
    return (
      <Space>
        {isAvailable ? (
          <Tag color="success" icon={<CheckCircleOutlined />}>
            可用
          </Tag>
        ) : (
          <Tag color="error" icon={<CloseCircleOutlined />}>
            不可用
          </Tag>
        )}
        {serviceStatus.error && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {serviceStatus.error}
          </Text>
        )}
      </Space>
    );
  };

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <Card
        title={
          <Space>
            <SettingOutlined />
            AI 助手配置中心
          </Space>
        }
        style={{
          background: isDark ? '#1f2937' : '#fff',
          borderColor: isDark ? '#374151' : '#e5e7eb'
        }}
      >
        <Alert
          message="💡 快速开始"
          description={
            <div>
              <Paragraph style={{ marginBottom: 8 }}>
                <strong>如果您已经下载了本地模型（如 Qwen2）</strong>，请直接查看 <strong>"本地模型 (LlamaCpp)"</strong> 标签页即可使用，无需 API Key。
              </Paragraph>
              <Paragraph>
                如果没有本地模型，您可以选择使用 Ollama（需要先安装运行）或配置 MiniMax API Key。
              </Paragraph>
            </div>
          }
          type="info"
          showIcon
          style={{ marginBottom: 24 }}
        />

        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'services',
              label: (
                <span>
                  <GlobalOutlined />
                  服务选择 & 状态
                </span>
              ),
              children: (
                <div>
                  <Title level={4}>服务状态概览</Title>
                  {status && (
                    <Descriptions
                      bordered
                      column={1}
                      style={{ marginBottom: 24 }}
                      contentStyle={{
                        background: isDark ? '#111827' : '#fff'
                      }}
                    >
                      <Descriptions.Item label="当前聊天服务">
                        <Space>
                          <Tag color="blue">{status.currentChatService}</Tag>
                          {renderServiceStatus(status.currentChatService, status.services[status.currentChatService])}
                        </Space>
                      </Descriptions.Item>
                      <Descriptions.Item label="当前翻译服务">
                        <Space>
                          <Tag color="green">{status.currentTranslationService}</Tag>
                          {renderServiceStatus(status.currentTranslationService, status.services[status.currentTranslationService])}
                        </Space>
                      </Descriptions.Item>
                      <Descriptions.Item label="MiniMax API">
                        {renderServiceStatus('minimax', status.services.minimax)}
                      </Descriptions.Item>
                      <Descriptions.Item label="Ollama">
                        {renderServiceStatus('ollama', status.services.ollama)}
                      </Descriptions.Item>
                      <Descriptions.Item label="本地模型 (LlamaCpp)">
                        {renderServiceStatus('llamacpp', status.services.llamacpp)}
                      </Descriptions.Item>
                    </Descriptions>
                  )}
                  
                  <Button
                    icon={<ReloadOutlined />}
                    onClick={checkStatus}
                    loading={loading}
                    style={{ marginBottom: 24 }}
                  >
                    刷新状态
                  </Button>

                  <Divider />

                  <Form form={form} layout="vertical">
                    <Form.Item
                      name="chatService"
                      label="聊天服务"
                      tooltip="选择用于 AI 助手聊天的服务"
                    >
                      <Select size="large">
                        <Option value="minimax">MiniMax API</Option>
                        <Option value="ollama">Ollama</Option>
                        <Option value="llamacpp">本地模型 (LlamaCpp) - 推荐</Option>
                      </Select>
                    </Form.Item>

                    <Form.Item
                      name="useSameServiceForTranslation"
                      label="翻译服务设置"
                      valuePropName="checked"
                    >
                      <Switch checkedChildren="使用与聊天相同的服务" unCheckedChildren="单独配置翻译服务" />
                    </Form.Item>

                    <Form.Item
                      name="translationService"
                      label="翻译服务"
                      tooltip="选择用于翻译的服务"
                      dependencies={['useSameServiceForTranslation']}
                      hidden={form.getFieldValue('useSameServiceForTranslation')}
                    >
                      <Select size="large">
                        <Option value="minimax">MiniMax API</Option>
                        <Option value="ollama">Ollama</Option>
                        <Option value="llamacpp">本地模型 (LlamaCpp)</Option>
                      </Select>
                    </Form.Item>
                  </Form>
                </div>
              )
            },
            {
              key: 'minimax',
              label: (
                <span>
                  <CloudServerOutlined />
                  MiniMax API
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
                  <Alert
                    message="MiniMax API 配置"
                    description="需要在 MiniMax 开放平台申请 API Key 和 Group ID"
                    type="info"
                    showIcon
                    style={{ marginBottom: 24 }}
                  />
                  
                  <Form.Item
                    name="minimaxApiKey"
                    label="API Key"
                    tooltip="您的 MiniMax API Key"
                  >
                    <Input.Password
                      placeholder="输入您的 API Key"
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="minimaxGroupId"
                    label="Group ID"
                    tooltip="您的 MiniMax Group ID"
                  >
                    <Input
                      placeholder="输入您的 Group ID"
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="minimaxBaseUrl"
                    label="API 地址"
                    tooltip="MiniMax API 的基础 URL"
                  >
                    <Input
                      placeholder="https://api.minimax.chat/v1"
                      size="large"
                    />
                  </Form.Item>
                </Form>
              )
            },
            {
              key: 'ollama',
              label: (
                <span>
                  <DesktopOutlined />
                  Ollama
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
                  <Alert
                    message="Ollama 配置"
                    description="需要先在本地安装并运行 Ollama"
                    type="info"
                    showIcon
                    style={{ marginBottom: 24 }}
                  />
                  
                  <Form.Item
                    name="ollamaBaseUrl"
                    label="服务地址"
                    tooltip="Ollama 服务的 URL 地址"
                  >
                    <Input
                      placeholder="http://localhost:11434"
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="ollamaModel"
                    label="模型"
                    tooltip="选择用于聊天的模型"
                  >
                    <Select size="large">
                      <Option value="llama3.2:3b">Llama 3.2 (3B)</Option>
                      <Option value="llama3.2:1b">Llama 3.2 (1B)</Option>
                      <Option value="qwen2.5:7b">Qwen 2.5 (7B)</Option>
                      <Option value="mistral:7b">Mistral (7B)</Option>
                    </Select>
                  </Form.Item>

                  <Form.Item
                    name="ollamaTemperature"
                    label="温度参数"
                    tooltip="控制输出的随机性，值越大越随机"
                  >
                    <InputNumber
                      min={0}
                      max={2}
                      step={0.1}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Form.Item>
                </Form>
              )
            },
            {
              key: 'llamacpp',
              label: (
                <span>
                  <FileTextOutlined />
                  本地模型 (LlamaCpp)
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
                  <Alert
                    message="本地模型配置"
                    description="直接使用 GGUF 格式的模型文件，无需额外服务"
                    type="success"
                    showIcon
                    style={{ marginBottom: 24 }}
                  />
                  
                  <Form.Item
                    name="llamacppModelPath"
                    label="模型文件路径"
                    tooltip="本地 GGUF 模型文件的绝对路径"
                  >
                    <Input
                      placeholder="/path/to/model.gguf"
                      size="large"
                      prefix={<FileTextOutlined />}
                    />
                  </Form.Item>

                  <Form.Item
                    name="llamacppTemperature"
                    label="温度参数"
                    tooltip="控制输出的随机性，值越大越随机（翻译建议 0.1-0.3）"
                  >
                    <InputNumber
                      min={0}
                      max={2}
                      step={0.1}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="llamacppCtxSize"
                    label="上下文大小"
                    tooltip="最大上下文窗口大小（tokens）"
                  >
                    <InputNumber
                      min={512}
                      max={32768}
                      step={512}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="llamacppGpuLayers"
                    label="GPU 层数量"
                    tooltip="-1 表示使用所有可用层，0 表示仅使用 CPU"
                  >
                    <InputNumber
                      min={-1}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Form.Item>
                </Form>
              )
            },
            {
              key: 'translation',
              label: (
                <span>
                  <GlobalOutlined />
                  翻译设置
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
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
                    name="defaultSourceLang"
                    label="默认源语言"
                    tooltip="翻译时的默认源语言（auto 表示自动检测）"
                  >
                    <Select size="large">
                      <Option value="auto">自动检测</Option>
                      <Option value="zh">中文</Option>
                      <Option value="en">English (英文)</Option>
                      <Option value="ja">日本語 (日文)</Option>
                      <Option value="ko">한국어 (韩文)</Option>
                    </Select>
                  </Form.Item>
                </Form>
              )
            },
            {
              key: 'advanced',
              label: (
                <span>
                  <SettingOutlined />
                  高级设置
                </span>
              ),
              children: (
                <Form form={form} layout="vertical">
                  <Form.Item
                    name="maxTokens"
                    label="最大生成长度"
                    tooltip="单次对话的最大 token 数量"
                  >
                    <InputNumber
                      min={256}
                      max={32768}
                      step={256}
                      style={{ width: '100%' }}
                      size="large"
                    />
                  </Form.Item>

                  <Form.Item
                    name="systemPrompt"
                    label="系统提示词"
                    tooltip="AI 助手的系统角色设定"
                  >
                    <TextArea
                      placeholder="输入系统提示词..."
                      rows={6}
                      style={{
                        background: isDark ? '#111827' : '#fff',
                        borderColor: isDark ? '#374151' : '#e5e7eb'
                      }}
                    />
                  </Form.Item>
                </Form>
              )
            }
          ]}
        />

        <Divider style={{ margin: '24px 0' }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Button
              danger
              onClick={handleReset}
              loading={saving}
            >
              重置为默认配置
            </Button>
          </Space>
          <Space>
            <Button
              onClick={loadConfig}
              disabled={saving}
            >
              重新加载
            </Button>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={handleSave}
              loading={saving}
              size="large"
            >
              保存配置
            </Button>
          </Space>
        </div>
      </Card>
    </div>
  );
}

export default AIConfig;
