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

const router = express.Router();

const now = () => new Date().toISOString();

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

module.exports = router;
