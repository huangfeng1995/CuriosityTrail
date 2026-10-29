import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Input, Button, Spin, Tooltip, App as AntApp } from 'antd';
import { SendOutlined, ClearOutlined } from '@ant-design/icons';
import { Square, Brain, EyeOff } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { streamPost } from '../../api/sse';
import { createBlock } from '../Editor/blocks';
import { planApply } from './applyPlan';
import { useMemoryPref } from '../../hooks/useMemoryPref';
import RoleTabs from './RoleTabs';
import MessageList from './MessageList';
import EmptyState from '../EmptyState';

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
    removeBlock,
  } = useWorkspace();

  const [roles, setRoles] = useState([]);
  const [input, setInput] = useState('');
  const abortRef = useRef(null);
  const listRef = useRef(null);
  // 流式累加器：token 回调闭包里的 streaming 永远是旧值，必须用 ref 累
  const streamBufRef = useRef('');
  // 工具过程累积器。事件回调闭包里的 msg 永远是旧快照，
  // 直接读 msg.toolTrace 会丢掉前面几次调用——必须用 ref 累。
  const toolTraceRef = useRef([]);
  // 长期记忆开关。作者说了算，默认开着。
  const [useMemory, setUseMemory] = useMemoryPref();
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

  /**
   * 发起一次对话。
   *
   * options.excludeRefIds   作者剔除的记忆条目（重新生成时带上）
   * options.replaceMessageId 被替换掉的助手消息（服务端 id）
   * options.reuseAssistantId 复用哪条助手气泡（重新生成时不新建气泡）
   */
  const send = useCallback(
    async (text, options = {}) => {
      const {
        excludeRefIds = [],
        replaceMessageId = '',
        reuseAssistantId = '',
      } = options;

      const content = (text ?? input).trim();
      if (!content || sending) return;

      // 重新生成：沿用原来的用户气泡与助手气泡，只换内容。
      // 新建一对气泡会让对话流里出现"同一个问题问了两遍"。
      const isRegen = Boolean(reuseAssistantId);

      // 本轮新插入的用户气泡。服务端回消息 id 时要靠它对上号——
      // 「记入记忆」要的是服务端 id，不是本地这个临时 id。
      let userBubbleId = '';

      if (!isRegen) {
        setInput('');
        userBubbleId = `u-${Date.now()}`;
        dispatch({
          type: 'message/add',
          message: { id: userBubbleId, role: 'user', content },
        });
      }

      const assistantId = isRegen ? reuseAssistantId : `a-${Date.now()}`;
      const assistantMsg = {
        id: assistantId,
        role: 'assistant',
        content: '',
        action: 'none',
        reason: '',
        citations: [],
        roleLabel: activeRole ? `${activeRole.icon} ${activeRole.name}` : '',
        applied: false,
        // 记住这次问了什么：重新生成时要拿它重发
        prompt: content,
        memoryRefs: [],
        memoryDegraded: false,
        memoryReason: '',
        // 工具过程：AI 自己翻出来的东西，作者要能核对
        toolTrace: [],
        // 消息字段叫 excludedRefIds（已剔除列表），入参叫 excludeRefIds，
        // 这里必须显式赋值：写成简写会引用一个不存在的变量，点发送直接 ReferenceError。
        excludedRefIds: excludeRefIds,
        regenerating: isRegen,
      };

      if (isRegen) {
        dispatch({ type: 'message/update', id: assistantId, patch: assistantMsg });
      } else {
        dispatch({ type: 'message/add', message: assistantMsg });
      }
      dispatch({ type: 'sending/set', sending: true });
      dispatch({ type: 'streaming/set', streaming: '' });

      const controller = new AbortController();
      abortRef.current = controller;
      streamBufRef.current = '';
      toolTraceRef.current = [];
      // 本次请求有没有拿到过实质回复。
      // 流正常结束却没收到 action 事件时，占位消息会一直是空的——
      // 必须兜底给作者一句看得见的话，不能留一个空气泡。
      let gotReply = false;
      let aborted = false;

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
            useMemory,
            excludeRefIds,
            replaceMessageId,
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
            } else if (event.type === 'memory') {
              // 记忆事件在第一个 token 之前到：作者先看到"参考了什么"，
              // 再看到答案。
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: {
                  memoryRefs: event.refs || [],
                  memoryDegraded: !!event.degraded,
                  memoryReason: event.reason || '',
                },
              });
            } else if (event.type === 'agent_thinking') {
              // 进入多步循环的信号。作者此刻还看不到任何 token，
              // 没有这个提示就只有一个不动的空占位。
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { thinking: event.label || '正在判断需要查什么' },
              });
            } else if (event.type === 'tool_start') {
              toolTraceRef.current = [
                ...toolTraceRef.current,
                { tool: event.tool, label: event.label, status: 'running' },
              ];
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { thinking: '', toolTrace: toolTraceRef.current },
              });
            } else if (event.type === 'tool_done') {
              // tool_done 是把 tool_start 那一条**补全**，不是新增一条。
              // 两次都往后追加的话，过程条里会出现两行「伏笔盘点」——
              // 一行永远停在"正在跑"，作者会以为卡住了。
              const done = {
                tool: event.tool,
                label: event.label,
                status: 'done',
                summary: event.summary || '',
                detail: event.detail || [],
                degraded: !!event.degraded,
                error: event.error || '',
              };
              const idx = toolTraceRef.current.findIndex(
                (t) => t.tool === event.tool && t.status === 'running'
              );
              if (idx >= 0) {
                toolTraceRef.current = toolTraceRef.current.map((t, i) =>
                  i === idx ? done : t
                );
              } else {
                toolTraceRef.current = [...toolTraceRef.current, done];
              }
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { toolTrace: toolTraceRef.current },
              });
            } else if (event.type === 'action') {
              gotReply = true;
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
                  // 工具过程的最终态：以 action 事件里的 skills 为准，
                  // 它是落库的同一份数据，重载消息时也能恢复。
                  toolTrace: event.skills && event.skills.length
                    ? event.skills.map((s) => ({ ...s, status: 'done' }))
                    : toolTraceRef.current,
                },
              });
            } else if (event.type === 'done') {
              dispatch({
                type: 'conversation/set',
                conversationId: event.conversationId,
              });
              // 记住服务端的助手消息 id：下次重新生成要靠它替换旧回答
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: {
                  serverMessageId: event.messageId || '',
                  regenerating: false,
                },
              });
              // 用户消息的服务端 id 同样要留着：作者可以给自己的提问
              // 点「记入记忆」。重新生成时这条提问是复用的，id 不变。
              if (userBubbleId && event.userMessageId) {
                dispatch({
                  type: 'message/update',
                  id: userBubbleId,
                  patch: { serverMessageId: event.userMessageId },
                });
              }
            } else if (event.type === 'error') {
              gotReply = true;
              dispatch({
                type: 'streaming/set',
                streaming: '',
              });
              const detail = event.message || 'AI 调用失败';
              dispatch({
                type: 'notice/set',
                error: detail,
              });
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { content: `调用失败：${detail}`, regenerating: false },
              });
            }
          },
          controller.signal
        );
      } catch (e) {
        if (e.name === 'AbortError') {
          // 作者主动点了「停止」：这不是故障，告诉他停在了哪儿就行。
          aborted = true;
          dispatch({
            type: 'message/update',
            id: assistantId,
            patch: { content: '已停止生成。', regenerating: false },
          });
        } else {
          gotReply = true;
          dispatch({ type: 'notice/set', error: e.message });
          dispatch({
            type: 'message/update',
            id: assistantId,
            patch: { content: `调用失败：${e.message}`, regenerating: false },
          });
        }
      } finally {
        // 流结束了，但既没收到 action 也没收到 error。
        // 说明连接在中途断掉了——给作者一句话，别留空白气泡。
        if (!gotReply && !aborted) {
          dispatch({
            type: 'message/update',
            id: assistantId,
            patch: { content: '连接中断，没有收到回复，请重试。', regenerating: false },
          });
        }
        dispatch({ type: 'sending/set', sending: false });
        dispatch({ type: 'streaming/set', streaming: '' });
        streamBufRef.current = '';
        abortRef.current = null;
      }
    },
    [input, sending, dispatch, work, chapter, roleKey, conversationId, blocks, activeRole, useMemory]
  );

  /**
   * 剔除一条记忆。
   *
   * 只是标记，不立刻重发——作者可能一次要剔好几条。
   * 剔完点「重新生成」才生效。
   */
  const excludeMemory = useCallback(
    (msg, ref) => {
      const list = msg.excludedRefIds || [];
      if (list.includes(ref.id)) return;
      dispatch({
        type: 'message/update',
        id: msg.id,
        patch: { excludedRefIds: [...list, ref.id] },
      });
    },
    [dispatch]
  );

  /**
   * 带着剔除名单重新生成这条回答。
   */
  const regenerate = useCallback(
    (msg) => {
      if (!msg?.prompt || sending) return;
      send(msg.prompt, {
        excludeRefIds: msg.excludedRefIds || [],
        replaceMessageId: msg.serverMessageId || '',
        reuseAssistantId: msg.id,
      });
    },
    [send, sending]
  );

  /**
   * 把 AI 的结构化输出写进正文。
   *
   * 落笔规则放在 applyPlan.js 里：target 可能是块 ID，也可能是原文片段，
   * 还得处理"整章还没有正文"这种情况。这里只负责执行算好的方案。
   */
  const applyAction = useCallback(
    (msg) => {
      const plan = planApply(blocks, msg.action, msg.target, msg.content);

      if (plan.kind === 'error') {
        toast.warning(plan.message);
        return;
      }

      if (plan.kind === 'replace' || plan.kind === 'append') {
        const before = blocks.find((b) => b.id === plan.blockId);
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: {
            applied: true,
            snapshot: { id: plan.blockId, content: before ? before.content : '' },
          },
        });
        updateBlock(plan.blockId, { content: plan.text });
      } else if (plan.kind === 'insert') {
        const block = createBlock('paragraph', { content: plan.text });
        insertBlock(plan.index, block);
        // 记下新块的 id：撤销时要把整块删掉，而不是只清空内容
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: { applied: true, snapshot: { id: block.id, inserted: true } },
        });
      }

      toast.success('已写入正文');
    },
    [blocks, updateBlock, insertBlock, dispatch, toast]
  );

  /**
   * 撤销一次应用：把被改的块退回原样。
   * 插入的新块要整个删掉——只清空内容的话，正文里会多出一个空段。
   */
  const revertAction = useCallback(
    (msg) => {
      if (!msg.snapshot) return;

      if (msg.snapshot.inserted) {
        removeBlock(msg.snapshot.id);
      } else {
        updateBlock(msg.snapshot.id, { content: msg.snapshot.content });
      }
      dispatch({ type: 'message/update', id: msg.id, patch: { applied: false } });
      toast.info('已撤销');
    },
    [updateBlock, removeBlock, dispatch, toast]
  );

  /**
   * 把一条消息记入长期记忆（手动层）。
   *
   * 手动层是作者明确划的线，权重最高的一层。
   * 这一层是同步写的：作者点了就该立刻知道成没成功，
   * 所以这里等服务端返回再给反馈，不做乐观更新。
   */
  const rememberMessage = useCallback(
    async (msg) => {
      if (!msg?.serverMessageId || msg.remembering) return;

      dispatch({
        type: 'message/update',
        id: msg.id,
        patch: { remembering: true },
      });

      try {
        const res = await fetch(`/api/ai/messages/${msg.serverMessageId}/remember`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || '记入失败');
        }

        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: { remembering: false, remembered: true },
        });
        toast.success('已记入长期记忆');
      } catch (e) {
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: { remembering: false },
        });
        toast.error(e.message || '记入失败');
      }
    },
    [dispatch, toast]
  );

  const clearChat = () => {
    dispatch({ type: 'message/clear' });
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  if (!chapter) {
    return (
      <EmptyState className="ct-empty-fill" text="选中一个章节后，AI 才能知道你在写什么" />
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
          onExcludeMemory={excludeMemory}
          onRegenerate={regenerate}
          onRemember={rememberMessage}
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
          <Tooltip
            title={
              useMemory
                ? '长期记忆已开启：AI 会自动回忆前情'
                : '长期记忆已关闭：AI 不会自动回忆前情'
            }
          >
            <Button
              size="small"
              type="text"
              icon={useMemory ? <Brain size={14} /> : <EyeOff size={14} />}
              onClick={() => setUseMemory(!useMemory)}
              disabled={sending}
              className={`ct-ai-memory-toggle${useMemory ? ' is-on' : ''}`}
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
