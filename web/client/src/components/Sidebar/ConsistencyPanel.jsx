import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Spin, Tag, Typography, message, Alert } from 'antd';
import { SafetyCertificateOutlined, RobotOutlined } from '@ant-design/icons';
import api from '../../api/client';

const { Text } = Typography;

/**
 * 全书一致性检查。
 *
 * 分两层：
 *   规则层 —— 本地比对数据库里的结构化数据，免费、立刻出结果
 *             （人物写了没出场、别名重名、设定没落地、章名重复…）
 *   AI 层   —— 把全书摘要 + 人物卡 + 设定卡交给审稿人，找语义矛盾
 *             （时间线打架、性格突变、设定冲突…）
 *
 * AI 层要花钱也未必配置了模型，所以两个按钮分开：
 * 先跑规则层看免费的，再决定要不要花钱跑 AI。
 * AI 失败不会废掉规则层的结果。
 */

/** 严重程度对应的颜色 */
const SEVERITY_COLOR = {
  high: 'red',
  medium: 'orange',
  low: 'default',
};

const SEVERITY_LABEL = {
  high: '严重',
  medium: '一般',
  low: '轻微',
};

export default function ConsistencyPanel({ workId }) {
  const [issues, setIssues] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const runRules = useCallback(async () => {
    if (!workId) return;
    setLoading(true);
    try {
      const res = await api.get(`/consistency/${workId}`);
      setIssues(res.data?.issues || []);
      setNotices([]);
    } catch (e) {
      message.error(e.response?.data?.error || '检查失败');
    } finally {
      setLoading(false);
    }
  }, [workId]);

  const runAi = useCallback(async () => {
    if (!workId) return;
    setAiLoading(true);
    try {
      const res = await api.post(`/consistency/${workId}`);
      setIssues(res.data?.issues || []);
      setNotices(res.data?.notices || []);
      if (!(res.data?.issues || []).length) {
        message.success('没发现明显问题');
      }
    } catch (e) {
      message.error(e.response?.data?.error || 'AI 检查失败');
    } finally {
      setAiLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    setIssues(null);
    setNotices([]);
  }, [workId]);

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <div
        style={{
          display: 'flex',
          gap: 6,
          marginBottom: 10,
        }}
      >
        <Button
          size="small"
          icon={<SafetyCertificateOutlined />}
          loading={loading}
          onClick={runRules}
          style={{ flex: 1 }}
        >
          规则检查
        </Button>
        <Button
          size="small"
          icon={<RobotOutlined />}
          loading={aiLoading}
          onClick={runAi}
          style={{ flex: 1 }}
        >
          AI 深度检查
        </Button>
      </div>

      <div style={{ fontSize: 11, opacity: 0.5, lineHeight: 1.7, marginBottom: 10 }}>
        规则检查比对人物卡、设定卡与正文，不花钱。AI 深度检查读全书找前后矛盾，会调用模型。
      </div>

      {notices.map((n, i) => (
        <Alert
          key={i}
          type="warning"
          message={n}
          style={{ marginBottom: 8, fontSize: 12 }}
        />
      ))}

      {loading && !issues && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}>
          <Spin size="small" />
        </div>
      )}

      {issues && issues.length === 0 && (
        <div style={{ fontSize: 12, opacity: 0.55, padding: '8px 6px', lineHeight: 1.7 }}>
          没发现问题。人物卡、设定卡与正文对得上。
        </div>
      )}

      {issues?.map((issue, i) => (
        <div
          key={i}
          style={{
            padding: '7px 8px',
            marginBottom: 6,
            borderRadius: 6,
            background: 'rgba(128,128,128,0.06)',
            borderLeft: `2px solid ${
              issue.severity === 'high'
                ? '#ef4444'
                : issue.severity === 'medium'
                ? '#d97706'
                : 'rgba(128,128,128,0.35)'
            }`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <span style={{ flex: 1, fontSize: 13, lineHeight: 1.6 }}>{issue.title}</span>
            <Tag
              color={SEVERITY_COLOR[issue.severity] || 'default'}
              style={{ fontSize: 10, lineHeight: '16px', marginRight: 0 }}
            >
              {SEVERITY_LABEL[issue.severity] || '一般'}
            </Tag>
          </div>
          {issue.detail && (
            <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.7, marginTop: 3 }}>
              {issue.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
