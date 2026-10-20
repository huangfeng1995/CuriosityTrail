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
        }))
    : [];

  // action=none 但有内容时，按对话回复处理
  if (action === 'none' && !content) {
    action = 'none';
  }

  return { action, target, content, reason, citations };
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
    retrieval = [],
    blocks,
  } = req.body || {};

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

    const role = await roles.getRole(roleKey);

    // 流式输出
    let fullText = '';
    let reasoning = '';

    const result = await provider.chatStream({
      messages: chatMessages,
      temperature: role?.temperature,
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
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai/prompts/:roleKey
// ---------------------------------------------------------------------------
router.post('/prompts/:roleKey', async (req, res) => {
  const { roleKey } = req.params;
  const { systemPrompt, temperature } = req.body || {};

  if (!systemPrompt || !String(systemPrompt).trim()) {
    return res.status(400).json({ error: '提示词不能为空' });
  }

  try {
    await roles.saveOverride(roleKey, {
      systemPrompt: String(systemPrompt),
      temperature: typeof temperature === 'number' ? temperature : undefined,
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
