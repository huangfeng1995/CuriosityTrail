import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Spin, message } from 'antd';
import { SafetyCertificateOutlined, RobotOutlined } from '@ant-design/icons';
import api from '../../api/client';

/**
 * 全书一致性检查。
 *
 * 分两层：
 *   规则层 —— 本地比对数据库里的结构化数据，免费、立刻出结果
 *             （人物写了没出场、别名重名、设定没落地、章名重复…）
 *   AI 层   —— 把整本正文按字数切批逐段精读，再汇总做一次跨章总检
 *             （时间线打架、性格突变、设定冲突…）
 *
 * AI 层要读完整本书，耗时以分钟计，所以走「起任务 + 轮询」：
 * 路由只负责返回任务号，进度和结果都靠轮询拿。
 *
 * 结果按章分组：写到哪一章就在哪一章采纳，勾选后一次交给写手改；
 * 别的章的意见给「去这一章」，因为写手一次只改一章的正文。
 */

const SEVERITY_LABEL = {
  high: '严重',
  medium: '一般',
  low: '轻微',
};

const POLL_INTERVAL_MS = 1200;

export default function ConsistencyPanel({ workId, chapterId, onOpenChapter }) {
  const [issues, setIssues] = useState(null);
  const [notices, setNotices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState(null);
  const [selected, setSelected] = useState([]);
  const [adopted, setAdopted] = useState(() => new Set());
  const [adopting, setAdopting] = useState(false);

  const timerRef = useRef(null);
  const aliveRef = useRef(true);
  // 发起批量采纳那一刻的勾选快照：回执到达时用它标记，避免中途改选导致错标
  const pendingRef = useRef([]);

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
    setSelected([]);
    pendingRef.current = [];
  }, [workId, stopPolling]);

  const poll = useCallback(
    (id) => {
      api
        .get(`/consistency/${workId}/ai/${id}`)
        .then((res) => {
          if (!aliveRef.current) return;
          const data = res.data || {};
          setJob({ id, status: data.status, done: data.done || 0, total: data.total || 0 });
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
    stopPolling();
    setJob({ id: '', status: 'running', done: 0, total: 0 });
    setSelected([]);
    pendingRef.current = [];
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
      setJob({ id: data.jobId, status: 'running', done: 0, total: data.total || 0 });
      poll(data.jobId);
    } catch (e) {
      setJob(null);
      message.error(e.response?.data?.error || 'AI 检查没有跑起来');
    }
  }, [workId, poll, stopPolling]);

  /** 侧栏批量采纳的回执：成功才标记，失败保持可勾选。 */
  useEffect(() => {
    const onResult = (e) => {
      const detail = e.detail || {};
      if (detail.source !== 'consistency') return;
      setAdopting(false);
      if (!detail.ok) return;

      const keys = pendingRef.current;
      setAdopted((prev) => {
        const next = new Set(prev);
        keys.forEach((key) => next.add(key));
        return next;
      });
      setSelected([]);
      pendingRef.current = [];
      message.success('已交给写手修改');
    };
    window.addEventListener('ct:adopt-result', onResult);
    return () => window.removeEventListener('ct:adopt-result', onResult);
  }, []);

  const { ruleIssues, groups } = useMemo(() => {
    const list = Array.isArray(issues) ? issues : [];
    const rules = list.filter((issue) => issue.type !== 'ai');

    const map = new Map();
    list
      .filter((issue) => issue.type === 'ai')
      .forEach((issue, index) => {
        const key = `consistency:${issue.chapterId || 'book'}:${index}`;
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
        map.get(groupKey).items.push({ ...issue, key });
      });

    const groupsOut = [...map.values()].sort(
      (a, b) => (a.chapterSeq || 9999) - (b.chapterSeq || 9999)
    );
    return { ruleIssues: rules, groups: groupsOut };
  }, [issues]);

  const toggle = (key) => {
    setSelected((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const adoptSelected = () => {
    if (!selected.length || adopting) return;
    const all = groups.flatMap((group) => group.items);
    const findings = selected
      .map((key) => all.find((issue) => issue.key === key))
      .filter(Boolean)
      .map((issue) => ({
        key: issue.key,
        quote: issue.quote,
        text: [issue.title, issue.detail].filter(Boolean).join('：'),
        status: 'located',
        blockId: issue.blockId || '',
      }));

    if (!findings.length) return;
    pendingRef.current = [...selected];
    setAdopting(true);
    window.dispatchEvent(
      new CustomEvent('ct:adopt-findings', {
        detail: { findings, source: 'consistency' },
      })
    );
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  const running = job?.status === 'running';
  const selectableCount = groups.reduce(
    (sum, group) =>
      sum +
      (group.chapterId === chapterId
        ? group.items.filter((issue) => issue.quote && !adopted.has(issue.key)).length
        : 0),
    0
  );

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
          AI 深度检查
        </Button>
      </div>

      <p className="ct-hint">
        规则检查比对人物卡、设定卡与正文，不花钱。AI 深度检查逐批读完整个正文，
        再汇总找跨章矛盾，会调用模型、需要等一会儿。
      </p>

      {running && (
        <div className="ct-ai-progress">
          <Spin size="small" />
          <span>
            {job.total
              ? `正在精读第 ${Math.min(job.done + 1, job.total)} / ${job.total} 批…`
              : '正在准备全书检查…'}
          </span>
        </div>
      )}

      {notices.map((notice, i) => (
        <Alert key={i} type="warning" message={notice} className="ct-alert" />
      ))}

      {loading && !issues && (
        <div className="ct-loading">
          <Spin size="small" />
        </div>
      )}

      {ruleIssues.map((issue, i) => (
        <div key={`rule-${i}`} className={`ct-issue sev-${issue.severity || 'low'}`}>
          <div className="ct-issue-head">
            <span className="ct-issue-title">{issue.title}</span>
            <span className="ct-badge">{SEVERITY_LABEL[issue.severity] || '一般'}</span>
          </div>
          {issue.detail && <div className="ct-issue-detail">{issue.detail}</div>}
        </div>
      ))}

      {groups.map((group) => (
        <div key={group.key} className="ct-issue-group">
          <div className="ct-issue-group-head">
            <span className="ct-issue-group-title">
              {group.chapterSeq
                ? `第 ${group.chapterSeq} 章 ${group.chapterTitle}`
                : '全书'}
            </span>
            <span className="ct-badge">{group.items.length} 条</span>
            {group.chapterId && group.chapterId !== chapterId && onOpenChapter && (
              <Button
                size="small"
                type="link"
                className="ct-issue-group-link"
                onClick={() => onOpenChapter(group.chapterId)}
              >
                去这一章
              </Button>
            )}
          </div>

          {group.items.map((issue) => {
            const isAdopted = adopted.has(issue.key);
            const selectable =
              group.chapterId === chapterId && Boolean(issue.quote) && !isAdopted;

            return (
              <div
                key={issue.key}
                className={`ct-issue sev-${issue.severity || 'low'}${
                  isAdopted ? ' is-adopted' : ''
                }`}
              >
                <div className="ct-issue-head">
                  {selectable && (
                    <span className="ct-issue-check">
                      <Checkbox
                        checked={selected.includes(issue.key)}
                        onChange={() => toggle(issue.key)}
                        aria-label={`选择这条意见：${issue.title}`}
                      />
                    </span>
                  )}
                  <span className="ct-issue-title">{issue.title}</span>
                  <span className="ct-badge">{SEVERITY_LABEL[issue.severity] || '一般'}</span>
                  {isAdopted && <span className="ct-finding-tag">已采纳</span>}
                </div>
                {issue.detail && <div className="ct-issue-detail">{issue.detail}</div>}
                {issue.quote && (
                  <div className="ct-issue-quote">原文：{issue.quote}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {issues && !issues.length && !running && (
        <p className="ct-hint">没发现问题。人物卡、设定卡与正文对得上。</p>
      )}

      {selectableCount > 0 && (
        <div className="ct-issue-batch">
          <Button
            size="small"
            type="primary"
            disabled={!selected.length}
            loading={adopting}
            onClick={adoptSelected}
          >
            采纳选中（{selected.length}）
          </Button>
        </div>
      )}
    </div>
  );
}
