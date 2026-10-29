'use strict';

/**
 * 对话记忆的三层写入。
 *
 *   conv_raw     原始层：作者问了什么 + AI 答了什么，原文入库
 *   conv_fact    事实层：AI 抽取出的结构化事实（承诺/决定/设定变更）
 *   conv_manual  手动层：作者点「记入记忆」，明确指定要留下的那条
 *
 * 三层都挂在**作品**下面（URI 里带 w/{workId}），因为召回是以作品为范围的：
 * 换一部作品写新故事时，上一部的对话不该跟着过来。
 *
 * 「宽进严出」体现在这里：写入时尽量多存（原文照收），
 * 收紧的部分放在召回侧（权重、阈值、条数）。
 *
 * 一个 source_id = 一条消息 id。三层靠 source_type 区分，
 * 唯一索引 (source_type, source_id, chunk_no) 保证互不覆盖。
 */

const config = require('../../config');
const { get } = require('../../database');
const indexer = require('./indexer');
const extractor = require('./extractor');

/** 原始层正文的前缀标记。让抽取与召回都能认出这是对话原文。 */
const RAW_USER_PREFIX = '作者：';
const RAW_AI_PREFIX = 'AI：';

/**
 * 拼原始层正文。
 *
 * 用户提问和 AI 回答放在一起存——拆开存的话，
 * "AI 说的"和"作者说的"在向量里分不开，
 * 召回时模型分不清这是谁的承诺。
 *
 * @param {string} userText
 * @param {string} assistantText
 * @returns {string}
 */
function buildRawText(userText, assistantText) {
  const parts = [];
  if (userText) parts.push(`${RAW_USER_PREFIX}${userText}`);
  if (assistantText) parts.push(`${RAW_AI_PREFIX}${assistantText}`);
  return parts.join('\n');
}

/**
 * 消息是否还躺在消息表里。
 *
 * 事实抽取是异步的：等它回来时，这一轮可能已经被"重新生成"覆盖了。
 * 那种情况下再写事实层，等于给一条已经不存在的消息存了记忆。
 *
 * @param {string} messageId
 * @param {string} conversationId
 * @returns {Promise<boolean>}
 */
async function messageExists(messageId, conversationId) {
  if (!messageId || !conversationId) return false;
  const row = await get(
    'SELECT 1 AS x FROM messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  return Boolean(row);
}

/**
 * 记一轮对话的原始层。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId 作品 id；没有作品就无处安放，不记
 * @param {string} params.conversationId
 * @param {string} params.messageId 这一轮助手消息的 id（作为锚点）
 * @param {string} params.userText
 * @param {string} params.assistantText
 */
function rememberRaw({ userId, workId, conversationId, messageId, userText, assistantText }) {
  if (!userId || !workId || !conversationId || !messageId) return;

  const text = buildRawText(userText, assistantText);
  if (!text.trim()) return;

  indexer.scheduleIndex({
    userId,
    workId,
    sourceType: 'conv_raw',
    sourceId: messageId,
    conversationId,
    content: text,
  });
}

/**
 * 记一轮对话抽取出的事实。
 *
 * 同一轮的多条事实合成一块（chunk_no=0）：
 * 事实之间是互相补充的关系，拆成多块反而割裂语义。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string[]} params.facts
 */
function rememberFacts({ userId, workId, conversationId, messageId, facts }) {
  if (!userId || !workId || !conversationId || !messageId) return;
  if (!Array.isArray(facts) || !facts.length) return;

  const text = facts.join('\n');
  if (!text.trim()) return;

  indexer.scheduleIndex({
    userId,
    workId,
    sourceType: 'conv_fact',
    sourceId: messageId,
    conversationId,
    content: text,
  });
}

/**
 * 手动记入一条消息。
 *
 * 作者明确说"记住这个"，那这条就必须留下，
 * 不管它看起来是不是重要。
 *
 * 这一层是**同步**写的：作者点了"记入记忆"，就该立刻告诉他成没成功。
 * 放在后台队列里的话，他看到的"已记入"是一句空话——
 * sidecar 挂了、embedding 报错了，作者毫不知情。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string} params.content 消息正文
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function rememberManual({ userId, workId, conversationId, messageId, content }) {
  if (!userId || !workId || !conversationId || !messageId) {
    return { ok: false, error: '参数不完整' };
  }
  const text = String(content || '').trim();
  if (!text) return { ok: false, error: '消息内容为空' };

  await indexer.indexSource({
    userId,
    workId,
    sourceType: 'conv_manual',
    sourceId: messageId,
    conversationId,
    content: text,
    // 不重试：作者正等着这条回话，让他等三轮退避才看到"失败了"，
    // 比立刻报错糟糕得多。
    maxAttempts: 1,
  });

  // indexSource 内部已经把失败写进台账（status='failed'），不抛异常。
  // 这里再读一次，把真实结果告诉作者。
  const row = await get(
    `SELECT status, last_error FROM memory_chunks
     WHERE user_id = ? AND source_type = 'conv_manual' AND source_id = ?
     ORDER BY chunk_no LIMIT 1`,
    [userId, messageId]
  );
  if (row && row.status === 'indexed') return { ok: true };
  return { ok: false, error: (row && row.last_error) || '记忆服务未运行' };
}

/**
 * 忘掉一条消息派生出来的全部记忆（三层都清）。
 *
 * 消息一旦从历史里消失，它的记忆也该跟着消失：
 * 否则召回时会翻出"上一版回答"的原文，
 * 而那条回答作者早就不要了。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.messageId
 */
function forgetMessage({ userId, messageId }) {
  if (!userId || !messageId) return;
  for (const sourceType of ['conv_raw', 'conv_fact', 'conv_manual']) {
    indexer.scheduleRemove({ userId, sourceType, sourceId: messageId });
  }
}

/**
 * 一轮对话的完整记忆流程：先入原始层，再异步抽事实。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.conversationId
 * @param {string} params.messageId
 * @param {string} params.userText
 * @param {string} params.assistantText
 */
function rememberTurn({ userId, workId, conversationId, messageId, userText, assistantText }) {
  if (!userId || !workId || !conversationId || !messageId) return;

  rememberRaw({ userId, workId, conversationId, messageId, userText, assistantText });

  if (!config.memoryExtractEnabled) return;

  // 事实抽取在后台跑，作者不等它
  extractor.scheduleExtract({
    userText,
    assistantText,
    onFacts: async (facts) => {
      // 抽取回来时，这一轮可能已经被重新生成覆盖了。
      // 那就不能再写事实层——记的是一条已经不存在的回答。
      if (!(await messageExists(messageId, conversationId))) return;
      rememberFacts({ userId, workId, conversationId, messageId, facts });
    },
  });
}

module.exports = {
  RAW_USER_PREFIX,
  RAW_AI_PREFIX,
  buildRawText,
  rememberRaw,
  rememberFacts,
  rememberManual,
  forgetMessage,
  rememberTurn,
};
