'use strict';

/**
 * AI 路由。
 *
 *   POST /api/ai/chat      侧边栏对话，SSE 流式
 *   POST /api/ai/inline    行内操作，非流式，返回结构化 JSON
 *   GET  /api/ai/roles     角色列表（含用户覆盖后的实际提示词）
 *   POST /api/ai/prompts/:roleKey  保存提示词覆盖
 *   DELETE /api/ai/prompts/:roleKey 恢复默认
 *   GET  /api/ai/status    provider 连通状态
 *   POST /api/ai/messages/:messageId/remember  把一条消息记入长期记忆
 *   GET  /api/ai/conversations            历史对话列表
 *   GET  /api/ai/conversations/:id/messages  一条历史对话的消息
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');
const aiConfig = require('../services/aiConfig');
const { resolveProvider, checkAllProviders } = require('../services/providers');
const { assembleContext, trimHistory } = require('../services/context');
const roles = require('../services/roles');
const localSearch = require('../services/search/local');
const webSearch = require('../services/search/deepseekSearch');
const { ownedWork } = require('../services/scope');
const { countWords } = require('../services/wordCount');
const memory = require('../services/memory/retriever');
const indexer = require('../services/memory/indexer');
const memoryConv = require('../services/memory/conversation');
const memorySources = require('../services/memory/sources');
const { parseModelJson } = require('../services/agent/parse');
const { runAgentLoop } = require('../services/agent/loop');
const {
  generateBeatPlan,
  checkBeatCoverage,
  formatBeatPlan,
  buildRewriteInstruction,
  beatBadge,
} = require('../services/agent/beatPlan');
const referenceAnchor = require('../services/agent/referenceAnchor');
const segmentWriter = require('../services/agent/segmentWriter');

const router = express.Router();

/** 规划步上限：超时即降级直写，不重试 */
const PLAN_TIMEOUT_MS = 45000;
/**
 * 写手单次输出预算。
 *
 * 基线 5000 字长章实测约 3500 tokens；思考模式还要从同一份预算里扣
 * reasoning，4096 会把正文挤空，8192 也没有余量，所以按 10000 给足。
 * 若上游存在更低的硬上限，会在这里报错，由部署侧顶到实际上限。
 */
const WRITER_MAX_TOKENS = 10000;
/** 单次起稿/重写的上限：按 10000 tokens 的生成时间留出余量（未分段时用） */
const WRITE_TIMEOUT_MS = 150000;
/** 分段起稿的单次调用上限。一组约 1300–1800 字，实测 15–30s，90s 留足余量 */
const SEGMENT_CALL_TIMEOUT_MS = 90000;
/** 覆盖自检上限：超时按「未自检」交付，不阻塞。正文 5000 字实测约 1.4s */
const CHECK_TIMEOUT_MS = 30000;
/**
 * 整轮预算。
 *
 * 最坏路径：规划 45s + 分段起稿 8 次 × 90s + 全局自检 30s
 * + 分组重写后的复核 30s = 825s，再留 15s 给上下文装配与落库，取 840s。
 * 8 次是硬上限（3 组起稿 + 3 次续写 + 2 次分组重写），
 * 超过就降级交付，不会无限重试。
 * 重写门槛要求剩余预算 ≥ 待重写组数 × 90s + 一次复核（30s），
 * 否则宁可保留当前稿，不半路开一个注定跑不完的重写。
 */
const ROUND_BUDGET_MS = 840000;

/**
 * 把模型给的字段转成可显示的文本。
 *
 * 模型不总是听话：content 有时是数组（分段写），有时是对象，
 * 还有时干脆给个数字。只接受 string 的话，这些情况会一律变成空串——
 * 作者看到的就是一个什么都没有的空白框。
 * 所以这里做兜底：数组按行拼，象取文本值，其余转字符串。
 */
function toText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';

  if (Array.isArray(value)) {
    return value
      .map((item) => toText(item))
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value === 'object') {
    // 常见的 { text: '...' } / { content: '...' } 形状
    for (const key of ['text', 'content', 'value']) {
      if (typeof value[key] === 'string') return value[key];
    }
    try {
      return JSON.stringify(value);
    } catch (e) {
      return '';
    }
  }

  return String(value);
}

/**
 * 归一化结构化输出，确保字段齐全且类型正确。
 */
function normalizeAction(payload) {
  if (!payload || typeof payload !== 'object') {
    return { action: 'none', content: '', reason: '', citations: [], findings: [] };
  }

  const validActions = ['replace', 'append', 'insert', 'comment', 'none', 'call_tool'];
  let action = validActions.includes(payload.action) ? payload.action : 'none';

  const content = toText(payload.content);
  const reason = toText(payload.reason);
  const target = toText(payload.target);

  const citations = Array.isArray(payload.citations)
    ? payload.citations
        .filter((c) => c && (c.title || c.snippet || c.url))
        .map((c) => ({
          source: String(c.source || '未知来源'),
          title: String(c.title || ''),
          snippet: String(c.snippet || ''),
          url: String(c.url || ''),
          // 站内素材的 id：前端靠它跳回素材详情
          materialId: c.materialId ? String(c.materialId) : '',
          // PDF 素材的页码：作者要能核对"出自第几页"
          page: Number(c.page) || 0,
        }))
    : [];

  // action=none 但有内容时，按对话回复处理
  if (action === 'none' && !content) {
    action = 'none';
  }

  // 工具调用摘要。技能执行结果由 loop.js 收集，通过 payload.skills 传进来。
  // 这一列必须在白名单里，否则会被静默丢弃——不报错，只是数据不见了。
  //
  // detail（读了哪些章、命中了哪些词）与 error（失败原因）也要带上：
  // 只留 label/summary 的话，回答落地后过程条就只剩一行字，
  // 作者没法再核对「这次到底读了哪些章」。
  const skills = Array.isArray(payload.skills)
    ? payload.skills.map((s) => ({
        tool: String(s.tool || ''),
        label: String(s.label || ''),
        summary: String(s.summary || ''),
        degraded: Boolean(s.degraded),
        detail: Array.isArray(s.detail)
          ? s.detail
              .filter((d) => d && (d.label || d.text))
              .map((d) => ({ label: String(d.label || ''), text: String(d.text || '') }))
          : [],
        error: String(s.error || ''),
      }))
    : [];

  // 审稿意见的结构化锚点。只做最小校验：quote 必填且不少于 6 字，text 必填；
  // 真实匹配由前端按当前正文实时做，这里不判断块是否存在。
  const findings = Array.isArray(payload.findings)
    ? payload.findings
        .map((f, i) => {
          if (!f || typeof f !== 'object') return null;
          const quote = toText(f.quote).trim();
          const text = toText(f.text || f.content).trim();
          if (!quote || !text || quote.replace(/\s+/g, '').length < 6) return null;
          const id = toText(f.id).trim() || `f${i + 1}`;
          const blockId = toText(f.blockId).trim();
          return blockId ? { id, quote, text, blockId } : { id, quote, text };
        })
        .filter(Boolean)
    : [];

  return { action, target, content, reason, citations, skills, findings };
}

/**
 * 解析角色最终实际生效的模型与思考状态。
 *
 * 角色级值有三种来源：角色自带默认、作者显式覆盖、跟随全局。
 * 设置页必须显示"最终用的是哪个"，否则作者看到"跟随全局设置"，
 * 根本猜不到实际跑的是哪套参数。
 *
 * 另外要算出温度到底生不生效：DeepSeek 思考模式下会忽略 temperature
 * （官方明确说明：设了不报错，但也没有任何效果）。
 * 前端据此把温度滑块置灰，避免作者调了半天发现毫无变化。
 */
function decorateRole(role, cfg, activeProvider) {
  const deepseek = cfg.deepseek || {};
  const globalThinking = deepseek.thinking === true;
  const globalModel = deepseek.model || 'deepseek-flash';

  // null / '' 表示跟随全局
  const thinking = role.thinking === null || role.thinking === undefined
    ? globalThinking
    : role.thinking;
  const model = role.model || globalModel;

  return {
    ...role,
    effectiveModel: model,
    effectiveThinking: thinking,
    // 只有实际用的 provider 是 DeepSeek 且开着思考时，温度才会失效。
    // 降级到 Ollama / OpenAI 兼容服务时它们没有思考模式，温度照常生效。
    temperatureEffective: !(activeProvider === 'deepseek' && thinking),
    // 全局基线也一起返回：作者在设置页改下拉框时需要实时重算，
    // 光给"已保存状态"的解析结果不够。
    globalThinking,
    globalModel,
    provider: activeProvider,
  };
}

/**
 * 模型没给出内容时，给作者一句能照着做的话。
 *
 * 这里必须区分四类失败，否则作者只会干等着重复重试：
 *   - 被长度上限截断：思考模式最常见，reasoning 计入 max_tokens，
 *     预算被思考吃光，正文一个字都没轮到。该做的是换个更短的说法再试。
 *   - 内容审核拦下：模型照常计费但一个字都不返回。
 *   - 只思考没正文：模型有 reasoning，但没写正文。
 *   - 上游真空响应：既没有正文，也没有思考内容——是供应商侧的空白完成。
 *
 * 措辞只说作者做得到的事。调大输出上限、关掉深度思考是部署期的运维动作，
 * 设置页里并没有这些开关——让作者去"设置里找"只会让他更困惑。
 *
 * @returns {{code: string, message: string}}
 */
