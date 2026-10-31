'use strict';

/**
 * 排空（优雅停机）测试。
 *
 * 这一层直接决定"部署时会不会打断作者正在写的稿子"，
 * 所以要盯住两件事：
 *   1. 在途请求被准确计数（不多不少）
 *   2. 排空期间新请求被明确拒绝，而不是挂在半路
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

const app = require('../app');
const drain = require('../services/drain');
const { ready } = require('../database');

let server;

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('排空：在途请求被计数，请求结束后归零', async () => {
  const before = drain.activeCount();

  const res = await server.request('/api/works');
  assert.strictEqual(res.status, 200);
  // 响应已经回来，计数就该回落了
  await res.json();

  assert.strictEqual(drain.activeCount(), before, '请求结束后计数要归零');
});

test('排空：健康检查不计入在途请求', async () => {
  // Docker 在停机期间一直探健康检查。把它算成"在途请求"，
  // 排空就永远等不到 0，容器只能被 SIGKILL 掉。
  const before = drain.activeCount();
  const res = await server.request('/api/health');
  await res.json();
  assert.strictEqual(drain.activeCount(), before, '健康检查不算在途请求');
});

test('排空：健康检查报告在途请求数', async () => {
  const res = await server.request('/api/health');
  const data = await res.json();

  assert.strictEqual(data.status, 'ok');
  assert.strictEqual(typeof data.activeRequests, 'number');
  assert.strictEqual(typeof data.activeChats, 'number');
  assert.strictEqual(data.draining, false, '平时不在排空');
});

test('排空：进入排空状态后新请求被明确拒绝', async () => {
  drain.beginDrain();

  const res = await server.request('/api/works');
  assert.strictEqual(res.status, 503, '排空期间要拒绝新请求');
  const data = await res.json();
  assert.ok(data.error && data.error.includes('重启'), '错误提示要说明原因');
});

test('排空：健康检查在排空期间仍然放行', async () => {
  // Docker 用健康检查判断容器是不是死了。排空期间它必须继续答，
  // 否则 Docker 会把还在收尾的容器判成 unhealthy。
  const res = await server.request('/api/health');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.draining, true);
});

test('排空：等在途请求收尾', async () => {
  // 前面已进入排空状态，在途计数是 0，应该立刻返回已排空
  const result = await drain.waitForDrain(1000);
  assert.strictEqual(result.drained, true);
  assert.strictEqual(result.active, 0);
});

test('停机记录：写入后能读回来', () => {
  // 容器日志会随重建消失，这个记录是"上次停机有没有打断作者的稿子"
  // 唯一可靠的答案来源，所以必须真的落到数据目录里。
  drain.writeRecord({
    signal: 'SIGTERM',
    startedAt: '2026-10-31T00:00:00.000Z',
    pendingRequests: 2,
    pendingChats: 1,
    drained: true,
  });

  const record = drain.readRecord();
  assert.ok(record, '要能读回记录');
  assert.strictEqual(record.signal, 'SIGTERM');
  assert.strictEqual(record.pendingRequests, 2);
  assert.strictEqual(record.pendingChats, 1);
  assert.strictEqual(record.drained, true);

  const file = path.join(env.dataDir, 'last-shutdown.json');
  assert.ok(fs.existsSync(file), '记录文件要真的在数据目录里');
});

test('停机记录：读不到记录时返回 null 而不是抛错', () => {
  // 首次部署、文件被删、文件写坏了——都应该是"没有记录"，不能把健康检查搞挂
  const original = path.join(env.dataDir, 'last-shutdown.json');
  const backup = fs.existsSync(original) ? fs.readFileSync(original) : null;
  fs.writeFileSync(original, '{ 这不是合法 JSON');
  assert.strictEqual(drain.readRecord(), null);

  if (backup) fs.writeFileSync(original, backup);
});

test('停机记录：健康检查能查到上次停机的结果', async () => {
  drain.writeRecord({
    signal: 'SIGTERM',
    startedAt: '2026-10-31T00:00:00.000Z',
    finishedAt: '2026-10-31T00:00:05.000Z',
    pendingRequests: 3,
    pendingChats: 1,
    drained: false,
    remaining: 2,
  });

  const res = await server.request('/api/health');
  const data = await res.json();

  assert.ok(data.lastShutdown, '健康检查要暴露上次停机记录');
  assert.strictEqual(data.lastShutdown.pendingRequests, 3);
  assert.strictEqual(data.lastShutdown.drained, false);
});
