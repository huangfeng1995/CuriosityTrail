'use strict';

/**
 * 写作进度路由。
 *
 *   GET /api/progress/:workId      单部作品的写作进度（含每日曲线）
 *   GET /api/progress              所有作品的进度汇总
 */

const express = require('express');
const { get } = require('../database');
const progress = require('../services/progress');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json(await progress.listAllProgress());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:workId', async (req, res) => {
  const { days } = req.query;
  try {
    const work = await get('SELECT id FROM works WHERE id = ?', [req.params.workId]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const result = await progress.getWorkProgress(req.params.workId, { days });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
