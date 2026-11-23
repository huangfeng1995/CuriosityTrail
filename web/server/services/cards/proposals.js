'use strict';

/**
 * 卡片提案的落库与状态流转。
 *
 * 两个入口共用这一份逻辑：
 *   · 生成即记录（B）：右栏一产出正文，就按消息 id 落「草稿」提案；
 *   · 采纳扫描：旧链路仍按正文识别，作为草稿缺失时的兜底。
 *
 * 「草稿 / 已进正文」不新增列，直接用 block_id 区分：
 *   · block_id IS NULL  → 草稿，还没写进正文；
 *   · block_id 非空     → 已进正文，采纳时补上的具体段落。
 * 这样既没有 schema 变更，撤销仍按 origin_ref 只作废 pending。
 */

const crypto = require('crypto');
const { all, get, run } = require('../../database');
const recognizer = require('./recognizer');

const now = () => new Date().toISOString();

/** 安全解析 payload JSON。 */
function parsePayload(row) {
  if (!row) return {};
  try {
    const value = JSON.parse(row.payload || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (e) {
    return {};
  }
}

/** 提案的对外形状：前端只需要这些字段。 */
function toProposal(row) {
  return {
    id: row.id,
    workId: row.work_id,
    chapterId: row.chapter_id || '',
    blockId: row.block_id || '',
    kind: row.kind,
    title: row.title,
    content: row.content || '',
    payload: parsePayload(row),
    sourceQuote: row.source_quote || '',
    status: row.status,
    cardId: row.card_id || '',
    originRef: row.origin_ref || '',
    // 草稿 = 还没进正文；已进正文 = 采纳时补上了 block_id。
    stage: row.block_id ? 'adopted' : 'draft',
    createdAt: row.created_at,
  };
}

/** 取作品下已有卡片的名字/标题，供识别时去重。 */
async function existingTitles(workId) {
  const [characters, settings, plots] = await Promise.all([
    all('SELECT name FROM characters WHERE work_id = ?', [workId]),
    all('SELECT name FROM settings WHERE work_id = ?', [workId]),
    all('SELECT title FROM plot_cards WHERE work_id = ?', [workId]),
  ]);
  return [
    ...characters.map((r) => r.name),
    ...settings.map((r) => r.name),
    ...plots.map((r) => r.title),
  ].filter(Boolean);
}

/** 作品下 pending 的 kind:title 集合；同一个名字不重复堆提案。 */
async function pendingKeySet({ userId, workId }) {
  const pending = await all(
    `SELECT kind, title FROM card_proposals
     WHERE user_id = ? AND work_id = ? AND status = 'pending'`,
    [userId, workId]
  );
  return new Set(pending.map((row) => `${row.kind}:${row.title}`));
}

/**
 * 批量落提案。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.chapterId
 * @param {string} params.originRef 来源消息 id；撤销按它作废 pending
 * @param {Array} params.proposals recognizer 的输出
 * @param {Array} [params.segments] 批量扫描的 block 片段
 * @param {string} [params.blockId] 单 block 采纳时的 block
 * @param {Set} [params.pendingKeys] 调用方已查好的去重集合，避免重复查询
 * @param {boolean} [params.sizeOnly] 只返回插入数量（草稿路径不需要完整形状）
 */
async function insertProposals({
  userId,
  workId,
  chapterId,
  originRef,
  proposals,
  segments = [],
  blockId = '',
  pendingKeys = null,
}) {
  if (!Array.isArray(proposals) || !proposals.length) return [];

  const keys = pendingKeys || (await pendingKeySet({ userId, workId }));

  // 批量扫描时把提案落回真正含有证据的那个 block；找不到就归到首个 block。
  const blockFor = (proposal) => {
    if (!segments.length) return blockId || null;
    const quote = String(proposal.source_quote || '').trim();
    if (quote) {
      const hit = segments.find((segment) => segment.text.includes(quote));
      if (hit) return hit.blockId || null;
    }
    return segments[0].blockId || null;
  };

  const inserted = [];
  for (const proposal of proposals) {
    const key = `${proposal.kind}:${proposal.title}`;
    if (keys.has(key)) continue;
    keys.add(key);

    const proposalBlockId = blockFor(proposal);
    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO card_proposals
         (id, user_id, work_id, chapter_id, block_id, origin_ref, kind, title, content,
          payload, source_quote, status, card_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`,
      [
        id,
        userId,
        workId,
        chapterId || null,
        proposalBlockId,
        originRef,
        proposal.kind,
        proposal.title,
        proposal.content,
        JSON.stringify(proposal.payload || {}),
        proposal.source_quote || '',
        ts,
        ts,
      ]
    );

    inserted.push(
      toProposal({
        id,
        work_id: workId,
        chapter_id: chapterId || null,
        block_id: proposalBlockId,
        origin_ref: originRef,
        kind: proposal.kind,
        title: proposal.title,
        content: proposal.content,
        payload: JSON.stringify(proposal.payload || {}),
        source_quote: proposal.source_quote || '',
        status: 'pending',
        card_id: '',
        created_at: ts,
      })
    );
  }
  return inserted;
}

/**
 * 生成即记录：右栏产出正文后，先落「草稿」提案。
 *
 * - 同一来源（消息 id）只落一次，重复触发直接返回空；
 * - 重新生成时把上一版来源的草稿 pending 作废，避免新旧两版叠在左栏；
 * - 已确认的提案不动（撤销/重生成都不回滚作者点过的确认）；
 * - 没有正文或太短时不调用识别，零成本返回；
 * - 失败静默，不影响正文。
 *
 * @param {Object} params
 * @param {Object} [params.provider] 测试注入；不传时用当前配置的 provider
 */
async function createDraftProposals({
  userId,
  workId,
  chapterId,
  originRef,
  text,
  replacedOriginRef = '',
  provider,
  log = () => {},
}) {
  const body = String(text || '').trim();
  if (!userId || !workId || !chapterId || !originRef || !body) return [];
  if (body.length < recognizer.MIN_TEXT_LENGTH) return [];

  // 测试环境默认关掉自动识别，避免后台调用挤占假模型的响应队列。
  if (!provider && String(process.env.CARD_PROPOSALS_AUTO || '').toLowerCase() === 'off') {
    return [];
  }

  // 同一来源已经落过（无论后续有没有采纳/确认）就不再重复识别。
  const existing = await get(
    'SELECT COUNT(*) AS n FROM card_proposals WHERE user_id = ? AND origin_ref = ?',
    [userId, originRef]
  );
  if (existing && existing.n) return [];

  // 重新生成：只作废上一版来源的草稿 pending，已进正文/已确认的保留。
  if (replacedOriginRef && replacedOriginRef !== originRef) {
    await run(
      `UPDATE card_proposals
       SET status = 'dismissed', updated_at = ?
       WHERE user_id = ? AND origin_ref = ? AND status = 'pending' AND block_id IS NULL`,
      [now(), userId, replacedOriginRef]
    );
  }

  const titles = await existingTitles(workId);
  const recognized = await recognizer.recognize({
    text: body,
    existingTitles: titles,
    ...(provider ? { provider } : {}),
  });
  if (!recognized.length) return [];

  const inserted = await insertProposals({
    userId,
    workId,
    chapterId,
    originRef,
    proposals: recognized,
    // 草稿还没有落到具体段落：block_id 留空，前端据此标「草稿」。
    blockId: '',
  });
  if (inserted.length) log({ count: inserted.length, chapterId, originRef });
  return inserted;
}

/**
 * 采纳后给草稿补出处：block_id 一旦写上，来源标记就变成「已进正文」。
 *
 * 只提升该来源下 pending 且还没 block 的草稿；跨章的草稿不动，交给旧扫描兜底。
 * 返回提升后的提案；没有可提升的返回空数组，调用方继续走识别。
 */
async function promoteDrafts({ userId, workId, chapterId, blockId, originRef }) {
  if (!userId || !workId || !chapterId || !blockId || !originRef) return [];

  const rows = await all(
    `SELECT * FROM card_proposals
     WHERE user_id = ? AND work_id = ? AND origin_ref = ?
       AND status = 'pending' AND block_id IS NULL
       AND (chapter_id IS NULL OR chapter_id = ?)
     ORDER BY created_at ASC`,
    [userId, workId, originRef, chapterId]
  );
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  await run(
    `UPDATE card_proposals
     SET chapter_id = ?, block_id = ?, updated_at = ?
     WHERE id IN (${placeholders})`,
    [chapterId, blockId, now(), ...ids]
  );

  const promoted = await all(
    `SELECT * FROM card_proposals WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
    ids
  );
  return promoted.map(toProposal);
}

module.exports = {
  parsePayload,
  toProposal,
  existingTitles,
  insertProposals,
  createDraftProposals,
  promoteDrafts,
};
