'use strict';

/**
 * 素材入库的机械约束（第一版数据层）。
 *
 * 覆盖用户点名的三条硬断言：
 *   1. 单批上限 12 条；同标题/同出处/正文前 40 字合并，不重复入库；
 *   2. sourced 必须有出处；missing 必须无出处且正文首行写「待补：」；
 *   3. 撤回即失效：撤回前后同一次检索的命中数不同。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const store = require('../services/materials/store');
const localSearch = require('../services/search/local');

let server;
let userId;

/** 每次用不同的关键词，避免不同用例互相干扰 FTS 命中 */
const KW_1 = '许都夜雨';
const KW_2 = '周瑜火攻';
const KW_3 = '官渡粮草';

test.before(async () => {
  await db.ready;
  server = await startServer(app);
  const row = await db.get("SELECT id FROM users WHERE phone = '13900000001'");
  userId = row.id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('单批超过 12 条直接拒绝，同标题/同正文合并', async () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => ({
    title: `${KW_1} 资料 ${i}`,
    body: `${KW_1} 的第 ${i} 段描述`,
    confidence: 'inferable',
  }));
  await assert.rejects(
    () => store.saveBatch(userId, thirteen, { createdBy: 'agent' }),
    /单批最多 12 条/
  );
  console.log('[cap] 13 条被拒绝 = true');

  const first = await store.saveBatch(
    userId,
    [{ title: '许都 夜雨', body: '许都夜雨，曹操巡城。', confidence: 'inferable' }],
    { createdBy: 'agent' }
  );
  const second = await store.saveBatch(
    userId,
    [{ title: '许都夜雨！', body: '许都夜雨，曹操巡城', confidence: 'inferable' }],
    { createdBy: 'agent' }
  );
  const rows = await db.all('SELECT id, title FROM materials WHERE user_id = ? AND title LIKE ?', [
    userId,
    '%许都%夜雨%',
  ]);
  console.log(
    `[dedupe] 第一批 created=${first.created.length}；第二批 merged=${second.merged.length}；库内同题行数=${rows.length}`
  );
  assert.strictEqual(first.created.length, 1);
  assert.strictEqual(second.merged.length, 1);
  assert.strictEqual(rows.length, 1);
});

test('provenance 与 missing 的机械约束', async () => {
  await assert.rejects(
    () =>
      store.saveBatch(
        userId,
        [
          {
            title: '曹操生卒',
            body: '曹操生于155年。',
            confidence: 'missing',
            provenance: '《三国志》',
          },
        ],
        { createdBy: 'agent' }
      ),
    /missing 的条目 provenance 必须为空/
  );
  await assert.rejects(
    () =>
      store.saveBatch(
        userId,
        [{ title: '曹操生卒', body: '曹操生于155年。', confidence: 'missing' }],
        { createdBy: 'agent' }
      ),
    /正文首行必须写成「待补/
  );
  await assert.rejects(
    () =>
      store.saveBatch(
        userId,
        [{ title: '官渡兵力', body: '袁绍十万。', confidence: 'sourced' }],
        { createdBy: 'agent' }
      ),
    /sourced 的条目必须有 provenance/
  );
  console.log('[constraint] missing 带出处被拒 = true；missing 缺待补行被拒 = true；sourced 缺出处被拒 = true');

  const ok = await store.saveBatch(
    userId,
    [
      {
        title: '曹操生卒年',
        body: '待补：曹操生卒年，正史未给出统一说法。',
        confidence: 'missing',
      },
    ],
    { createdBy: 'agent' }
  );
  const row = await db.get('SELECT * FROM materials WHERE id = ?', [ok.created[0].id]);
  console.log(
    `[missing] 入库 status=${row.status} confidence=${row.confidence} provenance长度=${(row.provenance || '').length}`
  );
  assert.strictEqual(row.confidence, 'missing');
  assert.strictEqual(row.provenance, '');
  assert.strictEqual(row.status, 'active');
});

