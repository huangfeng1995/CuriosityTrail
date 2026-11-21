'use strict';

/**
 * 灵感速记路由。
 *
 *   GET    /api/inspirations                     列表
 *   POST   /api/inspirations                     新建
 *   PUT    /api/inspirations/:id                 更新
 *   DELETE /api/inspirations/:id                 删除
 *   GET    /api/inspirations/suggestions/options 灵感方向维度清单
 *   POST   /api/inspirations/suggestions         生成一组候选方向（只读，不落库）
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');
const { ownedWork, ownedChapter } = require('../services/scope');
const { aiLimiter } = require('../middleware/rateLimit');
const inspirationPrompts = require('../services/inspirationPrompts');

const router = express.Router();
const now = () => new Date().toISOString();

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM inspirations WHERE user_id = ? ORDER BY consumed ASC, created_at DESC',
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { text, tags } = req.body || {};
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: '内容不能为空' });
  }

  try {
    const id = crypto.randomUUID();
    await run(
      'INSERT INTO inspirations (id, user_id, text, tags, consumed, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      [id, req.userId, String(text).trim(), tags || '', now()]
    );
    res.json(await get('SELECT * FROM inspirations WHERE id = ? AND user_id = ?', [id, req.userId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { text, tags, consumed } = req.body || {};
  try {
    const existing = await get('SELECT * FROM inspirations WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.userId,
    ]);
    if (!existing) return res.status(404).json({ error: '灵感不存在' });

    await run(
      'UPDATE inspirations SET text = ?, tags = ?, consumed = ? WHERE id = ? AND user_id = ?',
      [
        text !== undefined ? String(text).trim() : existing.text,
        tags !== undefined ? tags : existing.tags,
        consumed !== undefined ? (consumed ? 1 : 0) : existing.consumed,
        req.params.id,
        req.userId,
      ]
    );
    res.json(await get('SELECT * FROM inspirations WHERE id = ? AND user_id = ?', [req.params.id, req.userId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM inspirations WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.userId,
    ]);
    if (!result.changes) return res.status(404).json({ error: '灵感不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 灵感方向
// ---------------------------------------------------------------------------

router.get('/suggestions/options', (req, res) => {
  res.json({
    dimensions: inspirationPrompts.listDimensions(),
    defaultCount: inspirationPrompts.DEFAULT_COUNT,
  });
});

router.post('/suggestions', aiLimiter, async (req, res) => {
  const body = req.body || {};
  const workId = String(body.workId || '').trim();
  const chapterId = String(body.chapterId || '').trim();
  const dimension = String(body.dimension || '').trim();
  const count = inspirationPrompts.clampCount(body.count);
  const exclude = Array.isArray(body.exclude) ? body.exclude : [];
  const dimensions = Array.isArray(body.dimensions) ? body.dimensions : [];

  if (!workId) return res.status(400).json({ error: '缺少 workId' });

  try {
    const work = await ownedWork(workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    let chapter = null;
    if (chapterId) {
      chapter = await ownedChapter(chapterId, req.userId);
      if (!chapter || chapter.work_id !== workId) {
        return res.status(404).json({ error: '章节不存在' });
      }
    }

    res.json(
      await inspirationPrompts.suggest({
        work,
        chapter,
        userId: req.userId,
        dimension,
        count,
        exclude,
        dimensions,
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
