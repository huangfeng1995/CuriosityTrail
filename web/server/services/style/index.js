'use strict';

/**
 * 文风规则卡服务。
 *
 * 对外提供三件事：
 *   1. 卡的增删改查
 *   2. **解析当前生效的规则**（作品级优先，整类替换全局级）
 *   3. 把生效规则格式化成可以注入提示词的文本
 *
 * 样例原文从不入库：这张表只有规则、来源标注和 ≤100 字摘要。
 */

const crypto = require('crypto');
const { all, get, run } = require('../../database');
const { mergeRules, normalizeRules, formatStylePrompt } = require('./rules');

/** 摘要最多留多少字。仅供作者辨认样例是哪一段。 */
const EXCERPT_LIMIT = 100;

/**
 * 列出用户的全部卡。
 *
 * @param {string} userId
 * @param {string} [workId] 传了则只返回该作品的卡 + 全局卡
 */
async function listCards(userId, workId) {
  if (!userId) return [];
  const rows = workId
    ? await all(
        `SELECT * FROM style_cards
         WHERE user_id = ? AND (work_id = ? OR work_id IS NULL)
         ORDER BY created_at DESC`,
        [userId, workId]
      )
    : await all(
        'SELECT * FROM style_cards WHERE user_id = ? ORDER BY created_at DESC',
        [userId]
      );
  return rows.map(toCard);
}

/**
 * 取一张卡。
 */
async function getCard(id, userId) {
  if (!id || !userId) return null;
  const row = await get('SELECT * FROM style_cards WHERE id = ? AND user_id = ?', [id, userId]);
  return row ? toCard(row) : null;
}

/**
 * 建卡。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {'good'|'bad'} params.kind
 * @param {string} params.title
 * @param {Object} params.rules 已归一化的规则
 * @param {string} [params.workId] 空 = 全局卡
 * @param {string} [params.source] 'paste' | 'chapter'
 * @param {string} [params.chapterId]
 * @param {string} [params.excerpt]
 */
async function createCard(params) {
  const {
    userId,
    kind,
    title,
    rules,
    workId = null,
    source = 'paste',
    chapterId = null,
    excerpt = '',
  } = params;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(
    `INSERT INTO style_cards
       (id, user_id, work_id, kind, title, source, chapter_id, excerpt, rules, enabled, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      userId,
      workId || null,
      kind,
      String(title || '').trim() || '未命名样例',
      source,
      chapterId || null,
      String(excerpt || '').slice(0, EXCERPT_LIMIT),
      JSON.stringify(normalizeRules(rules)),
      now,
      now,
    ]
  );

  return getCard(id, userId);
}

/**
 * 改卡。
 *
 * 允许作者手改规则——蒸馏是模型猜的，作者看一眼觉得不对就得能改。
 *
 * @param {Object} params
 * @param {string} params.id
 * @param {string} params.userId
 * @param {Object} [params.patch] { title, rules, enabled }
 */
async function updateCard(params) {
  const { id, userId, patch = {} } = params;

  const existing = await get('SELECT * FROM style_cards WHERE id = ? AND user_id = ?', [id, userId]);
  if (!existing) return null;

  const fields = [];
  const values = [];

  if (patch.title !== undefined) {
    fields.push('title = ?');
    values.push(String(patch.title).trim() || existing.title);
  }
  if (patch.rules !== undefined) {
    fields.push('rules = ?');
    values.push(JSON.stringify(normalizeRules(patch.rules)));
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }

  if (!fields.length) return toCard(existing);

  fields.push('modified_at = ?');
  values.push(new Date().toISOString());
  values.push(id, userId);

  await run(
    `UPDATE style_cards SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
    values
  );

  return getCard(id, userId);
}

/**
 * 删卡。
 */
async function deleteCard(id, userId) {
  const result = await run('DELETE FROM style_cards WHERE id = ? AND user_id = ?', [id, userId]);
  return result.changes > 0;
}

/**
 * 解析当前生效的规则。
 *
 * 按 kind 分组处理：**作品级整类替换全局级**。
 * 叠加会产生「全局要求句长 ≤30，作品要求句长 ≥40」这类互相矛盾的要求，
 * 模型只能瞎猜。整类替换的语义是「这部作品我另有一套」，符合直觉。
 *
 * @param {string} userId
 * @param {string} [workId]
 * @returns {{good: Object, bad: Object, conflicts: Array<string>}}
 */
async function resolveEffectiveStyle(userId, workId) {
  const empty = { cards: [], rules: normalizeRules(null) };

  if (!userId) return { good: empty, bad: empty, conflicts: [] };

  const rows = await all(
    `SELECT * FROM style_cards
     WHERE user_id = ? AND enabled = 1
       AND (work_id IS NULL OR work_id = ?)
     ORDER BY created_at ASC`,
    [userId, workId || '']
  );

  const cards = rows.map(toCard);
  const conflicts = [];

  const pick = (kind) => {
    // 注意字段名：toCard 把 work_id 转成了 workId，这里必须用 workId。
    // 写成 c.work_id 会永远匹配不到，作品级卡会被全局级盖掉。
    const scoped = cards.filter((c) => c.kind === kind && c.workId && c.workId === workId);
    const global = cards.filter((c) => c.kind === kind && !c.workId);
    // 作品级存在就整类替换全局级
    const chosen = scoped.length ? scoped : global;
    const merged = mergeRules(chosen);
    conflicts.push(...merged.conflicts);
    return { cards: chosen, rules: merged.rules };
  };

  return {
    good: pick('good'),
    bad: pick('bad'),
    conflicts,
  };
}

/**
 * 取生效规则的注入文本。
 *
 * @param {string} userId
 * @param {string} [workId]
 * @returns {Promise<string>} 空串表示没有规则
 */
async function getStylePrompt(userId, workId) {
  const effective = await resolveEffectiveStyle(userId, workId);
  return formatStylePrompt(effective);
}

/**
 * 数据库行 → 对外结构。
 */
function toCard(row) {
  let rules = null;
  try {
    rules = JSON.parse(row.rules);
  } catch (e) {
    rules = null;
  }
  return {
    id: row.id,
    workId: row.work_id || '',
    kind: row.kind,
    title: row.title,
    source: row.source,
    chapterId: row.chapter_id || '',
    excerpt: row.excerpt || '',
    rules: normalizeRules(rules),
    enabled: !!row.enabled,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

module.exports = {
  EXCERPT_LIMIT,
  listCards,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  resolveEffectiveStyle,
  getStylePrompt,
};
