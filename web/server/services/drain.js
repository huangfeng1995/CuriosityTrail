'use strict';

/**
 * 排空（优雅停机）。
 *
 * 部署重建容器时会发 SIGTERM。默认的 Node 行为是立刻退出，
 * 在途的 SSE 流会被掐断——作者看到的是一句 network error，
 * 写了半章的东西全丢。
 *
 * 这里做四件事：
 *   1. 统计在途请求（尤其是 /api/ai/chat 的长连接）
 *   2. 收到 SIGTERM 后进入 draining 状态：新请求立刻被拒，
 *      告诉作者"服务正在重启"，而不是让它挂在半路
 *   3. 等在途请求收尾，最多等 SHUTDOWN_GRACE_MS，超时再硬退
 *   4. 把停机结果写进 DATA_DIR/last-shutdown.json
 *
 * 为什么"拒绝新请求"而不是"让它们进来"：
 * 排空期间新进来的生成请求大概率也等不到结果（容器马上就没了），
 * 让作者等一个注定失败的生成比立刻告诉他更糟。
 *
 * 为什么要落盘而不是只打日志：
 * 容器日志会随容器重建一起消失，而且停机那一刻的输出还可能丢。
 * 但"上一次部署有没有打断作者的稿子"是个必须能回答的问题——
 * 运维要看的是"上次停机时在途请求数是几、排空成功没有"，
 * 这得有个跨容器存活的记录。
 */

const fs = require('fs');
const path = require('path');

const config = require('../config');

let activeRequests = 0;
let activeChats = 0;
let draining = false;

/** 停机记录文件名（放在数据目录，容器重建后仍在）。 */
const RECORD_FILE = 'last-shutdown.json';

/**
 * 统计在途请求的中间件。
 *
 * 挂在 app 最前面（鉴权之前），这样连未登录的请求也算在内——
 * 排空时任何没关掉的连接都可能占着资源。
 */
function track(req, res, next) {
  // 健康检查不算在内：Docker 在停机期间还在每 30 秒探一次，
  // 把它算成"在途请求"会让排空永远等不到 0。
  const isHealth = req.path === '/api/health';
  const isChat = req.path === '/api/ai/chat';

  if (!isHealth) activeRequests += 1;
  if (isChat) activeChats += 1;

  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    if (!isHealth) activeRequests -= 1;
    if (isChat) activeChats -= 1;
  };
  // finish 与 close 可能都来（正常结束只触发 finish，客户端断开触发 close），
  // 但只能算一次账，所以用 settled 兜住
  res.on('finish', settle);
  res.on('close', settle);

  next();
}

/** 当前在途请求数。 */
function activeCount() {
  return activeRequests;
}

/** 当前在途的 AI 对话数。 */
function activeChatCount() {
  return activeChats;
}

/** 是否已进入排空状态。 */
function isDraining() {
  return draining;
}

/**
 * 进入排空状态。
 *
 * 之后所有新请求都会被 middleware 挡下并收到一句明确的中文提示。
 */
function beginDrain() {
  draining = true;
}

/**
 * 等在途请求收尾。
 *
 * @param {number} timeoutMs 最多等多久（毫秒）
 * @returns {Promise<{drained: boolean, active: number}>}
 *   drained 为 false 表示超时了，还有请求没收尾
 */
function waitForDrain(timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (activeRequests === 0) {
        resolve({ drained: true, active: 0 });
        return;
      }
      if (Date.now() >= deadline) {
        resolve({ drained: false, active: activeRequests });
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

/**
 * 排空中间件：排空期间的新请求一律拒掉。
 *
 * 返回 503 + 一句人话。作者看到"服务正在重启，稍等再试"，
 * 比看到一个空的报错框知道该怎么做。
 */
function rejectDuringDrain(req, res, next) {
  if (!draining) return next();
  res.status(503).json({ error: '服务正在重启，请稍后再试（已写好的内容不会丢）' });
}

/**
 * 写停机记录。
 *
 * 用 writeFileSync + rename：rename 是原子的，
 * 不会出现"读到半个 JSON"的情况（读的人可能是另一个容器）。
 *
 * @param {Object} detail 记录内容
 */
function writeRecord(detail) {
  try {
    const dir = config.dataDir;
    const target = path.join(dir, RECORD_FILE);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(detail, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    // 记录写不进去也不能影响停机本身
  }
}

/**
 * 读上一次的停机记录。
 *
 * @returns {Object|null}
 */
function readRecord() {
  try {
    const file = path.join(config.dataDir, RECORD_FILE);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = {
  track,
  activeCount,
  activeChatCount,
  isDraining,
  beginDrain,
  waitForDrain,
  rejectDuringDrain,
  writeRecord,
  readRecord,
};
