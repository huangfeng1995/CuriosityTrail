'use strict';

/**
 * 作品与章节路由。
 *
 *   GET    /api/works            作品列表
 *   POST   /api/works            新建作品
 *   GET    /api/works/:id        作品详情（含章节列表）
 *   PUT    /api/works/:id        更新作品
 *   DELETE /api/works/:id        删除作品
 *
 *   GET    /api/works/:id/chapters           章节列表
 *   POST   /api/works/:id/chapters           新建章节
 *   GET    /api/chapters/:chapterId           章节详情
 *   PUT    /api/chapters/:chapterId           更新章节（blocks 为权威数据）
 *   DELETE /api/chapters/:chapterId           删除章节
 *   POST   /api/chapters/:chapterId/reorder   章节排序
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run, transaction } = require('../database');

const router = express.Router();

const now = () => new Date().toISOString();

/**
 * blocks 为权威数据，同时维护 content 纯文本派生快照。
 */
function deriveContent(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// 作品
// ---------------------------------------------------------------------------

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT w.*, (SELECT COUNT(*) FROM chapters c WHERE c.work_id = w.id) AS chapter_count
       FROM works w
       ORDER BY w.modified_at DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { title, genre, synopsis, outline } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '作品标题不能为空' });
  }

  try {
    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO works (id, title, genre, synopsis, outline, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        String(title).trim(),
        genre || '',
        synopsis || '',
        outline || '',
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM works WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const work = await get('SELECT * FROM works WHERE id = ?', [req.params.id]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const chapters = await all(
      'SELECT * FROM chapters WHERE work_id = ? ORDER BY seq, created_at',
      [req.params.id]
    );
    res.json({ ...work, chapters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, genre, synopsis, outline } = req.body || {};
  try {
    const existing = await get('SELECT * FROM works WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '作品不存在' });

    await run(
      `UPDATE works SET title = ?, genre = ?, synopsis = ?, outline = ?, modified_at = ?
       WHERE id = ?`,
      [
        (title !== undefined ? String(title).trim() : existing.title),
        genre !== undefined ? genre : existing.genre,
        synopsis !== undefined ? synopsis : existing.synopsis,
        outline !== undefined ? outline : existing.outline,
        now(),
        req.params.id,
      ]
    );
    res.json(await get('SELECT * FROM works WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM works WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: '作品不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

router.get('/:id/chapters', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM chapters WHERE work_id = ? ORDER BY seq, created_at',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/chapters', async (req, res) => {
  const { title, volume, status } = req.body || {};
  try {
    const work = await get('SELECT id FROM works WHERE id = ?', [req.params.id]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const maxRow = await get(
      'SELECT MAX(seq) AS maxSeq FROM chapters WHERE work_id = ?',
      [req.params.id]
    );
    const seq = (maxRow?.maxSeq ?? 0) + 1;

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.params.id,
        (title && String(title).trim()) || `第 ${seq} 章`,
        seq,
        volume || '',
        status || 'draft',
        '',
        JSON.stringify([]),
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM chapters WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 章节排序：接收 id 数组，按数组顺序重写 seq。
 */
router.post('/:id/chapters/reorder', async (req, res) => {
  const { chapterIds } = req.body || {};
  if (!Array.isArray(chapterIds)) {
    return res.status(400).json({ error: 'chapterIds 必须是数组' });
  }

  try {
    const statements = chapterIds.map((chapterId, index) => ({
      sql: 'UPDATE chapters SET seq = ?, modified_at = ? WHERE id = ? AND work_id = ?',
      params: [index + 1, now(), chapterId, req.params.id],
    }));
    await transaction(statements);

    const rows = await all(
      'SELECT id, title, seq FROM chapters WHERE work_id = ? ORDER BY seq',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
