'use strict';

/**
 * 联网检索路由（作者手动触发）。
 *
 *   GET  /api/search/web?q=…&count=…   联网搜索，返回带 url 的结果
 *   POST /api/search/fetch  { url }     抓取某个网页的正文
 *
 * AI 对话里已经会自动联网检索（见 routes/ai.js 的 runRetrieval）。
 * 这里给作者一个手动入口：他想找某个具体的东西时，不用先跟 AI 聊一轮。
 */

const express = require('express');
const webSearch = require('../services/search/deepseekSearch');

const router = express.Router();

router.get('/web', async (req, res) => {
  const { q, count } = req.query;
  if (!q || !String(q).trim()) {
    return res.json({ items: [], reason: '' });
  }

  const result = await webSearch.search(String(q), {
    count: Math.min(Number(count) || 8, 20),
  });

  res.json({ items: result.items, reason: result.reason });
});

router.post('/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: '缺少 url' });
  }

  const result = await webSearch.fetchPage(String(url));
  res.json(result);
});

module.exports = router;
