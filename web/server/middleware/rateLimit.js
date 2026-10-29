'use strict';

/**
 * 限流中间件。
 *
 * 三档限制：
 *  - 登录：10 次 / 15 分钟，防验证码爆破
 *  - 发验证码：10 次 / 15 分钟，防短信轰炸
 *  - AI 调用：60 次 / 分钟，防脚本刷爆 API 额度
 *  - 全局 API：300 次 / 15 分钟，防一般滥用
 *
 * 按 IP 计数。Fly.io 部署时请求经平台代理到达，需信任代理以拿到真实客户端 IP。
 */

const rateLimit = require('express-rate-limit');

/** 统一的限流响应格式。 */
function handler(req, res) {
  res.status(429).json({
    error: '请求过于频繁，请稍后再试',
    retryAfter: Math.ceil((req.rateLimit?.resetTime || Date.now()) / 1000),
  });
}

const common = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
};

/** 登录限流：每 IP 每 15 分钟 10 次。 */
const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

/** 发送验证码限流：每 IP 每 15 分钟 10 次。 */
const smsLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

/** AI 调用限流：每 IP 每分钟 60 次。 */
const aiLimiter = rateLimit({
  ...common,
  windowMs: 60 * 1000,
  limit: 60,
});

/** 全局 API 限流：每 IP 每 15 分钟 300 次。 */
const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 300,
});

module.exports = { loginLimiter, smsLimiter, aiLimiter, apiLimiter };
