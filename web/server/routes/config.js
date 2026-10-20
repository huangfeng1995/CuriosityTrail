'use strict';

/**
 * 系统配置路由。
 *
 *   GET  /api/config/ai      读取 AI 配置（key 只回传掩码）
 *   PUT  /api/config/ai      更新 AI 配置
 *   POST /api/config/ai/test 测试某个 provider 的连通性
 */

const express = require('express');
const aiConfig = require('../services/aiConfig');
const { createProvider } = require('../services/providers');

const router = express.Router();

router.get('/ai', (req, res) => {
  res.json(aiConfig.getPublicConfig());
});

router.put('/ai', (req, res) => {
  const updates = req.body || {};

  // 前端传空字符串表示"不修改这一项"，避免掩码值被写回覆盖真 key
  const cleaned = { ...updates };
  for (const section of ['deepseek', 'openaiCompat', 'ollama']) {
    if (!cleaned[section]) continue;
    const next = { ...cleaned[section] };
    if ('apiKey' in next && !next.apiKey) delete next.apiKey;
    cleaned[section] = next;
  }

  aiConfig.updateConfig(cleaned);
  res.json(aiConfig.getPublicConfig());
});

router.post('/ai/test', async (req, res) => {
  const { provider } = req.body || {};
  const cfg = aiConfig.getConfig();

  try {
    const instance = createProvider(provider || cfg.provider, cfg[provider || cfg.provider] || {});
    if (!instance.configured) {
      return res.json({ ok: false, detail: '未配置' });
    }
    const status = await instance.checkStatus();
    res.json(status);
  } catch (err) {
    res.status(400).json({ ok: false, detail: err.message });
  }
});

module.exports = router;
