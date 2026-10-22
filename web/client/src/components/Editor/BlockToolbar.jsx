import React, { useState } from 'react';
import { Tooltip, Spin } from 'antd';
import { X } from 'lucide-react';

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

const TIP = {
  rewrite: '换一种表达，意思不变',
  expand: '增加细节与描写',
  shorten: '精简表达，保留要点',
  tone: '改变语气',
  continue: '在选区后接一句',
  critique: '审稿人视角挑问题，只给建议',
  colloquialize: '把书面语改自然',
};

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
      className="ct-inline-toolbar"
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
      }}
    >
      {ACTIONS.map((a) => {
        if (a.key === 'tone') {
          return (
            <div key={a.key} style={{ position: 'relative' }}>
              <button
                onClick={() => setToneOpen((v) => !v)}
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
