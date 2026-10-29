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
const { ownedWork, ownedSetting } = require('../services/scope');
const memory = require('../services/memory/indexer');

const router = express.Router();
const now = () => new Date().toISOString();

router.get('/', async (req, res) => {
  const { workId } = req.query;
  try {
    const rows = workId
      ? await all(
          `SELECT s.* FROM settings s
           JOIN works w ON w.id = s.work_id
           WHERE s.work_id = ? AND w.user_id = ?
           ORDER BY s.importance DESC, s.category, s.name`,
          [workId, req.userId]
        )
      : await all(
          `SELECT s.* FROM settings s
           JOIN works w ON w.id = s.work_id
           WHERE w.user_id = ?
           ORDER BY s.modified_at DESC`,
          [req.userId]
        );
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
    const work = await ownedWork(workId, req.userId);
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

    // 新设定立刻进记忆库
    memory.scheduleIndex({
      userId: req.userId,
      workId,
      sourceType: 'setting',
      sourceId: id,
    });

    res.json(await get('SELECT * FROM settings WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await ownedSetting(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: '设定不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { category, name, content, importance } = req.body || {};

  try {
    const existing = await ownedSetting(req.params.id, req.userId);
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

    // 设定改了，重新入索引
    memory.scheduleIndex({
      userId: req.userId,
      workId: existing.work_id,
      sourceType: 'setting',
      sourceId: req.params.id,
    });

    res.json(await ownedSetting(req.params.id, req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await ownedSetting(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '设定不存在' });

    await run('DELETE FROM settings WHERE id = ?', [req.params.id]);

    // 设定没了，记忆里的旧规则也得消失
    memory.scheduleRemove({
      userId: req.userId,
      sourceType: 'setting',
      sourceId: req.params.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
