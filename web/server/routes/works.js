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
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');
const { ownedWork } = require('../services/scope');
const memory = require('../services/memory/indexer');
const { TEMPLATES } = require('../services/pipeline/gate');

const router = express.Router();

const now = () => new Date().toISOString();

/**
 * 创作模板只接受 ''（未启用）或白名单内的模板名。
 * 不用「任意字符串直写」：拼错一个模板名会让作品静默退回未启用状态。
 */
function isValidTemplate(value) {
  return value === '' || TEMPLATES.has(value);
}

/**
 * 删作品时要显式清空的子表，按「先子后父」排序。
 *
 * 升级库上 PRAGMA foreign_keys 并不总是打开（见 database.js：只有首次建库才开），
 * 不能只靠 ON DELETE CASCADE，否则作品行删了、子表全成孤儿（线上历史孤儿行即由此而来）。
 * 这里列全当前所有带 work_id 的表；新增表必须同步加进来。
 *
 * 顺序约束：
 *   - messages 走 conversations 子查询，必须先于 conversations；
 *   - 引用 chapters 的表（版本/拍表/卡片/提案/写作事件等）必须在 chapters 之前；
 *   - knowledge_matrix / evidence_items 引用 facts 与 characters，
 *     story_facts 引用 story_secrets，setting_risks 引用 work_anchors，
 *     都按先子后父排。
 */
const WORK_CHILD_TABLES = [
  'conversations',
  'anchor_violations',
  'chapter_plans',
  'chapter_versions',
  'plot_cards',
  'card_proposals',
  'knowledge_pending',
  'shape_repairs',
  'writing_events',
  'knowledge_matrix',
  'evidence_items',
  'story_facts',
  'story_secrets',
  'setting_risks',
  'work_anchors',
  'work_blank_areas',
  'characters',
  'settings',
  'style_cards',
  'materials',
  'memory_chunks',
  'consistency_findings',
  // chapters 由 route 最后单独删：上面这些表还引用它
];

/** 消息没有 work_id，按会话归属清理。 */
const WORK_MESSAGES_SQL = `DELETE FROM messages
  WHERE conversation_id IN (SELECT id FROM conversations WHERE work_id = ?)`;

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
       WHERE w.user_id = ?
       ORDER BY w.modified_at DESC`,
      [req.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { title, genre, synopsis, outline, targetWords, template } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '作品标题不能为空' });
  }
  if (template !== undefined && !isValidTemplate(template)) {
    return res.status(400).json({ error: '创作模板取值不合法' });
  }

  try {
    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.userId,
        String(title).trim(),
        genre || '',
        synopsis || '',
        outline || '',
        Number(targetWords) || 0,
        template || '',
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM works WHERE id = ? AND user_id = ?', [id, req.userId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const work = await ownedWork(req.params.id, req.userId);
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
  const { title, genre, synopsis, outline, targetWords, template } = req.body || {};
  if (template !== undefined && !isValidTemplate(template)) {
    return res.status(400).json({ error: '创作模板取值不合法' });
  }
  try {
    const existing = await ownedWork(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '作品不存在' });

    await run(
      `UPDATE works SET title = ?, genre = ?, synopsis = ?, outline = ?, target_words = ?,
         template = ?, modified_at = ?
       WHERE id = ? AND user_id = ?`,
      [
        (title !== undefined ? String(title).trim() : existing.title),
        genre !== undefined ? genre : existing.genre,
        synopsis !== undefined ? synopsis : existing.synopsis,
        outline !== undefined ? outline : existing.outline,
        targetWords !== undefined ? (Number(targetWords) || 0) : existing.target_words,
        template !== undefined ? template : existing.template,
        now(),
        req.params.id,
        req.userId,
      ]
    );
    res.json(await get('SELECT * FROM works WHERE id = ? AND user_id = ?', [req.params.id, req.userId]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const workId = req.params.id;

  try {
    // 必须先确认归属：下面的子表清理按 work_id 删，不校验归属会误删别人的数据
    const work = await ownedWork(workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    // 向量 URI 必须在删除前抓好：台账一删就查不到了。
    // 但入队放到事务提交之后——删除失败回滚时，不能已经把向量清了。
    const memoryUris = (
      await all('SELECT viking_uri FROM memory_chunks WHERE user_id = ? AND work_id = ?', [
        req.userId,
        workId,
      ])
    ).map((row) => row.viking_uri);

    // 一个 savepoint 包住全部清理：任一步失败就整体回滚，绝不允许「删了一半还回 200」。
    // 用 SAVEPOINT 而不是 BEGIN：连接是共享的，外层可能已有记忆索引的事务。
    const savepoint = `delete_work_${crypto.randomUUID().replace(/-/g, '')}`;
    await run(`SAVEPOINT ${savepoint}`);
    try {
      await run(WORK_MESSAGES_SQL, [workId]);
      for (const table of WORK_CHILD_TABLES) {
        await run(`DELETE FROM ${table} WHERE work_id = ?`, [workId]);
      }
      // 章节最后删：上面的表都还引用它
      await run('DELETE FROM chapters WHERE work_id = ?', [workId]);

      const result = await run('DELETE FROM works WHERE id = ? AND user_id = ?', [
        workId,
        req.userId,
      ]);
      if (result.changes !== 1) {
        // 归属刚校验过还删不到，只可能是并发删除；报冲突，不能假装成功。
        const conflict = new Error('作品已被删除或不属于当前用户');
        conflict.status = 409;
        conflict.code = 'WORK_DELETE_CONFLICT';
        throw conflict;
      }

      await run(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (err) {
      await run(`ROLLBACK TO SAVEPOINT ${savepoint}`).catch(() => {});
      await run(`RELEASE SAVEPOINT ${savepoint}`).catch(() => {});
      throw err;
    }

    // 数据库已提交，再清向量；这一步失败不影响删除结果，只记日志。
    try {
      await memory.scheduleRemoveWork({ userId: req.userId, workId, uris: memoryUris });
    } catch (err) {
      console.error(`删除作品后清理向量失败 ${workId}：`, err.message || err);
    }

    res.json({ ok: true });
  } catch (err) {
    const status = Number(err.status) || 500;
    const code = err.code === 'WORK_DELETE_CONFLICT' ? err.code : 'WORK_DELETE_FAILED';
    console.error(`删除作品失败 ${workId}：`, err.message || err);
    res.status(status).json({
      error: status === 409 ? err.message : '删除作品失败，未做任何修改',
      code,
    });
  }
});

// ---------------------------------------------------------------------------
// 章节
// ---------------------------------------------------------------------------

router.get('/:id/chapters', async (req, res) => {
  try {
    const work = await ownedWork(req.params.id, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

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
  const { title, volume, status, outline } = req.body || {};
  try {
    const work = await ownedWork(req.params.id, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const maxRow = await get(
      'SELECT MAX(seq) AS maxSeq FROM chapters WHERE work_id = ?',
      [req.params.id]
    );
    const seq = (maxRow?.maxSeq ?? 0) + 1;

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.params.id,
        (title && String(title).trim()) || `第 ${seq} 章`,
        seq,
        volume || '',
        status || 'draft',
        '',
        JSON.stringify([]),
        outline ? String(outline) : '',
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM chapters WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
