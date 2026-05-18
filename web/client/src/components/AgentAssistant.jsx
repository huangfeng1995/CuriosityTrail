import React, { useState, useEffect, useRef } from 'react';
import { Card, Button, Input, Space, Spin, Typography, Select, message, Badge, Tooltip } from 'antd';
import { 
  SendOutlined, 
  RobotOutlined, 
  UserOutlined, 
  ClearOutlined,
  SettingOutlined,
  SyncOutlined,
  HistoryOutlined,
  TranslationOutlined
} from '@ant-design/icons';
import TranslationModal from './TranslationModal';
import axios from 'axios';

const { Text, Title } = Typography;
const { TextArea } = Input;

function AgentAssistant({ isDark }) {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [model, setModel] = useState('llama3.2:3b');
  const [translationModalVisible, setTranslationModalVisible] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [translationContext, setTranslationContext] = useState('');
  const messagesEndRef = useRef(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    checkOllamaStatus();
    loadHistory();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const checkOllamaStatus = async () => {
    try {
      const res = await axios.get('/api/agent/status');
      setOllamaStatus(res.data);
      if (res.data.models && res.data.models.length > 0) {
        setModel(res.data.models[0].name);
      }
    } catch (error) {
      setOllamaStatus({ success: false, error: '无法连接 Ollama' });
    }
  };

  const loadHistory = () => {
    const saved = localStorage.getItem('agent_messages');
    if (saved) {
      setMessages(JSON.parse(saved));
    }
  };

  const saveHistory = (newMessages) => {
    localStorage.setItem('agent_messages', JSON.stringify(newMessages));
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const sendMessage = async () => {
    if (!inputValue.trim() || loading) return;

    const userMessage = {
      role: 'user',
      content: inputValue,
      timestamp: new Date().toISOString()
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    saveHistory(newMessages);
    setInputValue('');
    setLoading(true);

    // 创建 SSE 连接
    const eventSource = new EventSource(`/api/agent/chat?message=${encodeURIComponent(inputValue)}`);
    eventSourceRef.current = eventSource;

    let fullResponse = '';
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.error) {
          message.error(data.error);
          setLoading(false);
          eventSource.close();
          return;
        }

        if (data.token) {
          fullResponse += data.token;
          setMessages(prev => {
            const updated = [...prev];
            const lastMsg = updated[updated.length - 1];
            if (lastMsg?.role === 'user') {
              updated.push({
                role: 'assistant',
                content: fullResponse,
                timestamp: new Date().toISOString()
              });
            } else {
              updated[updated.length - 1] = {
                ...lastMsg,
                content: fullResponse
              };
            }
            return updated;
          });
        }

        if (data.done) {
          setLoading(false);
          saveHistory([...newMessages, {
            role: 'assistant',
            content: fullResponse,
            timestamp: new Date().toISOString()
          }]);
          eventSource.close();
        }
      } catch (error) {
        console.error('SSE parse error:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('SSE error:', error);
      setLoading(false);
      message.error('连接失败，请检查 Ollama 是否运行');
      eventSource.close();
    };
  };

  const clearMessages = () => {
    setMessages([]);
    localStorage.removeItem('agent_messages');
    message.success('对话已清除');
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const openTranslation = (text, context = '') => {
    setSelectedText(text);
    setTranslationContext(context);
    setTranslationModalVisible(true);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
        flexWrap: 'wrap',
        gap: 12
      }}>
        <div>
          <Title level={2} style={{
            margin: 0,
            fontSize: 26,
            fontWeight: 700,
            color: isDark ? '#f9fafb' : '#111827',
            fontFamily: 'Inter, system-ui, sans-serif',
          }}>
            <Space>
              <RobotOutlined />
              AI 研究助手
            </Space>
          </Title>
          <div style={{
            fontSize: 14,
            color: isDark ? '#6b7280' : '#9ca3af',
            marginTop: 4,
          }}>
            基于本地 Ollama 模型，提供智能研究和写作支持
          </div>
        </div>

        <Space>
          <Badge status={ollamaStatus?.success ? 'success' : 'error'} />
          <Text style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>
            {ollamaStatus?.success ? 'Ollama 已连接' : 'Ollama 未连接'}
          </Text>
          <Tooltip title="检查连接">
            <Button 
              icon={<SyncOutlined spin={loading} />} 
              onClick={checkOllamaStatus}
              disabled={loading}
            />
          </Tooltip>
          <Tooltip title="清除对话">
            <Button 
              icon={<ClearOutlined />} 
              onClick={clearMessages}
              disabled={loading}
            />
          </Tooltip>
        </Space>
      </div>

      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: 20,
        background: isDark ? 'rgba(15, 23, 42, 0.3)' : 'rgba(248, 249, 250, 0.5)',
        borderRadius: 12,
        border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`,
        marginBottom: 16,
        maxHeight: 'calc(100vh - 350px)',
        minHeight: 400
      }}>
        {messages.length === 0 ? (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: isDark ? '#6b7280' : '#9ca3af'
          }}>
            <RobotOutlined style={{ fontSize: 48, marginBottom: 16 }} />
            <Title level={4} style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>
              欢迎使用 AI 研究助手
            </Title>
            <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', textAlign: 'center', maxWidth: 500 }}>
              我可以帮助你进行科学研究、报告撰写、文献分析和知识探索。
              <br />
              请确保 Ollama 已在本地运行（默认地址：localhost:11434）
            </Text>
          </div>
        ) : (
          <>
            {messages.map((msg, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  marginBottom: 16
                }}
              >
                <div style={{
                  maxWidth: '70%',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12
                }}>
                  {msg.role === 'assistant' && (
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: isDark ? 'rgba(96, 165, 250, 0.2)' : 'rgba(30, 58, 95, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      <RobotOutlined style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />
                    </div>
                  )}
                  
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: msg.role === 'user' 
                      ? (isDark ? '#1e3a5f' : '#1e3a5f')
                      : (isDark ? 'rgba(31, 41, 55, 0.8)' : 'rgba(255, 255, 255, 0.9)'),
                    color: msg.role === 'user' ? '#fff' : (isDark ? '#f9fafb' : '#111827'),
                    boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.08)',
                    whiteSpace: 'pre-wrap',
                    lineHeight: 1.6
                  }}>
                    {msg.content}
                    {msg.role === 'assistant' && msg.content && (
                      <div style={{ marginTop: 8, textAlign: 'right' }}>
                        <Button
                          size="small"
                          icon={<TranslationOutlined />}
                          onClick={() => openTranslation(msg.content, 'AI 回复')}
                          style={{ fontSize: 12 }}
                        >
                          翻译
                        </Button>
                      </div>
                    )}
                  </div>

                  {msg.role === 'user' && (
                    <div style={{
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: isDark ? 'rgba(96, 165, 250, 0.2)' : 'rgba(96, 165, 250, 0.1)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}>
                      <UserOutlined style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />
                    </div>
                  )}
                </div>
              </div>
            ))}
            
            {loading && messages[messages.length - 1]?.role === 'user' && (
              <div style={{
                display: 'flex',
                justifyContent: 'flex-start',
                marginBottom: 16
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12
                }}>
                  <div style={{
                    width: 36,
                    height: 36,
                    borderRadius: '50%',
                    background: isDark ? 'rgba(96, 165, 250, 0.2)' : 'rgba(30, 58, 95, 0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    <RobotOutlined style={{ color: isDark ? '#60a5fa' : '#1e3a5f' }} />
                  </div>
                  <div style={{
                    padding: '12px 16px',
                    borderRadius: '16px 16px 16px 4px',
                    background: isDark ? 'rgba(31, 41, 55, 0.8)' : 'rgba(255, 255, 255, 0.9)',
                    boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.08)'
                  }}>
                    <Spin size="small" />
                    <Text style={{ marginLeft: 8, color: isDark ? '#9ca3af' : '#6b7280' }}>
                      思考中...
                    </Text>
                  </div>
                </div>
              </div>
            )}
            
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      <div style={{
        padding: 16,
        background: isDark ? 'rgba(31, 41, 55, 0.6)' : 'rgba(255, 255, 255, 0.8)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderRadius: 12,
        border: `1px solid ${isDark ? 'rgba(55, 65, 81, 0.5)' : 'rgba(229, 231, 235, 0.5)'}`
      }}>
        <div style={{
          display: 'flex',
          gap: 12,
          alignItems: 'flex-end'
        }}>
          <TextArea
            placeholder="输入你的问题或任务... (Shift+Enter 换行，Enter 发送)"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            autoSize={{ minRows: 2, maxRows: 6 }}
            style={{
              flex: 1,
              borderRadius: 8,
              background: isDark ? '#111827' : '#fff',
              borderColor: isDark ? '#374151' : '#e5e7eb'
            }}
            disabled={loading}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            size="large"
            onClick={sendMessage}
            loading={loading}
            style={{
              borderRadius: 8,
              height: 68,
              boxShadow: isDark ? '0 4px 12px rgba(96, 165, 250, 0.3)' : '0 4px 12px rgba(30, 58, 95, 0.2)'
            }}
          >
            发送
          </Button>
        </div>

        <div style={{
          marginTop: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8
        }}>
          <Space wrap>
            <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af' }}>
              模型：
            </Text>
            <Select
              value={model}
              onChange={setModel}
              style={{ width: 160 }}
              size="small"
              disabled={loading}
            >
              <Select.Option value="llama3.2:3b">Llama 3.2 (3B)</Select.Option>
              <Select.Option value="llama3.2:1b">Llama 3.2 (1B)</Select.Option>
              <Select.Option value="qwen2.5:7b">Qwen 2.5 (7B)</Select.Option>
              <Select.Option value="mistral:7b">Mistral (7B)</Select.Option>
            </Select>
          </Space>
          
          <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af' }}>
            💡 快捷提示：支持科学研究、报告生成、文献分析、关键词提取等任务
          </Text>
        </div>
      </div>

      <TranslationModal
        visible={translationModalVisible}
        onCancel={() => setTranslationModalVisible(false)}
        text={selectedText}
        title="翻译 AI 回复"
        isDark={isDark}
      />
    </div>
  );
}

export default AgentAssistant;