test('origin=web 无台账时降级，有台账时才可 sourced', async () => {
  const withoutLedger = await store.saveBatch(
    userId,
    [
      {
        title: '赤壁风向',
        body: '赤壁东风，火攻曹营。',
        confidence: 'sourced',
        provenance: '《三国志·周瑜传》',
        origin: 'web',
        sourceUrl: 'https://example.com/a',
      },
    ],
    { createdBy: 'agent', ledger: [] }
  );
  const downgraded = await db.get('SELECT * FROM materials WHERE id = ?', [
    withoutLedger.created[0].id,
  ]);
  console.log(
    `[web-downgrade] origin=${downgraded.origin} confidence=${downgraded.confidence} status=${downgraded.status}`
  );
  assert.strictEqual(downgraded.origin, 'model');
  assert.strictEqual(downgraded.confidence, 'inferable');

  const ledger = [
    {
      query: '赤壁 东风',
      count: 3,
      urls: ['https://example.com/b'],
      ok: true,
      fetched: [],
    },
  ];
  const withLedger = await store.saveBatch(
    userId,
    [
      {
        title: '赤壁火攻',
        body: '赤壁火攻，东南风急，火船突袭曹营。',
        confidence: 'sourced',
        provenance: '《三国志·周瑜传》',
        origin: 'web',
        sourceUrl: 'https://example.com/b',
      },
    ],
    { createdBy: 'agent', ledger }
  );
  const kept = await db.get('SELECT * FROM materials WHERE id = ?', [withLedger.created[0].id]);
  console.log(
    `[web-ledger] origin=${kept.origin} confidence=${kept.confidence} status=${kept.status} search_log长度=${(kept.search_log || '').length}`
  );
  assert.strictEqual(kept.origin, 'web');
  assert.strictEqual(kept.confidence, 'sourced');
  assert.strictEqual(kept.status, 'pending');
  assert.ok(kept.search_log.length > 0);
});

test('撤回即失效：同一次检索命中数 1 → 0', async () => {
  const saved = await store.saveBatch(
    userId,
    [{ title: KW_3, body: '官渡粮草，袁绍军中断粮。', confidence: 'inferable' }],
    { createdBy: 'agent' }
  );
  const id = saved.created[0].id;

  const before = await localSearch.search(KW_3, { limit: 10, userId });
  assert.ok(before.some((r) => r.id === id));

  await server.request(`/api/materials/${id}/retract`, { method: 'POST' });

  const after = await localSearch.search(KW_3, { limit: 10, userId });
  const list = await server.request('/api/materials');
  const listBody = await list.json();

  console.log(
    `[retract] 撤回前命中=${before.length}；撤回后命中=${after.length}；默认列表含该条=${listBody.some((r) => r.id === id)}`
  );
  assert.strictEqual(after.length, 0);
  assert.ok(!listBody.some((r) => r.id === id));
});

test('批量确认：pending 确认前不可检索，确认后立刻可检索', async () => {
  const saved = await store.saveBatch(
    userId,
    [
      {
        title: KW_2,
        body: '赤壁东风起，周瑜火攻。',
        confidence: 'sourced',
        provenance: '《三国志·周瑜传》',
      },
    ],
    { createdBy: 'agent' }
  );
  const id = saved.created[0].id;
  const pendingRow = await db.get('SELECT status FROM materials WHERE id = ?', [id]);
  assert.strictEqual(pendingRow.status, 'pending');

  const before = await localSearch.search(KW_2, { limit: 10, userId });
  assert.ok(!before.some((r) => r.id === id));

  const res = await server.request('/api/materials/confirm', {
    method: 'POST',
    body: { ids: [id] },
  });
  const body = await res.json();
  const active = await db.get('SELECT status FROM materials WHERE id = ?', [id]);
  const after = await localSearch.search(KW_2, { limit: 10, userId });

  console.log(
    `[confirm] 确认前命中=${before.length}；confirm confirmed=${body.confirmed}；status=${active.status}；确认后命中=${after.length}`
  );
  assert.strictEqual(body.confirmed, 1);
  assert.strictEqual(active.status, 'active');
  assert.ok(after.some((r) => r.id === id));
});
