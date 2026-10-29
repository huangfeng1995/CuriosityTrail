'use strict';

/**
 * 人物卡路由。
 *
 *   GET    /api/characters?workId=    人物列表
 *   POST   /api/characters            新建人物
 *   GET    /api/characters/:id        人物详情
 *   PUT    /api/characters/:id        更新人物
 *   DELETE /api/characters/:id        删除人物
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');
const { ownedWork, ownedCharacter } = require('../services/scope');
const memory = require('../services/memory/indexer');

const router = express.Router();
const now = () => new Date().toISOString();

/**
 * relations 允许传数组或 JSON 字符串，统一存成 JSON 字符串。
 */
function normalizeRelations(relations) {
  if (!relations) return '';
  if (typeof relations === 'string') return relations;
  return JSON.stringify(relations);
}

router.get('/', async (req, res) => {
  const { workId } = req.query;
  try {
    const rows = workId
      ? await all(
          `SELECT c.* FROM characters c
           JOIN works w ON w.id = c.work_id
           WHERE c.work_id = ? AND w.user_id = ?
           ORDER BY c.name`,
          [workId, req.userId]
        )
      : await all(
          `SELECT c.* FROM characters c
           JOIN works w ON w.id = c.work_id
           WHERE w.user_id = ?
           ORDER BY c.modified_at DESC`,
          [req.userId]
        );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { workId, name, aliases, role, identity, personality, speech, goal, arc, relations, notes } =
    req.body || {};

  if (!workId) return res.status(400).json({ error: '缺少 workId' });
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '人物姓名不能为空' });
  }

  try {
    const work = await ownedWork(workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO characters
         (id, work_id, name, aliases, role, identity, personality, speech, goal, arc, relations, notes, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workId,
        String(name).trim(),
        aliases || '',
        role || '',
        identity || '',
        personality || '',
        speech || '',
        goal || '',
        arc || '',
        normalizeRelations(relations),
        notes || '',
        ts,
        ts,
      ]
    );

    // 新建的人物卡立刻进记忆库：作者可能马上就让 AI 参考这个人
    memory.scheduleIndex({
      userId: req.userId,
      workId,
      sourceType: 'character',
      sourceId: id,
    });

    res.json(await get('SELECT * FROM characters WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await ownedCharacter(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: '人物不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { name, aliases, role, identity, personality, speech, goal, arc, relations, notes } =
    req.body || {};

  try {
    const existing = await ownedCharacter(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '人物不存在' });

    await run(
      `UPDATE characters SET name = ?, aliases = ?, role = ?, identity = ?, personality = ?,
         speech = ?, goal = ?, arc = ?, relations = ?, notes = ?, modified_at = ?
       WHERE id = ?`,
      [
        name !== undefined ? String(name).trim() : existing.name,
        aliases !== undefined ? aliases : existing.aliases,
        role !== undefined ? role : existing.role,
        identity !== undefined ? identity : existing.identity,
        personality !== undefined ? personality : existing.personality,
        speech !== undefined ? speech : existing.speech,
        goal !== undefined ? goal : existing.goal,
        arc !== undefined ? arc : existing.arc,
        relations !== undefined ? normalizeRelations(relations) : existing.relations,
        notes !== undefined ? notes : existing.notes,
        now(),
        req.params.id,
      ]
    );

    // 档案改了，旧块作废、重新入索引
    memory.scheduleIndex({
      userId: req.userId,
      workId: existing.work_id,
      sourceType: 'character',
      sourceId: req.params.id,
    });

    res.json(await ownedCharacter(req.params.id, req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await ownedCharacter(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '人物不存在' });

    await run('DELETE FROM characters WHERE id = ?', [req.params.id]);

    // 人没了，记忆里的"林昭"也得跟着消失，否则召回会捞到一个空壳人物
    memory.scheduleRemove({
      userId: req.userId,
      sourceType: 'character',
      sourceId: req.params.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
