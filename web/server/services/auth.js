'use strict';

/**
 * 鉴权服务：密码校验与 JWT 会话签发。
 *
 * 密码使用 Node 内置 crypto.scrypt 派生，不引入 bcrypt。
 * 校验时对派生值做定长比较，避免时序侧信道。
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const KEY_LEN = 64;

/**
 * 用 scrypt 派生密码校验值。
 * @param {string} password 明文密码
 * @param {string} salt 盐
 * @returns {Buffer} 派生值
 */
function derive(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN);
}

/**
 * 校验明文密码是否与配置中的密码一致。
 * @param {string} candidate 用户提交的密码
 * @returns {boolean}
 */
function verifyPassword(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  try {
    const expected = derive(config.appPassword, config.appPasswordSalt);
    const actual = derive(candidate, config.appPasswordSalt);
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}

/**
 * 签发会话 token。
 * @param {boolean} remember 是否记住我（延长有效期）
 * @returns {string} JWT
 */
function signToken(remember = false) {
  const days = remember ? config.sessionRememberTtlDays : config.sessionTtlDays;
  return jwt.sign({ role: 'owner' }, config.jwtSecret, { expiresIn: `${days}d` });
}

/**
 * 校验会话 token。
 * @param {string} token
 * @returns {object|null} payload，非法时返回 null
 */
function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return null;
  }
}

/**
 * 计算会话 Cookie 的选项。
 * @param {boolean} remember
 * @returns {object} express res.cookie 选项
 */
function cookieOptions(remember = false) {
  const maxAge = (remember ? config.sessionRememberTtlDays : config.sessionTtlDays) * 24 * 60 * 60 * 1000;
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge,
    path: '/',
  };
}

module.exports = { verifyPassword, signToken, verifyToken, cookieOptions };
