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
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');
const aiConfig = require('../services/aiConfig');
const { resolveProvider, checkAllProviders } = require('../services/providers');
const { assembleContext } = require('../services/context');
const roles = require('../services/roles');
const localSearch = require('../services/search/local');
const webSearch = require('../services/search/deepseekSearch');

const router = express.Router();

/**
 * 解析模型的 JSON 输出。
 * 模型可能返回带 markdown 代码块的 JSON，需要剥掉。
 */
function parseModelJson(text) {
  if (!text) return null;

  let candidate = text.trim();

  // 剥掉 ```json ... ``` 包裹
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    candidate = fence[1].trim();
  }

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // 退而求其次：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

/**
 * 归一化结构化输出，确保字段齐全且类型正确。
 */
function normalizeAction(payload) {
  if (!payload || typeof payload !== 'object') {
    return { action: 'none', content: '', reason: '', citations: [] };
  }

  const validActions = ['replace', 'append', 'insert', 'comment', 'none'];
  let action = validActions.includes(payload.action) ? payload.action : 'none';

  const content = typeof payload.content === 'string' ? payload.content : '';
  const reason = typeof payload.reason === 'string' ? payload.reason : '';
  const target = typeof payload.target === 'string' ? payload.target : '';

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

  return { action, target, content, reason, citations };
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
 * 取得或创建会话。
 */
async function ensureConversation(conversationId, workId, title) {
  if (conversationId) {
    const existing = await get(
      'SELECT * FROM conversations WHERE id = ?',
      [conversationId]
    );
    if (existing) return existing;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    'INSERT INTO conversations (id, work_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, workId || null, title || '新对话', now, now]
  );
  return get('SELECT * FROM conversations WHERE id = ?', [id]);
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
async function runRetrieval(roleKey, message, existing) {
  if (!needsRetrieval(roleKey, message)) {
    return { fragments: existing, notices: [] };
  }

  const fragments = [];
  const notices = [];

  let results = await localSearch.searchLoose(message, { limit: 4 });

  // "素材库里有什么能用的"这类问法没有具体检索目标，关键词必然零命中。
  // 这时候给模型最近更新的几条，让它自己去判断哪条用得上。
  if (!results.length && localSearch.isGenericQuery(message)) {
    results = await localSearch.recent(4);
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

  try {
    // 站内素材检索 + 联网检索：资料员角色总会搜；其他角色在作者明确要"找/查"时也搜。
    // 检索结果既进上下文，也作为引用的兜底来源。
    const { fragments: searched, notices } = await runRetrieval(
      roleKey,
      String(message),
      retrieval
    );
    if (searched.length) {
      retrieval = searched;
    }

    const { messages, meta } = await assembleContext({
      workId,
      chapterId,
      roleKey,
      scope,
      retrieval,
      blocks,
    });

    const conversation = await ensureConversation(conversationId, workId);
    const now = new Date().toISOString();

    // 历史消息
    const history = await all(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
      [conversation.id]
    );

    // 保存用户消息
    await run(
      'INSERT INTO messages (id, conversation_id, role, content, role_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [crypto.randomUUID(), conversation.id, 'user', String(message), roleKey, now]
    );

    const chatMessages = [
      ...messages,
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: String(message) },
    ];

    const aiCfg = aiConfig.getConfig();
    const { provider, name, degraded, reason } = resolveProvider(aiCfg);

    if (degraded) {
      send({ type: 'notice', content: reason });
    }
    // 检索过程中的提示（比如联网检索没配 key）
    for (const notice of notices) {
      send({ type: 'notice', content: notice });
    }

    const role = await roles.getRole(roleKey);

    // 流式输出
    let fullText = '';
    let reasoning = '';

    const result = await provider.chatStream({
      messages: chatMessages,
      temperature: role?.temperature,
      // 角色可以单独指定模型与思考开关；没指定就跟随全局配置。
      // 角色模型只在 DeepSeek 下生效——别的 provider 用的是自己的模型名，
      // 硬套 DeepSeek 的模型名会直接报"模型不存在"。
      model: role?.model && name === 'deepseek' ? role.model : undefined,
      thinking: role?.thinking === null || role?.thinking === undefined
        ? undefined
        : (role.thinking ? 'enabled' : 'disabled'),
      jsonOutput: true,
      onToken: (token) => {
        fullText += token;
        send({ type: 'token', content: token });
      },
      onThinking: (chunk) => {
        reasoning += chunk;
      },
    });

    const rawText = result.content || fullText;
    const payload = normalizeAction(parseModelJson(rawText));

    // 模型没给 JSON 时，把原文当对话回复
    if (!parseModelJson(rawText) && rawText.trim()) {
      payload.action = 'comment';
      payload.content = rawText.trim();
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

    send({
      type: 'action',
      action: payload.action,
      target: payload.target,
      content: payload.content,
      reason: payload.reason,
      citations: payload.citations,
    });
    send({
      type: 'done',
      messageId,
      conversationId: conversation.id,
      provider: name,
    });
  } catch (err) {
    console.error('AI chat 失败：', err.message);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
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
    const { messages } = await assembleContext({
      workId,
      chapterId,
      roleKey,
      selection: String(selection),
      blocks,
      blockId,
      scope: 'inline',
      extraInstruction: actionInstruction + (instruction ? `。${instruction}` : ''),
    });

    const aiCfg = aiConfig.getConfig();
    const { provider, name, degraded, reason } = resolveProvider(aiCfg);
    const role = await roles.getRole(roleKey);

    const result = await provider.chat({
      messages: [
        ...messages,
        { role: 'user', content: String(selection) },
      ],
      temperature: role?.temperature,
      model: role?.model && name === 'deepseek' ? role.model : undefined,
      thinking: role?.thinking === null || role?.thinking === undefined
        ? undefined
        : (role.thinking ? 'enabled' : 'disabled'),
      jsonOutput: true,
    });

    const rawText = result.content || '';
    const parsed = parseModelJson(rawText);

    if (!parsed) {
      return res.json({
        action: 'comment',
        content: rawText.trim(),
        reason: '',
        citations: [],
        provider: name,
        degraded,
        notice: reason,
      });
    }

    res.json({
      ...normalizeAction(parsed),
      provider: name,
      degraded,
      notice: reason,
    });
  } catch (err) {
    console.error('AI inline 失败：', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai/roles
// ---------------------------------------------------------------------------
router.get('/roles', async (req, res) => {
  try {
    const list = await roles.listRoles();
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
    await roles.saveOverride(roleKey, {
      systemPrompt: String(systemPrompt),
      temperature: typeof temperature === 'number' ? temperature : undefined,
      model: typeof model === 'string' ? model.trim() : undefined,
      thinking: typeof thinking === 'boolean' ? thinking : undefined,
    });
    const role = await roles.getRole(roleKey);
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
    await roles.clearOverride(req.params.roleKey);
    const role = await roles.getRole(req.params.roleKey);
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
