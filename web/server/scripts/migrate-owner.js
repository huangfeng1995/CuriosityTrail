'use strict';

/**
 * 老数据认领脚本（单用户 → 多用户迁移的最后一步）。
 *
 *   node scripts/migrate-owner.js 13800138000
 *
 * 作用：
 *   1. 把该手机号建成账号（已存在则复用），并设为管理员；
 *   2. 把所有 user_id 为空的老数据挂到这个账号上。
 *
 * 为什么是脚本而不是自动迁移：上线那一刻还没有任何账号，
 * 自动塞给"第一个注册的人"是危险的——用户可能会用别的手机号先登录。
 * 由部署者显式指定手机号，才能保证数据不会挂错人。
 *
 * 幂等：重复执行不会重复改数据，也不会覆盖已经归属别人的数据。
 */

const crypto = require('crypto');
const { ready, get, run } = require('../database');
const { normalizePhone, isValidPhone } = require('../services/auth');

/** 直接带 user_id 的业务表。 */
const USER_SCOPED_TABLES = [
  'works',
  'materials',
  'inspirations',
  'conversations',
  'prompt_overrides',
];

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('用法：node scripts/migrate-owner.js <手机号>');
    process.exit(1);
  }

  const phone = normalizePhone(raw);
  if (!isValidPhone(phone)) {
    console.error(`手机号不合法：${raw}`);
    process.exit(1);
  }

  await ready;

  // 找账号或建账号
  let user = await get('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(
      `INSERT INTO users (id, phone, nickname, role, created_at, last_login_at)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
      [id, phone, '作者', now, now]
    );
    user = await get('SELECT * FROM users WHERE id = ?', [id]);
    console.log(`已创建账号：${phone}`);
  } else {
    await run(`UPDATE users SET role = 'admin' WHERE id = ?`, [user.id]);
    console.log(`已复用账号：${phone}`);
  }

  // 认领老数据：只动 user_id 为 NULL 或空串的行
  const summary = [];
  for (const table of USER_SCOPED_TABLES) {
    const before = await get(
      `SELECT COUNT(*) AS n FROM ${table} WHERE user_id IS NULL OR user_id = ''`
    );
    if (!before?.n) {
      summary.push(`${table}: 0`);
      continue;
    }

    await run(
      `UPDATE ${table} SET user_id = ? WHERE user_id IS NULL OR user_id = ''`,
      [user.id]
    );
    summary.push(`${table}: ${before.n}`);
  }

  console.log('已认领数据：' + summary.join('，'));
  console.log(`账号 ${phone} 已设为管理员（可整库备份/恢复）。`);
}

main().catch((err) => {
  console.error('迁移失败：', err.message);
  process.exit(1);
});
