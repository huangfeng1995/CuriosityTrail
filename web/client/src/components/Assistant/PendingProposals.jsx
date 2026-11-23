import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, App as AntApp } from 'antd';
import api from '../../api/client';

/**
 * 待确认的卡片提案列表。
 *
 * 左栏人物/设定/情节面板与右侧 AI 侧栏共用这一份交互：
 * 就地改标题 → 确认 / 丢弃。不另造一套流程，作者在哪看到都点得一样。
 *
 * 批量确认一次最多 5 条（与服务端上限一致），避免一屏提案被一键全点成事实。
 */
const MAX_BATCH = 5;

const KIND_LABELS = {
  character: '人物',
  setting: '设定',
  plot: '情节',
  inspiration: '灵感',
};

export default function PendingProposals({
  proposals,
  heading = '待确认',
  showKind = true,
  variant = 'sidebar',
}) {
  const [titles, setTitles] = useState({});
  const [busy, setBusy] = useState(false);
  const { message: toast } = AntApp.useApp();
  const draftCount = (proposals || []).filter((p) => p.stage === 'draft').length;

  // 确认/丢弃后广播一次：左栏面板、角标、右侧提案条都监听这个事件，
  // 谁先点的都能同步，不会出现「一边没了、另一边还挂着」。
  const notify = () => {
    window.dispatchEvent(new CustomEvent('ct:proposals-changed'));
  };

  // 卡片列表与提案是两份数据：确认后服务端已经建了卡，
  // 但人物/设定/情节面板自己的列表不会因此重拉。
  // 单独广播一次，只让「卡片列表」刷新，扫描/丢弃不用重拉。
  const notifyCards = () => {
    window.dispatchEvent(new CustomEvent('ct:cards-changed'));
  };

  // 提案换了（新扫描 / 切作品）就丢掉旧的编辑中标题，避免张冠李戴
  const idsKey = useMemo(() => (proposals || []).map((p) => p.id).join(','), [proposals]);
  useEffect(() => {
    setTitles({});
  }, [idsKey]);

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

        await api.post('/card-proposals/confirm', { ids: capped, edits });
        toast.success('已加入卡片');
        notifyCards();
        notify();
      } catch (e) {
        toast.warning(e.response?.data?.error || e.message || '确认失败，请重试');
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
        await api.post('/card-proposals/dismiss', { ids: [id] });
        notify();
      } catch (e) {
        toast.warning(e.response?.data?.error || e.message || '丢弃失败，请重试');
      } finally {
        setBusy(false);
      }
    },
    [busy, toast]
  );

  if (!proposals || !proposals.length) return null;

  return (
    <div className={`ct-card-props${variant === 'panel' ? ' is-in-panel' : ''}`}>
      <div className="ct-card-props-head">
        <span>
          {heading} · {proposals.length}
          {draftCount > 0 && (
            <span className="ct-card-props-draft-hint"> · {draftCount} 条草稿未进正文</span>
          )}
        </span>
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
            {showKind && (
              <span className={`ct-card-props-kind is-${p.kind}`}>
                {KIND_LABELS[p.kind] || p.kind}
              </span>
            )}
            <span
              className={`ct-card-props-stage is-${p.stage === 'draft' ? 'draft' : 'adopted'}`}
              title={
                p.stage === 'draft'
                  ? '还没写进正文；采纳后会补上具体章节与段落'
                  : '已经写进正文，出处已记录'
              }
            >
              {p.stage === 'draft' ? '草稿' : '已进正文'}
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
              {/* 灵感的确认只落到灵感速记，不自动转情节卡/设定 */}
              {p.kind === 'inspiration' ? '留作灵感' : '确认'}
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
