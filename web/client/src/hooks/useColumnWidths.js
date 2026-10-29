import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'ct.workspace.columns';
const COLLAPSE_KEY = 'ct.workspace.collapsed';

/**
 * 各栏宽度上下限。
 *
 * 左栏装目录树与 7 个资料面板，再窄就挤成一团；
 * 右栏装 AI 对话与输入框，过宽会让正文失去主次。
 */
export const LIMITS = {
  left: { min: 220, max: 520 },
  right: { min: 300, max: 620 },
};

const DEFAULTS = { left: 288, right: 352 };
const COLLAPSED_DEFAULTS = { left: false, right: false };

/** 中间编辑区的最小宽度。左右两栏加起来不能把正文挤没。 */
const CENTER_MIN = 420;

const clamp = (v, { min, max }) => Math.min(Math.max(v, min), max);

/**
 * 工作区栏宽 + 折叠状态。
 *
 * 宽度写进 localStorage：下次进来还是上次的样子。
 * 折叠状态也持久化：收起的栏下次进来仍是收起的。
 * 拖动时左右两栏互相让位，中间永远留够正文的位置。
 */
export default function useColumnWidths() {
  const [widths, setWidths] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        return {
          left: clamp(Number(saved.left) || DEFAULTS.left, LIMITS.left),
          right: clamp(Number(saved.right) || DEFAULTS.right, LIMITS.right),
        };
      }
    } catch {
      // 存储不可用（隐私模式）就用默认值
    }
    return DEFAULTS;
  });

  const [collapsed, setCollapsed] = useState(() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        return { left: !!saved.left, right: !!saved.right };
      }
    } catch {
      // 存储不可用就用默认值
    }
    return COLLAPSED_DEFAULTS;
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // 存不下就算了，本次会话内仍然生效
    }
  }, [widths]);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed));
    } catch {
      // 存不下就算了
    }
  }, [collapsed]);

  /**
   * 改某栏宽度。
   *
   * 另一栏宽度固定，本栏最多能长到「窗口宽度 − 另一栏 − 正文最小宽」。
   */
  const setWidth = useCallback((side, value) => {
    setWidths((prev) => {
      const other = side === 'left' ? prev.right : prev.left;
      const room = window.innerWidth - other - CENTER_MIN;
      const limit = { min: LIMITS[side].min, max: Math.max(LIMITS[side].min, room) };
      return { ...prev, [side]: clamp(value, limit) };
    });
  }, []);

  const setLeft = useCallback((v) => setWidth('left', v), [setWidth]);
  const setRight = useCallback((v) => setWidth('right', v), [setWidth]);

  /** 双击把手：回到默认宽度。 */
  const reset = useCallback((side) => {
    setWidths((prev) => ({ ...prev, [side]: DEFAULTS[side] }));
  }, []);

  /** 折叠 / 展开某栏。折叠时栏宽不丢，展开后恢复上次的宽度。 */
  const toggleCollapse = useCallback((side) => {
    setCollapsed((prev) => ({ ...prev, [side]: !prev[side] }));
  }, []);

  const toggleLeft = useCallback(() => toggleCollapse('left'), [toggleCollapse]);
  const toggleRight = useCallback(() => toggleCollapse('right'), [toggleCollapse]);

  // 窗口缩小后重新收敛栏宽，避免正文被挤没
  useEffect(() => {
    const onResize = () => {
      setWidths((prev) => {
        const maxSum = window.innerWidth - CENTER_MIN;
        if (prev.left + prev.right <= maxSum) return prev;
        const scale = maxSum / (prev.left + prev.right);
        return {
          left: clamp(Math.round(prev.left * scale), LIMITS.left),
          right: clamp(Math.round(prev.right * scale), LIMITS.right),
        };
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { widths, collapsed, setLeft, setRight, reset, toggleLeft, toggleRight };
}
