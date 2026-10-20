'use strict';

/**
 * 章节路由（独立于作品路由，因为章节操作都以 chapterId 为入口）。
 *
 *   GET    /api/chapters/:id            章节详情
 *   PUT    /api/chapters/:id            更新章节（blocks 为权威数据）
 *   DELETE /api/chapters/:id            删除章节
 */

const express = require('express');
const { get, run } = require('../database');

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

router.get('/:id', async (req, res) => {
  try {
    const chapter = await get('SELECT * FROM chapters WHERE id = ?', [req.params.id]);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });
    res.json(chapter);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, volume, status, blocks, content } = req.body || {};

  try {
    const existing = await get('SELECT * FROM chapters WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '章节不存在' });

    // blocks 存在时以 blocks 为准，content 是派生快照
    let nextContent = existing.content;
    let nextBlocks = existing.blocks;
    if (Array.isArray(blocks)) {
      nextBlocks = JSON.stringify(blocks);
      nextContent = deriveContent(blocks);
    } else if (typeof content === 'string') {
      nextContent = content;
    }

    await run(
      `UPDATE chapters SET title = ?, volume = ?, status = ?, content = ?, blocks = ?, modified_at = ?
       WHERE id = ?`,
      [
        title !== undefined ? String(title).trim() : existing.title,
        volume !== undefined ? volume : existing.volume,
        status !== undefined ? status : existing.status,
        nextContent,
        nextBlocks,
        now(),
        req.params.id,
      ]
    );
    res.json(await get('SELECT * FROM chapters WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await run('DELETE FROM chapters WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: '章节不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
