import React, { useEffect, useState } from 'react';
import {
  Tabs,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Button,
  Card,
  message,
  Tag,
  Space,
  Alert,
  Typography,
  Slider,
  Tooltip,
} from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import api from '../api/client';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Text, Paragraph } = Typography;

/**
 * 可选模型列表。
 *
 * 角色可以单独指定模型——审稿、查资料这类需要推理的活儿，
 * 用强模型；续写正文用快模型更顺手。
 */
const MODEL_OPTIONS = [
  { value: 'deepseek-flash', label: 'deepseek-flash（快，日常写作）' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强，复杂推理）' },
];

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
          { key: 'backup', label: '备份', children: <BackupConfig /> },
        ]}
      />
    </div>
  );
}

function ProviderConfig() {
  const isMobile = useIsMobile();
  const [form] = Form.useForm();
  const [status, setStatus] = useState(null);
  const [testing, setTesting] = useState('');

  // 深度思考开关开着时，DeepSeek 会忽略温度（官方明确说明），
  // 所以温度滑块要置灰并说明原因，免得调了没反应还以为坏了。
  const deepseekThinking = Form.useWatch(['deepseek', 'thinking'], form);

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
                <Select options={MODEL_OPTIONS} />
              </Form.Item>
              <Space size={16} wrap>
                <Form.Item
                  name={['deepseek', 'temperature']}
                  label="温度"
                  style={{ marginBottom: 0 }}
                  help={
                    deepseekThinking
                      ? '深度思考开启时温度不生效（DeepSeek 官方限制）'
                      : undefined
                  }
                >
                  <Slider
                    min={0}
                    max={1.5}
                    step={0.05}
                    disabled={deepseekThinking}
                    style={{ width: isMobile ? '100%' : 140 }}
                  />
                </Form.Item>
                <Form.Item name={['deepseek', 'maxTokens']} label="最大输出" style={{ marginBottom: 0 }}>
                  <InputNumber min={1024} max={32768} step={1024} />
                </Form.Item>
                <Form.Item name={['deepseek', 'reasoningEffort']} label="思考档位" style={{ marginBottom: 0 }}>
                  <Select
                    style={{ width: 100 }}
                    disabled={!deepseekThinking}
                    options={[
                      { value: 'high', label: '高' },
                      { value: 'max', label: '最高' },
                    ]}
                  />
                </Form.Item>
              </Space>
              <div style={{ marginTop: 12 }}>
                <Form.Item
                  name={['deepseek', 'thinking']}
                  label="深度思考"
                  valuePropName="checked"
                  help="开启后模型先推理再作答，更准但更慢也更贵。注意：此时温度不生效。日常写作建议关闭。"
                  style={{ marginBottom: 0 }}
                >
                  <Switch />
                </Form.Item>
              </div>
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
              <Space size={16} wrap>
                <Form.Item name={['openaiCompat', 'temperature']} label="温度" style={{ marginBottom: 0 }}>
                  <Slider
                    min={0}
                    max={1.5}
                    step={0.05}
                    style={{ width: isMobile ? '100%' : 140 }}
                  />
                </Form.Item>
                <Form.Item name={['openaiCompat', 'maxTokens']} label="最大输出" style={{ marginBottom: 0 }}>
                  <InputNumber min={1024} max={32768} step={1024} />
                </Form.Item>
              </Space>
              <div style={{ marginTop: 12 }}>
                <Button size="small" loading={testing === 'openaiCompat'} onClick={() => test('openaiCompat')}>
                  测试连接
                </Button>
              </div>
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
              <Space size={16} wrap>
                <Form.Item name={['ollama', 'temperature']} label="温度" style={{ marginBottom: 0 }}>
                  <Slider
                    min={0}
                    max={1.5}
                    step={0.05}
                    style={{ width: isMobile ? '100%' : 140 }}
                  />
                </Form.Item>
                <Form.Item name={['ollama', 'maxTokens']} label="最大输出" style={{ marginBottom: 0 }}>
                  <InputNumber min={1024} max={32768} step={1024} />
                </Form.Item>
              </Space>
              <div style={{ marginTop: 12 }}>
                <Button size="small" loading={testing === 'ollama'} onClick={() => test('ollama')}>
                  测试连接
                </Button>
              </div>
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
  const isMobile = useIsMobile();
  const [roles, setRoles] = useState([]);
  const [activeKey, setActiveKey] = useState('writer');
  const [draft, setDraft] = useState('');
  const [temperature, setTemperature] = useState(0.8);
  const [followGlobalTemp, setFollowGlobalTemp] = useState(false);
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState('inherit');
  const [saving, setSaving] = useState(false);

  // 把某个角色的当前值搬进编辑区
  const fill = (role) => {
    if (!role) return;
    setDraft(role.systemPrompt);
    setTemperature(role.temperature ?? 0.8);
    setFollowGlobalTemp(role.temperature === null);
    setModel(role.model || '');
    setThinking(
      role.thinking === null || role.thinking === undefined
        ? 'inherit'
        : role.thinking
          ? 'on'
          : 'off'
    );
  };

  const load = async () => {
    try {
      const res = await api.get('/ai/roles');
      setRoles(res.data);
      fill(res.data.find((r) => r.key === activeKey));
    } catch (e) {
      message.error('角色加载失败');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const select = (key) => {
    setActiveKey(key);
    fill(roles.find((r) => r.key === key));
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/ai/prompts/${activeKey}`, {
        systemPrompt: draft,
        temperature: followGlobalTemp ? null : temperature,
        model,
        thinking: thinking === 'inherit' ? null : thinking === 'on',
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

  // 实时算出这个角色现在实际会不会开思考。
  // 作者在下拉框里一改就得立刻看到温度滑块置灰，不能等保存后才变。
  const thinkingOn = (() => {
    if (thinking === 'on') return true;
    if (thinking === 'off') return false;
    return active?.globalThinking ?? false;
  })();
  const temperatureDead = active?.provider === 'deepseek' && thinkingOn;
  const effectiveModel = model || active?.globalModel || '';

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

      <Space size={16} wrap style={{ marginBottom: 12 }}>
        <div>
          <Text style={{ fontSize: 13 }}>
            温度 {followGlobalTemp ? '（跟随全局）' : temperature.toFixed(2)}
          </Text>
          <div>
            <Tooltip
              title={
                temperatureDead
                  ? 'DeepSeek 思考模式下温度不生效（官方限制）。关闭深度思考后温度才会起作用。'
                  : ''
              }
            >
              <Slider
                min={0}
                max={1.5}
                step={0.05}
                value={temperature}
                disabled={followGlobalTemp || temperatureDead}
                onChange={setTemperature}
                style={{ margin: 0, width: isMobile ? '100%' : 180 }}
              />
            </Tooltip>
          </div>
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>模型</Text>
          <div>
            <Select
              value={model || '__inherit__'}
              onChange={(v) => setModel(v === '__inherit__' ? '' : v)}
              options={[
                { value: '__inherit__', label: '跟随全局设置' },
                ...MODEL_OPTIONS,
              ]}
              style={{ width: isMobile ? '100%' : 240 }}
            />
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            实际使用：{effectiveModel}
          </Text>
        </div>

        <div>
          <Text style={{ fontSize: 13 }}>深度思考</Text>
          <div>
            <Select
              value={thinking}
              onChange={setThinking}
              options={[
                { value: 'inherit', label: '跟随全局设置' },
                { value: 'on', label: '开启' },
                { value: 'off', label: '关闭' },
              ]}
              style={{ width: isMobile ? '100%' : 140 }}
            />
          </div>
        </div>
      </Space>

      {temperatureDead && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这个角色开着深度思考，温度参数不会生效（DeepSeek 官方限制：思考模式忽略 temperature）。"
          description="如果想用温度控制发散度，请把「深度思考」关掉；需要推理深度则保留开启，改为在提示词里要求更细致。"
        />
      )}

      <Space size={16} wrap style={{ marginBottom: 12 }}>
        <Tooltip title="勾上则用「AI 供应商」里设的全局温度，不单独指定">
          <label style={{ fontSize: 13 }}>
            <input
              type="checkbox"
              checked={followGlobalTemp}
              onChange={(e) => setFollowGlobalTemp(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            跟随全局温度
          </label>
        </Tooltip>
      </Space>

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

function BackupConfig() {
  const isMobile = useIsMobile();
  const [backups, setBackups] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/export/backups');
      setBackups(res.data || []);
    } catch (e) {
      // 备份列表拿不到不影响手动下载
    }
  };

  useEffect(() => {
    load();
  }, []);

  const createNow = async () => {
    setBusy(true);
    try {
      const res = await api.post('/export/backups');
      message.success(`已生成备份：${res.data.name}`);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '备份失败');
    } finally {
      setBusy(false);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  return (
    <Card size="small" title="备份">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="服务器每天凌晨 3 点自动备份一次，保留最近 7 份。"
        description="备份包含全部稿件、素材库、人物卡与设定。也可以现在手动生成一份，或直接下载完整备份到本地。"
      />

      <Space wrap style={{ marginBottom: 16 }}>
        <Button type="primary" loading={busy} onClick={createNow}>
          立即备份
        </Button>
        <Button href="/api/export/backup">下载完整备份</Button>
        <Button onClick={load}>刷新列表</Button>
      </Space>

      {backups.length === 0 ? (
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          还没有定时备份。点「立即备份」会马上生成一份。
        </Paragraph>
      ) : (
        <div style={{ fontSize: 13 }}>
          {backups.map((b) => (
            <div
              key={b.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 8,
                padding: '5px 0',
                borderBottom: '1px solid rgba(128,128,128,0.1)',
              }}
            >
              <Text style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{b.name}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {formatSize(b.size)}
              </Text>
              <Text
                type="secondary"
                style={{ fontSize: 12, width: isMobile ? '100%' : 160, textAlign: 'right' }}
              >
                {new Date(b.mtime).toLocaleString('zh-CN')}
              </Text>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
