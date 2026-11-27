'use strict';

/**
 * 一致性检查路由。
 *
 *   GET /api/consistency/:workId   规则层检查（免费、立刻出结果）
 *
 * 规则层的结论会落到 consistency_findings，已忽略的结论重跑不再出现。
 */

const express = require('express');
const consistency = require('../services/consistency');
const findingsStore = require('../services/consistencyFindings');
const { ownedWork } = require('../services/scope');

const router = express.Router();

/**
 * 跑规则层并把结论落库。
 *
 * 返回的清单已经过滤掉「已忽略」的结论；已采纳的保留并带 status，
 * 让面板能标出来。
 */
async function runRuleFindings(userId, workId) {
  const issues = await consistency.runRuleChecks(workId);
  return findingsStore.recordFindings({
    userId,
    workId,
    source: 'rule',
    findings: issues,
  });
}

/**
 * 规则层检查。
 */
router.get('/:workId', async (req, res) => {
  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const issues = await runRuleFindings(req.userId, req.params.workId);
    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
