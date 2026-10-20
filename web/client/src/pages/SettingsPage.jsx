import React, { useEffect, useState } from 'react';
import {
  Tabs,
  Form,
  Input,
  InputNumber,
  Select,
  Button,
  Card,
  message,
  Tag,
  Space,
  Alert,
  Typography,
  Slider,
} from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import api from '../api/client';

const { Text, Paragraph } = Typography;

/**
 * 设置页：AI 供应商配置 + 角色提示词编辑。
 */
export default function SettingsPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Tabs
        defaultActiveKey="provider"
        items={[
          { key: 'provider', label: 'AI 供应商', children: <ProviderConfig /> },
          { key: 'prompts', label: '角色提示词', children: <PromptConfig /> },
        ]}
      />
    </div>
  );
}

function ProviderConfig() {
  const [form] = Form.useForm();
  const [status, setStatus] = useState(null);
  const [testing, setTesting] = useState('');

  const load = async () => {
    try {
      const res = await api.get('/config/ai');
      form.setFieldsValue(res.data);
    } catch (e) {
      message.error('配置加载失败');
    }
    loadStatus();
  };

  const loadStatus = async () => {
    try {
      const res = await api.get('/ai/status');
      setStatus(res.data);
    } catch (e) {
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async (values) => {
    try {
      // key 留空表示不改，避免把掩码写回去
      await api.put('/config/ai', {
        provider: values.provider,
        deepseek: {
          apiKey: values.deepseek?.apiKey || undefined,
          baseUrl: values.deepseek?.baseUrl,
          model: values.deepseek?.model,
          temperature: values.deepseek?.temperature,
          maxTokens: values.deepseek?.maxTokens,
          reasoningEffort: values.deepseek?.reasoningEffort,
          thinking: values.deepseek?.thinking,
        },
        openaiCompat: {
          apiKey: values.openaiCompat?.apiKey || undefined,
          baseUrl: values.openaiCompat?.baseUrl,
          model: values.openaiCompat?.model,
          temperature: values.openaiCompat?.temperature,
          maxTokens: values.openaiCompat?.maxTokens,
        },
        ollama: {
          baseUrl: values.ollama?.baseUrl,
          model: values.ollama?.model,
          temperature: values.ollama?.temperature,
          maxTokens: values.ollama?.maxTokens,
        },
      });
      message.success('已保存');
      loadStatus();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const test = async (provider) => {
    setTesting(provider);
    try {
      const res = await api.post('/config/ai/test', { provider });
      if (res.data.ok) message.success(res.data.detail || '连接正常');
      else message.warning(res.data.detail || '连接失败');
    } catch (e) {
      message.error(e.message);
    } finally {
      setTesting('');
    }
  };

  return (
    <div>
      {status && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Text strong>连接状态</Text>
            {status.active?.name ? (
              <Tag color="green">
                当前使用：{status.active.name}
                {status.active.degraded ? '（降级）' : ''}
              </Tag>
            ) : (
              <Tag color="red">无可用供应商</Tag>
            )}
            <Button size="small" onClick={loadStatus}>
              刷新
            </Button>
          </div>
          {status.providers?.map((p) => (
            <div
              key={p.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                padding: '3px 0',
              }}
            >
              {p.ok ? (
                <CheckCircleOutlined style={{ color: '#10b981' }} />
              ) : (
                <CloseCircleOutlined style={{ color: '#9ca3af' }} />
              )}
              <Text style={{ width: 110 }}>{p.name}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {p.detail}
              </Text>
            </div>
          ))}
          {status.active?.reason && !status.active?.name && (
            <Alert type="warning" message={status.active.reason} style={{ marginTop: 8 }} />
          )}
        </Card>
      )}

      <Card size="small" title="AI 供应商">
        <Form form={form} layout="vertical" size="small" onFinish={save}>
          <Form.Item
            name="provider"
            label="默认供应商"
            help="首选不可用时平台会自动降级到其他已配置的供应商。"
          >
            <Select
              options={[
                { value: 'deepseek', label: 'DeepSeek' },
                { value: 'openaiCompat', label: '其他 OpenAI 兼容服务' },
                { value: 'ollama', label: '本地 Ollama' },
              ]}
            />
          </Form.Item>

          <Form.Item label="DeepSeek">
            <div style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 12 }}>
              <Form.Item name={['deepseek', 'apiKey']} label="API Key" help="留空表示不修改已保存的 Key。">
                <Input.Password placeholder="sk-…" autoComplete="off" />
              </Form.Item>
              <Form.Item name={['deepseek', 'baseUrl']} label="接口地址">
                <Input />
              </Form.Item>
              <Form.Item name={['deepseek', 'model']} label="模型">
                <Select
                  options={[
                    { value: 'deepseek-flash', label: 'deepseek-flash（快，日常写作）' },
                    { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强，复杂推理）' },
                  ]}
                />
              </Form.Item>
              <Space size={16} wrap>
                <Form.Item name={['deepseek', 'temperature']} label="温度" style={{ marginBottom: 0 }}>
                  <Slider min={0} max={1.5} step={0.05} style={{ width: 140 }} />
                </Form.Item>
                <Form.Item name={['deepseek', 'maxTokens']} label="最大输出" style={{ marginBottom: 0 }}>
                  <InputNumber min={1024} max={32768} step={1024} />
                </Form.Item>
                <Form.Item name={['deepseek', 'reasoningEffort']} label="思考档位" style={{ marginBottom: 0 }}>
                  <Select
                    style={{ width: 100 }}
                    options={[
                      { value: 'low', label: '低' },
                      { value: 'high', label: '高' },
                      { value: 'max', label: '最高' },
                    ]}
                  />
                </Form.Item>
              </Space>
              <div style={{ marginTop: 12 }}>
                <Button size="small" loading={testing === 'deepseek'} onClick={() => test('deepseek')}>
                  测试连接
                </Button>
              </div>
            </div>
          </Form.Item>

          <Form.Item label="其他 OpenAI 兼容服务（兜底）">
            <div style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 12 }}>
              <Form.Item name={['openaiCompat', 'baseUrl']} label="接口地址">
                <Input placeholder="https://api.example.com/v1" />
              </Form.Item>
              <Form.Item name={['openaiCompat', 'apiKey']} label="API Key">
                <Input.Password autoComplete="off" />
              </Form.Item>
              <Form.Item name={['openaiCompat', 'model']} label="模型">
                <Input placeholder="gpt-4o-mini" />
              </Form.Item>
              <Button size="small" loading={testing === 'openaiCompat'} onClick={() => test('openaiCompat')}>
                测试连接
              </Button>
            </div>
          </Form.Item>

          <Form.Item label="本地 Ollama（离线兜底）">
            <div style={{ border: '1px solid rgba(128,128,128,0.2)', borderRadius: 8, padding: 12 }}>
              <Form.Item name={['ollama', 'baseUrl']} label="地址">
                <Input />
              </Form.Item>
              <Form.Item name={['ollama', 'model']} label="模型">
                <Input placeholder="qwen2.5:7b" />
              </Form.Item>
              <Button size="small" loading={testing === 'ollama'} onClick={() => test('ollama')}>
                测试连接
              </Button>
            </div>
          </Form.Item>

          <Button type="primary" htmlType="submit" icon={<SaveOutlined />}>
            保存配置
          </Button>
        </Form>
      </Card>
    </div>
  );
}

