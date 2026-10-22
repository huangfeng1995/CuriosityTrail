'use strict';

/**
 * 一致性检查路由。
 *
 *   GET  /api/consistency/:workId          规则层检查（免费、立刻出结果）
 *   POST /api/consistency/:workId          规则层 + AI 层
 */

const express = require('express');
const { get } = require('../database');
const aiConfig = require('../services/aiConfig');
const { resolveProvider } = require('../services/providers');
const roles = require('../services/roles');
const consistency = require('../services/consistency');

const router = express.Router();

/**
 * 规则层检查。
 */
router.get('/:workId', async (req, res) => {
  try {
    const work = await get('SELECT id FROM works WHERE id = ?', [req.params.workId]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const issues = await consistency.runRuleChecks(req.params.workId);
    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 规则层 + AI 层。
 *
 * AI 层失败不整个请求失败——规则层的结果照样返回，
 * 并在 notice 里说明 AI 那部分没跑成。
 */
router.post('/:workId', async (req, res) => {
  try {
    const work = await get('SELECT id FROM works WHERE id = ?', [req.params.workId]);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const issues = await consistency.runRuleChecks(req.params.workId);
    const notices = [];

    let aiIssues = [];
    try {
      const cfg = aiConfig.getConfig();
      const { provider, name } = resolveProvider(cfg);
      const role = await roles.getRole('critic');

      aiIssues = await consistency.runAiCheck(req.params.workId, {
        provider,
        providerName: name,
        role,
      });

      if (aiIssues.length) {
        issues.push(...aiIssues);
      }
    } catch (err) {
      // 没有可用 provider、没配 key、请求超时——都不该让规则层结果作废
      notices.push('AI 语义检查未完成：' + err.message);
    }

    res.json({ issues, notices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
