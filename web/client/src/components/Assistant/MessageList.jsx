import React from 'react';
import { Spin } from 'antd';
import ActionCard from './ActionCard';
import CitationBadge from './CitationBadge';

/**
 * 消息流。
 */
export default function MessageList({ messages, streaming, sending, onApply, onRevert }) {
  if (!messages.length && !streaming) {
    return (
      <div className="ct-ai-welcome">
        <span className="ct-ai-welcome-mark font-serif" aria-hidden="true">
          寻
        </span>
        <p className="ct-ai-welcome-text">
          选一个角色开始对话。
          <br />
          AI 会知道你正在写哪一章、涉及哪些人物与设定。
        </p>
      </div>
    );
  }

  return (
    <div className="ct-msgs">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`ct-msg is-${msg.role}`}
        >
          {msg.role === 'user' ? (
            <div className="ct-msg-bubble is-user">{msg.content}</div>
          ) : (
            <div className="ct-msg-body">
              {msg.roleLabel && <div className="ct-msg-role">{msg.roleLabel}</div>}
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
                <div className="ct-msg-bubble is-ai">{msg.content}</div>
              )}
              <CitationBadge citations={msg.citations} />
            </div>
          )}
        </div>
      ))}

      {streaming && (
        <div className="ct-msg is-assistant">
          <div className="ct-msg-body">
            <div className="ct-msg-bubble is-ai is-streaming">
              {streaming}
              <span className="ct-caret" />
            </div>
          </div>
        </div>
      )}

      {sending && !streaming && (
        <div className="ct-msg is-assistant">
          <div className="ct-msg-body">
            <div className="ct-msg-bubble is-ai is-thinking">
              <Spin size="small" />
              <span>正在思考…</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
