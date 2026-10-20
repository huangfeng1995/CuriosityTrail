import React from 'react';

/**
 * 来源角标。
 *
 * AI 检索到的参考资料要能溯源——用户点开才知道这段是查来的还是编的。
 */
export default function CitationBadge({ citations }) {
  if (!citations?.length) return null;

  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {citations.map((c, i) => (
        <div
          key={i}
          style={{
            fontSize: 12,
            padding: '6px 8px',
            borderRadius: 6,
            background: 'rgba(128,128,128,0.08)',
            borderLeft: '2px solid rgba(128,128,128,0.35)',
          }}
        >
          <div style={{ opacity: 0.7, marginBottom: 2 }}>
            [{i + 1}] {c.source || '来源'}
            {c.title ? ` · ${c.title}` : ''}
          </div>
          {c.snippet && (
            <div style={{ opacity: 0.85, lineHeight: 1.6 }}>{c.snippet}</div>
          )}
          {c.url && (
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, display: 'inline-block', marginTop: 2 }}
            >
              查看原文
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
