import React, { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

/**
 * 工具过程条。
 *
 * AI 自己翻出来的东西必须让作者看见，否则作者无法判断这次回答靠不靠谱。
 * 与记忆面板同位置、同视觉语言，但语义不同：
 *   记忆面板 = 参考了哪些旧账
 *   过程条   = 这次现查了什么
 *
 * 降级时必须标出来。作者会把本地小模型的结论当成云端结论，
 * 一次判错就摧毁对整套巡检能力的信任。
 */
export default function ToolPanel({ trace = [] }) {
  const [open, setOpen] = useState(false);

  if (!trace.length) return null;

  const last = trace[trace.length - 1];
  const summary = trace.map((t) => t.label).join('、');

  return (
    <div className="ct-tool">
      <button type="button" className="ct-tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{summary}</span>
        {last.summary && <span className="ct-tool-summary">{last.summary}</span>}
      </button>

      {open && (
        <div className="ct-tool-list">
          {trace.map((item, idx) => (
            <div key={`${item.tool}-${idx}`} className="ct-tool-item">
              <div className="ct-tool-item-head">
                <span className="ct-tool-label">{item.label}</span>
                {item.summary && <span className="ct-tool-summary">{item.summary}</span>}
              </div>
              {item.degraded && (
                <div className="ct-tool-degraded">
                  本次判定由本地模型完成，可信度有限
                </div>
              )}
              {item.error && <div className="ct-tool-degraded">执行失败：{item.error}</div>}
              {(item.detail || []).map((d, i) => (
                <div key={i} className="ct-tool-detail">
                  <span className="ct-tool-detail-label">{d.label}</span>
                  <span className="ct-tool-detail-text">{d.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
