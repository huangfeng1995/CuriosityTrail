import React, { useCallback, useEffect, useState } from 'react';
import api from '../../api/client';
import PendingProposals from './PendingProposals';

/**
 * 右侧 AI 侧栏里的卡片提案条。
 *
 * 只负责拉数据；确认/丢弃的交互在 PendingProposals 里，
 * 与左栏人物/设定/情节面板共用同一套流程。
 */
export default function CardProposals({ workId, chapterId, refreshToken }) {
  const [proposals, setProposals] = useState([]);

  const load = useCallback(() => {
    if (!workId) {
      setProposals([]);
      return undefined;
    }

    let alive = true;
    api
      .get('/card-proposals', { params: { workId, status: 'pending' } })
      .then((res) => {
        if (!alive) return;
        setProposals(Array.isArray(res.data?.proposals) ? res.data.proposals : []);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [workId]);

  // 换章、换作品都要重拉：提案归属章节，串章会认错来源。
  // 保存后的增量扫描也会广播 ct:proposals-changed，让这里跟着刷新。
  useEffect(() => {
    const cleanup = load();
    const onChanged = () => load();
    window.addEventListener('ct:proposals-changed', onChanged);
    return () => {
      cleanup?.();
      window.removeEventListener('ct:proposals-changed', onChanged);
    };
  }, [load, chapterId, refreshToken]);

  return <PendingProposals proposals={proposals} heading="卡片提案" />;
}
