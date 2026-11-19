import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Spin, message } from 'antd';
import { SafetyCertificateOutlined, RobotOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 全书一致性检查。
 *
 * 分两层：
 *   规则层 —— 本地比对数据库里的结构化数据，免费、立刻出结果
 *             （人物写了没出场、别名重名、设定没落地、章名重复…）
 *   跨章层 —— 把各章摘要交给模型做一次总检，调用次数是个位数
 *             （时间线打架、性格突变、设定冲突…）
 *
 * 结论有生命周期：open / adopted / dismissed，状态以服务端为准。
 * 忽略过的结论服务端不再返回；已采纳的会带着 status 回来，面板只负责置灰。
 * 所以这里不再保存本地的「已采纳」集合，刷新后看到的就是库里的状态。
 *
 * 结果按章分组：跨章问题常常只指得出章、指不出原句，
 * 只有 locatable 为真才给「打开正文」。
 */

const SEVERITY_LABEL = {
  high: '严重',
  medium: '一般',
  low: '轻微',
};

const SOURCE_LABEL = {
  rule: '规则',
  cross_chapter: '跨章',
};

const POLL_INTERVAL_MS = 1200;

/** 章节标注：没有章就是全书；有章号带标题，缺章号只给标题。 */
function chapterLabel(issue) {
  if (!issue.chapterId) return '全书';
  if (issue.chapterSeq) {
    return `第 ${issue.chapterSeq} 章${issue.chapterTitle ? ` · ${issue.chapterTitle}` : ''}`;
  }
  return issue.chapterTitle || '未命名章节';
}

export default function ConsistencyPanel({ workId, chapterId, onOpenChapter }) {
  const [issues, setIssues] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState(null);
  // 单条结论的请求状态：{ id, action }；只用于禁用按钮，不参与结论去留
  const [busy, setBusy] = useState(null);

  const timerRef = useRef(null);
  const aliveRef = useRef(true);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  useEffect(() => {
    stopPolling();
    setJob(null);
    setIssues(null);
    setNotices([]);
    setBusy(null);
  }, [workId, stopPolling]);

  const poll = useCallback(
    (id) => {
      api
        .get(`/consistency/${workId}/ai/${id}`)
        .then((res) => {
          if (!aliveRef.current) return;
          const data = res.data || {};
          setJob({
            id,
            status: data.status,
            done: data.done || 0,
            total: data.total || 0,
            calls: data.calls || 0,
          });
          if (Array.isArray(data.issues)) setIssues(data.issues);
          if (Array.isArray(data.notices)) setNotices(data.notices);

          if (data.status === 'running') {
            timerRef.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
            return;
          }
          if (data.status === 'failed') {
            message.error(data.error || 'AI 检查没有跑完');
          } else if (!(data.issues || []).length) {
            message.success('没发现明显问题');
          }
        })
        .catch((e) => {
          if (!aliveRef.current) return;
          setJob(null);
          message.error(e.response?.data?.error || '检查结果取不回来');
        });
    },
    [workId]
  );

  const runRules = useCallback(async () => {
    if (!workId) return;
    stopPolling();
    setJob(null);
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
  }, [workId, stopPolling]);

  // 打开面板即拉一次规则层：免费，且能把库里已采纳/已忽略的状态带回来，
  // 刷新页面后面板和数据库不会两套记忆。
  useEffect(() => {
    if (workId) runRules();
  }, [workId, runRules]);

  const runAi = useCallback(async () => {
    if (!workId) return;
    stopPolling();
    setJob({ id: '', status: 'running', done: 0, total: 0, calls: 0 });
    setNotices([]);
    setIssues(null);

    try {
      const res = await api.post(`/consistency/${workId}/ai`);
      const data = res.data || {};
      if (data.done) {
        setIssues(data.issues || []);
        setNotices(data.notices || []);
        setJob(null);
        return;
      }
      setJob({
        id: data.jobId,
        status: 'running',
        done: data.done || 0,
        total: data.total || 0,
        calls: 0,
      });
      poll(data.jobId);
    } catch (e) {
      setJob(null);
      message.error(e.response?.data?.error || 'AI 检查没有跑起来');
    }
  }, [workId, poll, stopPolling]);

  /** 忽略：服务端返回 dismissed 后从列表里移走，刷新也不会再出现。 */
  const dismissIssue = useCallback(
    async (issue) => {
      if (!workId || !issue.id || busy) return;
      setBusy({ id: issue.id, action: 'dismiss' });
      try {
        const res = await api.post(
          `/consistency/${workId}/findings/${issue.id}/dismiss`
        );
        const updated = res.data?.finding;
        const finalId = updated?.id || issue.id;
        setIssues((prev) => (prev || []).filter((item) => item.id !== finalId));
        message.success('已忽略，这条结论不会再出现');
      } catch (e) {
        message.error(e.response?.data?.error || '忽略失败，请再试一次');
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    },
    [workId, busy]
  );

  /** 采纳：用服务端返回的 Finding 覆盖本地那条，状态以库为准。 */
  const adoptIssue = useCallback(
    async (issue) => {
      if (!workId || !issue.id || busy) return;
      setBusy({ id: issue.id, action: 'adopt' });
      try {
        const res = await api.post(
          `/consistency/${workId}/findings/${issue.id}/adopt`
        );
        const updated = res.data?.finding;
        setIssues((prev) =>
          (prev || []).map((item) =>
            item.id === issue.id
              ? { ...item, ...(updated || {}), status: updated?.status || 'adopted' }
              : item
          )
        );
        message.success('已采纳');
      } catch (e) {
        message.error(e.response?.data?.error || '采纳失败，请再试一次');
      } finally {
        if (aliveRef.current) setBusy(null);
      }
    },
    [workId, busy]
  );

  const { ruleIssues, groups } = useMemo(() => {
    const list = Array.isArray(issues) ? issues : [];
    const rules = list.filter((issue) => issue.type !== 'ai');

    const map = new Map();
    list
      .filter((issue) => issue.type === 'ai')
      .forEach((issue) => {
        const groupKey = issue.chapterId || '__book__';
        if (!map.has(groupKey)) {
          map.set(groupKey, {
            key: groupKey,
            chapterId: issue.chapterId || '',
            chapterSeq: issue.chapterSeq || 0,
            chapterTitle: issue.chapterTitle || '',
            items: [],
          });
        }
        map.get(groupKey).items.push(issue);
      });

    const groupsOut = [...map.values()].sort(
      (a, b) => (a.chapterSeq || 9999) - (b.chapterSeq || 9999)
    );
    return { ruleIssues: rules, groups: groupsOut };
  }, [issues]);

  const renderIssue = (issue) => {
    const isAdopted = issue.status === 'adopted';
    const isBusy = busy?.id === issue.id;
    const disabled = isAdopted || isBusy || job?.status === 'running';
    const locatable = issue.locatable === true && Boolean(issue.chapterId);
    const canJump =
      locatable && issue.chapterId !== chapterId && typeof onOpenChapter === 'function';

    return (
      <div
        key={issue.id}
        className={`ct-issue sev-${issue.severity || 'low'}${
          isAdopted ? ' is-adopted' : ''
        }`}
      >
        <div className="ct-issue-head">
          <span className="ct-issue-title">{issue.title}</span>
          <span className="ct-badge">{SEVERITY_LABEL[issue.severity] || '一般'}</span>
          {isAdopted && <span className="ct-finding-tag">已采纳</span>}
        </div>
        {issue.detail && <div className="ct-issue-detail">{issue.detail}</div>}
        {issue.quote && <div className="ct-issue-quote">原文：{issue.quote}</div>}

        <div className="ct-issue-meta">
          <span className={`ct-issue-source is-${issue.source || 'rule'}`}>
            {SOURCE_LABEL[issue.source] || '规则'}
          </span>
          <span className="ct-issue-where" title={chapterLabel(issue)}>
            {chapterLabel(issue)}
          </span>
          {canJump && (
            <Button
              size="small"
              type="link"
              className="ct-issue-jump"
              onClick={() => onOpenChapter(issue.chapterId)}
            >
              打开正文
            </Button>
          )}
          {!locatable && issue.chapterId && (
            <span className="ct-issue-unlocatable">定位不到原句</span>
          )}
        </div>

        <div className="ct-issue-ops">
          <Button
            size="small"
            type="link"
            disabled={disabled}
            loading={isBusy && busy.action === 'adopt'}
            onClick={() => adoptIssue(issue)}
          >
            采纳
          </Button>
          <Button
            size="small"
            type="text"
            disabled={disabled}
            loading={isBusy && busy.action === 'dismiss'}
            onClick={() => dismissIssue(issue)}
          >
            忽略
          </Button>
        </div>
      </div>
    );
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  const running = job?.status === 'running';

  return (
    <div className="ct-panel">
      <div className="ct-check-actions">
        <Button
          size="small"
          icon={<SafetyCertificateOutlined />}
          loading={loading}
          disabled={running}
          onClick={runRules}
        >
          规则检查
        </Button>
        <Button
          size="small"
          icon={<RobotOutlined />}
          loading={running}
          onClick={runAi}
        >
          AI 跨章检查
        </Button>
      </div>

      {running && (
        <div className="ct-ai-progress">
          <Spin size="small" />
          <span>
            {job.total
              ? `跨章检查中 · 已完成 ${job.done} / ${job.total} 次调用`
              : '正在准备跨章检查…'}
          </span>
        </div>
      )}

      {!running && job?.status === 'done' && job.calls > 0 && (
        <p className="ct-hint">跨章总检完成 · 本次调用模型 {job.calls} 次。</p>
      )}

      {notices.map((notice, i) => (
        <Alert key={i} type="warning" message={notice} className="ct-alert" />
      ))}

      {loading && !issues && (
        <div className="ct-loading">
          <Spin size="small" />
        </div>
      )}

      {ruleIssues.map(renderIssue)}

      {groups.map((group) => (
        <div key={group.key} className="ct-issue-group">
          <div className="ct-issue-group-head">
            <span className="ct-issue-group-title" title={chapterLabel(group)}>
              {chapterLabel(group)}
            </span>
            <span className="ct-badge">{group.items.length} 条</span>
          </div>
          {group.items.map(renderIssue)}
        </div>
      ))}

      {issues && !issues.length && !running && <p className="ct-hint">没发现问题。</p>}
    </div>
  );
}
