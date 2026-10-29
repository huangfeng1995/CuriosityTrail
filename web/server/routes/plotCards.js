'use strict';

/**
 * 情节卡路由。
 *
 *   GET    /api/plot-cards/work/:workId            作品的全部卡片
 *   GET    /api/plot-cards/chapter/:chapterId      某章的卡片
 *   POST   /api/plot-cards/work/:workId            新建卡片
 *   PUT    /api/plot-cards/:id                     更新卡片
 *   DELETE /api/plot-cards/:id                     删除卡片
 *   POST   /api/plot-cards/work/:workId/reorder    批量排序
 */

const express = require('express');
const { get } = require('../database');
const plotCards = require('../services/plotCards');
const { ownedWork, ownedChapter, ownedPlotCard } = require('../services/scope');

const router = express.Router();

router.get('/work/:workId', async (req, res) => {
  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    res.json(await plotCards.listCards(req.params.workId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chapter/:chapterId', async (req, res) => {
  try {
    const chapter = await ownedChapter(req.params.chapterId, req.userId);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });

    res.json(await plotCards.listCardsByChapter(req.params.chapterId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/work/:workId', async (req, res) => {
  const { title, chapterId, kind, content, status } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '卡片标题不能为空' });
  }

  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    // 卡片挂到章上时，校验章确实属于这部作品
    if (chapterId) {
      const chapter = await get(
        'SELECT id FROM chapters WHERE id = ? AND work_id = ?',
        [chapterId, req.params.workId]
      );
      if (!chapter) return res.status(400).json({ error: '章节不属于该作品' });
    }

    const card = await plotCards.createCard({
      workId: req.params.workId,
      chapterId,
      title,
      kind,
      content,
      status,
    });
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, kind, content, status, chapterId } = req.body || {};
  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: '卡片标题不能为空' });
  }

  try {
    const existing = await ownedPlotCard(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '卡片不存在' });

    // 换挂章节时同样要校验：不能把卡片挂到别人的章上
    if (chapterId) {
      const chapter = await get(
        'SELECT id FROM chapters WHERE id = ? AND work_id = ?',
        [chapterId, existing.work_id]
      );
      if (!chapter) return res.status(400).json({ error: '章节不属于该作品' });
    }

    const card = await plotCards.updateCard(req.params.id, {
      title,
      kind,
      content,
      status,
      chapterId,
    });
    if (!card) return res.status(404).json({ error: '卡片不存在' });
    res.json(card);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const existing = await ownedPlotCard(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '卡片不存在' });

    const ok = await plotCards.deleteCard(req.params.id);
    if (!ok) return res.status(404).json({ error: '卡片不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/work/:workId/reorder', async (req, res) => {
  const { cardIds } = req.body || {};
  if (!Array.isArray(cardIds)) {
    return res.status(400).json({ error: 'cardIds 必须是数组' });
  }

  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    await plotCards.reorderCards(req.params.workId, cardIds);
    res.json(await plotCards.listCards(req.params.workId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
