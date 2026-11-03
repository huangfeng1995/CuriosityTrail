import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, App as AntApp } from 'antd';

/**
 * 卡片提案条。
 *
 * AI 从刚写完的正文里识别出新人物/新设定/新情节，先在这里排队等作者确认。
 * 确认才写进卡片表——未确认的提案不参与上下文装配，模型不能替作者定稿。
 *
 * 批量确认一次最多 5 条（与服务端上限一致），避免一屏提案被一键全点成事实。
 */
const MAX_BATCH = 5;

const KIND_LABELS = {
  character: '人物',
  setting: '设定',
  plot: '情节',
};

export default function CardProposals({ workId, chapterId, refreshToken }) {
  const [proposals, setProposals] = useState([]);
  const [titles, setTitles] = useState({});
  const [busy, setBusy] = useState(false);
  const { message: toast } = AntApp.useApp();

  const load = useCallback(() => {
    if (!workId) {
      setProposals([]);
      return;
    }

    let alive = true;
    fetch(`/api/card-proposals?workId=${encodeURIComponent(workId)}&status=pending`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data) return;
        setProposals(Array.isArray(data.proposals) ? data.proposals : []);
        setTitles({});
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [workId]);

  // 换章、换作品都要重拉：提案归属章节，串章会认错来源
  useEffect(() => load(), [load, chapterId, refreshToken]);

  const confirm = useCallback(
    async (ids) => {
      if (!ids.length || busy) return;
      const capped = ids.slice(0, MAX_BATCH);
      setBusy(true);
      try {
        const edits = {};
        for (const id of capped) {
          const title = titles[id];
          if (title && title.trim()) edits[id] = { title: title.trim() };
        }

        const res = await fetch('/api/card-proposals/confirm', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: capped, edits }),
        });
        if (!res.ok) throw new Error('确认失败');

        setProposals((prev) => prev.filter((p) => !capped.includes(p.id)));
      } catch (e) {
        toast.warning(e.message || '确认失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [busy, titles, toast]
  );

  const dismiss = useCallback(
    async (id) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await fetch('/api/card-proposals/dismiss', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [id] }),
        });
        if (!res.ok) throw new Error('丢弃失败');
        setProposals((prev) => prev.filter((p) => p.id !== id));
      } catch (e) {
        toast.warning(e.message || '丢弃失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [busy, toast]
  );

  if (!proposals.length) return null;

  return (
    <div className="ct-card-props">
      <div className="ct-card-props-head">
        <span>卡片提案 · {proposals.length}</span>
        {proposals.length > 1 && (
          <Button
            size="small"
            type="link"
            disabled={busy}
            onClick={() => confirm(proposals.slice(0, MAX_BATCH).map((p) => p.id))}
          >
            全部确认（最多 {MAX_BATCH} 条）
          </Button>
        )}
      </div>

      {proposals.map((p) => (
        <div className="ct-card-props-row" key={p.id}>
          <div className="ct-card-props-line">
            <span className={`ct-card-props-kind is-${p.kind}`}>
              {KIND_LABELS[p.kind] || p.kind}
            </span>
            <Input
              size="small"
              value={titles[p.id] ?? p.title}
              onChange={(e) =>
                setTitles((prev) => ({ ...prev, [p.id]: e.target.value }))
              }
              aria-label="卡片标题"
            />
          </div>
          {(p.content || p.sourceQuote) && (
            <div className="ct-card-props-note">
              {p.content}
              {p.sourceQuote ? `「${p.sourceQuote}」` : ''}
            </div>
          )}
          <div className="ct-card-props-ops">
            <Button size="small" type="primary" disabled={busy} onClick={() => confirm([p.id])}>
              确认
            </Button>
            <Button size="small" type="text" disabled={busy} onClick={() => dismiss(p.id)}>
              丢弃
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
