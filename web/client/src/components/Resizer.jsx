import React, { useEffect, useRef, useState } from 'react';

/**
 * 分栏拖拽把手。
 *
 * 用 Pointer Events 而非 mouse 事件：触控板、触屏、鼠标一套代码通吃。
 * 指针捕获后即使拖出把手范围，事件仍然回到把手上。
 *
 * @param {'left'|'right'} side 所属栏：left 表示把手在左栏右缘，拖动方向与栏宽同向
 * @param {number} value 当前栏宽
 * @param {number} min 最小宽度
 * @param {number} max 最大宽度
 * @param {(v: number) => void} onChange 拖动过程中的宽度
 * @param {() => void} onReset 双击复位
 * @param {() => void} [onCollapse] 收起本栏（可选，传入则在把手顶部显示折叠按钮）
 */
export default function Resizer({ side, value, min, max, onChange, onReset, onCollapse }) {
  const [dragging, setDragging] = useState(false);
  // 记录起点：每次按下都从这里算，拖到边界再拖回来不会累积误差
  const anchor = useRef(null);

  const handleDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    anchor.current = { x: e.clientX, value };
    setDragging(true);
    document.body.classList.add('ct-resizing');
  };

  const handleMove = (e) => {
    if (!anchor.current) return;
    const delta = e.clientX - anchor.current.x;
    // 右栏的把手在栏的左缘，往右拖栏变窄
    onChange(side === 'left' ? anchor.current.value + delta : anchor.current.value - delta);
  };

  const handleUp = (e) => {
    if (!anchor.current) return;
    anchor.current = null;
    setDragging(false);
    document.body.classList.remove('ct-resizing');
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  // 拖到一半切走标签页：把手的状态要收干净，别把整页光标卡在 col-resize
  useEffect(() => () => {
    anchor.current = null;
    document.body.classList.remove('ct-resizing');
  }, []);

  const handleKey = (e) => {
    const step = e.shiftKey ? 40 : 12;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(value - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(value + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      className={`ct-resizer is-${side}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? '调整左栏宽度' : '调整右栏宽度'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="拖动调整宽度，双击复位"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      onDoubleClick={onReset}
      onKeyDown={handleKey}
    >
      {onCollapse && (
        <button
          type="button"
          className="ct-resizer-collapse"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onCollapse();
          }}
          title={side === 'left' ? '收起左栏' : '收起右栏'}
          aria-label={side === 'left' ? '收起左栏' : '收起右栏'}
        >
          {side === 'left' ? '‹' : '›'}
        </button>
      )}
    </div>
  );
}
