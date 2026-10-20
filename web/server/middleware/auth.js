'use strict';

/**
 * 鉴权中间件。
 *
 * requireAuth 保护所有业务 API；未携带有效会话 Cookie 时返回 401。
 * /api/health 与 /api/auth/login 由 index.js 显式排除。
 */

const config = require('../config');
const { verifyToken } = require('../services/auth');

/**
 * 从请求中提取会话 token。
 * 优先读 Cookie（浏览器场景），同时兼容 Authorization: Bearer（脚本场景）。
 */
function extractToken(req) {
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${config.sessionCookieName}=`));
    if (match) {
      return decodeURIComponent(match.slice(config.sessionCookieName.length + 1));
    }
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

/** 校验会话，未通过返回 401。 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
  req.user = payload;
  next();
}

module.exports = { requireAuth, extractToken };
