import React, { useState } from 'react';
import { Button, Tooltip, Spin } from 'antd';

/**
 * 行内 AI 工具条。
 *
 * 选中文本后浮在选区上方，点击动作调 /api/ai/inline 拿回结构化结果，
 * 由父组件写回块内并提示可撤销。
 */

const ACTIONS = [
  { key: 'rewrite', label: '改写' },
  { key: 'expand', label: '扩写' },
  { key: 'shorten', label: '缩写' },
  { key: 'tone', label: '换语气' },
  { key: 'continue', label: '续写' },
  { key: 'critique', label: '找茬' },
  { key: 'colloquialize', label: '口语化' },
];

export default function BlockToolbar({ selection, onRun, onClose, position }) {
  const [busy, setBusy] = useState('');
  const [toneOpen, setToneOpen] = useState(false);

  if (!selection) return null;

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

  return (
    <div
      style={{
        position: 'absolute',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 6px',
        borderRadius: 8,
        background: '#1f2937',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
        whiteSpace: 'nowrap',
      }}
    >
      {ACTIONS.map((a) => {
        if (a.key === 'tone') {
          return (
            <div key={a.key} style={{ position: 'relative' }}>
              <button
                onClick={() => setToneOpen((v) => !v)}
                disabled={!!busy}
                style={toolStyle}
              >
                {busy === 'tone' ? <Spin size="small" /> : a.label}
              </button>
              {toneOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '110%',
                    left: 0,
                    background: '#111827',
                    borderRadius: 6,
                    padding: 4,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 96,
                  }}
                >
                  {['正式', '口语', '冷峻', '温暖', '悬疑'].map((tone) => (
                    <button
                      key={tone}
                      onClick={() => run('tone', `改成${tone}的语气`)}
                      style={{ ...toolStyle, width: '100%', justifyContent: 'flex-start' }}
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
              style={toolStyle}
            >
              {busy === a.key ? <Spin size="small" /> : a.label}
            </button>
          </Tooltip>
        );
      })}

      <Button
        type="text"
        size="small"
        onClick={onClose}
        style={{ color: '#9ca3af', height: 22, padding: '0 4px' }}
      >
        ✕
      </Button>
    </div>
  );
}

const TIP = {
  rewrite: '换一种表达，意思不变',
  expand: '增加细节与描写',
  shorten: '精简表达，保留要点',
  tone: '改变语气',
  continue: '在选区后接一句',
  critique: '审稿人视角挑问题，只给建议',
  colloquialize: '把书面语改自然',
};

const toolStyle = {
  border: 'none',
  background: 'transparent',
  color: '#f3f4f6',
  fontSize: 13,
  padding: '4px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  minWidth: 24,
  height: 22,
  lineHeight: '22px',
};

toolStyle[':hover'] = { background: 'rgba(255,255,255,0.12)' };
