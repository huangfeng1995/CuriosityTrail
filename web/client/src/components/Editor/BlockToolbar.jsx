import React, { useEffect, useState } from 'react';
import { Tooltip, Spin } from 'antd';
import { X } from 'lucide-react';
import { BLOCK_TYPES, MARKABLE_TYPES } from './blocks';

/**
 * 章节头的固定动作栏。
 *
 * 以前它跟着选区浮在光标正下方，会压住下面几行正文，点一下就发 AI，容易误触。
 * 现在固定在章节头里，不参与正文排版：滚动、缩放、改选区都不会盖住正文。
 *
 * 只有选中文字后才可用：
 *  - 选中了 → 显示「已选 N 字」，动作只作用于这一段；
 *  - 没选中 → 整条置灰并提示怎么用，点不动，不会误发请求。
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
  hasSelection = false,
  selectedChars = 0,
  onRun,
  onMark,
  blockType,
  onClose,
}) {
  const [busy, setBusy] = useState('');
  const [toneOpen, setToneOpen] = useState(false);
  const [markOpen, setMarkOpen] = useState(false);

  // 选区消失时把二级菜单一并收起，别留一个不知道作用在哪的菜单。
  useEffect(() => {
    if (!hasSelection) {
      setToneOpen(false);
      setMarkOpen(false);
    }
  }, [hasSelection]);

  // 「标记」只在选中文字、且选中的块可标时才出现。
  const canMark = hasSelection && !!onMark && MARKABLE_TYPES.includes(blockType);
  const disabled = !hasSelection || !!busy;

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
      className={`ct-inline-toolbar${hasSelection ? ' is-active' : ' is-idle'}`}
      // 点按钮时别让 textarea 失焦：失焦会清掉选区，按钮就不知道改哪一段了。
      onMouseDown={(e) => e.preventDefault()}
    >
      <Tooltip
        title={
          hasSelection
            ? '下面的动作只作用于选中的这段文字'
            : '先在正文里选中一段文字，这一排才会变成可用'
        }
      >
        <span className={`ct-scope-chip${hasSelection ? ' is-active' : ''}`}>
          {hasSelection ? `已选 ${selectedChars} 字` : '选中文字后可用'}
        </span>
      </Tooltip>

      <span className="ct-scope-sep" />

      {/* 「标记」改的是段落类型，跟后面一排改文字的动作不是一类，排在最前。 */}
      {canMark && (
        <div style={{ position: 'relative' }}>
          <Tooltip title="把选中的这段标成某种段落类型">
            <button
              onClick={() => {
                setToneOpen(false);
                setMarkOpen((v) => !v);
              }}
              disabled={disabled}
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
              <Tooltip title={TIP[a.key]}>
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
              </Tooltip>
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
              disabled={disabled}
              className="ct-inline-btn"
            >
              {busy === a.key ? <Spin size="small" /> : a.label}
            </button>
          </Tooltip>
        );
      })}

      <button
        onClick={onClose}
        disabled={!hasSelection}
        className="ct-inline-btn is-close"
        title="关闭"
      >
        <X size={13} />
      </button>
    </div>
  );
}
