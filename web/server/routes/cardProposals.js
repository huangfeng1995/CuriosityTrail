'use strict';

/**
 * 卡片提案路由。
 *
 *   GET  /api/card-proposals?workId=&status=  提案列表
 *   POST /api/card-proposals/scan             识别一段正文 → 生成提案（失败静默）
 *   POST /api/card-proposals/confirm          确认（可改标题），一次最多 5 条
 *   POST /api/card-proposals/dismiss          丢弃，不写卡片表
 *
 * 设计底线：
 *   · 模型只产出提案，永远不直接写 characters / settings / plot_cards；
 *   · 未确认的提案不进卡片表，所以上下文装配不可能把它当事实注入；
 *   · 识别失败、超时、输出不合法一律返回空数组，不向作者报错。
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run, transaction } = require('../database');
const { ownedWork, ownedChapter } = require('../services/scope');
const recognizer = require('../services/cards/recognizer');
const proposals = require('../services/cards/proposals');
const memory = require('../services/memory/indexer');

const router = express.Router();

/** 一次最多确认几条：防止作者手滑把一屏提案全点成事实 */
const MAX_CONFIRM = 5;
/** 一次最多丢弃几条 */
const MAX_DISMISS = 20;

const now = () => new Date().toISOString();

/** 提案的对外形状由 service 统一维护，避免两处口径分叉。 */
const toProposal = proposals.toProposal;
const parsePayload = proposals.parsePayload;
const existingTitles = proposals.existingTitles;

