'use strict';

/**
 * 灵感方向路由的边界校验。
 *
 * 生成本身由 inspirationPrompts.test.js 用假 provider 覆盖；
 * 这里只测权限与参数，避免测试环境真的去打线上模型。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

const app = require('../app');
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

test('GET /api/inspirations/suggestions/options 返回六维清单', async () => {
  const res = await server.request('/api/inspirations/suggestions/options');
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.dimensions.length, 6);
  assert.strictEqual(body.defaultCount, 2);
  assert.ok(body.dimensions.every((d) => d.key && d.label && d.description));
});

test('POST /api/inspirations/suggestions 缺少 workId 返回 400', async () => {
  const res = await server.request('/api/inspirations/suggestions', {
    method: 'POST',
    body: { dimension: 'conflict' },
  });
  assert.strictEqual(res.status, 400);
});

test('POST /api/inspirations/suggestions 不能读别人的作品', async () => {
  const otherCookie = await server.loginAs('13900000002');
  const workRes = await server.requestAs(otherCookie, '/api/works', {
    method: 'POST',
    body: { title: '别人的作品' },
  });
  assert.strictEqual(workRes.status, 200);
  const otherWork = await workRes.json();

  const res = await server.request('/api/inspirations/suggestions', {
    method: 'POST',
    body: { workId: otherWork.id, dimension: 'conflict' },
  });
  assert.strictEqual(res.status, 404);
});

test('POST /api/inspirations/suggestions 拒绝不属于该作品的章节', async () => {
  const workRes = await server.request('/api/works', {
    method: 'POST',
    body: { title: '我的作品' },
  });
  const work = await workRes.json();

  const otherCookie = await server.loginAs('13900000003');
  const otherWorkRes = await server.requestAs(otherCookie, '/api/works', {
    method: 'POST',
    body: { title: '另一部作品' },
  });
  const otherWork = await otherWorkRes.json();
  const otherChapterRes = await server.requestAs(
    otherCookie,
    `/api/works/${otherWork.id}/chapters`,
    { method: 'POST', body: { title: '别人的章节' } }
  );
  const otherChapter = await otherChapterRes.json();

  const res = await server.request('/api/inspirations/suggestions', {
    method: 'POST',
    body: { workId: work.id, chapterId: otherChapter.id, dimension: 'conflict' },
  });
  assert.strictEqual(res.status, 404);
});
