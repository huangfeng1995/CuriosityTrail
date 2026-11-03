'use strict';

/**
 * HP2：锚点库 CRUD 与导入草稿。
 *
 * 重点覆盖设计文档的验收项：
 *   PV2 无出处的 sourced 422 且零入库
 *   PV3 blank 被强设 immutable 被拒，路由返回可读 4xx 而非 500
 *   非本人作品 / 模板未启用 均 404
 *   非法 rule_type 的处理
 *   删作品后三张流水线子表无残留
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

let db;
let app;
let server;
let anchorsSvc;
let workId;

async function createWork(body = {}) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: '锚点测试作品', template: 'history_thriller', ...body },
  });
  assert.strictEqual(res.status, 200, '建作品应成功');
  return res.json();
}

async function importAnchors(id, candidates) {
  return server.request(`/api/pipeline/${id}/anchors/import`, {
    method: 'POST',
    body: { candidates },
  });
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
  anchorsSvc = require('../services/pipeline/anchors');
  server = await startServer(app);
  workId = (await createWork()).id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// PV2：无出处 422 + 零入库
// ---------------------------------------------------------------------------

test('PV2：sourced 缺 source_locator 整批 422，库里零新增', async () => {
  const before = await anchorCount(workId);

  const res = await importAnchors(workId, [
    {
      kind: 'person',
      subject: '曹操',
      claim: '曹操卒于建安二十五年正月',
      confidence: 'sourced',
      source_title: '三国志',
      source_locator: '武帝纪',
    },
    {
      kind: 'person',
      subject: '司马懿',
      claim: '司马懿曾任文学掾',
      confidence: 'sourced',
      source_title: '晋书',
      // 故意缺 source_locator
    },
  ]);

  assert.strictEqual(res.status, 422, '整批必须 422');
  const body = await res.json();
  assert.match(body.error, /source_locator/, '错误信息要指出缺什么');
  assert.strictEqual(await anchorCount(workId), before, '校验失败必须零入库');
});

test('PV2：source_title 只有全角空格也算缺失', async () => {
  const res = await importAnchors(workId, [
    {
      kind: 'person',
      subject: '曹丕',
      claim: '曹丕代汉',
      confidence: 'sourced',
      source_title: '　　',
      source_locator: '文帝纪',
    },
  ]);
  assert.strictEqual(res.status, 422);
});

// ---------------------------------------------------------------------------
// 正常导入与归一化
// ---------------------------------------------------------------------------

test('导入：三档置信可入库，书名/条目去空白并全角转半角', async () => {
  const res = await importAnchors(workId, [
    {
      kind: 'person',
      subject: ' 曹操 ',
      claim: '曹操卒于建安二十五年正月',
      confidence: 'sourced',
      source_title: '　三 国 志　',
      source_locator: '武 帝 纪',
      source_quote: '二十五年春正月，庚子，王崩于洛阳。',
    },
    {
      kind: 'office',
      subject: '司空',
      claim: '一般认为司空府征辟需符传',
      confidence: 'inferred', // 兼容拼写，落库应归一为 inferable
      source_title: '后汉书',
    },
    {
      kind: 'time',
      subject: '建安二十五年',
      claim: '具体月份无载',
      confidence: 'blank',
      why_blank: '史料未载具体月份',
      usable_for: '可虚构赴许时间',
    },
  ]);

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.imported, 3);

  const listRes = await listAnchors(workId);
  const list = await listRes.json();
  const bySubject = new Map(list.map((a) => [a.subject, a]));

  const caocao = bySubject.get('曹操');
  assert.strictEqual(caocao.sourceTitle, '三国志', '书名应去掉所有空白');
  assert.strictEqual(caocao.sourceLocator, '武帝纪', '条目应去掉所有空白');
  assert.strictEqual(caocao.status, 'pending');
  assert.deepStrictEqual(caocao.rules, [{ rule_type: 'manual_only', params: {} }]);

  assert.strictEqual(bySubject.get('司空').confidence, 'inferable', 'inferred 应归一为 inferable');

  const blank = bySubject.get('建安二十五年');
  assert.strictEqual(blank.confidence, 'blank');
  assert.strictEqual(blank.immutable, false, 'blank 必须 immutable=0');

  const areas = await db.all('SELECT * FROM work_blank_areas WHERE work_id = ?', [workId]);
  assert.strictEqual(areas.length, 1, '空白锚点应同步写一条空白区');
  assert.strictEqual(areas[0].topic, '建安二十五年');
  assert.strictEqual(areas[0].usable_for, '可虚构赴许时间');
});

// ---------------------------------------------------------------------------
// PV3：blank immutable
// ---------------------------------------------------------------------------

test('PV3：blank 显式 immutable=1 返回可读 422，且零入库', async () => {
  const before = await anchorCount(workId);
  const res = await importAnchors(workId, [
    {
      kind: 'event',
      subject: '杨俊赴许都',
      claim: '日期无载',
      confidence: 'blank',
      immutable: 1,
    },
  ]);

  assert.strictEqual(res.status, 422, '不能落到 CHECK 报 500');
  const body = await res.json();
  assert.match(body.error, /空白/, '错误信息应说明空白锚点不能不可变');
  assert.strictEqual(await anchorCount(workId), before);
});

// ---------------------------------------------------------------------------
// 非法 rule_type
// ---------------------------------------------------------------------------

test('非法 rule_type：未知规则丢弃；全部无效则降级 manual_only', async () => {
  const res = await importAnchors(workId, [
    {
      kind: 'person',
      subject: '钟会',
      claim: '钟会曾任司隶校尉',
      confidence: 'inferable',
      source_title: '三国志',
      rules: [
        { rule_type: 'teleport_forbidden', params: { from: '成都' } },
        { rule_type: 'term_forbidden', params: { terms: ['大人'] } },
      ],
    },
    {
      kind: 'place',
      subject: '许都',
      claim: '一般认为许都即许县',
      confidence: 'inferable',
      source_title: '后汉书',
      rules: [{ rule_type: 'not_a_rule', params: {} }],
    },
  ]);
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  const bySubject = new Map(body.anchors.map((a) => [a.subject, a]));
  assert.deepStrictEqual(
    bySubject.get('钟会').rules,
    [{ rule_type: 'term_forbidden', params: { terms: ['大人'] } }],
    '未知类型丢弃，合法类型保留'
  );
  assert.deepStrictEqual(
    bySubject.get('许都').rules,
    [{ rule_type: 'manual_only', params: {} }],
    '全部无效时降级为仅人工核对'
  );
});

// ---------------------------------------------------------------------------
// 状态流转
// ---------------------------------------------------------------------------

test('activate / reject：只允许合法流转', async () => {
  const work = await createWork({ title: '状态流转作品' });
  const imported = await importAnchors(work.id, [
    {
      kind: 'person',
      subject: '司马懿',
      claim: '司马懿曾任文学掾',
      confidence: 'sourced',
      source_title: '晋书',
      source_locator: '宣帝纪',
    },
  ]);
  const anchor = (await imported.json()).anchors[0];

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

// ---------------------------------------------------------------------------
// 归属与模板门禁
// ---------------------------------------------------------------------------

test('非本人作品：list / import / activate / 删除均 404，且不动别人的数据', async () => {
  const work = await createWork({ title: '越权测试作品' });
  await importAnchors(work.id, [
    {
      kind: 'person',
      subject: '刘备',
      claim: '刘备曾任徐州牧',
      confidence: 'inferable',
      source_title: '三国志',
    },
  ]);
  const anchor = (await (await listAnchors(work.id)).json())[0];

  const otherCookie = await server.loginAs('13900000002');

  const list = await server.requestAs(otherCookie, `/api/pipeline/${work.id}/anchors`);
  assert.strictEqual(list.status, 404, '别人的作品必须 404 而不是 403');

  const imp = await server.requestAs(otherCookie, `/api/pipeline/${work.id}/anchors/import`, {
    method: 'POST',
    body: { candidates: [{ kind: 'person', subject: 'x', claim: 'y', confidence: 'blank' }] },
  });
  assert.strictEqual(imp.status, 404);

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

test('模板未启用：所有锚点入口 404', async () => {
  const offWork = await createWork({ title: '未启用模板作品', template: '' });

  const list = await listAnchors(offWork.id);
  assert.strictEqual(list.status, 404);

  const imp = await importAnchors(offWork.id, [
    { kind: 'person', subject: 'x', claim: 'y', confidence: 'blank' },
  ]);
  assert.strictEqual(imp.status, 404);

  const draft = await server.request(`/api/pipeline/${offWork.id}/anchors/draft`, {
    method: 'POST',
    body: { topic: '曹操' },
  });
  assert.strictEqual(draft.status, 404);
});

// ---------------------------------------------------------------------------
// 删除作品清理
// ---------------------------------------------------------------------------

test('删除作品：三张流水线子表该 work_id 残留为 0', async () => {
  const work = await createWork({ title: '待删除作品' });
  await importAnchors(work.id, [
    {
      kind: 'person',
      subject: '曹操',
      claim: '曹操卒于建安二十五年正月',
      confidence: 'sourced',
      source_title: '三国志',
      source_locator: '武帝纪',
    },
    {
      kind: 'time',
      subject: '建安二十五年',
      claim: '具体月份无载',
      confidence: 'blank',
    },
  ]);

  const anchor = await db.get('SELECT id FROM work_anchors WHERE work_id = ? LIMIT 1', [work.id]);
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

// ---------------------------------------------------------------------------
// 导入草稿
// ---------------------------------------------------------------------------

test('draft：模型输出被归一化，非法候选标 valid=false，未知规则降级', async () => {
  const provider = {
    chat: async () => ({
      content: JSON.stringify({
        anchors: [
          {
            kind: 'person',
            subject: '曹操',
            claim: '曹操卒于建安二十五年正月',
            confidence: 'sourced',
            source_title: '三国志',
            source_locator: '武帝纪',
          },
          {
            kind: 'person',
            subject: '司马懿',
            claim: '司马懿曾任文学掾',
            confidence: 'sourced',
            source_title: '晋书',
          },
          {
            kind: 'place',
            subject: '许都',
            claim: '一般认为许都即许县',
            confidence: 'inferable',
            source_title: '后汉书',
            rules: [{ rule_type: 'unknown', params: {} }],
          },
        ],
        blankAreas: [{ topic: '杨俊赴许日期', why_blank: '未载', usable_for: '可虚构' }],
      }),
    }),
  };

  const before = await anchorCount(workId);
  const result = await anchorsSvc.draftAnchors({ topic: '曹操', provider });

  assert.strictEqual(result.anchors.length, 3);
  assert.strictEqual(result.anchors[0].valid, true);
  assert.strictEqual(result.anchors[1].valid, false, '缺条目的 sourced 不可勾选');
  assert.match(result.anchors[1].errors.join('；'), /source_locator/);
  assert.deepStrictEqual(result.anchors[2].rules, [{ rule_type: 'manual_only', params: {} }]);
  assert.match(result.anchors[2].warnings.join('；'), /manual_only|仅人工核对/);
  assert.strictEqual(result.blankAreas.length, 1);
  assert.strictEqual(result.blankAreas[0].topic, '杨俊赴许日期');
  assert.strictEqual(await anchorCount(workId), before, '草稿不得落库');
});

test('draft：provider 失败返回空数组 + notice，不抛 500', async () => {
  const provider = {
    chat: async () => {
      throw new Error('上游挂了');
    },
  };
  const result = await anchorsSvc.draftAnchors({ topic: '曹操', provider });
  assert.deepStrictEqual(result.anchors, []);
  assert.deepStrictEqual(result.blankAreas, []);
  assert.ok(result.notice);
});

test('draft 路由：缺 topic 返回 400', async () => {
  const res = await server.request(`/api/pipeline/${workId}/anchors/draft`, {
    method: 'POST',
    body: {},
  });
  assert.strictEqual(res.status, 400);
});
