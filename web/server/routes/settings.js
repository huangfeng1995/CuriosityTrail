'use strict';

/**
 * 世界观设定路由。
 *
 *   GET    /api/settings?workId=      设定列表
 *   POST   /api/settings              新建设定
 *   GET    /api/settings/:id          设定详情
 *   PUT    /api/settings/:id          更新设定
 *   DELETE /api/settings/:id          删除设定
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');

const router = express.Router();
const now = () => new Date().toISOString();

router.get('/', async (req, res) => {
  const { workId } = req.query;
  try {
    const rows = workId
      ? await all(
          'SELECT * FROM settings WHERE work_id = ? ORDER BY importance DESC, category, name',
          [workId]
        )
      : await all('SELECT * FROM settings ORDER BY modified_at DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { workId, category, name, content, importance } = req.body || {};

  if (!workId) return res.status(400).json({ error: '缺少 workId' });
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '设定名称不能为空' });
  }

  try {
    const work = await get('SELECT id FROM works WHERE id = ?', [workId]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO settings (id, work_id, category, name, content, importance, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workId,
        category || '其他',
        String(name).trim(),
        content || '',
        Number.isFinite(Number(importance)) ? Number(importance) : 3,
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM settings WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM settings WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '设定不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { category, name, content, importance } = req.body || {};

  try {
    const existing = await get('SELECT * FROM settings WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '设定不存在' });

    await run(
      `UPDATE settings SET category = ?, name = ?, content = ?, importance = ?, modified_at = ?
       WHERE id = ?`,
      [
        category !== undefined ? category : existing.category,
        name !== undefined ? String(name).trim() : existing.name,
        content !== undefined ? content : existing.content,
        importance !== undefined ? Number(importance) : existing.importance,
        now(),
        req.params.id,
      ]
    );
    res.json(await get('SELECT * FROM settings WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM settings WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: '设定不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
