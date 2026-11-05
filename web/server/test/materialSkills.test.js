'use strict';

/**
 * 素材类 agent 技能：注册表、无 key 行为、批量上限、检索台账。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv } = require('./helpers');
const env = setupTempEnv();

const db = require('../database');
const skills = require('../services/skills');
const deepseekSearch = require('../services/search/deepseekSearch');

let userId;

test.before(async () => {
  await db.ready;
  // 技能测试不需要起 HTTP 服务，直接建一个用户
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id, phone, nickname, created_at) VALUES (?, ?, ?, ?)',
    [id, '13900000001', '测试作者', ts]
  );
  userId = id;
});

test.after(async () => {
  env.cleanup();
});

test('三个素材工具都注册进 call_tool', async () => {
  const names = skills.listSkills().map((s) => s.name);
  const present = ['searchMaterials', 'webSearch', 'saveMaterials'].every((n) => names.includes(n));
  console.log(`[registry] 工具数=${names.length}；素材三件套齐全=${present}`);
  assert.ok(present);
});

test('webSearch 无 key 时明确不可用，不返回任何结果', async () => {
  const original = deepseekSearch.available;
  deepseekSearch.available = () => false;
  try {
    const out = await skills.runSkill('webSearch', { query: '明代 酒楼' }, {
      userId,
      searchLedger: [],
    });
    assert.strictEqual(out.ok, true);
    console.log(
      `[webSearch] degraded=${out.result.degraded} unavailable=${out.result.unavailable}；summary="${out.result.summary}"；items=${out.result.items.length}`
    );
    assert.strictEqual(out.result.unavailable, true);
    assert.ok(out.result.summary.includes('未配置 DeepSeek API Key，联网检索不可用'));
    assert.strictEqual(out.result.items.length, 0);
  } finally {
    deepseekSearch.available = original;
  }
});

test('saveMaterials 超过 12 条按工具错误回传，模型可据此分批', async () => {
  const items = Array.from({ length: 13 }, (_, i) => ({
    title: `批量素材 ${i}`,
    body: `批量素材正文 ${i}`,
    confidence: 'inferable',
  }));
  const out = await skills.runSkill('saveMaterials', { items }, { userId, workId: '' });
  console.log(`[batch] ok=${out.ok}；error="${out.error}"`);
  assert.strictEqual(out.ok, false);
  assert.ok(out.error.includes('单批最多 12 条'));
});

test('saveMaterials 通过台账保留 web 来源，缺台账则降级为 model', async () => {
  const query = '明代 酒楼 陈设';
  const url = 'https://example.com/inn';
  const ledger = [{ query, count: 2, urls: [url], ok: true, fetched: [] }];

  const kept = await skills.runSkill(
    'saveMaterials',
    {
      items: [
        {
          title: '明代酒楼陈设',
          body: '酒楼门前架设彩楼欢门。',
          provenance: '《东京梦华录》',
          confidence: 'sourced',
          origin: 'web',
          sourceUrl: url,
        },
      ],
    },
    { userId, workId: '', searchLedger: ledger }
  );
  assert.strictEqual(kept.ok, true);
  const keptRow = await db.get('SELECT * FROM materials WHERE id = ?', [kept.result.created[0].id]);
  console.log(
    `[ledger] ok=${kept.ok}；origin=${keptRow.origin} confidence=${keptRow.confidence} status=${keptRow.status}`
  );
  assert.strictEqual(keptRow.origin, 'web');
  assert.strictEqual(keptRow.confidence, 'sourced');
  assert.strictEqual(keptRow.status, 'pending');

  const dropped = await skills.runSkill(
    'saveMaterials',
    {
      items: [
        {
          title: '明代茶肆',
          body: '茶肆内设松棚。',
          provenance: '未知网页',
          confidence: 'sourced',
          origin: 'web',
          sourceUrl: 'https://example.com/tea',
        },
      ],
    },
    { userId, workId: '', searchLedger: [] }
  );
  const droppedRow = await db.get('SELECT * FROM materials WHERE id = ?', [
    dropped.result.created[0].id,
  ]);
  console.log(`[no-ledger] origin=${droppedRow.origin} confidence=${droppedRow.confidence}`);
  assert.strictEqual(droppedRow.origin, 'model');
  assert.strictEqual(droppedRow.confidence, 'inferable');
});

test('saveMaterials 的 missing 条目必须带「待补：」首行', async () => {
  const bad = await skills.runSkill(
    'saveMaterials',
    {
      items: [{ title: '曹操生年', body: '约155年。', confidence: 'missing' }],
    },
    { userId }
  );
  console.log(`[missing] 缺待补行 ok=${bad.ok}；error="${bad.error}"`);
  assert.strictEqual(bad.ok, false);

  const good = await skills.runSkill(
    'saveMaterials',
    {
      items: [
        {
          title: '曹操生年（待补）',
          body: '待补：曹操生年，正史说法不一。',
          confidence: 'missing',
        },
      ],
    },
    { userId }
  );
  console.log(`[missing] 合法条目 ok=${good.ok}；summary="${good.result.summary}"`);
  assert.strictEqual(good.ok, true);
});
