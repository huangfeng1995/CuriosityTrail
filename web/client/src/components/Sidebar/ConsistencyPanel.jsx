import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Spin, Typography, message, Alert } from 'antd';
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
    <div className="ct-panel">
      <div className="ct-check-actions">
        <Button
          size="small"
          icon={<SafetyCertificateOutlined />}
          loading={loading}
          onClick={runRules}
        >
          规则检查
        </Button>
        <Button
          size="small"
          icon={<RobotOutlined />}
          loading={aiLoading}
          onClick={runAi}
        >
          AI 深度检查
        </Button>
      </div>

      <p className="ct-hint">
        规则检查比对人物卡、设定卡与正文，不花钱。AI 深度检查读全书找前后矛盾，会调用模型。
      </p>

      {notices.map((n, i) => (
        <Alert key={i} type="warning" message={n} className="ct-alert" />
      ))}

      {loading && !issues && (
        <div className="ct-loading">
          <Spin size="small" />
        </div>
      )}

      {issues && issues.length === 0 && (
        <p className="ct-hint">没发现问题。人物卡、设定卡与正文对得上。</p>
      )}

      {issues?.map((issue, i) => (
        <div key={i} className={`ct-issue sev-${issue.severity || 'low'}`}>
          <div className="ct-issue-head">
            <span className="ct-issue-title">{issue.title}</span>
            <span className="ct-badge">{SEVERITY_LABEL[issue.severity] || '一般'}</span>
          </div>
          {issue.detail && <div className="ct-issue-detail">{issue.detail}</div>}
        </div>
      ))}
    </div>
  );
}
