'use strict';

/**
 * 系统配置路由。
 *
 *   GET  /api/config/ai      读取 AI 配置（key 只回传掩码）
 *   PUT  /api/config/ai      更新 AI 配置
 */

const express = require('express');
const aiConfig = require('../services/aiConfig');
const { isAdmin } = require('../services/scope');

const router = express.Router();

router.get('/ai', (req, res) => {
  res.json(aiConfig.getPublicConfig());
});

router.put('/ai', async (req, res) => {
  // 全站共用一份 AI 配置。任何登录用户都能写，等于任何人都能把
  // 所有人的 AI 弄挂；只有管理员能改。
  if (!(await isAdmin(req.userId))) {
    return res.status(403).json({ error: '只有管理员可以修改 AI 配置' });
  }

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

module.exports = router;
