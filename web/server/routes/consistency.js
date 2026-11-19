'use strict';

/**
 * 一致性检查路由。
 *
 *   GET  /api/consistency/:workId                         规则层检查（免费、立刻出结果）
 *   POST /api/consistency/:workId/ai                      启动跨章总检（异步任务）
 *   GET  /api/consistency/:workId/ai/:jobId               查询进度与结果
 *   POST /api/consistency/:workId/findings/:id/dismiss    忽略一条结论
 *   POST /api/consistency/:workId/findings/:id/adopt      标记一条结论已采纳
 *
 * 规则层与跨章总检的结论都会落到 consistency_findings：
 * 忽略过的结论重跑不再出现，已采纳的保留状态供面板标记。
 *
 * 跨章总检只发章节摘要，调用次数是个位数，所以仍然走「起任务 + 轮询」，
 * 但不再逐批精读全文。
 */

const crypto = require('crypto');
const express = require('express');
const aiConfig = require('../services/aiConfig');
const { resolveProvider } = require('../services/providers');
const roles = require('../services/roles');
const consistency = require('../services/consistency');
const findingsStore = require('../services/consistencyFindings');
const { ownedWork } = require('../services/scope');

const router = express.Router();

/** 任务保留多久。结果只是给这次检查看的，不需要长期存。 */
const JOB_TTL_MS = 10 * 60 * 1000;

const jobs = new Map();

/** AI 不可用时的提示：说清楚去哪解决，不甩一段堆栈。 */
function friendlyAiError(err) {
  const message = String(err?.message || '');
  if (message.includes('没有可用的 AI provider')) {
    return '没有可用的 AI 服务，请先到设置页配置模型';
  }
  return `AI 检查没有跑起来：${message}`;
}

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

async function runJob(job, plan, ruleIssues) {
  try {
    const cfg = aiConfig.getConfig();
    const { provider, name } = resolveProvider(cfg);
    const role = await roles.getRole('critic', job.userId);

    const result = await consistency.executeAiCheck(plan, {
      provider,
      providerName: name,
      role,
      excludeIssues: ruleIssues,
      onProgress: (done, total) => {
        job.done = done;
        job.total = total;
      },
    });

    // 结论落库后再返回：跨章问题也有 id，前端才能忽略/采纳。
    // 已忽略过的不会出现在返回里，重跑也不会复活。
    const aiIssues = await findingsStore.recordFindings({
      userId: job.userId,
      workId: job.workId,
      source: 'cross_chapter',
      findings: result.issues,
    });

    job.issues = [...ruleIssues, ...aiIssues];
    job.notices = [...job.notices, ...result.notices];
    job.calls = result.calls;
    job.status = 'done';
  } catch (err) {
    job.status = 'failed';
    job.error = friendlyAiError(err);
    job.notices = [...job.notices, job.error];
  } finally {
    const timer = setTimeout(() => jobs.delete(job.jobId), JOB_TTL_MS);
    if (timer.unref) timer.unref();
  }
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

/**
 * 启动跨章总检。
 *
 * 规则层的结果立刻并进任务：作者不用等模型跑完才看到免费的检查项。
 */
router.post('/:workId/ai', async (req, res) => {
  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    // 同一部作品已经有任务在跑：直接复用，避免重复烧模型额度
    const running = [...jobs.values()].find(
      (job) =>
        job.userId === req.userId &&
        job.workId === req.params.workId &&
        job.status === 'running'
    );
    if (running) {
      return res.status(202).json({
        jobId: running.jobId,
        total: running.total,
        done: running.done,
      });
    }

    const ruleIssues = await runRuleFindings(req.userId, req.params.workId);
    const plan = await consistency.planAiCheck(req.params.workId);
    const notices = plan ? [...plan.notices] : [];

    if (!plan || !plan.digests.length) {
      return res.json({
        jobId: '',
        total: 0,
        done: true,
        issues: ruleIssues,
        notices: [...notices, '全书还没有正文，没有可检查的内容。'],
      });
    }

    // 调用次数就是个位数：分组数 + 一次跨组汇总
    const total = plan.calls;
    const job = {
      jobId: crypto.randomUUID(),
      userId: req.userId,
      workId: req.params.workId,
      status: 'running',
      done: 0,
      total,
      calls: 0,
      issues: ruleIssues,
      notices,
      error: '',
    };
    jobs.set(job.jobId, job);

    // 不 await：路由立刻返回任务号，前端轮询进度
    runJob(job, plan, ruleIssues);

    res.status(202).json({ jobId: job.jobId, total, done: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 查询任务进度与结果。
 */
router.get('/:workId/ai/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.userId !== req.userId || job.workId !== req.params.workId) {
    return res.status(404).json({ error: '检查任务不存在或已过期' });
  }

  res.json({
    status: job.status,
    done: job.done,
    total: job.total,
    calls: job.calls,
    issues: job.issues,
    notices: job.notices,
    error: job.error,
  });
});

/**
 * 修改一条结论的状态。
 *
 * 忽略（dismissed）后重跑不再报；采纳（adopted）后保留并带状态，
 * 让面板显示「已处理」。
 */
async function changeFindingStatus(req, res, status) {
  try {
    const work = await ownedWork(req.params.workId, req.userId);
    if (!work) return res.status(404).json({ error: '作品不存在' });

    const finding = await findingsStore.setFindingStatus({
      userId: req.userId,
      workId: req.params.workId,
      id: req.params.findingId,
      status,
    });
    if (!finding) return res.status(404).json({ error: '结论不存在' });

    res.json({ finding });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
}

router.post('/:workId/findings/:findingId/dismiss', (req, res) =>
  changeFindingStatus(req, res, 'dismissed')
);

router.post('/:workId/findings/:findingId/adopt', (req, res) =>
  changeFindingStatus(req, res, 'adopted')
);

module.exports = router;
