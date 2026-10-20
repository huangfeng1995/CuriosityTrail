import React, { useState, useEffect, useRef } from 'react';
import { 
  Card, Button, Input, Space, Spin, Typography, Select, message, Badge, Tooltip, 
  Modal, Form, InputNumber, Alert
} from 'antd';
import { 
  SendOutlined, RobotOutlined, UserOutlined, ClearOutlined,
  SettingOutlined, SyncOutlined
} from '@ant-design/icons';
import axios from 'axios';

const { TextArea } = Input;
const { Title, Text } = Typography;
const { Option } = Select;

function AgentAssistant({ isDark }) {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [configModalVisible, setConfigModalVisible] = useState(false);
  const [form] = Form.useForm();
  const messagesEndRef = useRef(null);

  useEffect(() => {
    fetchConfig();
    fetchStatus();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchConfig = async () => {
    try {
      const res = await axios.get('/api/ai-config/config');
      const cfg = res.data;
      setConfig(cfg);
      
      form.setFieldsValue({
        ...cfg,
        minimax: cfg.minimax || {},
        translation: cfg.translation || {},
        chat: cfg.chat || {}
      });
    } catch (err) {
      console.error('获取配置失败:', err);
    }
  };

  const fetchStatus = async () => {
    try {
      const res = await axios.get('/api/ai-config/status');
      setStatus(res.data);
    } catch (err) {
      console.error('获取状态失败:', err);
    }
  };

  const handleSaveConfig = async (values) => {
    try {
      const finalConfig = { ...values };
      finalConfig.chatService = 'minimax';
      finalConfig.translationService = 'minimax';

      await axios.post('/api/ai-config/config', finalConfig);
      setConfig(finalConfig);
      message.success('配置已保存');
      setConfigModalVisible(false);
      fetchStatus();
    } catch (err) {
      console.error('保存配置失败:', err);
      message.error('保存配置失败');
    }
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;

    const userMessage = { role: 'user', content: inputText };
    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setIsLoading(true);

    try {
      const res = await axios.post('/api/agent/chat', {
        messages: [...messages, userMessage]
      });

      const assistantMessage = {
        role: 'assistant',
        content: res.data.message
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (err) {
      console.error('发送消息失败:', err);
      message.error('发送消息失败');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    setMessages([]);
    message.info('对话已清空');
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        padding: '0 0 16px 0',
        borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
        marginBottom: 16
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Title level={3} style={{ 
            margin: 0,
            fontSize: 20,
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            fontFamily: 'Noto Serif SC, serif',
          }}>
            AI 研究助手
          </Title>
          {config && status && (
            <Badge
              status={status.services[config.chatService]?.available ? 'success' : 'error'}
              text={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {status.services[config.chatService]?.available ? '服务就绪' : '请配置服务'}
                </Text>
              }
            />
          )}
        </div>
        <Space>
          <Tooltip title="清空对话">
            <Button icon={<ClearOutlined />} onClick={handleClear} />
          </Tooltip>
          <Tooltip title="刷新状态">
            <Button icon={<SyncOutlined />} onClick={fetchStatus} />
          </Tooltip>
        </Space>
      </div>

      <div style={{ 
        flex: 1, 
        overflowY: 'auto',
        marginBottom: 16,
        paddingRight: 8
      }}>
        {messages.length === 0 ? (
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center',
            height: '100%',
            color: isDark ? '#9ca3af' : '#6b7280'
          }}>
            <RobotOutlined style={{ fontSize: 64, marginBottom: 16, opacity: 0.5 }} />
            <Text type="secondary" style={{ fontSize: 16, textAlign: 'center', maxWidth: 400 }}>
              你好！我是 AI 研究助手，帮你进行文献分析、报告撰写和知识探索。
              <br /><br />
              直接开始提问吧！
            </Text>
          </div>
        ) : (
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {messages.map((msg, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
                }}
              >
                <Card
                  size="small"
                  style={{
                    maxWidth: '70%',
                    background: msg.role === 'user' 
                      ? (isDark ? '#1e3a5f' : '#e6f7ff')
                      : (isDark ? '#1f2937' : '#ffffff'),
                    border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                    borderRadius: 12
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ 
                      fontSize: 24, 
                      color: msg.role === 'user' 
                        ? (isDark ? '#60a5fa' : '#1890ff')
                        : (isDark ? '#34d399' : '#52c41a')
                    }}>
                      {msg.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                    </div>
                    <div>
                      <Text style={{ 
                        color: isDark ? '#f9fafb' : '#111827',
                        whiteSpace: 'pre-wrap'
                      }}>
                        {msg.content}
                      </Text>
                    </div>
                  </div>
                </Card>
              </div>
            ))}
            {isLoading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <Card size="small" style={{ 
                  background: isDark ? '#1f2937' : '#ffffff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: 12
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <RobotOutlined style={{ fontSize: 24, color: isDark ? '#34d399' : '#52c41a' }} />
                    <Spin />
                  </div>
                </Card>
              </div>
            )}
          </Space>
        )}
        <div ref={messagesEndRef} />
      </div>

      <Space.Compact style={{ width: '100%' }}>
        <TextArea
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="输入你的问题... (Shift + Enter 换行)"
          autoSize={{ minRows: 1, maxRows: 4 }}
          disabled={isLoading}
          style={{
            background: isDark ? '#1f2937' : '#ffffff',
            borderColor: isDark ? '#374151' : '#d9d9d9',
            color: isDark ? '#f9fafb' : '#111827'
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          loading={isLoading}
          disabled={!inputText.trim()}
        >
          发送
        </Button>
      </Space.Compact>

      {/* 配置弹窗 - 简化版 */}
      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <SettingOutlined />
            <span>AI 助手配置</span>
          </div>
        }
        open={configModalVisible}
        onCancel={() => setConfigModalVisible(false)}
        onOk={() => form.submit()}
        width={600}
        okText="保存配置"
        cancelText="取消"
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSaveConfig}
          initialValues={config}
        >
          <Alert
            message="配置说明"
            description="在此填入你的 AI 服务 API Key。配置将保存在服务器端，不会泄露到客户端。"
            type="info"
            showIcon
            style={{ marginBottom: 24 }}
          />

          <Card
            size="small"
            title="API 配置"
            style={{ marginBottom: 16 }}
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Form.Item
                name={['minimax', 'apiKey']}
                label="MiniMax API Key"
                rules={[{ required: true, message: '请输入 API Key' }]}
              >
                <Input.Password placeholder="输入 MiniMax API Key" />
              </Form.Item>
              <Form.Item
                name={['minimax', 'groupId']}
                label="MiniMax Group ID"
                rules={[{ required: true, message: '请输入 Group ID' }]}
              >
                <Input placeholder="输入 MiniMax Group ID" />
              </Form.Item>
              <Form.Item
                name={['minimax', 'baseUrl']}
                label="API 地址（可选）"
              >
                <Input placeholder="默认: https://api.minimax.chat/v1" />
              </Form.Item>
            </Space>
          </Card>

          <Card size="small" title="翻译设置" style={{ marginBottom: 16 }}>
            <Form.Item
              name={['translation', 'defaultTargetLang']}
              label="默认翻译目标语言"
            >
              <Select style={{ width: '100%' }}>
                <Option value="zh">中文</Option>
                <Option value="en">English</Option>
                <Option value="ja">日本語</Option>
                <Option value="ko">한국어</Option>
                <Option value="fr">Français</Option>
                <Option value="de">Deutsch</Option>
                <Option value="es">Español</Option>
              </Select>
            </Form.Item>
          </Card>

          <Card size="small" title="聊天设置">
            <Form.Item
              name={['chat', 'systemPrompt']}
              label="系统提示词"
            >
              <TextArea rows={3} placeholder="AI 助手的行为设定" />
            </Form.Item>
            <Form.Item
              name={['chat', 'temperature']}
              label="Temperature"
            >
              <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              name={['chat', 'maxTokens']}
              label="最大 Token 数"
            >
              <InputNumber min={128} max={8192} step={128} style={{ width: '100%' }} />
            </Form.Item>
          </Card>
        </Form>
      </Modal>
    </div>
  );
}

export default AgentAssistant;