function describeEmptyReply(result = {}, reasoning = '') {
  if (result.finishReason === 'length') {
    return {
      code: 'AI_TRUNCATED',
      message: '这次输出被长度上限截断了，正文没写完。可以把要求说得更短一点再试。',
    };
  }
  if (result.finishReason === 'content_filter') {
    return {
      code: 'AI_CONTENT_FILTER',
      message:
        '这段内容可能触发了模型的内容审核，没能给出正文。可以换个说法，或先把可能敏感的段落改一改再试。',
    };
  }
  if (reasoning && reasoning.trim()) {
    return {
      code: 'AI_REASONING_ONLY',
      message: '模型这次只做了思考，没有给出正文。请再试一次，或把要求说得更具体些。',
    };
  }
  return {
    code: 'AI_EMPTY_RESPONSE',
    message:
      '上游返回了空响应：既没有正文，也没有思考内容。请再试一次；如果连续出现，说明供应商这一轮不稳定。',
  };
}

/**
 * 取得或创建会话。会话按用户隔离：别人的 conversationId 直接当作不存在。
 */
async function ensureConversation(conversationId, workId, title, userId) {
  if (conversationId) {
    const existing = await get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [
      conversationId,
      userId,
    ]);
    if (existing) return existing;
  }

  // 会话挂作品时必须确认作品属于本人，否则会把别人的 work_id 写进自己的会话
  const work = await ownedWork(workId, userId);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    'INSERT INTO conversations (id, user_id, work_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, work ? work.id : null, title || '新对话', now, now]
  );
  return get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
}

// ---------------------------------------------------------------------------
// 站内素材检索
// ---------------------------------------------------------------------------

/**
 * 作者明确表达"找/查/搜"意图的信号词。
 * 资料员角色不需要信号——它的本职就是检索。
 */
const SEARCH_INTENT = [
  '找找', '查找', '搜', '搜索', '查一下', '查查', '有没有', '有吗',
  '素材', '资料', '参考', '出处', '来源', '原文', '典故', '引用',
];

/**
 * 作者明确要"外部资料"的信号词。
 * 站内素材是作者自己的东西，联网是查世界上的事实，两者不能混为一谈。
 */
const WEB_INTENT = [
  '上网', '网上', '联网', '外网', '外部', '外部资料', '外部信息',
  '百度', '维基', '百科', '谷歌', 'google', 'wiki', 'wikipedia',
  '网上查', '上网查', '查一下网上',
];

/**
 * 判断这次提问是否需要检索素材库。
 */
function needsRetrieval(roleKey, message) {
  if (roleKey === 'researcher') return true;
  return SEARCH_INTENT.some((word) => message.includes(word));
}

/**
 * 作者明确要"原文/全文"的信号词。
 * search 返回的 summary 只有几百字，正文细节要 fetch 才有。
 */
const FETCH_INTENT = ['原文', '全文', '完整版', '完整内容', '详细内容', '详细点', '具体内容'];

/**
 * 判断是否要联网检索。
 * 资料员默认要联网——它的本职是"查资料"，站内没有就该往外找。
 */
function needsWebSearch(roleKey, message) {
  if (roleKey === 'researcher') return true;
  return WEB_INTENT.some((word) => message.toLowerCase().includes(word));
}

/**
 * 判断是否要抓取网页正文。
 */
function needsWebFetch(message) {
  return FETCH_INTENT.some((word) => message.includes(word));
}

/**
 * 检索素材库与外部资料，归一化成上下文装配器认识的片段格式。
 *
 * 站内检索是纯关键词匹配，召回的是"候选"——真正相关的片段由模型二次筛选，
 * 所以这里放宽召回、限制条数，把判断权交给模型。
 *
 * @returns {Promise<{fragments: Array, notices: Array<string>}>}
 *   fragments 是喂给模型的参考资料，notices 是给作者看的提示
 *   （比如"联网检索没配 key，这次只用了站内素材"）
 */
async function runRetrieval(roleKey, message, existing, userId) {
  if (!needsRetrieval(roleKey, message)) {
    return { fragments: existing, notices: [] };
  }

  const fragments = [];
  const notices = [];

  let results = await localSearch.searchLoose(message, { limit: 4, userId });

  // "素材库里有什么能用的"这类问法没有具体检索目标，关键词必然零命中。
  // 这时候给模型最近更新的几条，让它自己去判断哪条用得上。
  if (!results.length && localSearch.isGenericQuery(message)) {
    results = await localSearch.recent(4, userId);
  }

  for (const r of results) {
    fragments.push({
      kind: 'local',
      title: r.title,
      snippet: r.snippet,
      source: r.source,
      sourceUrl: r.sourceUrl,
      materialId: r.id,
      page: r.page || 0,
    });
  }

  // 联网检索。作者明确要外部资料时无条件查；
  // 资料员角色在站内没查到东西时也往外找——本地没有就该上网。
  if (needsWebSearch(roleKey, message) || (roleKey === 'researcher' && !results.length)) {
    const web = await webSearch.search(message, {
      oriQuestion: message,
      count: 4,
    });
    if (web.ok) {
      const webFragments = web.items.map((item) => ({
        kind: 'web',
        title: item.title,
        snippet: item.snippet,
        source: '网页',
        sourceUrl: item.url,
        materialId: '',
        page: 0,
      }));

      // 作者要"原文/全文"时，把最相关的那条网页正文抓下来换掉摘要
      if (webFragments.length && needsWebFetch(message)) {
        const fetched = await webSearch.fetchPage(webFragments[0].sourceUrl);
        if (fetched.ok && fetched.content) {
          webFragments[0].snippet = fetched.content;
        }
      }

      fragments.push(...webFragments);
    } else if (web.reason) {
      // 联网不可用（没配 key / 请求失败）要告诉作者，不能默默少给资料
      notices.push(web.reason);
    }
  }

  if (!fragments.length) return { fragments: existing, notices };

  // 调用方已经带了片段（用户手动指定的），以手动的为准
  return { fragments: existing.length ? existing : fragments, notices };
}

/**
 * 把检索到的素材补进引用列表。
 *
 * 模型自己写的 citations 只覆盖它"用到了"的部分，但作者需要知道
 * "系统查到了哪些、查到了什么"。这里把检索到的素材一并附上，
 * 保证每条素材都带可点开的来源。
 */
