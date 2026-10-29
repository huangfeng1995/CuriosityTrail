import React from 'react';
import { Spin } from 'antd';
import { Bookmark, BookmarkCheck } from 'lucide-react';
import ActionCard from './ActionCard';
import CitationBadge from './CitationBadge';
import MemoryPanel from './MemoryPanel';
import EmptyState from '../EmptyState';

/**
 * 「记入记忆」按钮。
 *
 * 手动层是作者明确划的线：这条要记住。
 * AI 自己判断的是"哪些值得记"，作者划的是"必须记"——
 * 两者不能互相替代，所以这个按钮必须显眼、必须在每条消息上都有。
 *
 * 没有服务端 id 的消息（还在流式输出、或失败的那条）不给按钮：
 * 点了也没用，不如不给。
 */
function RememberButton({ msg, onRemember }) {
  if (!onRemember || !msg.serverMessageId) return null;

  if (msg.remembered) {
    return (
      <span className="ct-msg-remember is-on">
        <BookmarkCheck size={12} />
        已记入记忆
      </span>
    );
  }

  return (
    <button
      type="button"
      className="ct-msg-remember"
      disabled={msg.remembering}
      onClick={() => onRemember(msg)}
      title="把这条记入长期记忆，之后 AI 每次都会想起它"
    >
      <Bookmark size={12} />
      {msg.remembering ? '记入中…' : '记入记忆'}
    </button>
  );
}

/**
 * 消息流。
 */
export default function MessageList({
  messages,
  streaming,
  sending,
  onApply,
  onRevert,
  onExcludeMemory,
  onRegenerate,
  onRemember,
}) {
  if (!messages.length && !streaming) {
    return (
      <EmptyState
        className="ct-empty-welcome"
        text={
          <>
            选一个角色开始对话。
            <br />
            AI 会知道你正在写哪一章、涉及哪些人物与设定。
          </>
        }
      />
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
            <div className="ct-msg-user">
              <div className="ct-msg-bubble is-user">{msg.content}</div>
              <RememberButton msg={msg} onRemember={onRemember} />
            </div>
          ) : (
            <div className="ct-msg-body">
              {msg.roleLabel && <div className="ct-msg-role">{msg.roleLabel}</div>}

              {/* 记忆面板在正文上方：作者先看到"AI 参考了什么"，
                  再看答案——顺序反了就成了事后补注。 */}
              {(msg.memoryRefs?.length || msg.memoryDegraded) && (
                <MemoryPanel
                  refs={msg.memoryRefs || []}
                  degraded={msg.memoryDegraded}
                  reason={msg.memoryReason || ''}
                  onExclude={(ref) => onExcludeMemory?.(msg, ref)}
                  onRegenerate={
                    msg.excludedRefIds?.length && onRegenerate
                      ? () => onRegenerate(msg)
                      : null
                  }
                  regenerating={!!msg.regenerating}
                />
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
                // 只有空白字符的回复也要当成空：否则气泡画出来是空的，
                // 作者看到一片空白，既没有内容也没有提示
                <div className="ct-msg-bubble is-ai">
                  {(msg.content || '').trim() || '（本次没有返回内容）'}
                </div>
              )}
              <div className="ct-msg-foot">
                <RememberButton msg={msg} onRemember={onRemember} />
                <CitationBadge citations={msg.citations} />
              </div>
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
