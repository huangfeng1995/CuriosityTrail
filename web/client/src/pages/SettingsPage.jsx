import React, { useEffect, useState } from 'react';
import {
  Tabs,
  Input,
  Button,
  Card,
  message,
  Space,
  Alert,
  Typography,
} from 'antd';
import {
  SaveOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import api from '../api/client';
import { useIsMobile } from '../hooks/useMediaQuery';

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
  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
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
