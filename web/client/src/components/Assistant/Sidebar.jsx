import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Input, Button, Spin, Dropdown, App as AntApp } from 'antd';
import { SendOutlined, ClearOutlined, LoadingOutlined } from '@ant-design/icons';
import { History, MoreHorizontal } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { streamPost } from '../../api/sse';
import { createBlock } from '../Editor/blocks';
import { planApply } from './applyPlan';
import { collectCriticFindings, sendAdoptionBatch } from './findings';
import { pendingActions } from './pendingActions';
import { useMemoryPref } from '../../hooks/useMemoryPref';
import RoleTabs from './RoleTabs';
import MessageList from './MessageList';
import HistoryPanel from './HistoryPanel';
import CardProposals from './CardProposals';
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const abortRef = useRef(null);
  const listRef = useRef(null);
  // 停止按钮的三态：idle（可停）→ stopping（正在中断）→ stopped（已停，短暂显示）。
  // 中断是瞬间完成的，只在 sending 上做二元切换的话，作者点下去只会看到
  // 按钮"啪"地变回发送，看不出到底停没停。
  const [stopPhase, setStopPhase] = useState('idle');
  const stopTimerRef = useRef(null);
  // 流式累加器：token 回调闭包里的 streaming 永远是旧值，必须用 ref 累
  const streamBufRef = useRef('');
  // 工具过程累积器。事件回调闭包里的 msg 永远是旧快照，
  // 直接读 msg.toolTrace 会丢掉前面几次调用——必须用 ref 累。
  const toolTraceRef = useRef([]);
  // 长期记忆的开关在设置页「长期记忆」里，写作页只读这个值。
  // 同一个开关在写作页再放一遍，只会让作者怀疑两处是不是同一件事。
  const [useMemory] = useMemoryPref();
  // 卡片提案刷新信号：正文应用后异步识别完成时递增，通知侧栏重拉列表
  const [proposalRefresh, setProposalRefresh] = useState(0);
  const [activeFindingKey, setActiveFindingKey] = useState('');
  // 已采纳的意见：批量/单条成功后都记在这里，避免重复发给写手
  const [adoptedFindingKeys, setAdoptedFindingKeys] = useState(() => new Set());
  // 消息自动滚底时读这份镜像：只在「新消息到达」时判断要不要让位，
  // 不把 activeFindingKey 放进依赖，否则关掉定位条也会把列表拽回底部。
  const activeFindingRef = useRef('');
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

  useEffect(() => {
    activeFindingRef.current = activeFindingKey;
  }, [activeFindingKey]);

  // 消息滚动到底。
  // 正在核对某条审稿意见时不抢滚动位置：否则新消息一到，
  // 列表会被拽回底部，作者刚点中的那条又看不见了。
  useEffect(() => {
    if (activeFindingRef.current) return;
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  // 滚到待确认的卡片。
  //
  // 专注模式退出时，作者点「去看看」——那时候右栏可能刚展开，
  // 消息列表还停在顶部，看不到那张卡在哪。
  //
  // 用 block: 'start' 而不是 'center'：卡片里是 AI 写的整段正文，
  // 可能比视口还高。居中的话上下都超出屏幕，作者看到的还是读不到重点。
  // 贴顶对齐刚好把「改写 / 续写 / 插入」标签和「应用到正文」按钮露出来。
  //
  // 用 window 事件而不是 props：触发方在 Workspace 的 toast 里，
  // 而 Sidebar 拿不到 Workspace 的局部状态。走事件省一次改造。
  const scrollToPending = useCallback(() => {
    const pending = pendingActions(messages).pop();
    if (!pending) return;
    const el = listRef.current?.querySelector(`[data-msg-id="${pending.id}"]`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const onScrollToPending = () => scrollToPending();
    window.addEventListener('ct:scroll-to-pending', onScrollToPending);
    return () => window.removeEventListener('ct:scroll-to-pending', onScrollToPending);
  }, [scrollToPending]);

  const activeRole = roles.find((r) => r.key === roleKey);

  // 审稿意见的锚点按当前正文实时算：作者改稿后位置会变，不落库快照。
  const criticFindings = useMemo(
    () => collectCriticFindings(messages, blocks),
    [messages, blocks]
  );

  const findingsByMessage = useMemo(() => {
    const map = new Map();
    criticFindings.forEach((finding) => {
      if (!map.has(finding.messageId)) map.set(finding.messageId, []);
      map.get(finding.messageId).push(finding);
    });
    return map;
  }, [criticFindings]);

  /**
   * 发起一次对话。
   *
   * options.excludeRefIds   作者剔除的记忆条目（重新生成时带上）
   * options.replaceMessageId 被替换掉的助手消息（服务端 id）
   * options.reuseAssistantId 复用哪条助手气泡（重新生成时不新建气泡）
   * options.roleKey          本轮强制用的角色（采纳审稿意见时固定为写手）
   */
  const send = useCallback(
    async (text, options = {}) => {
      const {
        excludeRefIds = [],
        replaceMessageId = '',
        reuseAssistantId = '',
        roleKey: sendRoleKey = roleKey,
      } = options;
      const sendRole = roles.find((r) => r.key === sendRoleKey) || activeRole;

      const content = (text ?? input).trim();
      if (!content || sending) return;

      // 新的一轮开始：把上一轮的「已停止」收尾提示收掉。
      if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
      setStopPhase('idle');

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
        roleKey: sendRoleKey,
        content: '',
        action: 'none',
        reason: '',
        citations: [],
        findings: [],
        roleLabel: sendRole ? `${sendRole.icon} ${sendRole.name}` : '',
        applied: false,
        // 规划与章末检查的结构化结果：卡片上用小徽标展示，
        // 不塞进正文，也不改变正文列宽。
        beatCheck: null,
        planDegraded: '',
        anchorViolations: [],
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
      // 批量采纳要据此决定「是否标记已采纳」：失败整批都不标
      let failed = false;

      try {
        await streamPost(
          '/api/ai/chat',
          {
            message: content,
            workId: work?.id,
            chapterId: chapter?.id,
            roleKey: sendRoleKey,
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
                  // 审稿人的结构化锚点。旧后端没有这个字段时保持空数组，
                  // 前端照旧按纯文本渲染。
                  findings: Array.isArray(event.findings) ? event.findings : [],
                  // 节拍覆盖与规划降级：只做结构化徽标，不改正文。
                  beatCheck: event.beatCheck || null,
                  planDegraded: event.planDegraded || '',
                  // 工具过程的最终态：以 action 事件里的 skills 为准，
                  // 它是落库的同一份数据，重载消息时也能恢复。
                  //
                  // 但必须按技能名**合并**，不能整体替换：
                  // 流式阶段 tool_done 已经写进来的章节明细与失败原因，
                  // 一旦这里换成一份精简列表就被冲掉了，
                  // 作者点开过程条只会看到一行技能名。
                  toolTrace: event.skills && event.skills.length
                    ? event.skills.map((s) => {
                        const prev = toolTraceRef.current.find((t) => t.tool === s.tool) || {};
                        return {
                          ...prev,
                          ...s,
                          // skills 里 detail 为空数组时，保留流式阶段收到的那份
                          detail: s.detail && s.detail.length ? s.detail : (prev.detail || []),
                          error: s.error || prev.error || '',
                          status: 'done',
                        };
                      })
                    : toolTraceRef.current,
                  // 回答已经落地，占位提示要撤掉，否则它会一直挂在气泡上
                  thinking: '',
                },
              });
            } else if (event.type === 'anchor_violation') {
              // 章末锚点检查的冲突列表。单独事件先到，
              // 存到消息上，卡片的「史实冲突」徽标再点开看原句与定位。
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: {
                  anchorViolations: Array.isArray(event.violations) ? event.violations : [],
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
                  // done 里再带一份冲突列表，避免事件顺序变化时漏掉徽标
                  ...(Array.isArray(event.anchorViolations)
                    ? { anchorViolations: event.anchorViolations }
                    : {}),
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
              failed = true;
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
          failed = true;
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
        // 停下来的这一下要留痕：先让「停止中」站住 0.4 秒（中断本身是瞬间的，
        // 不留这一下的话按钮会直接跳回发送，作者看不出点没点到），
        // 再显示「已停止生成」，2.2 秒后自动回到「发送」。
        if (aborted) {
          stopTimerRef.current = setTimeout(() => {
            setStopPhase('stopped');
            stopTimerRef.current = setTimeout(() => setStopPhase('idle'), 2200);
          }, 420);
        } else {
          setStopPhase('idle');
        }
      }

      return !failed && !aborted && gotReply;
    },
    [input, sending, dispatch, work, chapter, roleKey, conversationId, blocks, activeRole, roles, useMemory]
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

      let appliedBlockId = '';
      if (plan.kind === 'replace' || plan.kind === 'append') {
        appliedBlockId = plan.blockId;
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
        appliedBlockId = block.id;
        insertBlock(plan.index, block);
        // 记下新块的 id：撤销时要把整块删掉，而不是只清空内容
        dispatch({
          type: 'message/update',
          id: msg.id,
          patch: { applied: true, snapshot: { id: block.id, inserted: true } },
        });
      }

      toast.success('已写入正文');

      // 卡片沉淀：正文落地后异步识别这一段里的新人物/新设定/新情节。
      // 不 await、不报错——识别失败绝不能打断写作。
      if (work?.id && chapter?.id && plan.text) {
        fetch('/api/card-proposals/scan', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workId: work.id,
            chapterId: chapter.id,
            blockId: appliedBlockId,
            text: plan.text,
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.proposals?.length) setProposalRefresh((n) => n + 1);
          })
          .catch(() => {});
      }
    },
    [blocks, updateBlock, insertBlock, dispatch, toast, work, chapter]
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
   * 采纳一条或多条意见。
   *
   * 已定位的意见走 /api/ai/inline（短上下文 + 显式选区，不会被聊天历史撑爆），
   * 未定位的全章级建议仍走 /chat。失败时整批都不标记，并给一句人话提示；
   * 成功后把条目标成已采纳，作者不会因为同一条意见被重复发给写手而反复改稿。
   *
   * source 用来把回执送回发起方：检查面板发起的那批要标记面板里的条目，
   * 卡片里点的不需要。
   */
  const adoptFindings = useCallback(
    async (findings, source = '') => {
      if (sending) {
        window.dispatchEvent(
          new CustomEvent('ct:adopt-result', {
            detail: { ok: false, sent: false, keys: [], source },
          })
        );
        return { ok: false, sent: false, keys: [] };
      }

      // inline 通道：已定位的意见直接改写对应块，不带对话历史、不走 agent loop。
      const inlineFn = async (params) => {
        const res = await fetch('/api/ai/inline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(params),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      };

      const result = await sendAdoptionBatch(send, findings, {
        blocks,
        workId: work?.id,
        chapterId: chapter?.id,
        inlineFn,
      });

      // 把 inline 改写结果落到正文块上。
      // replace：整块替换；append：追加到块尾。
      if (result.blockUpdates && result.blockUpdates.length) {
        result.blockUpdates.forEach((update) => {
          const block = blocks.find((b) => b.id === update.blockId);
          if (!block) return;
          if (update.action === 'replace') {
            updateBlock(update.blockId, { content: update.content });
          } else if (update.action === 'append') {
            updateBlock(update.blockId, { content: block.content + update.content });
          }
        });
      }

      if (result.ok) {
        setAdoptedFindingKeys((prev) => {
          const next = new Set(prev);
          result.keys.forEach((key) => next.add(key));
          return next;
        });
      } else if (result.sent) {
        toast.warning('这次没有改成，请再试一次');
      }

      window.dispatchEvent(
        new CustomEvent('ct:adopt-result', {
          detail: { ok: result.ok, sent: result.sent, keys: result.keys, source },
        })
      );
      return result;
    },
    [send, sending, toast, blocks, work, chapter, updateBlock]
  );

  // 左侧「检查」面板勾选后，同样交给这里统一发一次 /chat：
  // 写手改稿的入口只有一个，避免两处各写一套流式处理。
  useEffect(() => {
    const onAdopt = (e) => {
      const detail = e.detail || {};
      const findings = Array.isArray(detail.findings) ? detail.findings : [];
      if (!findings.length) return;
      adoptFindings(findings, detail.source || '');
    };
    window.addEventListener('ct:adopt-findings', onAdopt);
    return () => window.removeEventListener('ct:adopt-findings', onAdopt);
  }, [adoptFindings]);

  /** 侧栏意见 → 正文：滚到对应块并高亮。 */
  const jumpToFinding = useCallback((finding) => {
    setActiveFindingKey(finding.key);
    window.dispatchEvent(
      new CustomEvent('ct:focus-block', {
        detail: { blockId: finding.blockId, findingKey: finding.key },
      })
    );
  }, []);

  // 正文沟槽 → 侧栏：滚到那条意见并选中。
  //
  // 不调用 scrollIntoView：它会把外层页面一起滚，而且消息卡片很高时
  // 「先滚卡片、再滚行」两次平滑滚动会互相打架，行最后还是可能停在
  // 视口外。这里只算行相对列表面板的偏移，把它放到面板中间。
  useEffect(() => {
    const onFocusFinding = (e) => {
      const detail = e.detail || {};
      setActiveFindingKey(detail.findingKey || '');

      const listEl = listRef.current;
      if (!listEl) return;
      const row = Array.from(listEl.querySelectorAll('[data-finding-key]')).find(
        (el) => el.dataset.findingKey === detail.findingKey
      );
      if (!row) return;

      const listRect = listEl.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const pad = 10;
      const outside =
        rowRect.top < listRect.top + pad || rowRect.bottom > listRect.bottom - pad;
      if (!outside) return;

      const centered =
        listEl.scrollTop +
        (rowRect.top - listRect.top) -
        (listRect.height - rowRect.height) / 2;
      listEl.scrollTo({ top: Math.max(0, centered), behavior: 'smooth' });
    };
    window.addEventListener('ct:focus-finding', onFocusFinding);
    return () => window.removeEventListener('ct:focus-finding', onFocusFinding);
  }, []);

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

  /**
   * 打开一条历史对话。
   *
   * 服务端存的是结构化输出，这里转成消息流要的形状：
   * 重新生成依赖 prompt（这一轮问了什么）与 serverMessageId，
   * 缺了它们，历史里的回答只能看不能重来。
   */
  const openHistoryConversation = useCallback(
    async (id) => {
      if (sending) {
        toast.warning('正在生成回复，等这一轮结束再切换对话');
        return;
      }

      setHistoryLoading(true);
      try {
        const res = await fetch(
          `/api/ai/conversations/${encodeURIComponent(id)}/messages`,
          { credentials: 'include' }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || '加载失败');
        }

        let lastPrompt = '';
        const list = (data.messages || []).map((m) => {
          if (m.role === 'user') {
            lastPrompt = m.content;
            return {
              id: m.id,
              role: 'user',
              content: m.content,
              serverMessageId: m.id,
            };
          }

          const role = roles.find((r) => r.key === m.roleKey);
          return {
            id: m.id,
            role: 'assistant',
            roleKey: m.roleKey || '',
            content: m.content,
            action: m.action,
            target: m.target || '',
            reason: m.reason || '',
            citations: m.citations || [],
            findings: Array.isArray(m.findings) ? m.findings : [],
            // 历史消息也保留节拍/降级/冲突徽标：payload 里存了同一份结构化结果。
            beatCheck: m.beatCheck || null,
            planDegraded: m.planDegraded || '',
            anchorViolations: Array.isArray(m.anchorViolations) ? m.anchorViolations : [],
            roleLabel:
              m.roleLabel || (role ? `${role.icon} ${role.name}` : ''),
            toolTrace: m.toolTrace || [],
            applied: false,
            prompt: lastPrompt,
            serverMessageId: m.id,
            memoryRefs: [],
            memoryDegraded: false,
            memoryReason: '',
            excludedRefIds: [],
          };
        });

        dispatch({ type: 'conversation/load', conversationId: data.id, messages: list });

        // 沿用这条对话最后用的角色：切回旧对话却换了人设，
        // 接着问下去的回答风格会突然变掉。
        const lastRoleKey = (data.messages || [])
          .map((m) => m.roleKey)
          .filter(Boolean)
          .pop();
        if (lastRoleKey) {
          dispatch({ type: 'role/set', roleKey: lastRoleKey });
        }

        setHistoryOpen(false);
      } catch (e) {
        toast.error(e.message || '加载历史对话失败');
      } finally {
        setHistoryLoading(false);
      }
    },
    [sending, roles, dispatch, toast]
  );

  const startNewConversation = useCallback(() => {
    if (sending) {
      toast.warning('正在生成回复，等这一轮结束再开新对话');
      return;
    }
    dispatch({ type: 'message/clear' });
    setHistoryOpen(false);
  }, [sending, dispatch, toast]);

  const stop = () => {
    // 连点两下没有意义：第一下已经中断了，第二下只会让状态闪一下。
    if (!abortRef.current || stopPhase === 'stopping') return;
    setStopPhase('stopping');
    abortRef.current.abort();
  };

  // 组件卸载时把收尾定时器清掉，避免卸载后 setState。
  useEffect(() => () => clearTimeout(stopTimerRef.current), []);

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

      <CardProposals
        workId={work?.id}
        chapterId={chapter?.id}
        refreshToken={proposalRefresh}
      />

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
          findingsByMessage={findingsByMessage}
          chapterSeq={chapter?.seq}
          activeFindingKey={activeFindingKey}
          adoptedFindingKeys={adoptedFindingKeys}
          onAdoptFindings={adoptFindings}
          onJumpToFinding={jumpToFinding}
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
          {/* 历史对话与清空都是偶尔用一次的动作，收进「⋯」；
              输入区只留「发送」这一件事常驻可见。 */}
          <Dropdown
            trigger={['click']}
            placement="topLeft"
            menu={{
              items: [
                {
                  key: 'history',
                  icon: <History size={13} />,
                  label: '历史对话',
                  disabled: sending,
                  onClick: () => setHistoryOpen(true),
                },
                {
                  key: 'clear',
                  icon: <ClearOutlined />,
                  label: '清空当前对话',
                  disabled: sending || !messages.length,
                  onClick: clearChat,
                },
              ],
            }}
          >
            <Button
              size="small"
              type="text"
              icon={<MoreHorizontal size={15} />}
              title="更多"
              aria-label="更多对话操作"
            />
          </Dropdown>
          <span style={{ flex: 1 }} />
          {sending || stopPhase === 'stopping' ? (
            <button
              type="button"
              className="ct-ai-stop"
              onClick={stop}
              disabled={stopPhase === 'stopping'}
              title="停止生成"
              aria-label="停止生成"
            >
              {stopPhase === 'stopping' ? (
                <LoadingOutlined spin className="ct-ai-stop-spin" />
              ) : (
                <span className="ct-ai-stop-glyph" aria-hidden />
              )}
              {stopPhase === 'stopping' ? '停止中' : '停止'}
            </button>
          ) : stopPhase === 'stopped' ? (
            <span className="ct-ai-stopped" role="status">
              已停止生成
            </span>
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

      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        workId={work?.id}
        currentId={conversationId}
        busy={historyLoading}
        onSelect={openHistoryConversation}
        onNew={startNewConversation}
      />
    </div>
  );
}
