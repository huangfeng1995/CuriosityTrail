import React from 'react';
import { Typography, Spin } from 'antd';
import ActionCard from './ActionCard';
import CitationBadge from './CitationBadge';

const { Text } = Typography;

/**
 * 消息流。
 */
export default function MessageList({ messages, streaming, sending, onApply, onRevert }) {
  if (!messages.length && !streaming) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          textAlign: 'center',
        }}
      >
        <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.9 }}>
          选一个角色开始对话。
          <br />
          AI 会知道你正在写哪一章、涉及哪些人物与设定。
        </Text>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
      {messages.map((msg) => (
        <div
          key={msg.id}
          style={{
            marginBottom: 14,
            display: 'flex',
            flexDirection: 'column',
            alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
          }}
        >
          {msg.role === 'user' ? (
            <div
              style={{
                maxWidth: '90%',
                padding: '8px 12px',
                borderRadius: 10,
                background: 'rgba(59,110,165,0.12)',
                fontSize: 14,
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
              }}
            >
              {msg.content}
            </div>
          ) : (
            <div style={{ maxWidth: '100%', width: '100%' }}>
              {msg.roleLabel && (
                <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 3 }}>
                  {msg.roleLabel}
                </div>
              )}
              {msg.action && msg.action !== 'none' ? (
                <ActionCard
                  action={msg.action}
                  content={msg.content}
                  reason={msg.reason}
                  applied={msg.applied}
                  onApply={() => onApply?.(msg)}
                  onRevert={() => onRevert?.(msg)}
                />
              ) : (
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 10,
                    background: 'rgba(128,128,128,0.08)',
                    fontSize: 14,
                    lineHeight: 1.8,
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {msg.content}
                </div>
              )}
              <CitationBadge citations={msg.citations} />
            </div>
          )}
        </div>
      ))}

      {streaming && (
        <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
          {streaming}
          <Spin size="small" style={{ marginLeft: 6 }} />
        </div>
      )}
    </div>
  );
}
