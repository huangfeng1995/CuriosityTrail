import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../../api/client';

/**
 * 作品的待确认卡片提案。
 *
 * 左栏三个卡片面板和 PanelNav 角标共用这一份数据——各自拉一遍会出现
 * 「角标还有、点进去是空的」这种不同步。
 *
 * 保存后的增量扫描、采纳后的即时识别都会广播 ct:proposals-changed，
 * 确认/丢弃后调用 refresh 即可。
 */
export default function usePendingProposals(workId) {
  const [proposals, setProposals] = useState([]);

  const refresh = useCallback(async () => {
    if (!workId) {
      setProposals([]);
      return;
    }
    try {
      const res = await api.get('/card-proposals', {
        params: { workId, status: 'pending' },
      });
      setProposals(Array.isArray(res.data?.proposals) ? res.data.proposals : []);
    } catch (e) {
      // 待确认是辅助信息：拉不到就不显示，不打断写作
    }
  }, [workId]);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh();
    window.addEventListener('ct:proposals-changed', onChanged);
    return () => window.removeEventListener('ct:proposals-changed', onChanged);
  }, [refresh]);

  // 按 kind 计数，给 PanelNav 出角标
  const counts = useMemo(() => {
    const acc = {};
    for (const p of proposals) acc[p.kind] = (acc[p.kind] || 0) + 1;
    return acc;
  }, [proposals]);

  /** 只取某一类（面板顶部只显示自己这一类） */
  const byKind = useCallback(
    (kind) => proposals.filter((p) => p.kind === kind),
    [proposals]
  );

  return { proposals, counts, byKind, refresh };
}
