'use strict';

/**
 * 长期记忆路由。
 *
 *   GET    /api/memory/status       记忆服务与索引状态
 *   GET    /api/memory/stats        索引统计（已索引/待处理/失败）
 *   POST   /api/memory/rebuild      重建索引
 *   POST   /api/memory/search       手动检索（调试用）
 */

const express = require('express');

const client = require('../services/memory/client');
const indexer = require('../services/memory/indexer');
const retriever = require('../services/memory/retriever');
const { ownedWork, isAdmin } = require('../services/scope');

const router = express.Router();

/**
 * GET /api/memory/status
 *
 * 前端设置页用它显示"记忆服务是否在跑"和"索引是否健康"。
 */
router.get('/status', async (req, res) => {
  try {
    const health = await client.health();
    const consistency = await indexer.checkMetaConsistency(req.userId);
    const stats = await indexer.stats(req.userId);

    res.json({
      enabled: client.isEnabled(),
      serviceRunning: Boolean(health),
      model: health ? health.model : '',
      dim: health ? health.dim : 0,
      indexConsistent: consistency.ok,
      consistencyReason: consistency.reason,
      stats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memory/stats
 */
router.get('/stats', async (req, res) => {
  try {
    res.json(await indexer.stats(req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/rebuild
 *
 * body: { workId?, scope?: 'mine' | 'all' }
 * scope=all 只有管理员能用。
 */
router.post('/rebuild', async (req, res) => {
  const { workId, scope = 'mine' } = req.body || {};

  try {
    if (scope === 'all') {
      if (!(await isAdmin(req.userId))) {
        return res.status(403).json({ error: '只有管理员可以重建全部索引' });
      }
      // 重建全站，不是只重建管理员自己的。
      // 换 embedding 模型时维度对不上的旧向量散在每个用户名下，
      // 只重建自己那份，其他用户的索引仍然是坏的。
      const result = await indexer.rebuildAll();
      return res.json(result);
    }

    if (workId) {
      const work = await ownedWork(workId, req.userId);
      if (!work) return res.status(404).json({ error: '作品不存在' });
      const result = await indexer.rebuild({ userId: req.userId, workId });
      return res.json(result);
    }

    const result = await indexer.rebuild({ userId: req.userId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/memory/search
 *
 * body: { workId, query, limit? }
 * 调试用：让作者能直接看到"记忆库现在能召回什么"。
 */
router.post('/search', async (req, res) => {
  const { workId, query, limit } = req.body || {};

  if (!workId) return res.status(400).json({ error: '缺少 workId' });
  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: '检索内容不能为空' });
  }

  try {
    const work = await ownedWork(workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const result = await retriever.retrieve({
      userId: req.userId,
      workId,
      query: String(query),
      limit,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