function mergeCitations(modelCitations, fragments) {
  const list = Array.isArray(modelCitations) ? [...modelCitations] : [];
  const seen = new Set(list.map((c) => c.materialId || c.url || c.title));

  for (const fragment of fragments) {
    if (!fragment) continue;
    // 站内素材有 materialId，联网结果只有 url，两者都是有效来源
    const key = fragment.materialId || fragment.sourceUrl;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({
      source: fragment.source || '素材库',
      title: fragment.title,
      snippet: fragment.snippet,
      url: fragment.sourceUrl || '',
      materialId: fragment.materialId || '',
      page: fragment.page || 0,
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// 长期记忆召回
// ---------------------------------------------------------------------------

/**
 * 取当前章的尾部正文，作为召回查询的一部分。
 *
 * 只用作者这一句指令做查询太窄——"继续写"这种指令没有任何语义，
 * 拿它去检索什么也召不回来。当前章末尾才是"作者正在写什么"的真实信号。
 *
 * @param {string} chapterId
 * @param {string} userId
 * @param {Array} [blocks] 编辑中未保存的块，优先于已存正文
 * @returns {Promise<string>}
 */
async function getChapterTail(chapterId, userId, blocks) {
  if (Array.isArray(blocks) && blocks.length) {
    const text = blocks
      .filter((b) => b && b.content)
      .map((b) => b.content)
      .join('\n\n');
    if (text) return text.slice(-1500);
  }

  if (!chapterId || !userId) return '';

  const chapter = await get(
    `SELECT c.content, c.blocks FROM chapters c
     JOIN works w ON w.id = c.work_id
     WHERE c.id = ? AND w.user_id = ?`,
    [chapterId, userId]
  );
  if (!chapter) return '';

  let text = chapter.content || '';
  try {
    const parsed = JSON.parse(chapter.blocks || '[]');
    if (Array.isArray(parsed) && parsed.length) {
      text = parsed
        .filter((b) => b && b.content)
        .map((b) => b.content)
        .join('\n\n');
    }
  } catch (e) {
    // blocks 不是合法 JSON 就退回 content
  }

  return text.slice(-1500);
}

/**
 * 召回长期记忆。
 *
 * 任何一步失败都只返回空结果——记忆是加分项，不是必需品。
 *
 * @param {object} params
 * @returns {Promise<{refs: Array, degraded: boolean, reason: string}>}
 */
async function recallMemory(params) {
  const {
    req,
    workId,
    chapterId,
    blocks,
    instruction,
    useMemory,
    excludeRefIds,
    excludeSourceKeys,
    scope = 'chat',
  } = params;

  if (!useMemory || !workId) {
    return { refs: [], degraded: false, reason: '' };
  }

  try {
    // 换了 embedding 模型还没重建索引时，旧向量维度对不上，
    // 混用会得到"看起来正常但全是错的"结果——直接不召回。
    const consistency = await indexer.checkMetaConsistency(req.userId);
    if (!consistency.ok) {
      return { refs: [], degraded: true, reason: consistency.reason };
    }

    const chapterTail = await getChapterTail(chapterId, req.userId, blocks);
    const query = memory.buildQueryText({ chapterTail, instruction });

    return await memory.retrieve({
      userId: req.userId,
      workId,
      query,
      // 当前章的正文已经全量注进上下文了，召回它没有意义。
      excludeChapterId: chapterId || '',
      excludeRefIds: Array.isArray(excludeRefIds) ? excludeRefIds : [],
      excludeSourceKeys: Array.isArray(excludeSourceKeys) ? excludeSourceKeys : [],
      scope,
    });
  } catch (e) {
    return { refs: [], degraded: true, reason: '记忆召回失败' };
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/chat —— 侧边栏对话，SSE
// ---------------------------------------------------------------------------
router.post('/chat', async (req, res) => {
  const {
    message,
    workId,
    chapterId,
    roleKey = 'writer',
    conversationId,
    scope = 'chapter',
    blocks,
    useMemory = true,
    excludeRefIds = [],
    replaceMessageId = '',
  } = req.body || {};
  let retrieval = Array.isArray(req.body?.retrieval) ? req.body.retrieval : [];

  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // 客户端断开（关页面、点取消）时立刻中止模型调用，不让它在后台空转烧 token。
  // 再兜一个整轮上限：模型卡住时，作者至少能收到一条明确的错误。
  //
  // 为什么按 420s 算：一轮可能包含多次模型调用（技能循环最多 4 步），
  // 长文起稿还要再叠一次缺拍重写。按「规划 45 + 起稿 150 + 自检 30 +
  // 重写 150 + 复核 30」的最坏路径留 15s 余量，见 ROUND_BUDGET_MS。
  // provider 的单次调用超时（180s）在下面一层，两层一起兜底。
  const clientAbort = new AbortController();
  const roundSignal = AbortSignal.any([clientAbort.signal, AbortSignal.timeout(ROUND_BUDGET_MS)]);
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort();
    }
  });

  // 本次新插入的用户消息。失败时要把它清掉，
  // 否则历史里会留下"作者问了、但没人答"的记录，污染下一轮的上下文。
  //
  // 重新生成时上一版的提问会被复用（既不删也不重建），这时它是 null——
  // 复用的那条是原稿的一部分，不能删。
  let insertedUserMessageId = null;

  // 重新生成时：被替换掉的上一版回答，以及复用的上一版提问。
  let replacedMessage = null;
  let reusedUserMessage = null;

  let conversation = null;

  // 本次调用的追踪 id：日志和 done 事件都用它，排查时能把两边对上
  const traceId = crypto.randomUUID();

  // 被摘掉的旧回答。失败时要原样放回去。
  let removedRows = [];

  const restoreRemoved = async () => {
    for (const row of removedRows) {
      await run(
        `INSERT INTO messages (id, conversation_id, role, content, role_key, action, payload, citations, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.conversation_id,
          row.role,
          row.content,
          row.role_key,
          row.action,
          row.payload,
          row.citations,
          row.created_at,
        ]
      ).catch(() => {});
    }
  };

  try {
    // 站内素材检索 + 联网检索：资料员角色总会搜；其他角色在作者明确要"找/查"时也搜。
    // 检索结果既进上下文，也作为引用的兜底来源。
    const { fragments: searched, notices } = await runRetrieval(
      roleKey,
      String(message),
      retrieval,
      req.userId
    );
    if (searched.length) {
      retrieval = searched;
    }

    // 长期记忆召回。失败或超时都只是少一段上下文，不能影响这次对话。
    //
    // 重新生成时，上一版回答的记忆要整条排掉：
    // 作者要的是另一个答案，不是让模型在旧答案的记忆上继续写。
    // 对话三层都以消息 id 为来源 id，所以三个键都排掉。
    const excludeSourceKeys = replaceMessageId
      ? ['conv_raw', 'conv_fact', 'conv_manual'].map((type) => `${type}:${replaceMessageId}`)
      : [];

    const memoryResult = await recallMemory({
      req,
      workId,
      chapterId,
      blocks,
      instruction: String(message),
      useMemory,
      excludeRefIds,
      excludeSourceKeys,
      scope: 'chat',
    });

    const { messages, meta } = await assembleContext({
      workId,
      chapterId,
      roleKey,
      scope,
      retrieval,
      memoryRefs: memoryResult.refs,
      blocks,
      userId: req.userId,
    });

    conversation = await ensureConversation(conversationId, workId, undefined, req.userId);
    const now = new Date().toISOString();

    // 重新生成：把上一版回答从历史里摘掉。
    //
    // 不摘的话，模型会在上下文里同时看到"上一版回答"和"同一个提问"，
    // 它多半顺着上一版继续写，而不是重新回答——作者剔除记忆后想看的
    // 是另一个答案，而不是旧答案的续写。
    //
    // 只摘回答，**保留那一轮的提问**：作者可能对提问点过「记入记忆」，
    // 手动层是按消息 id 锚定的，把这行删掉再新建一条新 id 的，
    // 作者手动记下的东西就指空了。
    //
    // 先删后插，失败时再把删掉的行原样写回去：一次失败的重生成
    // 不该把作者之前已经拿到的好答案弄丢。
    if (replaceMessageId) {
      const old = await get(
        'SELECT * FROM messages WHERE id = ? AND conversation_id = ?',
        [replaceMessageId, conversation.id]
      );
      if (old) {
        replacedMessage = old;

        // 同一轮里在它之前的用户提问——复用它，不删
        const prevUser = await get(
          `SELECT * FROM messages
           WHERE conversation_id = ? AND role = 'user'
             AND rowid <= (SELECT rowid FROM messages WHERE id = ?)
           ORDER BY rowid DESC LIMIT 1`,
          [conversation.id, replaceMessageId]
        );
        reusedUserMessage = prevUser || null;

        removedRows = [old];
        for (const row of removedRows) {
          await run('DELETE FROM messages WHERE id = ?', [row.id]);
        }
      }
    }

    // 历史消息
    // 重新生成时，复用的那行提问还在库里，但它要作为"这一轮的问题"
    // 出现在最后，所以先从历史里剔掉。
    const history = reusedUserMessage
      ? await all(
          `SELECT role, content FROM messages
           WHERE conversation_id = ? AND id != ?
           ORDER BY created_at, rowid`,
          [conversation.id, reusedUserMessage.id]
        )
      : await all(
          'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
          [conversation.id]
        );

    // 历史可能很长。超出预算时只保留最近一段，并从 user 消息开始——
    // 从 assistant 开头截断，模型会看到"没有提问的回答"，顺着它继续写。
    const historyTrim = trimHistory(history);

    // 保存用户消息
    // id 记下来：这次调用失败时要把它删掉，否则历史里会留下一条
    // "作者问了、但没有任何回答"的孤立消息，污染下一轮的上下文。
    //
    // 重新生成时上一版的提问还在，而且就是同一个问题——不新建一条。
    if (!reusedUserMessage) {
      insertedUserMessageId = crypto.randomUUID();
      await run(
        'INSERT INTO messages (id, conversation_id, role, content, role_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [insertedUserMessageId, conversation.id, 'user', String(message), roleKey, now]
      );

      // 用第一句话当会话标题。历史列表里一屏都是「新对话」的话，
      // 作者只能逐条点开去找，等于没有历史。
      if (!conversation.title || conversation.title === '新对话') {
        const title = makePreview(message).slice(0, 24);
        if (title) {
          await run('UPDATE conversations SET title = ? WHERE id = ?', [title, conversation.id]);
          conversation.title = title;
        }
      }
    }

    const chatMessages = [
      ...messages,
      ...historyTrim.rows.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(message) },
    ];

    // 省掉的历史要明说：不说的话模型会以为对话刚刚开始，
    // 作者谈过的事它一概装作没听过。
    if (historyTrim.omitted > 0 && messages.length) {
      messages[0].content += `\n\n（说明：更早的 ${historyTrim.omitted} 条历史消息因长度限制已省略。）`;
    }

    const aiCfg = aiConfig.getConfig();
    const { provider, name, degraded, reason } = resolveProvider(aiCfg);

    if (degraded) {
      send({ type: 'notice', content: reason });
    }
    // 检索过程中的提示（比如联网检索没配 key）
    for (const notice of notices) {
      send({ type: 'notice', content: notice });
    }

    // 记忆事件必须在第一个 token 之前发。
    // 前端要先把"本次参考了哪几条记忆"显示出来，
    // 迟了就会和已经流出来的正文混在一起，作者分不清哪段是记忆。
    send({
      type: 'memory',
      refs: memoryResult.refs.map((ref) => ({
        id: ref.id,
        sourceType: ref.sourceType,
        label: ref.label,
        preview: ref.preview,
        score: ref.score,
        sourceId: ref.sourceId,
        messageId: ref.messageId,
      })),
      degraded: memoryResult.degraded,
      reason: memoryResult.reason,
    });

    const role = await roles.getRole(roleKey, req.userId);

    // 角色模型只在 DeepSeek 下生效——其他 provider 用的是自己配置的模型名，
    // 硬套 DeepSeek 的模型名会直接报"模型不存在"。
    // 不提示的话，作者会以为设置已经生效，实际用的是默认模型。
    if (role && role.model && name !== 'deepseek') {
      send({
        type: 'notice',
        content: `角色模型「${role.model}」仅在 DeepSeek 下生效，当前使用的是 ${name} 的默认模型。`,
      });
    }

    const startedAt = Date.now();

    // 流式输出
    let fullText = '';

    // 进入循环之前先告诉作者"正在判断"。
    // 第一轮模型调用的 token 全被缓冲不下发（见 loop.js），
    // 没有这个信号，作者从发问到看到任何反馈之间只有一个不动的空占位。
    send({ type: 'agent_thinking', label: '正在判断需要查什么' });

    // ---- 节拍规划（写手起稿前） ----
    //
    // 只对「写手 + 具体章节」生效：其它角色（审稿、资料）不需要节拍表，
    // 没有章节的闲聊也没法规划。
    //
    // 规划失败一律降级直写：它只是增强，不能因为规划挂了就让整轮失败。
    const planningEnabled = roleKey === 'writer' && Boolean(chapterId);
    let beatPlan = null;
    let planDegraded = '';

    if (planningEnabled) {
      send({ type: 'agent_thinking', label: '正在规划本章节拍' });
      const planStartedAt = Date.now();
      try {
        // 规划用同一份上下文快照，但不注入整章正文：
        // 把原文再塞一遍，模型会把改写任务当成"润色"，而不是重新编排。
        const planContext = await assembleContext({
          workId,
          chapterId,
          roleKey,
          scope,
          retrieval,
          memoryRefs: memoryResult.refs,
          blocks,
          userId: req.userId,
          includeChapterBody: false,
        });

        const planOut = await generateBeatPlan({
          provider,
          systemPrompt: planContext.messages[0].content,
          instruction: String(message),
          options: {
            temperature: role?.temperature,
            model: role?.model && name === 'deepseek' ? role.model : undefined,
            thinking: role?.thinking === null || role?.thinking === undefined
              ? undefined
              : (role.thinking ? 'enabled' : 'disabled'),
            // 45s 硬顶；取消信号一路沿用，作者断开时规划立刻停。
            signal: AbortSignal.any([roundSignal, AbortSignal.timeout(PLAN_TIMEOUT_MS)]),
          },
        });

        const planMs = Date.now() - planStartedAt;
        if (planOut.plan) {
          beatPlan = planOut.plan;
          // 拼进写手请求：system 末尾、技能清单之前。
          chatMessages[0].content += `\n\n---\n\n${formatBeatPlan(beatPlan)}`;
        } else {
          planDegraded = planOut.reason || 'failed';
        }

        console.log(
          JSON.stringify({
            event: 'ai_plan',
            traceId,
            userId: req.userId,
            role: roleKey,
            ok: Boolean(beatPlan),
            reason: planDegraded,
            durationMs: planMs,
            beats: beatPlan ? beatPlan.beats.length : 0,
            paragraphs: beatPlan ? beatPlan.totalParagraphs : 0,
            errors: (planOut.errors || []).slice(0, 6),
            usage: planOut.usage || null,
          })
        );

        if (!beatPlan && !roundSignal.aborted) {
          // 作者要看得见"这一轮没有规划"：否则他只会觉得这次写得松散，
          // 却不知道是规划环节降级了。
          send({ type: 'notice', content: '本章节拍规划没有成功，这一轮按直写处理（未规划）。' });
        }
      } catch (err) {
        // 规划出意外（含取消）都不该挡住写作。
        planDegraded = err.code === 'AI_TIMEOUT' ? 'timeout' : 'error';
        console.error('节拍规划失败：', err.message);
      }
    }

    // ---- 范文编排锚点（作者授权后） ----
    //
    // 位置紧挨节拍表：先告诉模型「这一章要发生什么」，再给一段
    // 「好的编排长什么样」的参照。默认不注入；作者开启并确认后才会返回内容，
    // 撤回时内容已被清空，这里拿到的就是空串。
    if (planningEnabled) {
      const anchorBlock = await referenceAnchor.buildInjection(req.userId);
      if (anchorBlock) {
        chatMessages[0].content += `\n\n---\n\n${anchorBlock}`;
        console.log(
          JSON.stringify({
            event: 'ai_anchor',
            traceId,
            userId: req.userId,
            role: roleKey,
            chars: Array.from(anchorBlock).length,
          })
        );
      }
    }

    const runChat = (messagesForRound = chatMessages, overrides = {}, hooks = {}) =>
      runAgentLoop({
        provider,
        messages: messagesForRound,
        options: {
          temperature: role?.temperature,
          // 角色模型只在 DeepSeek 下生效——别的 provider 用的是自己的模型名，
          // 硬套 DeepSeek 的模型名会直接报"模型不存在"。
          model: role?.model && name === 'deepseek' ? role.model : undefined,
          thinking: role?.thinking === null || role?.thinking === undefined
            ? undefined
            : (role.thinking ? 'enabled' : 'disabled'),
          // 写手预算：5000 字长章约 3500 tokens，思考还会额外占用同一份
          // max_tokens，10000 才能把正文完整写完。
          maxTokens: WRITER_MAX_TOKENS,
          // 取消/超时信号一路传到 provider：客户端断开时请求立刻停掉
          signal: roundSignal,
          // 重试时可以覆盖：关 JSON 模式 / 关思考，见下面的空回复重试
          ...overrides,
        },
        ctx: {
          userId: req.userId,
          workId: conversation.work_id,
          // 当前章节：技能要检查「这一章写得符不符合文风」时需要它。
          chapterId: chapterId || '',
          providerName: name,
          degraded,
          role: roleKey,
          signal: roundSignal,
        },
        onToken: (token) => {
          // 分段起稿时不往外推 token：各段的正文要等全部写完再拼成整章，
          // 中途先推出去的话，续写或分组重写会让作者看到一份前后矛盾的稿子。
          if (hooks.suppressTokens) return;
          fullText += token;
          send({ type: 'token', content: token });
        },
        onToolStart: ({ tool, label }) => {
          if (hooks.suppressTokens) return;
          send({ type: 'tool_start', tool, label });
        },
        onToolDone: ({ tool, result }) => {
          if (hooks.suppressTokens) return;
          // 工具调用的记账由 loop.js 负责，这里只负责把事件推给前端。
          // 两处都记一份的话，字段形状会慢慢分叉（失败项带不带 error、
          // 摘要里要不要带明细），改一处漏一处就是静默丢数据。
          send({
            type: 'tool_done',
            tool,
            label: result.label || tool,
            summary: result.summary || '',
            detail: result.detail || [],
            degraded: Boolean(result.degraded),
          });
        },
        onToolError: ({ tool, error }) => {
          if (hooks.suppressTokens) return;
          send({ type: 'tool_done', tool, label: tool, summary: '', detail: [], degraded: false, error });
        },
      });

    // 未分段时的单次上限：一次写太久会把整轮预算吃光，
    // 到点仍然中止并由上层保留已有结果。
    const writeSignal = () => AbortSignal.any([roundSignal, AbortSignal.timeout(WRITE_TIMEOUT_MS)]);
    // 分段起稿时每次调用各自计时：一组超时只丢这一组，不连坐整章。
    const segmentSignal = () =>
      AbortSignal.any([roundSignal, AbortSignal.timeout(SEGMENT_CALL_TIMEOUT_MS)]);

    let finalResult;
    let segmented = null;
    let segmentRun = null;
    let isEmptyReply = false;

    if (planningEnabled && beatPlan) {
      // ---- 分段起稿 ----
      //
      // 每组一次模型调用。每组都带完整节拍表、已写正文尾部和
      // 本组段数/字数目标；只有最后一组允许收束并埋章末钩子。
      send({ type: 'agent_thinking', label: '正在按节拍分组起稿' });

      segmentRun = async ({ instruction }) => {
        const result = await runChat(
          [...chatMessages, { role: 'user', content: instruction }],
          { signal: segmentSignal() },
          { suppressTokens: true }
        );

        const segmentParsed = result.parsed;
        let content = '';
        if (segmentParsed && typeof segmentParsed.content === 'string') {
          content = segmentParsed.content;
        } else if (!segmentParsed) {
          // 和单次起稿同一条回退规则：没按 JSON 返回时，原文就是正文。
          content = String(result.raw || '');
        }

        return {
          content: String(content || '').trim(),
          action: segmentParsed?.action,
          finishReason: result.finishReason,
          usage: result.usage,
        };
      };

      const segmentStartedAt = Date.now();
      segmented = await segmentWriter.draftInSegments({
        plan: beatPlan,
        runSegment: segmentRun,
        maxCalls: segmentWriter.MAX_SEGMENT_CALLS,
        log: (entry) => {
          console.log(
            JSON.stringify({
              event: 'ai_segment',
              traceId,
              userId: req.userId,
              role: roleKey,
              ...entry,
            })
          );
        },
        progress: ({ phase, index, total, beatIds }) => {
          const label =
            phase === 'continue'
              ? `第 ${index + 1}/${total} 组写短了，正在续写`
              : `正在写第 ${index + 1}/${total} 组（${beatIds.join('、')}）`;
          send({ type: 'agent_thinking', label });
        },
      });

      console.log(
        JSON.stringify({
          event: 'ai_segment_done',
          traceId,
          userId: req.userId,
          role: roleKey,
          groups: segmented.groups.length,
          calls: segmented.callCount,
          continuations: segmented.continuations,
          degraded: segmented.degraded,
          paragraphs: segmentWriter.splitParagraphs(segmented.content).length,
          chars: countWords(segmented.content),
          originalChars: segmented.originalChars,
          truncated: segmented.truncated,

          durationMs: Date.now() - segmentStartedAt,
          usage: segmented.usage,
        })
      );

      // 把分段结果包装成和单次起稿一样的形状，后面的自检、重写、落库
      // 全部走同一套逻辑，不再维护第二条分发路径。
      finalResult = {
        parsed: {
          action: segmented.action,
          content: segmented.content,
          reason: `分段起稿（${segmented.groups.length} 组 / ${segmented.callCount} 次调用）`,
          citations: [],
        },
        raw: '',
        reasoning: '',
        toolCalls: [],
        stopReason: 'final',
        finishReason: segmented.finishReason,
        usage: segmented.usage,
      };
    } else {
      finalResult = await runChat(chatMessages, { signal: writeSignal() });

      // 空回复重试一次。
      //
      // DeepSeek 的 JSON 模式偶尔会给出一次完全空白的完成：finish_reason 是 stop、
      // 用量照常计费，正文一个字都没有。也可能是流在第一个正文 token 之前就被掐断。
      // 这两种情况重发一次通常就好了；让作者自己反复点重试，等于把服务端的不稳定
      // 转嫁给他。只在「一个字都没上屏」时重试——已经推给前端的 token 不能重来。
      isEmptyReply =
        !String(finalResult.raw || '').trim() &&
        !finalResult.parsed &&
        !fullText.trim();

      if (isEmptyReply) {
        console.log(
          JSON.stringify({
            event: 'ai_empty',
            traceId,
            userId: req.userId,
            provider: name,
            role: roleKey,
            finishReason: finalResult.finishReason || '',
            usage: finalResult.usage,
          })
        );

        // 重试时压掉较老的历史，并在最后一条消息后补一句提醒。
        //
        // 复现实验（同一段对话、同样的提问）：
        //   完整历史 + JSON 模式 → 稳定返回两三千个空格和换行，一个字正文都没有；
        //   只留最近几轮      → 正常返回 JSON。
        // 所以原样重发没有意义，必须换掉"让模型退化成空白"的那个条件。
        const retryMessages = (() => {
          const hasSystem = chatMessages[0] && chatMessages[0].role === 'system';
          const system = hasSystem ? [chatMessages[0]] : [];
          const rest = hasSystem ? chatMessages.slice(1) : [...chatMessages];
          const recent = rest.slice(-RETRY_HISTORY_KEEP);
          const last = recent[recent.length - 1];
          if (last) {
            recent[recent.length - 1] = {
              ...last,
              content:
                String(last.content || '') +
                '\n\n（上一次没有返回任何内容。这一次不要输出 JSON，直接用纯文本写出完整正文，不要解释。）',
            };
          }
          return [...system, ...recent];
        })();

        finalResult = await runChat(retryMessages, {
          // 关键：换掉"让模型退化成空白"的条件，而不是原样重发。
          // 实测长历史 + response_format=json_object 会稳定返回几千个空格；
          // 第二次关掉 JSON 模式，模型按纯文本输出，正文才拿得回来。
          jsonOutput: false,
          // 思考同样会吃 token 预算，重试时关掉，把预算留给正文。
          ...(role?.thinking ? { thinking: 'disabled' } : {}),
          signal: writeSignal(),
        });
      }
    }

    // 结构化运行记录：一次对话一行，方便排查"为什么慢 / 为什么停"。
    // 只记元信息，不落对话正文。
    console.log(
      JSON.stringify({
        event: 'ai_chat',
        traceId,
        userId: req.userId,
        provider: name,
        role: roleKey,
        durationMs: Date.now() - startedAt,
        stopReason: finalResult.stopReason,
        finishReason: finalResult.finishReason || '',
        retried: isEmptyReply,
        segmented: Boolean(segmented),
        segmentCalls: segmented ? segmented.callCount : 0,
        rawLength: String(finalResult.raw || '').length,
        reasoningLength: String(finalResult.reasoning || '').length,
        tools: finalResult.toolCalls.map((t) => t.tool),
        usage: finalResult.usage,
      })
    );

    const rawText = finalResult.raw || fullText;
    const parsed = finalResult.parsed;

    /**
     * 把一轮模型结果转成可下发的 payload。
     *
     * 抽成函数是因为缺拍重写后要用同一套规则重新算一遍：
     * 解析失败回退原文、正文为空时用 reason 顶上——两条路必须一致，
     * 否则重写稿可能绕过回退逻辑，变成空气泡。
     */
    const buildPayload = (result, raw) => {
      const p = normalizeAction({ ...(result.parsed || {}), skills: result.toolCalls });

      // 模型没给 JSON 时，把原文当正文下发。
      //
      // 不能丢：这段文本是作者唯一能拿回的东西。标成 append 并带上
      // parseFailed，前端才会给出「应用到正文」按钮；reason 说明这是
      // 格式失败后的原文回退，避免作者以为模型正常完成了改写。
      if (!result.parsed && String(raw || '').trim()) {
        p.action = 'append';
        p.content = String(raw).trim();
        p.reason = '模型没有按约定格式返回，已把原始文本当作正文；确认无误后点「应用到正文」。';
        p.parseFailed = true;
      }

      // 模型给了 JSON，但正文是空的（常见于 action='none' 的空回复）。
      // 它至少给了理由——把理由当正文显示，总好过让作者对着一片空白。
      if (!p.content.trim() && p.reason.trim()) {
        p.action = 'comment';
        p.content = p.reason.trim();
      }

      return p;
    };

    let payload = buildPayload(finalResult, rawText);

    // ---- 节拍覆盖自检 ----
    //
    // 只在「规划成功 + 真的产出了正文」时跑：
    //   - comment/none 是讨论，不是正文，自检没有意义；
    //   - parseFailed 的原文回退可能只是半段文本，按节拍判会误报；
    //   - 被截断的正文没有自检价值（缺的一定缺）。
    //
    // 自检失败/超时一律交付当前稿，不让作者为一轮「检查」再等一次失败。
    let beatCheck = null;
    let beatCheckError = '';
    let beatRewrite = false;
    let beatRewriteFailed = false;

    const isProse = ['replace', 'append', 'insert'].includes(payload.action) && !payload.parseFailed;

    if (beatPlan && isProse && payload.content.trim()) {
      if (finalResult.finishReason === 'length') {
        beatCheckError = 'truncated';
      } else {
        const elapsed = Date.now() - startedAt;
        // 自检本身要跑得完才值得发起；装不下就按「未自检」交付。
        if (ROUND_BUDGET_MS - elapsed < CHECK_TIMEOUT_MS) {
          beatCheckError = 'time_budget';
        } else {
          send({ type: 'agent_thinking', label: '正在检查节拍覆盖' });
          const checkStartedAt = Date.now();
          const checkOut = await checkBeatCoverage({
            provider,
            plan: beatPlan,
            body: payload.content,
            options: {
              signal: AbortSignal.any([roundSignal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
            },
          });
          const checkMs = Date.now() - checkStartedAt;
          beatCheck = checkOut.coverage;
          beatCheckError = beatCheck ? '' : (checkOut.reason || 'failed');

          console.log(
            JSON.stringify({
              event: 'ai_beat_check',
              traceId,
              userId: req.userId,
              ok: Boolean(beatCheck),
              reason: beatCheckError,
              durationMs: checkMs,
              planned: beatPlan.beats.length,
              covered: beatCheck ? beatCheck.covered.length : 0,
              missing: beatCheck ? beatCheck.missing : [],
              weak: beatCheck ? beatCheck.weak.map((w) => w.id) : [],
              hookPresent: beatCheck ? beatCheck.hookPresent : null,
              chapterGoalMet: beatCheck ? beatCheck.chapterGoalMet : null,
              rewrote: false,
              usage: checkOut.usage || null,
            })
          );
        }
      }
    }

    // 缺拍重写：最多一次。
    //
    // 重写失败、超时或客户已断开都不丢第一版——作者已经有一份能用的稿子，
    // 不能为了补两拍把它换成一句错误。
    //
    // 只有剩余预算装得下「一次重写 + 一次复核」才发起：否则重写跑到一半
    // 就会被整轮上限掐断，第一版也没了，等于双输。
    // 只有覆盖报告真的指出缺拍/weak 才进重写；全覆盖时不打 skip 日志，
    // 否则每一轮成功起稿都会多一条无意义的 ai_segment_rewrite_skip。
    const segmentedMissingIds = beatCheck
      ? [...beatCheck.missing, ...beatCheck.weak.map((w) => w.id)]
      : [];
    if (
      segmented &&
      beatPlan &&
      beatCheck &&
      segmentedMissingIds.length &&
      !roundSignal.aborted
    ) {
      // 分段起稿的缺拍重写：只换掉缺拍所在的组，其他组原样保留。
      // 整章重来等于把已经合格的部分再洗一遍，调用次数也会立刻顶到上限。
      const missingIds = segmentedMissingIds;
      const affected = segmentWriter.groupsForIds(segmented.groups, missingIds);
      const remainingMs = ROUND_BUDGET_MS - (Date.now() - startedAt);
      const neededMs = affected.length * SEGMENT_CALL_TIMEOUT_MS + CHECK_TIMEOUT_MS;

      if (!affected.length) {
        console.log(
          JSON.stringify({
            event: 'ai_segment_rewrite_skip',
            traceId,
            userId: req.userId,
            reason: 'no_group',
            missing: missingIds,
          })
        );
      } else if (remainingMs < neededMs) {
        console.log(
          JSON.stringify({
            event: 'ai_segment_rewrite_skip',
            traceId,
            userId: req.userId,
            reason: 'time_budget',
            groups: affected.map((g) => g.index + 1),
            remainingMs,
            neededMs,
          })
        );
      } else {
        send({
          type: 'agent_thinking',
          label: `正在重写缺少节拍的组：${affected.map((g) => g.index + 1).join('、')}`,
        });

        try {
          const rewriteStartedAt = Date.now();
          const rewrite = await segmentWriter.rewriteMissingGroups({
            plan: beatPlan,
            groups: segmented.groups,
            coverage: beatCheck,
            runSegment: segmentRun,
            maxCalls: segmentWriter.MAX_SEGMENT_CALLS,
            callCount: segmented.callCount,
            log: (entry) => {
              console.log(
                JSON.stringify({
                  event: 'ai_segment',
                  traceId,
                  userId: req.userId,
                  role: roleKey,
                  ...entry,
                })
              );
            },
            progress: ({ index, total, beatIds }) => {
              send({
                type: 'agent_thinking',
                label: `正在重写第 ${index + 1}/${total} 组（${beatIds.join('、')}）`,
              });
            },
          });

          if (rewrite.content.trim()) {
            payload.content = rewrite.content;
            finalResult.parsed.content = rewrite.content;
            finalResult.finishReason = rewrite.finishReason || finalResult.finishReason;
            finalResult.usage = segmentWriter.usageSum([
              ...segmented.calls,
              ...rewrite.calls,
            ]);

            segmented = {
              ...segmented,
              groups: rewrite.groups,
              calls: [...segmented.calls, ...rewrite.calls],
              callCount: rewrite.callCount,
              degraded: rewrite.degraded || segmented.degraded,

              truncated: rewrite.truncated,
              originalChars: rewrite.originalChars,
              chars: rewrite.chars,
            };

            beatRewrite = rewrite.rewroteGroups > 0;
            if (rewrite.degraded || rewrite.failedGroups.length) beatRewriteFailed = true;

            console.log(
              JSON.stringify({
                event: 'ai_segment_rewrite',
                traceId,
                userId: req.userId,
                durationMs: Date.now() - rewriteStartedAt,
                groups: affected.map((g) => g.index + 1),
                rewroteGroups: rewrite.rewroteGroups,
                callCount: rewrite.callCount,
                degraded: rewrite.degraded,
                finishReason: rewrite.finishReason || '',
                contentLength: rewrite.content.length,
                usage: segmentWriter.usageSum(rewrite.calls),
              })
            );

            // 重写后必须再判一次：只按旧报告交付，「仍缺哪几拍」就是猜的。
            const recheckStartedAt = Date.now();
            const recheckOut = await checkBeatCoverage({
              provider,
              plan: beatPlan,
              body: payload.content,
              options: {
                signal: AbortSignal.any([roundSignal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
              },
            });
            const recheckMs = Date.now() - recheckStartedAt;

            if (recheckOut.coverage) {
              beatCheck = recheckOut.coverage;
              beatCheckError = '';
            } else {
              beatCheckError = 'recheck';
            }

            console.log(
              JSON.stringify({
                event: 'ai_beat_check',
                traceId,
                userId: req.userId,
                ok: Boolean(recheckOut.coverage),
                reason: recheckOut.reason || '',
                durationMs: recheckMs,
                planned: beatPlan.beats.length,
                missing: recheckOut.coverage ? recheckOut.coverage.missing : beatCheck.missing,
                weak: recheckOut.coverage ? recheckOut.coverage.weak.map((w) => w.id) : [],
                hookPresent: recheckOut.coverage ? recheckOut.coverage.hookPresent : null,
                chapterGoalMet: recheckOut.coverage ? recheckOut.coverage.chapterGoalMet : null,
                rewrote: true,
                usage: recheckOut.usage || null,
              })
            );
          } else {
            beatRewriteFailed = true;
          }
        } catch (err) {
          beatRewriteFailed = true;
          console.error('分段重写失败：', err.message);
        }
      }
    } else if (
      beatPlan &&
      beatCheck &&
      beatCheck.missing.length &&
      !roundSignal.aborted &&
      ROUND_BUDGET_MS - (Date.now() - startedAt) >= WRITE_TIMEOUT_MS + CHECK_TIMEOUT_MS
    ) {
      send({
        type: 'agent_thinking',
        label: `正在补写缺少的节拍：${beatCheck.missing.join('、')}`,
      });

      try {
        const rewriteStartedAt = Date.now();
        const rewriteResult = await runChat(
          [
            ...chatMessages,
            { role: 'user', content: buildRewriteInstruction(beatPlan, beatCheck) },
          ],
          { signal: writeSignal() }
        );
        const rewritePayload = buildPayload(rewriteResult, rewriteResult.raw || '');

        if (rewritePayload.content.trim()) {
          finalResult = rewriteResult;
          payload = rewritePayload;
          beatRewrite = true;

          console.log(
            JSON.stringify({
              event: 'ai_beat_rewrite',
              traceId,
              userId: req.userId,
              durationMs: Date.now() - rewriteStartedAt,
              finishReason: rewriteResult.finishReason || '',
              contentLength: payload.content.length,
              usage: rewriteResult.usage || null,
            })
          );

          // 重写后必须再判一次：不复判就只能按旧报告交付，
          // 「仍缺哪几拍」也就成了猜的。
          const recheckStartedAt = Date.now();
          const recheckOut = await checkBeatCoverage({
            provider,
            plan: beatPlan,
            body: payload.content,
            options: {
              signal: AbortSignal.any([roundSignal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]),
            },
          });
          const recheckMs = Date.now() - recheckStartedAt;

          if (recheckOut.coverage) {
            beatCheck = recheckOut.coverage;
            beatCheckError = '';
          } else {
            beatCheckError = 'recheck';
          }

          console.log(
            JSON.stringify({
              event: 'ai_beat_check',
              traceId,
              userId: req.userId,
              ok: Boolean(recheckOut.coverage),
              reason: recheckOut.reason || '',
              durationMs: recheckMs,
              planned: beatPlan.beats.length,
              missing: recheckOut.coverage ? recheckOut.coverage.missing : beatCheck.missing,
              weak: recheckOut.coverage ? recheckOut.coverage.weak.map((w) => w.id) : [],
              hookPresent: recheckOut.coverage ? recheckOut.coverage.hookPresent : null,
              chapterGoalMet: recheckOut.coverage ? recheckOut.coverage.chapterGoalMet : null,
              rewrote: true,
              usage: recheckOut.usage || null,
            })
          );
        }
      } catch (err) {
        // 重写失败就保留第一版。作者至少拿到了一稿，而不是一条报错。
        beatRewriteFailed = true;
        console.error('缺拍重写失败：', err.message);
      }
    }

    // 编排结果必须以作者看得见的方式落地：reason 前挂一个徽标，
    // 前端不用改也能显示；日志里另有 ai_beat_check 供复盘。
    // 没有规划就没有「编排」可言，此时不能挂「未自检」——那会让作者
    // 以为检查跑过且失败了，而真相是这一轮根本没规划。
    const badge = beatPlan
      ? beatBadge({
          coverage: beatCheck,
          checkError: beatCheckError,
          rewrote: beatRewrite,
          rewriteFailed: beatRewriteFailed,
          truncated: finalResult.finishReason === 'length',
        })
      : '';
    const segmentBadge = segmented ? segmentWriter.segmentBadge(segmented.degraded) : '';
    const truncationBadge =
      segmented && segmented.truncated
        ? `【字数安全上限 ${segmentWriter.MAX_CHAPTER_CHARS}：已截到最后一个完整段】`
        : '';
    if (segmentBadge || truncationBadge || badge) {
      payload.reason = [segmentBadge, truncationBadge, badge, payload.reason].filter(Boolean).join(' ');
    }
    payload.beatCheck = beatCheck;
    if (planDegraded) payload.planDegraded = planDegraded;
    if (segmented) {
      payload.segmentInfo = {
        groups: segmented.groups.length,
        calls: segmented.callCount,
        continuations: segmented.continuations,
        degraded: segmented.degraded || '',

        truncated: Boolean(segmented.truncated),
        originalChars: segmented.originalChars || 0,
        chars: segmented.chars || 0,
      };
    }

    // 模型一个字都没给。
    //
    // 这时候绝不能像平常那样下发 action='none' + content=''：
    // 前端会把它渲染成一个空白的圆角框，作者既看不到内容也看不到原因，
    // 只能对着一片空白反复重试。改成明确的错误事件，让作者知道发生了什么、
    // 下一步该做什么。
    //
    // 三类空回复要分开报，否则作者只会干等着重复重试：
    //   1. 模型返回了有效 JSON（通常是 action=none）——模型有回应，只是没正文。
    //      常见于指令不明确（如"根据上面建议重写"但没说改哪段）。
    //   2. 模型只做了思考没写正文（reasoning 非空）。
    //   3. 真空响应（既无 JSON 也无思考）。
    if (!payload.content.trim()) {
      const reasoning = (finalResult.reasoning || '').trim();
      let code;
      let reason;
      if (parsed) {
        // 模型返回了有效 JSON（通常是 action=none），只是没正文。
        // 报"模型没有返回内容"会误导作者——模型有回应，只是无事可做或指令不明确。
        code = 'AI_NO_BODY';
        reason =
          'AI 没能给出可写入的正文（可能是指令不够明确）。请说明要改写哪段、改成什么样，再试一次。';
      } else {
        // 无有效 JSON：按 finishReason / reasoning 分成
        // 被截断 / 内容审核 / 只思考无正文 / 真空响应四类。
        ({ code, message: reason } = describeEmptyReply(
          { finishReason: finalResult.finishReason },
          reasoning
        ));
      }

      // 这一轮到底收到了什么，必须留下证据。
      // 只记"空回复"没法定位：可能是真的一字未收、可能是一堆空白字符、
      // 也可能是 JSON 解析成功但字段名不对。三条路的修法完全不同。
      // 只截前 40 个字符，够看出字符种类，又不至于把正文写进日志。
      const rawForLog = String(rawText || '');
      const headCodes = Array.from(rawForLog.slice(0, 40))
        .map((c) => c.codePointAt(0))
        .join(',');
      console.log(
        JSON.stringify({
          event: 'ai_empty_final',
          traceId,
          userId: req.userId,
          role: roleKey,
          code,
          finishReason: finalResult.finishReason || '',
          retried: isEmptyReply,
          rawLength: rawForLog.length,
          trimmedLength: rawForLog.trim().length,
          parsed: Boolean(parsed),
          parsedKeys: parsed ? Object.keys(parsed).slice(0, 10) : [],
          contentLength: String(payload.content || '').length,
          reasonLength: String(payload.reason || '').length,
          reasoningLength: reasoning.length,
          headCodes,
          usage: finalResult.usage,
        })
      );

      // 重试过一次还是空：告诉作者这不是他的问题，也省得他反复点。
      // 不说明的话，"请再试一次"等于让他继续撞同一堵墙。
      // 第二次已经换成纯文本模式了，所以这里要说清"换了条件仍失败"，
      // 否则作者会以为是同一套请求又跑了一遍。
      if (isEmptyReply) {
        reason = `已自动重试一次（第二次改为纯文本输出），仍然没有拿到正文。${reason}`;
      }

      // 这次调用没产生任何回复，别把孤零零的用户消息留在历史里——
      // 它会在下一轮被当成"作者问了但没人答"的上下文塞给模型。
      //
      // 重新生成时那条提问是复用来的，不是这一轮插的，删了就把原稿弄坏了。
      if (insertedUserMessageId) {
        await run('DELETE FROM messages WHERE id = ?', [insertedUserMessageId]);
      }

      // 重生成失败：把上一版问答放回去，作者至少还留着上一个答案
      await restoreRemoved();

      send({ type: 'error', code, message: reason });
      send({
        type: 'done',
        conversationId: conversation.id,
        provider: name,
        stopReason: finalResult.stopReason,
        traceId,
      });
      return;
    }

    // 检索到的素材补进引用：作者要看到"查到了什么、从哪来的"
    payload.citations = mergeCitations(payload.citations, retrieval);

    // 保存助手消息
    const messageId = crypto.randomUUID();
    await run(
      `INSERT INTO messages (id, conversation_id, role, content, role_key, action, payload, citations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        conversation.id,
        'assistant',
        payload.content,
        roleKey,
        payload.action,
        JSON.stringify(payload),
        JSON.stringify(payload.citations),
        new Date().toISOString(),
      ]
    );
    await run(
      'UPDATE conversations SET updated_at = ? WHERE id = ?',
      [new Date().toISOString(), conversation.id]
    );

    // 这一轮对话进记忆库：原始层立刻入库，事实层后台抽。
    // 记忆写不进去也不该影响对话本身。
    memoryConv.rememberTurn({
      userId: req.userId,
      workId: conversation.work_id,
      conversationId: conversation.id,
      messageId,
      userText: String(message),
      assistantText: payload.content,
    });

    // 重新生成：上一版回答的消息行已经摘掉了，它留在记忆库里的三层也得清。
    // 不清的话，下次召回会把"上一版回答"的原文翻出来——
    // 而那条回答作者早就不要了。
    if (replacedMessage) {
      memoryConv.forgetMessage({ userId: req.userId, messageId: replacedMessage.id });
    }

    send({
      type: 'action',
      action: payload.action,
      target: payload.target,
      content: payload.content,
      reason: payload.reason,
      citations: payload.citations,
      skills: payload.skills,
      // 审稿意见的结构化锚点（块 ID / 原文片段）。没有时为 []。
      findings: payload.findings || [],
      // 模型没按 JSON 契约返回、原文被当作正文回退时为 true。
      // 前端可据此提示作者「这是原文，不是模型正常生成的改写」。
      parseFailed: Boolean(payload.parseFailed),
      // 节拍覆盖报告（未跑或失败时为 null）与规划降级原因。
      // reason 里的徽标是给作者看的短句，这两个字段留给后续复盘/前端展示。
      beatCheck: payload.beatCheck || null,
      planDegraded: payload.planDegraded || '',
      // 分段起稿的分组/调用信息：前端与测试靠它确认这一轮跑了几次、有没有降级。
      segmentInfo: payload.segmentInfo || null,
    });
    send({
      type: 'done',
      messageId,
      // 用户消息的服务端 id 也一并带回：前端要靠它才能给"作者自己的提问"
      // 提供「记入记忆」。重新生成时这条提问是复用的，id 不变。
      userMessageId: insertedUserMessageId || (reusedUserMessage && reusedUserMessage.id) || '',
      conversationId: conversation.id,
      provider: name,
      // 这次为什么停：final=正常出结果；前端可据此区分"写完"与"被截断"
      stopReason: finalResult.stopReason,
      traceId,
    });
  } catch (err) {
    console.error('AI chat 失败：', err.message);

    // 失败也带 code：前端和日志都要能分辨「超时 / 被取消 / 上游报错 / 技能打转」，
    // 否则所有异常都只剩一句转述给作者的话，排查时无从下手。
    let errorCode = err.code || 'AI_PROVIDER_ERROR';

    // 模型反复调用技能却拿不到结果：这句话要说明白，
    // 作者才知道是自己问得太绕，而不是平台坏了。
    if (err.code === 'MAX_STEPS') {
      errorCode = 'AI_MAX_STEPS';
      err.message = '这次没能查完：模型反复调用技能但没有拿到结果。请换个说法再问一次。';
    } else if (err.code === 'AI_TIMEOUT' || err.name === 'TimeoutError') {
      // 整轮超时上限到了，或流式读取中途被中止时，抛的是 DOMException，
      // message 是英文（"The operation was aborted due to timeout"）。
      // 原样透给作者既看不懂，还会让他以为平台坏了。
      errorCode = 'AI_TIMEOUT';
      err.message = 'AI 这次超时了：等了很久都没有返回完整结果。可以把要求说得短一点，或分几次写。';
    } else if (err.code === 'AI_ABORTED' || err.name === 'AbortError') {
      errorCode = 'AI_ABORTED';
      err.message = '这次请求被中止了，没有拿到完整结果。';
    }

    // 失败的这轮同样不能留下孤立消息。
    // 注意只删用户消息：助手消息此时还没写库，删了也不会丢东西。
    //
    // 重新生成时那条提问是复用来的，删了会把原稿弄坏——不动它。
    if (insertedUserMessageId) {
      await run('DELETE FROM messages WHERE id = ?', [insertedUserMessageId]).catch(() => {});
    }

    // 重生成失败：把上一版问答放回去
    await restoreRemoved();

    // 作者已经断开：没有接收方了，写事件既发不出去也没有意义。
    // 这时候也别打"失败"日志——取消不是故障。
    if (clientGone) {
      res.end();
      return;
    }

    send({ type: 'error', code: errorCode, message: err.message });
    // 补一个 done：前端靠它同步 conversationId，
    // 缺了这一条，作者下一句话会另起一个会话，前面的对话就断了。
    if (conversation) {
      send({
        type: 'done',
        conversationId: conversation.id,
        stopReason: err.stopReason || 'error',
        traceId,
      });
    }
  } finally {
    res.end();
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/messages/:messageId/remember —— 手动记入长期记忆
// ---------------------------------------------------------------------------

/**
 * 作者点「记入记忆」。
 *
 * 手动层是最高权重的一层：作者明确说"这条要记住"，
 * 那不管它看起来多普通都得留下。
 *
 * 这一层同步写——作者点了就该立刻知道成没成功。
 * 丢进后台队列的话，他看到的"已记入"只是一句空话：
 * sidecar 没起来、embedding 报错了，作者毫不知情。
 *
 * 幂等：同一条消息重复点，走的还是同一条来源，
 * 索引器靠内容哈希判断没变就不重复调 embedding。
 */
router.post('/messages/:messageId/remember', async (req, res) => {
  const { messageId } = req.params;

  try {
    // 归属校验在 SQL 里：别人的消息拿不到。
    const row = await memorySources.findMessage(messageId, req.userId);
    if (!row) {
      return res.status(404).json({ error: '消息不存在' });
    }

    const result = await memoryConv.rememberManual({
      userId: req.userId,
      workId: row.work_id,
      conversationId: row.conversation_id,
      messageId,
      content: row.content,
    });

    if (!result.ok) {
      return res.status(502).json({ error: result.error || '记入记忆失败' });
    }

    res.json({ ok: true, messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/conversations —— 历史对话列表
// ---------------------------------------------------------------------------

/** 历史列表里预览文案的长度上限 */
const PREVIEW_LIMIT = 80;

/** 空回复重试时保留多少条最近消息（含本轮提问）。见下面重试处的复现说明 */
const RETRY_HISTORY_KEEP = 5;

/**
 * 只保留有内容的消息预览。
 *
 * 助手消息存的是结构化输出，content 可能是空串、也可能是整段正文；
 * 折成一行并截断，才能在列表里一眼看出这轮聊了什么。
 */
function makePreview(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_LIMIT);
}

router.get('/conversations', async (req, res) => {
  const { workId } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  try {
    // 按作品筛选时也要校验归属：不能拿别人的 workId 探出"这里有没有对话"
    if (workId && !(await ownedWork(workId, req.userId))) {
      return res.json([]);
    }

    // 只列有消息的会话：点开就空的会话在历史里没有意义
    const params = workId ? [req.userId, workId, limit] : [req.userId, limit];
    const rows = await all(
      `SELECT c.id, c.work_id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
              (SELECT m.content FROM messages m WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS last_content
         FROM conversations c
        WHERE c.user_id = ?
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          ${workId ? 'AND c.work_id = ?' : ''}
        ORDER BY c.updated_at DESC
        LIMIT ?`,
      params
    );

    res.json(
      rows.map((row) => ({
        id: row.id,
        workId: row.work_id,
        title: row.title || '新对话',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        messageCount: row.message_count,
        preview: makePreview(row.last_content),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/conversations/:id/messages —— 一条历史对话的全部消息
// ---------------------------------------------------------------------------
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    // 归属校验写进 SQL：别人的会话 id 一律当作不存在
    const conversation = await get(
      'SELECT * FROM conversations WHERE id = ? AND user_id = ?',
      [req.params.id, req.userId]
    );
    if (!conversation) {
      return res.status(404).json({ error: '对话不存在' });
    }

    const rows = await all(
      `SELECT id, role, content, role_key, action, payload, citations, created_at
         FROM messages
        WHERE conversation_id = ?
        ORDER BY created_at, rowid`,
      [conversation.id]
    );

    // 角色名要显示在气泡上。一次取全表再映射，避免逐条查库。
    const roleList = await roles.listRoles(req.userId);
    const roleMap = new Map(roleList.map((r) => [r.key, r]));

    const messages = rows.map((row) => {
      const role = roleMap.get(row.role_key);
      let payload = null;
      if (row.payload) {
        try {
          payload = JSON.parse(row.payload);
        } catch (e) {
          payload = null;
        }
      }

      let citations = [];
      if (row.citations) {
        try {
          const parsed = JSON.parse(row.citations);
          if (Array.isArray(parsed)) citations = parsed;
        } catch (e) {
          citations = [];
        }
      }

      if (row.role === 'user') {
        return { id: row.id, role: 'user', content: row.content, roleKey: row.role_key };
      }

      return {
        id: row.id,
        role: 'assistant',
        content: row.content,
        roleKey: row.role_key,
        roleLabel: role ? `${role.icon} ${role.name}` : '',
        action: (payload && payload.action) || row.action || '',
        target: (payload && payload.target) || '',
        reason: (payload && payload.reason) || '',
        citations,
        // 审稿意见的锚点随消息一起读回；旧消息没有这个字段时为空数组
        findings: Array.isArray(payload && payload.findings) ? payload.findings : [],
        // 工具过程落库在 payload.skills 里，重载时一并还原：
        // 作者回到旧对话，仍然能核对当时 AI 现查了什么
        toolTrace: Array.isArray(payload && payload.skills)
          ? payload.skills.map((s) => ({ ...s, status: 'done' }))
          : [],
      };
    });

    res.json({
      id: conversation.id,
      workId: conversation.work_id,
      title: conversation.title || '新对话',
      updatedAt: conversation.updated_at,
      messages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/inline —— 行内操作
// ---------------------------------------------------------------------------
router.post('/inline', async (req, res) => {
  const {
    action = 'rewrite',
    selection,
    blocks,
    blockId,
    workId,
    chapterId,
    roleKey = 'editor',
    instruction,
    useMemory = true,
    excludeRefIds = [],
  } = req.body || {};

  if (!selection || !String(selection).trim()) {
    return res.status(400).json({ error: '选区内容不能为空' });
  }

  const INLINE_ACTIONS = {
    rewrite: '改写这段文字，换一种表达方式，意思保持不变',
    expand: '扩写这段文字，增加细节与描写，保持原意',
    shorten: '缩写这段文字，精简表达，保留核心要点',
    tone: '改变这段文字的语气',
    continue: '在选区后面接着往下写一句',
    critique: '以审稿人视角指出这段的问题，只给建议不要改写',
    colloquialize: '把这段书面语改得自然口语化',
  };

  const actionInstruction = INLINE_ACTIONS[action] || INLINE_ACTIONS.rewrite;

  try {
    // 行内操作也要召回：改写一段话时，作者同样希望 AI 记得前情。
    const memoryResult = await recallMemory({
      req,
      workId,
      chapterId,
      blocks,
      instruction: actionInstruction + (instruction ? `。${instruction}` : ''),
      useMemory,
      excludeRefIds,
      scope: 'inline',
    });

    const { messages } = await assembleContext({
      workId,
      chapterId,
      roleKey,
      selection: String(selection),
      blocks,
      blockId,
      scope: 'inline',
      memoryRefs: memoryResult.refs,
      extraInstruction: actionInstruction + (instruction ? `。${instruction}` : ''),
      userId: req.userId,
    });

    const aiCfg = aiConfig.getConfig();
    const { provider, name, degraded, reason } = resolveProvider(aiCfg);
    const role = await roles.getRole(roleKey, req.userId);

    // 角色模型只在 DeepSeek 下生效，非 DeepSeek 时提示作者（与侧边栏一致）。
    // 合并进 notice 字段：行内操作没有独立的事件通道，多一个字段前端不认识。
    const noticeText = [
      reason,
      role && role.model && name !== 'deepseek'
        ? `角色模型「${role.model}」仅在 DeepSeek 下生效，当前使用的是 ${name} 的默认模型。`
        : '',
    ]
      .filter(Boolean)
      .join('；');

    // 行内操作走 provider.chat（非流式），但上游同样会偶发返回 200 空内容。
    // 与 /chat 路径一致：空回复自动重试一次，并且第二次换掉条件（关 JSON 模式）。
    const callInline = async (msgList, overrides = {}) =>
      provider.chat({
        messages: msgList,
        temperature: role?.temperature,
        model: role?.model && name === 'deepseek' ? role.model : undefined,
        thinking: role?.thinking === null || role?.thinking === undefined
          ? undefined
          : (role.thinking ? 'enabled' : 'disabled'),
        jsonOutput: true,
        ...overrides,
      });

    const baseMessages = [...messages, { role: 'user', content: String(selection) }];
    let result = await callInline(baseMessages);

    const isEmpty =
      !String(result.content || '').trim() &&
      !parseModelJson(result.content || '') &&
      !String(result.reasoning || '').trim();

    if (isEmpty) {
      // 原样重发没有意义：让模型退化成空白的条件还在。
      // 第二次关掉 JSON 模式，并要求它直接用纯文本写正文。
      const retryMessages = [...baseMessages];
      const last = retryMessages[retryMessages.length - 1];
      retryMessages[retryMessages.length - 1] = {
        ...last,
        content:
          String(last.content || '') +
          '\n\n（上一次没有返回任何内容。这一次不要输出 JSON，直接用纯文本写出完整正文，不要解释。）',
      };
      result = await callInline(retryMessages, {
        jsonOutput: false,
        ...(role?.thinking ? { thinking: 'disabled' } : {}),
      });
    }

    const rawText = result.content || '';
    const parsed = parseModelJson(rawText);

    if (!parsed) {
      // 模型没给出任何内容：不能返回空正文，那会让行内工具"改写"成空白段落。
      if (!rawText.trim()) {
        // 四类空回复分开报，否则作者只会干等着重复重试：
        //   1. 被长度截断（finishReason=length）
        //   2. 内容审核拦下（finishReason=content_filter）
        //   3. 只思考无正文（reasoning 非空）
        //   4. 真空响应（既无 content 也无 reasoning）
        const { code, message } = describeEmptyReply(result, result.reasoning);
        return res.status(502).json({
          code,
          error: isEmpty ? `已自动重试一次（第二次改为纯文本输出），仍然没有拿到正文。${message}` : message,
        });
      }
      // 解析失败但拿到了原文：不能丢，也不能谎称改写成功。
      // 作为 append 正文交给作者确认，并标记 parseFailed。
      return res.json({
        action: 'append',
        content: rawText.trim(),
        reason: '模型没有按约定格式返回，已把原始文本当作正文；确认无误后点「应用到正文」。',
        parseFailed: true,
        citations: [],
        provider: name,
        degraded,
        notice: noticeText,
        memoryRefs: memoryResult.refs,
        memoryDegraded: memoryResult.degraded,
      });
    }

    const payload = normalizeAction(parsed);

    // 同理：正文为空就别把它当成一次成功的改写交回去。
    // parsed 存在说明模型返回了有效 JSON（通常是 action=none），
    // 报"模型没有返回内容"会误导作者——模型有回应，只是没正文。
    if (!payload.content.trim()) {
      if (payload.reason.trim()) {
        payload.action = 'comment';
        payload.content = payload.reason.trim();
      } else {
        return res.status(502).json({
          code: 'AI_NO_BODY',
          error:
            'AI 没能给出可写入的正文（可能是指令不够明确）。请说明要改写哪段、改成什么样，再试一次。',
        });
      }
    }

    res.json({
      ...payload,
      provider: name,
      degraded,
      notice: noticeText,
      memoryRefs: memoryResult.refs,
      memoryDegraded: memoryResult.degraded,
    });
  } catch (err) {
    console.error('AI inline 失败：', err.message);

    // 与 /chat 一致：超时不能混在 500 里笼统报，前端要能区分。
    if (err.code === 'AI_TIMEOUT' || err.name === 'TimeoutError') {
      return res.status(504).json({
        code: 'AI_TIMEOUT',
        error: 'AI 这次超时了：等了很久都没有返回结果。可以把选区缩小一点再试。',
      });
    }
    if (err.code === 'AI_ABORTED' || err.name === 'AbortError') {
      return res.status(499).json({ code: 'AI_ABORTED', error: '这次请求被中止了，没有拿到结果。' });
    }

    res.status(500).json({ error: err.message, code: err.code || 'AI_PROVIDER_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/roles
// ---------------------------------------------------------------------------
router.get('/roles', async (req, res) => {
  try {
    const list = await roles.listRoles(req.userId);
    const cfg = aiConfig.getConfig();
    // 用实际生效的 provider，而不是设置页里选的那个：
    // DeepSeek 没配 key 时会降级到 Ollama，而 Ollama 没有思考模式。
    let activeProvider = cfg.provider;
    try {
      activeProvider = resolveProvider(cfg).name;
    } catch (e) {
      // 一个可用 provider 都没有时保持原样，前端只是少显示一条提示
    }
    res.json(list.map((role) => decorateRole(role, cfg, activeProvider)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/prompts/:roleKey
// ---------------------------------------------------------------------------
router.post('/prompts/:roleKey', async (req, res) => {
  const { roleKey } = req.params;
  const { systemPrompt, temperature, model, thinking } = req.body || {};

  if (!systemPrompt || !String(systemPrompt).trim()) {
    return res.status(400).json({ error: '提示词不能为空' });
  }

  try {
    await roles.saveOverride(
      roleKey,
      {
        systemPrompt: String(systemPrompt),
        temperature: typeof temperature === 'number' ? temperature : undefined,
        model: typeof model === 'string' ? model.trim() : undefined,
        thinking: typeof thinking === 'boolean' ? thinking : undefined,
      },
      req.userId
    );
    const role = await roles.getRole(roleKey, req.userId);
    res.json(role);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ai/prompts/:roleKey
// ---------------------------------------------------------------------------
router.delete('/prompts/:roleKey', async (req, res) => {
  try {
    await roles.clearOverride(req.params.roleKey, req.userId);
    const role = await roles.getRole(req.params.roleKey, req.userId);
    res.json(role);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/status
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  try {
    const aiCfg = aiConfig.getConfig();
    const providers = await checkAllProviders(aiCfg);

    let active = null;
    try {
      const resolved = resolveProvider(aiCfg);
      active = { name: resolved.name, degraded: resolved.degraded, reason: resolved.reason };
    } catch (e) {
      active = { name: null, degraded: false, reason: e.message };
    }

    res.json({
      active,
      providers,
      config: aiConfig.getPublicConfig(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
