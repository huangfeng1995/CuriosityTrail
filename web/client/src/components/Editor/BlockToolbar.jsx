import React, { useState } from 'react';
import { Tooltip, Spin } from 'antd';
import { X } from 'lucide-react';
import { BLOCK_TYPES, MARKABLE_TYPES } from './blocks';

/**
 * 章节头的固定动作栏。
 *
 * 以前它跟着选区浮在光标正下方，会压住下面几行正文，点一下就发 AI，容易误触。
 * 现在固定在章节头里，不参与正文排版：滚动、缩放、改选区都不会盖住正文。
 *
 * 只在选中文字后才渲染（由 ChapterEditor 决定），因此这里不再处理
 * "未选中时置灰并解释怎么用"的形态：没有内容就不占位。
 * 动作名本身就是说明（改写 / 扩写 / 缩写…），不再额外挂一遍解释文案。
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

export default function BlockToolbar({ selectedChars = 0, onRun, onMark, blockType, onClose }) {
  const [busy, setBusy] = useState('');
  const [toneOpen, setToneOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);

  // 「标记」只在选中的块可标时才出现。
  const canMark = !!onMark && MARKABLE_TYPES.includes(blockType);
  const disabled = !!busy;

  const run = async (action, instruction) => {
    setBusy(action);
    try {
      await onRun(action, instruction);
    } finally {
      setBusy('');
      setToneOpen(false);
    }
  };

  const mark = (type) => {
    onMark?.(type);
    setMarkOpen(false);
  };

  return (
    <div
      className="ct-inline-toolbar is-active"
      // 点按钮时别让 textarea 失焦：失焦会清掉选区，按钮就不知道改哪一段了。
      onMouseDown={(e) => e.preventDefault()}
    >
      <span className="ct-scope-chip">已选 {selectedChars} 字</span>

      {ACTIONS.map((a) => {
        if (a.key === 'tone') {
          return (
            <div key={a.key} style={{ position: 'relative' }}>
              <button
                onClick={() => {
                  setMarkOpen(false);
                  setToneOpen((v) => !v);
                }}
                disabled={disabled}
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
          <button
            key={a.key}
            onClick={() => run(a.key)}
            disabled={disabled}
            className="ct-inline-btn"
          >
            {busy === a.key ? <Spin size="small" /> : a.label}
          </button>
        );
      })}

      {/* 段落类型与上面八个 AI 动作不是一回事：它只改块的 type，不写一个字，
          也不发任何请求。单独隔开放在最后，避免被当成又一个"改写"入口。 */}
      {canMark && (
        <>
          <span className="ct-scope-sep" />
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => {
                setToneOpen(false);
                setMarkOpen((v) => !v);
              }}
              disabled={disabled}
              className="ct-inline-btn is-meta"
              title="只改段落类型，不改文字"
            >
              类型
            </button>
            {markOpen && (
              <div className="ct-tone-menu is-meta">
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
        </>
      )}

      <button onClick={onClose} className="ct-inline-btn is-close" title="关闭">
        <X size={13} />
      </button>
    </div>
  );
}
