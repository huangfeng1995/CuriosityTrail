import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../api/client';
import { useWorkspace } from '../../store/workspace';

/**
 * 「这张卡在正文里出现在哪」。
 *
 * 统计在服务端做：正文在 blocks 里，前端要跨章统计就得先把整部作品拉下来。
 * 这里只负责把结果按卡片 id 归好，并驱动正文的标黄。
 *
 * 卡片选中后通过 window 事件通知编辑器：
 *   ct:card-highlight  detail = { words, label, blockId? }
 * 编辑器在 ChapterEditor 里监听，命中词所在的块会整块标黄。
 * 用事件而不是放进 store：高亮是纯视图状态，换章、关面板都该自动消失，
 * 塞进全局状态反而要额外维护清理逻辑。
 */

export const CARD_HIGHLIGHT_EVENT = 'ct:card-highlight';

/** 通知正文标出这些词；words 为空即取消标黄。 */
export function emitCardHighlight({ words = [], label = '', blockId = '' }) {
  window.dispatchEvent(
    new CustomEvent(CARD_HIGHLIGHT_EVENT, {
      detail: { words, label, blockId },
    })
  );
}

/**
 * @param {string} workId
 * @param {Array<{id: string, key?: string, label: string, words: string[]}>} cards
 */
export default function useCardOccurrences(workId, cards) {
  const { chapter, loadChapter } = useWorkspace();
  const [stats, setStats] = useState({});
  const [selectedId, setSelectedId] = useState('');

  // 卡片内容一改就重扫。用 id + 词表做签名，避免数组引用变化导致无谓请求。
  const signature = useMemo(
    () => (cards || []).map((c) => `${c.id}:${(c.words || []).join(',')}`).join('|'),
    [cards]
  );

  // scan 只依赖签名：面板每次 load 都会生成新数组，直接依赖 cards 会反复重扫
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const scan = useCallback(async () => {
    const list = cardsRef.current || [];
    if (!workId || !signature) {
      setStats({});
      return;
    }
    const items = list
      .filter((c) => c.words && c.words.length)
      .map((c) => ({ key: c.id, words: c.words }));
    if (!items.length) {
      setStats({});
      return;
    }
    try {
      const res = await api.post('/occurrences/scan', { workId, items });
      setStats(res.data || {});
    } catch (e) {
      // 统计失败不打断编辑：卡片列表照常可用，只是不显示处数
      setStats({});
    }
  }, [workId, signature]);

  useEffect(() => {
    scan();
  }, [scan]);

  // 换作品时把选中状态和高亮一起清掉，否则旧作品的名字会标在新作品上
  useEffect(() => {
    setSelectedId('');
    emitCardHighlight({ words: [] });
  }, [workId]);

  const selectedCard = useMemo(
    () => (cards || []).find((c) => c.id === selectedId) || null,
    [cards, selectedId]
  );

  const toggle = useCallback(
    (card) => {
      if (!card) return;
      if (selectedId === card.id) {
        setSelectedId('');
        emitCardHighlight({ words: [] });
        return;
      }
      setSelectedId(card.id);
      emitCardHighlight({ words: card.words || [], label: card.label || '' });
    },
    [selectedId]
  );

  const goto = useCallback(
    async (entry) => {
      if (!entry?.chapterId || !selectedCard) return;
      if (chapter?.id !== entry.chapterId) {
        await loadChapter(entry.chapterId);
      }
      emitCardHighlight({
        words: selectedCard.words || [],
        label: selectedCard.label || '',
        blockId: entry.firstBlockId,
      });
    },
    [chapter, loadChapter, selectedCard]
  );

  const clear = useCallback(() => {
    setSelectedId('');
    emitCardHighlight({ words: [] });
  }, []);

  return { stats, selectedId, selectedCard, toggle, goto, clear, rescan: scan };
}
