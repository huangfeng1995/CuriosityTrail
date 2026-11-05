import React, { useState } from 'react';
import { Tooltip, Spin } from 'antd';
import { X } from 'lucide-react';
import { BLOCK_TYPES, MARKABLE_TYPES } from './blocks';

/**
 * 行内工具条。
 *
 * 选中文本后浮在选区上方：
 *  - 「标记」：把这段文字标成正文 / 对白 / 独白（拆块由父组件统一处理）
 *  - 其余动作调 /api/ai/inline 拿回结构化结果，由父组件写回块内并提示可撤销
 */

const MARK_TARGETS = BLOCK_TYPES.filter((t) => MARKABLE_TYPES.includes(t.type));

const ACTIONS = [
  { key: 'rewrite', label: '改写' },
  { key: 'expand', label: '扩写' },
  { key: 'shorten', label: '缩写' },
  { key: 'tone', label: '换语气' },
  { key: 'continue', label: '续写' },
  { key: 'critique', label: '找茬' },
  { key: 'colloquialize', label: '口语化' },
];

const TIP = {
  rewrite: '换一种表达，意思不变',
  expand: '增加细节与描写',
  shorten: '精简表达，保留要点',
  tone: '改变语气',
  continue: '在选区后接一句',
  critique: '审稿人视角挑问题，只给建议',
  colloquialize: '把书面语改自然',
};

export default function BlockToolbar({
  selection,
  onRun,
  onMark,
  blockType,
  onClose,
  position,
  toolbarRef,
  menuUp,
}) {
  const [busy, setBusy] = useState('');
  const [toneOpen, setToneOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);

  if (!selection) return null;

  const canMark = !!onMark && MARKABLE_TYPES.includes(blockType);

  const run = async (action, instruction) => {
    setBusy(action);
    try {
      await onRun(action, instruction);
      onClose?.();
    } finally {
      setBusy('');
      setToneOpen(false);
    }
  };

  const mark = (type) => {
    onMark?.(type);
    setMarkOpen(false);
    onClose?.();
  };

  return (
    <div
      ref={toolbarRef}
      className={`ct-inline-toolbar${menuUp ? ' is-menu-up' : ''}`}
      // 点按钮时别让 textarea 失焦：Blur 会触发块高度收缩（失焦才收），
      // 正文一移位，工具条锚点跟着动，窄屏上甚至会整条被滚出可视区。
      onMouseDown={(e) => e.preventDefault()}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        // 尺寸量到之前、或选区滚出可视区时先隐藏：
        // 宁可晚一帧出现，也不要把工具条摆错位置再跳一下。
        visibility: position?.ready && position?.visible ? 'visible' : 'hidden',
      }}
    >
      {/* 「标记」放最前：它是改数据语义的动作，跟后面一排改文字的动作不是一类。
          二级菜单而不是平铺，工具条已经有七个 AI 按钮，再摊三个会顶出正文栏。 */}
      {canMark && (
        <div style={{ position: 'relative' }}>
          <Tooltip title="把选中的这段标成某种段落类型">
            <button
              onClick={() => {
                setToneOpen(false);
                setMarkOpen((v) => !v);
              }}
              disabled={!!busy}
              className="ct-inline-btn"
            >
              标记
            </button>
          </Tooltip>
          {markOpen && (
            <div className="ct-tone-menu">
              {MARK_TARGETS.map((t) => (
                <Tooltip key={t.type} title={t.hint} placement="right">
                  <button
                    onClick={() => mark(t.type)}
                    disabled={t.type === blockType}
                    className="ct-inline-btn"
                  >
                    {t.label}
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
        </div>
      )}

      {ACTIONS.map((a) => {
        if (a.key === 'tone') {
          return (
            <div key={a.key} style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  setMarkOpen(false);
                  setToneOpen((v) => !v);
                }}
                disabled={!!busy}
                className="ct-inline-btn"
              >
                {busy === 'tone' ? <Spin size="small" /> : a.label}
              </button>
              {toneOpen && (
                <div className="ct-tone-menu">
                  {['正式', '口语', '冷峻', '温暖', '悬疑'].map((tone) => (
                    <button
                      key={tone}
                      onClick={() => run('tone', `改成${tone}的语气`)}
                      className="ct-inline-btn"
                    >
                      {tone}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }

        return (
          <Tooltip key={a.key} title={TIP[a.key]}>
            <button
              onClick={() => run(a.key)}
              disabled={!!busy}
              className="ct-inline-btn"
            >
              {busy === a.key ? <Spin size="small" /> : a.label}
            </button>
          </Tooltip>
        );
      })}

      <button onClick={onClose} className="ct-inline-btn is-close" title="关闭">
        <X size={13} />
      </button>
    </div>
  );
}
