'use strict';

/**
 * 历史悬疑流水线：锚点库。
 *
 * 所有入口先过同一道门：作品属于当前用户**且** template 已启用。
 * 任一条件不满足都返回 404，不区分「不存在」与「未启用」——
 * 避免用状态码探出别人作品是否存在。
 */

const express = require('express');
const crypto = require('crypto');

const { all, get, run, transaction } = require('../database');
const { ownedWork } = require('../services/scope');
const { isPipelineEnabled } = require('../services/pipeline/gate');
const anchors = require('../services/pipeline/anchors');
const knowledgeScan = require('../services/pipeline/knowledgeScan');
const knowledgeView = require('../services/pipeline/knowledgeView');

const router = express.Router();

const now = () => new Date().toISOString();

/**
 * 待确认总数（跨作品）。
 *
 * 设置入口上的角标靠它：作者不需要打开任何一个面板，
 * 也能知道「有东西等我处理」。
 */
router.get('/pending-count', async (req, res) => {
  try {
    const row = await get(
      `SELECT
         (SELECT COUNT(*) FROM knowledge_pending p
            JOIN works w ON w.id = p.work_id
           WHERE w.user_id = ? AND p.status = 'pending')
         +
         (SELECT COUNT(*) FROM anchor_violations v
            JOIN works w ON w.id = v.work_id
           WHERE w.user_id = ? AND v.dismissed = 0) AS n`,
      [req.userId, req.userId]
    );
    return res.json({ count: row?.n || 0 });
  } catch (err) {
    console.error('[pipeline] 待确认计数失败:', err);
    return res.json({ count: 0 });
  }
});

