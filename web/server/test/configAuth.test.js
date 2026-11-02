'use strict';

/**
 * AI 配置写入的权限测试。
 *
 * 全站共用一份 AI 配置，key 改坏了所有人的 AI 都会挂。
 * 所以 PUT /api/config/ai 必须是管理员专属，普通登录用户一律 403。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer, createUser } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR——config.js 在加载时就把它定死了
const env = setupTempEnv();

const app = require('../app');
const { ready } = require('../database');

let server;

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  await server.close();
  env.cleanup();
});

test('普通登录用户修改 AI 配置：403，且配置没有被改动', async () => {
  const res = await server.request('/api/config/ai', {
    method: 'PUT',
    body: { deepseek: { temperature: 0.99 } },
  });

  assert.strictEqual(res.status, 403, '普通用户不能改全站 AI 配置');
  const body = await res.json();
  assert.ok(body.error, '应给出可读的错误');

  // 拒绝必须发生在写入之前，而不是"写完了再报错"
  const current = await server.request('/api/config/ai');
  const config = await current.json();
  assert.notStrictEqual(config.deepseek.temperature, 0.99, '被拒绝的请求不能留下任何改动');
});

test('管理员修改 AI 配置：正常生效', async () => {
  const admin = await createUser({ phone: '13900000009', role: 'admin' });
  const cookie = await server.loginAs(admin.phone);

  const res = await server.requestAs(cookie, '/api/config/ai', {
    method: 'PUT',
    body: { deepseek: { temperature: 0.95 } },
  });

  assert.strictEqual(res.status, 200, '管理员应能正常修改');
  const body = await res.json();
  assert.strictEqual(body.deepseek.temperature, 0.95, '改动应当生效');
});
