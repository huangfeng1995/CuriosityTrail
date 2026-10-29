'use strict';

/**
 * 鉴权服务：手机验证码登录与会话签发。
 *
 * 登录方式参考 flomo：填手机号 → 收验证码 → 首次登录自动注册。
 * 没有密码、没有邮箱，账号就是手机号。
 *
 * 验证码只存 HMAC 哈希（密钥用 JWT secret），库文件泄露也无法直接登录。
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');
const sms = require('./sms');

const CODE_LENGTH = 6;
const CODE_MAX_ATTEMPTS = 5;

/**
 * 规范化手机号：去掉空格/横线，接受 +86 前缀。
 * @param {string} input
 * @returns {string}
 */
function normalizePhone(input) {
  if (typeof input !== 'string') return '';
  const digits = input.replace(/\D/g, '');
  return digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
}

/**
 * 是否为中国大陆手机号。
 * @param {string} phone
 * @returns {boolean}
 */
function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(phone);
}

/**
 * 验证码哈希。绑定手机号，避免同一个码跨账号使用。
 * @param {string} phone
 * @param {string} code
 * @returns {string}
 */
function hashCode(phone, code) {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${phone}:${code}`).digest('hex');
}

/**
 * 生成并发送登录验证码。
 *
 * @param {string} phone 已规范化的手机号
 * @param {string} ip 请求方 IP（仅记录，便于排查滥用）
 * @returns {Promise<{devMode: boolean}>}
 */
async function issueLoginCode(phone, ip) {
  const now = Date.now();

  const recent = await db.get(
    'SELECT created_at FROM login_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1',
    [phone]
  );
  if (recent) {
    const elapsed = (now - new Date(recent.created_at).getTime()) / 1000;
    if (elapsed < config.smsResendSeconds) {
      const err = new Error(`发送太频繁，请 ${Math.ceil(config.smsResendSeconds - elapsed)} 秒后再试`);
      err.status = 429;
      throw err;
    }
  }

  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM login_codes WHERE phone = ? AND created_at > ?',
    [phone, dayAgo]
  );
  if (count >= config.smsDailyLimit) {
    const err = new Error('今日验证码发送次数已达上限，请明天再试');
    err.status = 429;
    throw err;
  }

  // 开发模式使用固定验证码，不真的发短信（生产环境该开关无效）
  const code = config.smsDevMode
    ? config.smsDevCode
    : String(crypto.randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');

  await db.run(
    `INSERT INTO login_codes (id, phone, code_hash, expires_at, attempts, consumed, ip, created_at)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    [
      crypto.randomUUID(),
      phone,
      hashCode(phone, code),
      new Date(now + config.smsCodeTtlMinutes * 60 * 1000).toISOString(),
      ip || null,
      new Date(now).toISOString(),
    ]
  );

  if (config.smsDevMode) {
    console.log(`[dev] 手机号 ${phone} 的登录验证码：${code}`);
    return { devMode: true };
  }

  await sms.sendLoginCode(phone, code);

  // 顺手清理一天前就过期的验证码，避免表无限增长
  await db.run('DELETE FROM login_codes WHERE expires_at < ?', [
    new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  ]);

  return { devMode: false };
}

/**
 * 校验并消费验证码。校验通过后该码立即失效，不能重复使用。
 *
 * @param {string} phone
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function consumeLoginCode(phone, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;

  const row = await db.get(
    `SELECT * FROM login_codes
     WHERE phone = ? AND consumed = 0
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  if (!row) return false;
  if (row.attempts >= CODE_MAX_ATTEMPTS) return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;

  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = Buffer.from(hashCode(phone, code), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await db.run('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    return false;
  }

  await db.run('UPDATE login_codes SET consumed = 1 WHERE id = ?', [row.id]);
  return true;
}

/**
 * 签发会话 token。
 * @param {string} userId 用户 id
 * @param {boolean} remember 是否记住我（延长有效期）
 * @returns {string} JWT
 */
function signToken(userId, remember = false) {
  const days = remember ? config.sessionRememberTtlDays : config.sessionTtlDays;
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: `${days}d` });
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
  const maxAge =
    (remember ? config.sessionRememberTtlDays : config.sessionTtlDays) * 24 * 60 * 60 * 1000;
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge,
    path: '/',
  };
}

module.exports = {
  normalizePhone,
  isValidPhone,
  issueLoginCode,
  consumeLoginCode,
  signToken,
  verifyToken,
  cookieOptions,
};
