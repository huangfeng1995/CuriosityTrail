import React, { useCallback, useEffect, useState } from 'react';
import {
  Tabs,
  Input,
  Button,
  Card,
  message,
  Space,
  Alert,
  Typography,
  Switch,
  Descriptions,
} from 'antd';
import {
  SaveOutlined,
  UndoOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import api from '../api/client';
import { useAuth } from '../store/auth';
import { useIsMobile } from '../hooks/useMediaQuery';
import { useMemoryPref } from '../hooks/useMemoryPref';

const { Text, Paragraph } = Typography;

/**
 * 设置页。
 *
 * 供应商配置、连接状态、模型/温度/深度思考这些参数都是部署期
 * 的运维细节，客户写作用不到，所以设置页里一个不留。
 * 留下的是客户真正需要的两件事：调每个 AI 角色的提示词、
 * 以及稿件的备份。
 */
export default function SettingsPage() {
  const { user } = useAuth();

  const items = [
    { key: 'prompts', label: '角色提示词', children: <PromptConfig /> },
    { key: 'memory', label: '长期记忆', children: <MemoryConfig /> },
  ];
  // 备份是整库级别的：下载包里是所有人的稿子，只有管理员能看这个入口
  if (user?.role === 'admin') {
    items.push({ key: 'backup', label: '备份', children: <BackupConfig /> });
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <Tabs defaultActiveKey="prompts" items={items} />
    </div>
  );
}

/**
 * 长期记忆设置。
 *
 * 作者在这里能做的只有三件事：开不开、看看索引建得怎么样、重建。
 * 模型名、维度这些是部署期的事，不摆给作者看。
 */
function MemoryConfig() {
  const [enabled, setEnabled] = useMemoryPref();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/memory/status');
      setStatus(res.data);
    } catch (e) {
      message.error('记忆状态获取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const res = await api.post('/memory/rebuild', { scope: 'mine' });
      message.success(`已安排重建 ${res.data.scheduled} 个来源，稍后自动完成`);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '重建失败');
    } finally {
      setRebuilding(false);
    }
  };

  const stats = status?.stats || {};
  const running = status?.serviceRunning;

  return (
    <Card size="small" title="长期记忆">
      <Paragraph type="secondary" style={{ fontSize: 13 }}>
        长期记忆会自动从你的章节、人物卡、设定卡和往期对话里翻出与当前写作相关的内容，
        一起交给 AI。它记的是「这部作品自己的历史」，素材库不在其中。
      </Paragraph>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 0',
          borderTop: '1px solid var(--border-faint)',
          borderBottom: '1px solid var(--border-faint)',
          marginBottom: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 14 }}>在对话中使用长期记忆</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            关掉后 AI 不再自动回忆前情。也可以随时在 AI 侧边栏的输入框旁临时关闭。
          </div>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>

      {status && !status.enabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="记忆服务当前处于关闭状态"
          description="需要部署方在服务端启用后才能使用。"
        />
      )}

      {status && !running && status.enabled && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="记忆服务没有运行"
          description="AI 会照常工作，只是不会自动回忆前情。"
        />
      )}

      {status && !status.indexConsistent && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="索引与当前记忆服务不一致"
          description={`${status.consistencyReason}。请点下面的「重建索引」。`}
        />
      )}

      <Descriptions size="small" column={2} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="服务状态">
          {status ? (
            <Text type={running ? 'success' : 'danger'}>
              {running ? '运行中' : '未运行'}
            </Text>
          ) : (
            '—'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="记忆来源数">{stats.works ?? 0} 部作品</Descriptions.Item>
        <Descriptions.Item label="已建索引">
          {stats.indexed ?? 0} 块
        </Descriptions.Item>
        <Descriptions.Item label="待处理">
          {stats.pending ?? 0} 块
        </Descriptions.Item>
        <Descriptions.Item label="失败">
          <Text type={stats.failed ? 'danger' : undefined}>{stats.failed ?? 0} 块</Text>
        </Descriptions.Item>
        <Descriptions.Item label="合计">{stats.total ?? 0} 块</Descriptions.Item>
      </Descriptions>

      <Space wrap>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新状态
        </Button>
        <Button type="primary" onClick={rebuild} loading={rebuilding} disabled={!running}>
          重建索引
        </Button>
      </Space>

      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        重建只动索引，不改你的稿子。章节、人物、设定改动后会自动增量更新，
        一般不需要手动重建。
      </Paragraph>
    </Card>
  );
}

/**
 * 角色提示词编辑。
 *
 * 客户可以按自己的喜好微调每个 AI 角色的默认提示词（写手、编辑、
 * 审稿人、灵感师、资料员）。模型、温度、深度思考这些参数不暴露，
 * 由服务端统一配置。
 */
function PromptConfig() {
  const [roles, setRoles] = useState([]);
  const [activeKey, setActiveKey] = useState('writer');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // 把某个角色的当前提示词搬进编辑区
  const fill = (role) => {
    if (!role) return;
    setDraft(role.systemPrompt);
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
