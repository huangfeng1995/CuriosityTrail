'use strict';

/**
 * 写作洞察路由。
 *
 *   GET /api/insights/stats?period=day|week|month|year   聚合写作统计
 *   GET /api/insights/fingerprint                        写作指纹
 *   GET /api/insights/badges                             荣誉徽章
 */

const express = require('express');
const insights = require('../services/insights');

const router = express.Router();

router.get('/stats', async (req, res) => {
  try {
    const result = await insights.getAggregateStats(req.userId, {
      period: req.query.period,
      buckets: req.query.buckets,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/fingerprint', async (req, res) => {
  try {
    res.json(await insights.getFingerprint(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/badges', async (req, res) => {
  try {
    res.json(await insights.getBadges(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
