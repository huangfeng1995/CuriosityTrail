import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input, Button, Spin, Tooltip, App as AntApp } from 'antd';
import { SendOutlined, ClearOutlined } from '@ant-design/icons';
import { Square } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { streamPost } from '../../api/sse';
import { createBlock } from '../Editor/blocks';
import RoleTabs from './RoleTabs';
import MessageList from './MessageList';

/**
 * AI 侧边栏。
 *
 * 与 AI 的对话走 SSE：token 实时上屏，模型给出结构化 action 后，
 * 由用户在 ActionCard 上点「应用到正文」才真的写进稿子——AI 不该擅自改稿。
 */
export default function AssistantSidebar() {
  const {
    work,
    chapter,
    blocks,
    roleKey,
    conversationId,
    messages,
    sending,
    streaming,
    notice,
    dispatch,
    updateBlock,
    insertBlock,
  } = useWorkspace();

  const [roles, setRoles] = useState([]);
  const [input, setInput] = useState('');
  const abortRef = useRef(null);
  const listRef = useRef(null);
  // 流式累加器：token 回调闭包里的 streaming 永远是旧值，必须用 ref 累
  const streamBufRef = useRef('');
  const { message: toast } = AntApp.useApp();

  // 角色列表
  useEffect(() => {
    let alive = true;
    fetch('/api/ai/roles', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => alive && setRoles(Array.isArray(data) ? data : []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 消息滚动到底
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  const activeRole = roles.find((r) => r.key === roleKey);

  const send = useCallback(
    async (text) => {
      const content = (text ?? input).trim();
      if (!content || sending) return;

      setInput('');

      const userMsg = {
        id: `u-${Date.now()}`,
        role: 'user',
        content,
      };
      const assistantId = `a-${Date.now()}`;
      const assistantMsg = {
        id: assistantId,
        role: 'assistant',
        content: '',
        action: 'none',
        reason: '',
        citations: [],
        roleLabel: activeRole ? `${activeRole.icon} ${activeRole.name}` : '',
        applied: false,
      };

      dispatch({ type: 'message/add', message: userMsg });
      dispatch({ type: 'message/add', message: assistantMsg });
      dispatch({ type: 'sending/set', sending: true });
      dispatch({ type: 'streaming/set', streaming: '' });

      const controller = new AbortController();
      abortRef.current = controller;
      streamBufRef.current = '';

      try {
        await streamPost(
          '/api/ai/chat',
          {
            message: content,
            workId: work?.id,
            chapterId: chapter?.id,
            roleKey,
            conversationId,
            scope: 'chapter',
            blocks,
          },
          (event) => {
            if (event.type === 'token') {
              streamBufRef.current += event.content;
              dispatch({
                type: 'streaming/set',
                streaming: streamBufRef.current,
              });
            } else if (event.type === 'notice') {
              dispatch({ type: 'notice/set', notice: event.content });
            } else if (event.type === 'action') {
              dispatch({
                type: 'streaming/set',
                streaming: '',
              });
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: {
                  content: event.content,
                  action: event.action,
                  // target 指向正文里的块 ID，写回时要靠它定位，
                  // 漏了就会写错段落
                  target: event.target,
                  reason: event.reason,
                  citations: event.citations,
                },
              });
            } else if (event.type === 'done') {
              dispatch({
                type: 'conversation/set',
                conversationId: event.conversationId,
              });
            } else if (event.type === 'error') {
              dispatch({
                type: 'notice/set',
                error: event.message || 'AI 调用失败',
              });
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { content: `调用失败：${event.message}` },
              });
            }
          },
          controller.signal
        );
      } catch (e) {
        if (e.name !== 'AbortError') {
          dispatch({ type: 'notice/set', error: e.message });
          dispatch({
            type: 'message/update',
            id: assistantId,
            patch: { content: `调用失败：${e.message}` },
          });
        }
      } finally {
        dispatch({ type: 'sending/set', sending: false });
        dispatch({ type: 'streaming/set', streaming: '' });
        streamBufRef.current = '';
        abortRef.current = null;
      }
    },
    [input, sending, dispatch, work, chapter, roleKey, conversationId, blocks, activeRole]
  );

  /**
   * 把 AI 的结构化输出写进正文。
   * replace 覆盖目标块，append 追加到目标块尾，insert 在目标块后插新块。
   */
  const applyAction = useCallback(
    (msg) => {
      const targetId = msg.target;
      const index = blocks.findIndex((b) => b.id === targetId);

      if (msg.action === 'replace') {
        if (index < 0) {
          toast.warning('找不到要替换的段落，AI 给出的 target 与当前正文不匹配');
          return;
        }
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: {
            applied: true,
            snapshot: { id: blocks[index].id, content: blocks[index].content },
          },
        });
        updateBlock(blocks[index].id, { content: msg.content });
      } else if (msg.action === 'append') {
        // 没有明确目标就追加到最后一个有内容的块
        const target =
          index >= 0 ? blocks[index] : [...blocks].reverse().find((b) => b.content);

        if (!target) {
          toast.warning('当前章节还没有正文');
          return;
        }
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: {
            applied: true,
            snapshot: { id: target.id, content: target.content },
          },
        });
        updateBlock(target.id, { content: target.content + msg.content });
      } else if (msg.action === 'insert') {
        const at = index >= 0 ? index + 1 : blocks.length;
        insertBlock(at, createBlock('paragraph', { content: msg.content }));
        dispatch({ type: 'message/update', id: msg.id, patch: { applied: true } });
      }

      toast.success('已写入正文');
    },
    [blocks, updateBlock, insertBlock, dispatch, toast]
  );

  /**
   * 撤销一次应用：把被改的块退回原样。
   */
  const revertAction = useCallback(
    (msg) => {
      if (msg.snapshot) {
        updateBlock(msg.snapshot.id, { content: msg.snapshot.content });
        dispatch({ type: 'message/update', id: msg.id, patch: { applied: false } });
        toast.info('已撤销');
      }
    },
    [updateBlock, dispatch, toast]
  );

  const clearChat = () => {
    dispatch({ type: 'message/clear' });
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  if (!chapter) {
    return (
      <div className="ct-ai-idle">
        <span className="ct-empty-mark font-serif" aria-hidden="true">
          寻
        </span>
        <p className="ct-empty-text">选中一个章节后，AI 才能知道你在写什么</p>
      </div>
    );
  }

  return (
    <div className="ct-ai">
      <RoleTabs
        roles={roles}
        activeKey={roleKey}
        onChange={(key) => dispatch({ type: 'role/set', roleKey: key })}
      />

      {activeRole?.suggestions?.length > 0 && (
        <div className="ct-ai-suggestions">
          {activeRole.suggestions.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              disabled={sending}
              className="ct-chip"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {notice && <div className="ct-ai-notice">{notice}</div>}

      <div ref={listRef} className="ct-ai-scroll">
        <MessageList
          messages={messages}
          streaming={streaming}
          sending={sending}
          onApply={applyAction}
          onRevert={revertAction}
        />
      </div>

      <div className="ct-ai-input">
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`以${activeRole?.name || 'AI'}的身份提问…（Enter 发送，Shift+Enter 换行）`}
          autoSize={{ minRows: 2, maxRows: 6 }}
          disabled={sending}
          className="ct-ai-textarea"
        />
        <div className="ct-ai-actions">
          <Tooltip title="清空当前对话">
            <Button
              size="small"
              type="text"
              icon={<ClearOutlined />}
              onClick={clearChat}
              disabled={sending || !messages.length}
            />
          </Tooltip>
          <span style={{ flex: 1 }} />
          {sending ? (
            <Button
              size="small"
              icon={<Square style={{ fontSize: 9 }} />}
              onClick={stop}
            >
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              size="small"
              icon={<SendOutlined />}
              onClick={() => send()}
              disabled={!input.trim()}
            >
              发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
