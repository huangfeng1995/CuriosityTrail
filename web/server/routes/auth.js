'use strict';

/**
 * 认证路由：登录 / 登出 / 会话查询。
 *
 * 单用户模型——没有注册、没有多账号，所有人共用一个密码。
 */

const express = require('express');
const config = require('../config');
const { verifyPassword, signToken, verifyToken, cookieOptions } = require('../services/auth');
const { loginLimiter } = require('../middleware/rateLimit');

const router = express.Router();

/** 登录：校验密码并下发会话 Cookie。 */
router.post('/login', loginLimiter, (req, res) => {
  const { password, remember } = req.body || {};

  if (!verifyPassword(password)) {
    return res.status(401).json({ error: '密码错误' });
  }

  const token = signToken(Boolean(remember));
  res.cookie(config.sessionCookieName, token, cookieOptions(Boolean(remember)));

  res.json({
    authenticated: true,
    expiresInDays: remember ? config.sessionRememberTtlDays : config.sessionTtlDays,
  });
});

/** 登出：清除会话 Cookie。 */
router.post('/logout', (req, res) => {
  res.clearCookie(config.sessionCookieName, { path: '/' });
  res.json({ authenticated: false });
});

/** 会话查询：前端启动时调用，判断是否已登录。 */
router.get('/session', (req, res) => {
  const token =
    req.cookies?.[config.sessionCookieName] ||
    (req.headers.cookie || '')
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${config.sessionCookieName}=`))
      ?.split('=')
      .slice(1)
      .join('=');

  const payload = verifyToken(token);
  if (!payload) {
    return res.json({ authenticated: false });
  }

  res.json({ authenticated: true });
});

module.exports = router;
