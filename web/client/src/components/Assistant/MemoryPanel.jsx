import React, { useState } from 'react';
import { Button, Tooltip } from 'antd';
import { ChevronRight, ChevronDown, EyeOff, RotateCcw } from 'lucide-react';

/**
 * 长期记忆面板。
 *
 * 记忆是"AI 自己翻出来的旧账"——作者看不见它，就没法判断这次回答
 * 到底参考了什么。所以每次 AI 回复上方都要挂一块：本次参考了哪几条、
 * 来自哪里、内容是什么，并且允许当场剔除某一条后重新生成。
 *
 * 剔除是**单条**的：整份记忆都用不上的情况很少，
 * 多半是"人名记错了"这种一条的问题。全局关掉放在输入区的开关上。
 */
export default function MemoryPanel({ refs = [], degraded = false, reason = '', onExclude, onRegenerate, regenerating }) {
  const [open, setOpen] = useState(false);

  if (degraded) {
    // 降级不是作者的错，但得让他知道"这次没翻旧账"，
    // 否则他会以为 AI 就是不懂前情。
    return (
      <div className="ct-memory is-degraded">
        <span className="ct-memory-flag">长期记忆未启用</span>
        <span className="ct-memory-degraded-reason">{reason}</span>
      </div>
    );
  }

  if (!refs.length) return null;

  const summary = `本次参考了 ${refs.length} 条记忆`;

  return (
    <div className="ct-memory">
      <button
        type="button"
        className="ct-memory-head"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{summary}</span>
      </button>

      {open && (
        <div className="ct-memory-list">
          {refs.map((ref) => (
            <div key={ref.id} className="ct-memory-item">
              <div className="ct-memory-item-head">
                <span className="ct-memory-label">{ref.label}</span>
                {typeof ref.score === 'number' && (
                  <span className="ct-memory-score" title="语义相似度">
                    {(ref.score * 100).toFixed(0)}%
                  </span>
                )}
                {onExclude && (
                  <Tooltip title="这条不用了，重新生成时排除它">
                    <button
                      type="button"
                      className="ct-memory-exclude"
                      onClick={() => onExclude(ref)}
                    >
                      <EyeOff size={12} />
                      剔除
                    </button>
                  </Tooltip>
                )}
              </div>
              {ref.preview && <div className="ct-memory-preview">{ref.preview}</div>}
            </div>
          ))}

          {onRegenerate && (
            <div className="ct-memory-actions">
              <Button
                size="small"
                type="text"
                icon={<RotateCcw size={12} />}
                onClick={onRegenerate}
                loading={regenerating}
              >
                重新生成（不带这些记忆）
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
