import React, { useEffect, useState } from 'react';
import {
  Tabs,
  Input,
  Select,
  Button,
  Card,
  message,
  Space,
  Alert,
  Typography,
  Slider,
  Tooltip,
} from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SaveOutlined,
  UndoOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
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
 * 设置页。
 *
 * 原本有「AI 供应商」标签页让用户填 API Key。这是部署期的运维动作，
 * 不是写作期该操心的事——密钥由服务器环境变量提供，所以整页拿掉。
 * 用户仍然需要知道「AI 现在能不能用」，所以保留一张只读状态卡。
 */
export default function SettingsPage() {
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <AiStatusCard />
      <Tabs
        defaultActiveKey="prompts"
        items={[
          { key: 'prompts', label: '角色提示词', children: <PromptConfig /> },
          { key: 'backup', label: '备份', children: <BackupConfig /> },
        ]}
      />
    </div>
  );
}

/**
 * AI 连接状态（只读）。
 *
 * 想知道 AI 能不能用、当前跑的是哪个模型、额度还剩多少，
 * 看这里就够了。改配置是部署的事，不在这里暴露。
 */
function AiStatusCard() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/ai/status');
      setStatus(res.data);
    } catch (e) {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <Card size="small" title="AI 状态" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {status?.active?.name ? (
          <Text style={{ color: 'var(--bamboo)', fontWeight: 600 }}>
            {status.active.name}
            {status.active.degraded ? '（降级运行）' : ''}
          </Text>
        ) : (
          <Text style={{ color: 'var(--cinnabar)', fontWeight: 600 }}>暂不可用</Text>
        )}
        <span style={{ flex: 1 }} />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
          刷新
        </Button>
      </div>

      {status?.providers?.map((p) => (
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
            <CheckCircleOutlined style={{ color: 'var(--bamboo)' }} />
          ) : (
            <CloseCircleOutlined style={{ color: 'var(--text-quaternary)' }} />
          )}
          <Text style={{ width: 110 }}>{p.name}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {p.detail}
          </Text>
        </div>
      ))}

      {status?.active?.reason && !status?.active?.name && (
        <Alert type="warning" message={status.active.reason} style={{ marginTop: 8 }} />
      )}
    </Card>
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
      <div className="ct-role-picker">
        {roles.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`ct-role-pick${r.key === activeKey ? ' is-active' : ''}`}
            onClick={() => select(r.key)}
          >
            <span className="ct-role-pick-icon" aria-hidden="true">
              {r.icon}
            </span>
            <span className="ct-role-pick-name">{r.name}</span>
            {r.overridden ? <span className="ct-role-pick-dot" title="已自定义" /> : null}
          </button>
        ))}
      </div>

      {active && (
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          {active.description}
        </Paragraph>
      )}

      <div className="ct-params">
        <div className="ct-param">
          <div className="ct-param-label">
            温度 {followGlobalTemp ? '（跟随全局）' : temperature.toFixed(2)}
          </div>
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
              style={{ margin: 0, width: '100%' }}
            />
          </Tooltip>
        </div>

        <div className="ct-param">
          <div className="ct-param-label">模型</div>
          <Select
            value={model || '__inherit__'}
            onChange={(v) => setModel(v === '__inherit__' ? '' : v)}
            options={[
              { value: '__inherit__', label: '跟随全局设置' },
              ...MODEL_OPTIONS,
            ]}
            style={{ width: '100%' }}
          />
          <div className="ct-param-hint">实际使用：{effectiveModel || '未指定'}</div>
        </div>

        <div className="ct-param">
          <div className="ct-param-label">深度思考</div>
          <Select
            value={thinking}
            onChange={setThinking}
            options={[
              { value: 'inherit', label: '跟随全局设置' },
              { value: 'on', label: '开启' },
              { value: 'off', label: '关闭' },
            ]}
            style={{ width: '100%' }}
          />
        </div>
      </div>

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
        <Tooltip title="勾上则用服务端配置的全局温度，不单独指定">
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
                borderBottom: '1px solid var(--border-faint)',
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