function PromptConfig() {
  const [roles, setRoles] = useState([]);
  const [activeKey, setActiveKey] = useState('writer');
  const [draft, setDraft] = useState('');
  const [temperature, setTemperature] = useState(0.8);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/ai/roles');
      setRoles(res.data);
      const found = res.data.find((r) => r.key === activeKey);
      if (found) {
        setDraft(found.systemPrompt);
        setTemperature(found.temperature);
      }
    } catch (e) {
      message.error('角色加载失败');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const select = (key) => {
    setActiveKey(key);
    const found = roles.find((r) => r.key === key);
    if (found) {
      setDraft(found.systemPrompt);
      setTemperature(found.temperature);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/ai/prompts/${activeKey}`, {
        systemPrompt: draft,
        temperature,
      });
      message.success('已保存');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    try {
      await api.delete(`/ai/prompts/${activeKey}`);
      message.success('已恢复默认');
      load();
    } catch (e) {
      message.error('恢复失败');
    }
  };

  const active = roles.find((r) => r.key === activeKey);

  return (
    <Card size="small">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {roles.map((r) => (
          <Button
            key={r.key}
            size="small"
            type={r.key === activeKey ? 'primary' : 'default'}
            onClick={() => select(r.key)}
          >
            {r.icon} {r.name}
            {r.overridden ? ' ·已改' : ''}
          </Button>
        ))}
      </div>

      {active && (
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          {active.description}
        </Paragraph>
      )}

      <div style={{ marginBottom: 12 }}>
        <Text style={{ fontSize: 13 }}>温度 {temperature.toFixed(2)}</Text>
        <Slider
          min={0}
          max={1.5}
          step={0.05}
          value={temperature}
          onChange={setTemperature}
          style={{ margin: 0 }}
        />
      </div>

      <Input.TextArea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={20}
        style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5, lineHeight: 1.7 }}
      />

      <Space style={{ marginTop: 12 }}>
        <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
          保存
        </Button>
        <Button icon={<UndoOutlined />} onClick={restore}>
          恢复默认
        </Button>
      </Space>
    </Card>
  );
}
