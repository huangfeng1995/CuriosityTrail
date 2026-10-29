'use strict';

/**
 * 写作进度路由。
 *
 *   GET /api/progress/:workId      单部作品的写作进度（含每日曲线）
 *   GET /api/progress              当前用户所有作品的进度汇总
 */

const express = require('express');
const progress = require('../services/progress');
const { ownedWork } = require('../services/scope');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json(await progress.listAllProgress(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:workId', async (req, res) => {
  const { days } = req.query;
  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const result = await progress.getWorkProgress(req.params.workId, { days });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
