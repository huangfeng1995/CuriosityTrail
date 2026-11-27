'use strict';

/**
 * HP2：锚点库状态流转与归属校验。
 *
 * 重点覆盖：
 *   activate / reject 只允许合法流转
 *   非本人作品 / 模板未启用 均 404
 *   删作品后流水线子表无残留
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let app;
let server;
let anchorSeq = 0;

async function createWork(body = {}) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: '锚点测试作品', template: 'history_thriller', ...body },
  });
  assert.strictEqual(res.status, 200, '建作品应成功');
  return res.json();
}

async function seedAnchor(workId, overrides = {}) {
  const row = {
    id: `anchor-${(anchorSeq += 1)}`,
    work_id: workId,
    kind: 'person',
    subject: '曹操',
    claim: '曹操卒于建安二十五年正月',
    confidence: 'inferable',
    source_title: '三国志',
    source_locator: null,
    source_quote: null,
    rules: JSON.stringify([{ rule_type: 'manual_only', params: {} }]),
    immutable: 1,
    source_material_id: '',
    status: 'pending',
    created_at: TS,
    modified_at: TS,
    ...overrides,
  };
  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, source_title, source_locator,
        source_quote, rules, immutable, source_material_id, status, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.work_id,
      row.kind,
      row.subject,
      row.claim,
      row.confidence,
      row.source_title,
      row.source_locator,
      row.source_quote,
      row.rules,
      row.immutable,
      row.source_material_id,
      row.status,
      row.created_at,
      row.modified_at,
    ]
  );
  return row;
}

async function listAnchors(id, cookie) {
  const fn = cookie ? server.requestAs.bind(server, cookie) : server.request.bind(server);
  return fn(`/api/pipeline/${id}/anchors`);
}

async function anchorCount(id) {
  const row = await db.get('SELECT COUNT(*) AS c FROM work_anchors WHERE work_id = ?', [id]);
  return row.c;
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  app = require('../app');
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('activate / reject：只允许合法流转', async () => {
  const work = await createWork({ title: '状态流转作品' });
  const anchor = await seedAnchor(work.id);

  const first = await server.request(`/api/pipeline/${work.id}/anchors/${anchor.id}/activate`, {
    method: 'POST',
  });
  assert.strictEqual(first.status, 200);
  assert.strictEqual((await first.json()).status, 'active');

  const again = await server.request(`/api/pipeline/${work.id}/anchors/${anchor.id}/activate`, {
    method: 'POST',
  });
  assert.strictEqual(again.status, 409, '重复激活应冲突');

  const rejected = await server.request(`/api/pipeline/${work.id}/anchors/${anchor.id}/reject`, {
    method: 'POST',
  });
  assert.strictEqual(rejected.status, 200);
  assert.strictEqual((await rejected.json()).status, 'rejected');

  const activateRejected = await server.request(
    `/api/pipeline/${work.id}/anchors/${anchor.id}/activate`,
    { method: 'POST' }
  );
  assert.strictEqual(activateRejected.status, 409, '已拒绝不能再激活');
});

test('非本人作品：list / activate / 删除均 404，且不动别人的数据', async () => {
  const work = await createWork({ title: '越权测试作品' });
  const anchor = await seedAnchor(work.id);
  const otherCookie = await server.loginAs('13900000002');

  const list = await server.requestAs(otherCookie, `/api/pipeline/${work.id}/anchors`);
  assert.strictEqual(list.status, 404, '别人的作品必须 404 而不是 403');

  const act = await server.requestAs(
    otherCookie,
    `/api/pipeline/${work.id}/anchors/${anchor.id}/activate`,
    { method: 'POST' }
  );
  assert.strictEqual(act.status, 404);

  const del = await server.requestAs(otherCookie, `/api/works/${work.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 404);

  // 越权删除没有清掉别人的锚点
  assert.strictEqual(await anchorCount(work.id), 1);

  // 归还给本人删除，后续用例不残留
  const ownDelete = await server.request(`/api/works/${work.id}`, { method: 'DELETE' });
  assert.strictEqual(ownDelete.status, 200);
});

test('模板未启用：锚点列表 404', async () => {
  const offWork = await createWork({ title: '未启用模板作品', template: '' });

  const list = await listAnchors(offWork.id);
  assert.strictEqual(list.status, 404);
});

test('删除作品：三张流水线子表该 work_id 残留为 0', async () => {
  const work = await createWork({ title: '待删除作品' });
  const anchor = await seedAnchor(work.id);

  await db.run(
    `INSERT INTO anchor_violations (id, work_id, anchor_id, rule_type, severity, quote, created_at)
     VALUES (?, ?, ?, 'presence_forbidden', 'block', '曹操端坐堂上。', ?)`,
    ['violation-for-delete', work.id, anchor.id, '2026-01-01T00:00:00.000Z']
  );

  const del = await server.request(`/api/works/${work.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  for (const table of ['work_anchors', 'work_blank_areas', 'anchor_violations']) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${table} WHERE work_id = ?`, [work.id]);
    assert.strictEqual(row.c, 0, `${table} 不应留下孤儿行`);
  }
  const workRow = await db.get('SELECT COUNT(*) AS c FROM works WHERE id = ?', [work.id]);
  assert.strictEqual(workRow.c, 0);
});
