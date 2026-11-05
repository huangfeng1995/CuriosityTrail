'use strict';

/**
 * 一致性检查路由。
 *
 *   GET  /api/consistency/:workId                规则层检查（免费、立刻出结果）
 *   POST /api/consistency/:workId/ai             启动 AI 全书检查（异步任务）
 *   GET  /api/consistency/:workId/ai/:jobId      查询进度与结果
 *
 * 全书检查要逐批读完整本正文，一次几分钟很正常——同步接口会撞上
 * 网关与浏览器的超时，所以改成「起任务 + 轮询」。
 */

const crypto = require('crypto');
const express = require('express');
const aiConfig = require('../services/aiConfig');
const { resolveProvider } = require('../services/providers');
const roles = require('../services/roles');
const consistency = require('../services/consistency');
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

async function runJob(job, plan) {
  try {
    const cfg = aiConfig.getConfig();
    const { provider, name } = resolveProvider(cfg);
    const role = await roles.getRole('critic', job.userId);

    const result = await consistency.executeAiCheck(plan, {
      provider,
      providerName: name,
      role,
      onProgress: (done, total) => {
        job.done = done;
        job.total = total;
      },
    });

    job.issues = [...job.issues, ...result.issues];
    job.notices = [...job.notices, ...result.notices];
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

    const issues = await consistency.runRuleChecks(req.params.workId);
    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 启动 AI 全书检查。
 *
 * 规则层的结果立刻并进任务：作者不用等几分钟才看到免费的检查项。
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

    const ruleIssues = await consistency.runRuleChecks(req.params.workId);
    const plan = await consistency.planAiCheck(req.params.workId);
    const notices = plan ? [...plan.notices] : [];

    if (!plan || !plan.batches.length) {
      return res.json({
        jobId: '',
        total: 0,
        done: true,
        issues: ruleIssues,
        notices: [...notices, '全书还没有正文，没有可检查的内容。'],
      });
    }

    const total = plan.batches.length + (plan.batches.length > 1 ? 1 : 0);
    const job = {
      jobId: crypto.randomUUID(),
      userId: req.userId,
      workId: req.params.workId,
      status: 'running',
      done: 0,
      total,
      issues: ruleIssues,
      notices,
      error: '',
    };
    jobs.set(job.jobId, job);

    // 不 await：路由立刻返回任务号，前端轮询进度
    runJob(job, plan);

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
    issues: job.issues,
    notices: job.notices,
    error: job.error,
  });
});

module.exports = router;
