'use strict';

/**
 * 认证路由：发送验证码 / 登录 / 登出 / 会话查询。
 *
 * 手机号 + 短信验证码，首次登录自动注册（参考 flomo 的极简形式）。
 */

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../database');
const {
  normalizePhone,
  isValidPhone,
  issueLoginCode,
  consumeLoginCode,
  signToken,
  verifyToken,
  cookieOptions,
} = require('../services/auth');
const { loginLimiter, smsLimiter } = require('../middleware/rateLimit');
const { extractToken } = require('../middleware/auth');

const router = express.Router();

/** 发送登录验证码。 */
router.post('/send-code', smsLimiter, async (req, res, next) => {
  const phone = normalizePhone(req.body?.phone);
  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: '请输入正确的手机号' });
  }

  try {
    const result = await issueLoginCode(phone, req.ip);
    // 开发模式下把固定验证码回给前端，省得每次都去翻服务端日志；
    // 生产环境 smsDevMode 恒为 false，这个字段不会出现。
    res.json({
      ok: true,
      devMode: result.devMode,
      devCode: result.devMode ? config.smsDevCode : undefined,
    });
  } catch (err) {
    next(err);
  }
});

/** 登录：校验验证码，首次登录自动创建账号。 */
router.post('/login', loginLimiter, async (req, res, next) => {
  const phone = normalizePhone(req.body?.phone);
  const { code, remember } = req.body || {};

  if (!isValidPhone(phone)) {
    return res.status(400).json({ error: '请输入正确的手机号' });
  }

  try {
    const valid = await consumeLoginCode(phone, code);
    if (!valid) {
      return res.status(401).json({ error: '验证码错误或已过期' });
    }

    const now = new Date().toISOString();
    let user = await db.get(
      'SELECT id, phone, nickname, role FROM users WHERE phone = ?',
      [phone]
    );
    if (!user) {
      user = { id: crypto.randomUUID(), phone, nickname: null, role: 'user' };
      await db.run('INSERT INTO users (id, phone, nickname, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)', [
        user.id,
        user.phone,
        user.nickname,
        now,
        now,
      ]);
    } else {
      await db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [now, user.id]);
    }

    const token = signToken(user.id, Boolean(remember));
    res.cookie(config.sessionCookieName, token, cookieOptions(Boolean(remember)));

    res.json({
      authenticated: true,
      user: { id: user.id, phone: user.phone, nickname: user.nickname, role: user.role },
      expiresInDays: remember ? config.sessionRememberTtlDays : config.sessionTtlDays,
    });
  } catch (err) {
    next(err);
  }
});

/** 登出：清除会话 Cookie。 */
router.post('/logout', (req, res) => {
  res.clearCookie(config.sessionCookieName, { path: '/' });
  res.json({ authenticated: false });
});

/** 会话查询：前端启动时调用，判断是否已登录。 */
router.get('/session', async (req, res) => {
  const payload = verifyToken(extractToken(req));
  if (!payload || !payload.sub) {
    return res.json({ authenticated: false });
  }

  const user = await db.get(
    'SELECT id, phone, nickname, role FROM users WHERE id = ?',
    [payload.sub]
  );
  if (!user) {
    // 用户已被删除，旧 token 不能再代表任何身份
    res.clearCookie(config.sessionCookieName, { path: '/' });
    return res.json({ authenticated: false });
  }

  res.json({ authenticated: true, user });
});

module.exports = router;