/** 单条锚点的对外形状 */
function toAnchor(row) {
  let rules = [];
  try {
    const parsed = JSON.parse(row.rules || '[]');
    rules = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    rules = [{ rule_type: 'manual_only', params: {} }];
  }
  return {
    id: row.id,
    workId: row.work_id,
    kind: row.kind,
    subject: row.subject,
    claim: row.claim,
    confidence: row.confidence,
    sourceTitle: row.source_title || '',
    sourceLocator: row.source_locator || '',
    sourceQuote: row.source_quote || '',
    rules,
    immutable: row.immutable === 1,
    status: row.status,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

async function pipelineWork(req, res) {
  const work = await ownedWork(req.params.workId, req.userId);
  if (!work || !isPipelineEnabled(work)) {
    res.status(404).json({ error: '作品不存在' });
    return null;
  }
  return work;
}

function fail(res, err) {
  if (err instanceof anchors.ValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error('[pipeline] 锚点接口失败:', err);
  return res.status(500).json({ error: '锚点操作失败' });
}

// ---------------------------------------------------------------------------
// 整理草稿（只返回候选，不落库）
// ---------------------------------------------------------------------------

router.post('/:workId/anchors/draft', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const { topic, era, hint } = req.body || {};
    if (!topic || !String(topic).trim()) {
      return res.status(400).json({ error: '请先给一个整理主题' });
    }

    const result = await anchors.draftAnchors({ topic, era, hint });
    return res.json(result);
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

router.post('/:workId/anchors/import', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    // 先整批校验；任何一条不合法都不会进入写库阶段（PV2）。
    const values = anchors.validateImportBatch((req.body || {}).candidates);

    const ids = values.map(() => crypto.randomUUID());
    const ts = now();
    const statements = [];
    let blankAreas = 0;

    values.forEach((value, index) => {
      statements.push({
        sql: `INSERT INTO work_anchors
                (id, work_id, kind, subject, claim, confidence,
                 source_title, source_locator, source_quote, rules, immutable,
                 status, created_at, modified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        params: [
          ids[index],
          work.id,
          value.kind,
          value.subject,
          value.claim,
          value.confidence,
          value.source_title || null,
          value.source_locator || null,
          value.source_quote || null,
          JSON.stringify(value.rules),
          value.immutable,
          ts,
          ts,
        ],
      });

      // P.5.1：空白锚点同步写一条空白区，后续知情边界直接查这张表。
      if (value.confidence === 'blank') {
        statements.push({
          sql: `INSERT INTO work_blank_areas
                  (id, work_id, topic, why_blank, usable_for, status, created_at, modified_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
          params: [
            crypto.randomUUID(),
            work.id,
            value.subject,
            value.why_blank || null,
            value.usable_for || null,
            ts,
            ts,
          ],
        });
        blankAreas += 1;
      }
    });

    await transaction(statements);

    const rows = await all(
      `SELECT * FROM work_anchors WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    // 按候选顺序返回，便于前端与勾选列表对齐
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => toAnchor(byId.get(id)));

    return res.json({ imported: values.length, blankAreas, anchors: ordered });
  } catch (err) {
    return fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// 列表与状态流转
// ---------------------------------------------------------------------------

router.get('/:workId/anchors', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const { status, kind } = req.query || {};
    const where = ['work_id = ?'];
    const params = [work.id];

    if (status !== undefined) {
      if (!['pending', 'active', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'status 取值不合法' });
      }
      where.push('status = ?');
      params.push(status);
    }
    if (kind !== undefined) {
      if (!anchors.KINDS.has(kind)) {
        return res.status(400).json({ error: 'kind 取值不合法' });
      }
      where.push('kind = ?');
      params.push(kind);
    }

    const rows = await all(
      `SELECT * FROM work_anchors WHERE ${where.join(' AND ')}
       ORDER BY created_at ASC, id ASC`,
      params
    );
    return res.json(rows.map(toAnchor));
  } catch (err) {
    return fail(res, err);
  }
});

const TRANSITIONS = {
  activate: { from: ['pending'], to: 'active' },
  reject: { from: ['pending', 'active'], to: 'rejected' },
};

function statusHandler(action) {
  return async (req, res) => {
    try {
      const work = await pipelineWork(req, res);
      if (!work) return;

      const anchor = await get(
        'SELECT * FROM work_anchors WHERE id = ? AND work_id = ?',
        [req.params.id, work.id]
      );
      if (!anchor) return res.status(404).json({ error: '锚点不存在' });

      const rule = TRANSITIONS[action];
      if (!rule.from.includes(anchor.status)) {
        return res.status(409).json({
          error: `当前状态 ${anchor.status} 不能执行 ${action}`,
        });
      }

      await run(
        'UPDATE work_anchors SET status = ?, modified_at = ? WHERE id = ?',
        [rule.to, now(), anchor.id]
      );
      const updated = await get('SELECT * FROM work_anchors WHERE id = ?', [anchor.id]);
      return res.json(toAnchor(updated));
    } catch (err) {
      return fail(res, err);
    }
  };
}

router.post('/:workId/anchors/:id/activate', statusHandler('activate'));
router.post('/:workId/anchors/:id/reject', statusHandler('reject'));

// ---------------------------------------------------------------------------
// 知情扫描（HP7）
// ---------------------------------------------------------------------------

/**
 * 扫描正文里的知情变化。
 *
 * 扫描失败是**降级**，不是错误响应：本章不更新、旧边界继续用，
 * 前端不需要为它弹红条。只有输入本身不合法（章节不存在/章节号不符）
 * 才返回 4xx。
 */
router.post('/:workId/knowledge/scan', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const { chapterId, chapterSeq, text } = req.body || {};
    if (!chapterId) return res.status(400).json({ error: '缺少 chapterId' });
    if (!text || !String(text).trim()) {
      return res.status(400).json({ error: '缺少要扫描的正文' });
    }

    const result = await knowledgeScan.scanKnowledge({
      workId: work.id,
      chapterId,
      chapterSeq,
      text: String(text),
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof knowledgeScan.ScanInputError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[pipeline] 知情扫描失败:', err);
    return res.json({ applied: [], pending: [], failed: true, knowledgePendingCount: 0 });
  }
});

// ---------------------------------------------------------------------------
// 知情边界只读视图（作者核对用）
// ---------------------------------------------------------------------------

/**
 * 第 N 章编辑时 AI 看到的边界：谁已知、谁未知。
 *
 * 只读接口，不写任何表。与知识扫描/注入共用 knowledgeAt，
 * 语义统一为「第 N 章开写前」，避免作者看到的和模型看到的对不上。
 */
router.get('/:workId/knowledge/boundary', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const chapterId = String(req.query.chapterId || '');
    if (!chapterId) return res.status(400).json({ error: '缺少 chapterId' });

    const view = await knowledgeView.boundaryForChapter(work.id, chapterId);
    if (!view) return res.status(404).json({ error: '章节不存在' });
    return res.json(view);
  } catch (err) {
    console.error('[pipeline] 知情边界读取失败:', err);
    return res.status(500).json({ error: '知情边界读取失败' });
  }
});

// ---------------------------------------------------------------------------
// 待确认队列
// ---------------------------------------------------------------------------

function toPendingKnowledge(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    chapterSeq: row.chapter_seq,
    characterId: row.character_id,
    characterName: row.character_name,
    factId: row.fact_id,
    factLabel: row.fact_label,
    fromState: row.from_state,
    toState: row.to_state,
    evidence: row.evidence,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toViolation(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id,
    chapterSeq: row.chapter_seq,
    chapterTitle: row.chapter_title || '',
    anchorId: row.anchor_id,
    ruleType: row.rule_type,
    severity: row.severity,
    quote: row.quote,
    offsetStart: row.offset_start,
    detail: row.detail || '',
    createdAt: row.created_at,
  };
}

/**
 * 待确认队列：知情变化 + 本章锚点冲突。
 *
 * 这两类都是「引擎已经发现、但不能自己生效」的东西，必须集中给作者看；
 * 否则 pending 只是在库里堆积，等于静默丢弃。
 */
router.get('/:workId/pending', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const knowledge = await all(
      `SELECT * FROM knowledge_pending
       WHERE work_id = ? AND status = 'pending'
       ORDER BY created_at ASC, id ASC`,
      [work.id]
    );
    const violations = await all(
      `SELECT v.*, c.title AS chapter_title, c.seq AS chapter_seq
       FROM anchor_violations v
       LEFT JOIN chapters c ON c.id = v.chapter_id
       WHERE v.work_id = ? AND v.dismissed = 0
       ORDER BY v.created_at ASC, v.id ASC`,
      [work.id]
    );

    return res.json({
      knowledge: knowledge.map(toPendingKnowledge),
      violations: violations.map(toViolation),
    });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * 确认一条知情变化。
 *
 * 这条路由就是「作者确认后才落库」的闸门：扫描自动写入只到 suspects/partial，
 * knows/exposed 与任何校验不过的条目都停在这里，等这一步。
 */
router.post('/:workId/pending/knowledge/:id/confirm', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const row = await get(
      'SELECT * FROM knowledge_pending WHERE id = ? AND work_id = ?',
      [req.params.id, work.id]
    );
    if (!row) return res.status(404).json({ error: '待确认条目不存在' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `当前状态 ${row.status} 不能确认` });
    }
    // 角色或事实没解析出来时不能硬写：matrix 的外键会直接失败。
    if (!row.character_id || !row.fact_id) {
      return res.status(422).json({
        error: '这一条的角色或事实没能对应到库里，不能确认；请先补齐人物/事实后重新扫描',
      });
    }
    if (!knowledgeScan.STATES.has(row.to_state)) {
      return res.status(422).json({ error: `状态不合法：${row.to_state}` });
    }

    const exists = await get(
      `SELECT id FROM knowledge_matrix
       WHERE character_id = ? AND fact_id = ? AND chapter_seq = ?`,
      [row.character_id, row.fact_id, row.chapter_seq]
    );
    if (exists) {
      return res.status(409).json({ error: '本章已有该角色/事实的知情记录，不能重复写入' });
    }

    const ts = now();
    await transaction([
      {
        sql: `INSERT INTO knowledge_matrix
                (id, work_id, character_id, fact_id, chapter_seq, state,
                 evidence_id, source_chapter_id, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        params: [
          crypto.randomUUID(),
          work.id,
          row.character_id,
          row.fact_id,
          row.chapter_seq,
          row.to_state,
          row.chapter_id,
          row.evidence,
          ts,
        ],
      },
      {
        sql: `UPDATE knowledge_pending SET status = 'confirmed', modified_at = ?
              WHERE id = ?`,
        params: [ts, row.id],
      },
    ]);

    return res.json({ ok: true, knowledge: toPendingKnowledge({ ...row, status: 'confirmed' }) });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * 批量确认知情变化。
 *
 * 与单条确认同一套校验，只是一次处理一批：作者在设置里点一次，
 * 不用为每条候选逐个别点。校验不过的条目跳过并返回原因，
 * 不会把整批都拒掉。
 */
router.post('/:workId/pending/knowledge/confirm-batch', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: '没有待确认的条目' });

    const ts = now();
    const statements = [];
    const skipped = [];
    let confirmed = 0;

    for (const id of ids) {
      const row = await get(
        'SELECT * FROM knowledge_pending WHERE id = ? AND work_id = ?',
        [id, work.id]
      );
      if (!row) {
        skipped.push({ id, reason: '条目不存在' });
        continue;
      }
      if (row.status !== 'pending') {
        skipped.push({ id, reason: `当前状态 ${row.status} 不能确认` });
        continue;
      }
      if (!row.character_id || !row.fact_id) {
        skipped.push({ id, reason: '角色或事实没能对应到库里' });
        continue;
      }
      if (!knowledgeScan.STATES.has(row.to_state)) {
        skipped.push({ id, reason: `状态不合法：${row.to_state}` });
        continue;
      }
      const exists = await get(
        `SELECT id FROM knowledge_matrix
         WHERE character_id = ? AND fact_id = ? AND chapter_seq = ?`,
        [row.character_id, row.fact_id, row.chapter_seq]
      );
      if (exists) {
        skipped.push({ id, reason: '本章已有该角色/事实的知情记录' });
        continue;
      }

      statements.push({
        sql: `INSERT INTO knowledge_matrix
                (id, work_id, character_id, fact_id, chapter_seq, state,
                 evidence_id, source_chapter_id, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        params: [
          crypto.randomUUID(),
          work.id,
          row.character_id,
          row.fact_id,
          row.chapter_seq,
          row.to_state,
          row.chapter_id,
          row.evidence,
          ts,
        ],
      });
      statements.push({
        sql: `UPDATE knowledge_pending SET status = 'confirmed', modified_at = ?
              WHERE id = ?`,
        params: [ts, row.id],
      });
      confirmed += 1;
    }

    if (statements.length) await transaction(statements);
    return res.json({ confirmed, skipped });
  } catch (err) {
    return fail(res, err);
  }
});

/** 驳回一条知情变化：只改 pending 状态，不碰 knowledge_matrix。 */
router.post('/:workId/pending/knowledge/:id/dismiss', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const row = await get(
      'SELECT * FROM knowledge_pending WHERE id = ? AND work_id = ?',
      [req.params.id, work.id]
    );
    if (!row) return res.status(404).json({ error: '待确认条目不存在' });
    if (row.status !== 'pending') {
      return res.status(409).json({ error: `当前状态 ${row.status} 不能驳回` });
    }

    await run(
      "UPDATE knowledge_pending SET status = 'dismissed', modified_at = ? WHERE id = ?",
      [now(), row.id]
    );
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

/**
 * 驳回一条锚点冲突。
 *
 * block 级（有出处 + 不可变）不允许驳回：它意味着正文与史实硬冲突，
 * 只能改正文，不能靠点一下让它消失。
 */
router.post('/:workId/violations/:id/dismiss', async (req, res) => {
  try {
    const work = await pipelineWork(req, res);
    if (!work) return;

    const row = await get(
      'SELECT * FROM anchor_violations WHERE id = ? AND work_id = ?',
      [req.params.id, work.id]
    );
    if (!row) return res.status(404).json({ error: '冲突记录不存在' });
    if (row.severity === 'block') {
      return res.status(409).json({ error: 'block 级冲突必须改写正文，不能驳回' });
    }
    if (row.dismissed === 1) return res.json({ ok: true });

    await run('UPDATE anchor_violations SET dismissed = 1 WHERE id = ?', [row.id]);
    return res.json({ ok: true });
  } catch (err) {
    return fail(res, err);
  }
});

module.exports = router;