// ---------------------------------------------------------------------------
// GET /api/card-proposals?workId=&status=pending
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const workId = String(req.query.workId || '').trim();
  const status = String(req.query.status || 'pending').trim();
  if (!workId) return res.status(400).json({ error: '缺少 workId' });
  if (!['pending', 'confirmed', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status 不合法' });
  }

  try {
    const work = await ownedWork(workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const rows = await all(
      `SELECT * FROM card_proposals
       WHERE user_id = ? AND work_id = ? AND status = ?
       ORDER BY created_at ASC`,
      [req.userId, workId, status]
    );
    res.json({ proposals: rows.map(toProposal) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/card-proposals/scan
// ---------------------------------------------------------------------------
router.post('/scan', async (req, res) => {
  const body = req.body || {};
  const workId = String(body.workId || '').trim();
  const chapterId = String(body.chapterId || '').trim();
  const blockId = String(body.blockId || '').trim();
  // 来源采纳：保存触发的扫描为空，采纳触发的扫描带消息 id。
  // 撤销时按它作废这一轮 pending 提案。
  const originRef = String(body.originRef || '').trim().slice(0, 200);

  // 批量扫描：保存后可能一次改动多个 block。合并成一次识别，
  // 再按 source_quote 回落到具体 block，避免一条请求一个模型调用。
  const segments = Array.isArray(body.blocks)
    ? body.blocks
        .filter((b) => b && typeof b === 'object')
        .map((b) => ({
          blockId: String(b.blockId || '').trim(),
          text: String(b.text || ''),
        }))
        .filter((b) => b.text.trim())
        .slice(0, 20)
    : [];
  const text = segments.length
    ? segments.map((s) => s.text).join('\n\n')
    : String(body.text || '');

  // 识别失败必须静默：从这里开始，任何出口都返回 200
  const skip = (reason) => res.json({ proposals: [], skipped: true, reason });

  try {
    if (!workId || !text.trim()) return skip('missing');
    if (text.trim().length < recognizer.MIN_TEXT_LENGTH) return skip('short');

    const work = await ownedWork(workId, req.userId);
    if (!work) return skip('work');

    if (chapterId) {
      const chapter = await ownedChapter(chapterId, req.userId);
      if (!chapter || chapter.work_id !== workId) return skip('chapter');
    }

    // B：右栏生成时已经落过「草稿」提案，采纳只需要补出处。
    // 命中时不再调识别模型，避免同一条来源被识别两次；
    // 没命中（草稿生成失败/旧链路）才走下面的识别兜底。
    const promoted = await proposals.promoteDrafts({
      userId: req.userId,
      workId,
      chapterId,
      blockId,
      originRef,
    });
    if (promoted.length) {
      return res.json({ proposals: promoted, skipped: false, promoted: promoted.length });
    }

    const titles = await existingTitles(workId);
    const recognized = await recognizer.recognize({ text, existingTitles: titles });
    if (!recognized.length) return res.json({ proposals: [], skipped: false });

    const inserted = await proposals.insertProposals({
      userId: req.userId,
      workId,
      chapterId,
      originRef,
      proposals: recognized,
      segments,
      blockId,
    });

    res.json({ proposals: inserted, skipped: false });
  } catch (err) {
    // 超时、上游报错、解析失败都在这里收口——静默
    return skip('error');
  }
});

// ---------------------------------------------------------------------------
// POST /api/card-proposals/confirm
// ---------------------------------------------------------------------------

/**
 * 把一条提案落成卡片。
 *
 * INSERT 卡片与 UPDATE 提案状态放在同一个事务里：只成功一半的话，
 * 作者会看到卡片建了、提案还挂着，再点一次就重复建卡。
 *
 * @param {Object} row 提案行
 * @param {string} title 作者可能改过的标题
 * @returns {Promise<string>} 新建卡片 id
 */
async function confirmOne(row, title) {
  const id = crypto.randomUUID();
  const ts = now();
  const payload = parsePayload(row);
  let cardId = id;

  if (row.kind === 'character') {
    await transaction([
      {
        sql: `INSERT INTO characters
                (id, work_id, name, aliases, role, identity, personality, speech,
                 goal, arc, relations, notes, source_chapter_id, source_block_id,
                 created_at, modified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          row.work_id,
          title,
          payload.aliases || '',
          payload.role || '',
          payload.identity || '',
          payload.personality || '',
          payload.speech || '',
          payload.goal || '',
          payload.arc || '',
          '',
          row.source_quote ? `来源原文：${row.source_quote}` : '',
          row.chapter_id || null,
          row.block_id || null,
          ts,
          ts,
        ],
      },
      {
        sql: `UPDATE card_proposals
              SET status = 'confirmed', card_id = ?, title = ?, updated_at = ?
              WHERE id = ? AND status = 'pending'`,
        params: [id, title, ts, row.id],
      },
    ]);
  } else if (row.kind === 'setting') {
    await transaction([
      {
        sql: `INSERT INTO settings
                (id, work_id, category, name, content, importance,
                 source_chapter_id, source_block_id, created_at, modified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          id,
          row.work_id,
          payload.category || '规则',
          title,
          row.content || '',
          3,
          row.chapter_id || null,
          row.block_id || null,
          ts,
          ts,
        ],
      },
      {
        sql: `UPDATE card_proposals
              SET status = 'confirmed', card_id = ?, title = ?, updated_at = ?
              WHERE id = ? AND status = 'pending'`,
        params: [id, title, ts, row.id],
      },
    ]);
  } else {
    // 情节节点：确认即表示「正文里已经发生」，状态直接落 done
    const maxSeq = await get(
      'SELECT MAX(seq) AS seq FROM plot_cards WHERE work_id = ?',
      [row.work_id]
    );
    const seq = Number(maxSeq && maxSeq.seq ? maxSeq.seq : 0) + 1;
    await transaction([
      {
        sql: `INSERT INTO plot_cards
                (id, work_id, chapter_id, title, kind, content, seq, status,
                 source_block_id, created_at, modified_at)
              VALUES (?, ?, ?, ?, 'plot', ?, ?, 'done', ?, ?, ?)`,
        params: [
          id,
          row.work_id,
          row.chapter_id || null,
          title,
          row.content || '',
          seq,
          row.block_id || null,
          ts,
          ts,
        ],
      },
      {
        sql: `UPDATE card_proposals
              SET status = 'confirmed', card_id = ?, title = ?, updated_at = ?
              WHERE id = ? AND status = 'pending'`,
        params: [id, title, ts, row.id],
      },
    ]);
  }

  // 确认后的卡片进记忆库：与手动建卡一致，下一轮 AI 能召回
  if (row.kind === 'character' || row.kind === 'setting') {
    memory.scheduleIndex({
      userId: row.user_id,
      workId: row.work_id,
      sourceType: row.kind === 'character' ? 'character' : 'setting',
      sourceId: cardId,
    });
  }

  return cardId;
}

router.post('/confirm', async (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : [];
  const edits = body.edits && typeof body.edits === 'object' ? body.edits : {};

  if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
  if (ids.length > MAX_CONFIRM) {
    return res.status(400).json({ error: `一次最多确认 ${MAX_CONFIRM} 条` });
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await all(
      `SELECT * FROM card_proposals WHERE id IN (${placeholders}) AND user_id = ?`,
      [...ids, req.userId]
    );
    if (rows.length !== ids.length) return res.status(404).json({ error: '提案不存在' });

    const results = [];
    for (const row of rows) {
      // 幂等：已经确认过的直接返回原卡片 id，不重复建卡
      if (row.status === 'confirmed') {
        results.push({ id: row.id, cardId: row.card_id, kind: row.kind, reused: true });
        continue;
      }
      if (row.status !== 'pending') {
        results.push({ id: row.id, error: '已丢弃' });
        continue;
      }

      const work = await ownedWork(row.work_id, req.userId);
      if (!work) return res.status(404).json({ error: '作品不存在' });

      const edited = edits[row.id] || {};
      const title =
        recognizer.normalizeTitle(edited.title) ||
        row.title;
      if (!title) return res.status(400).json({ error: '标题不能为空' });

      const cardId = await confirmOne(row, title);
      results.push({ id: row.id, cardId, kind: row.kind, reused: false });
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/card-proposals/dismiss
// ---------------------------------------------------------------------------
router.post('/dismiss', async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids)
    ? req.body.ids.filter((id) => typeof id === 'string' && id)
    : [];
  if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
  if (ids.length > MAX_DISMISS) {
    return res.status(400).json({ error: `一次最多丢弃 ${MAX_DISMISS} 条` });
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const result = await run(
      `UPDATE card_proposals
       SET status = 'dismissed', updated_at = ?
       WHERE id IN (${placeholders}) AND user_id = ? AND status = 'pending'`,
      [now(), ...ids, req.userId]
    );
    res.json({ dismissed: result.changes || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/card-proposals/dismiss-source
//
// 作者撤销一次采纳时调用：把这次采纳产生的 pending 提案一并作废。
// 已确认成卡的不回滚——作者是看着原句点的确认，撤销正文不代表那条设定不成立；
// 返回 confirmed 数量，让前端能如实提示「已确认的 N 条保留」。
// ---------------------------------------------------------------------------
router.post('/dismiss-source', async (req, res) => {
  const originRef = String((req.body || {}).originRef || '').trim();
  if (!originRef) return res.status(400).json({ error: '缺少 originRef' });

  try {
    const kept = await get(
      `SELECT COUNT(*) AS n FROM card_proposals
       WHERE user_id = ? AND origin_ref = ? AND status = 'confirmed'`,
      [req.userId, originRef]
    );
    const result = await run(
      `UPDATE card_proposals
       SET status = 'dismissed', updated_at = ?
       WHERE user_id = ? AND origin_ref = ? AND status = 'pending'`,
      [now(), req.userId, originRef]
    );
    res.json({
      dismissed: result.changes || 0,
      confirmed: (kept && kept.n) || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.MAX_CONFIRM = MAX_CONFIRM;
