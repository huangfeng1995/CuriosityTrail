'use strict';

/**
 * 设置入口角标 + 批量确认知情变化。
 *
 * 角标要能跨作品计数；批量确认要一次处理一批，且校验不过的条目跳过、
 * 不会拖垮整批。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');
const env = setupTempEnv();

const app = require('../app');
const db = require('../database');

let server;
let userId;
let workId;
let characterId;
let factId;

const ts = () => new Date().toISOString();

test.before(async () => {
  await db.ready;
  server = await startServer(app);
  const user = await db.get("SELECT id FROM users WHERE phone = '13900000001'");
  userId = user.id;

  workId = crypto.randomUUID();
  characterId = crypto.randomUUID();
  factId = crypto.randomUUID();
  const now = ts();

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, 'history_thriller', ?, ?)`,
    [workId, userId, '测试作品', now, now]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?)`,
    [characterId, workId, '曹操', now, now]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [factId, workId, '曹操挟天子以令诸侯', '曹操,天子', now, now]
  );
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

async function addPending({ character = characterId, fact = factId, toState = 'knows' } = {}) {
  const id = crypto.randomUUID();
  const now = ts();
  await db.run(
    `INSERT INTO knowledge_pending
       (id, work_id, chapter_id, chapter_seq, character_id, character_name, fact_id,
        fact_label, from_state, to_state, evidence, reason, status, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?, 'unknown', ?, 'E1', '测试', 'pending', ?, ?)`,
    [id, workId, character, character ? '曹操' : '未知角色', fact, fact ? 'F1' : '未知事实', toState, now, now]
  );
  return id;
}

test('pending-count 跨作品计数，批量确认后归零', async () => {
  await addPending();
  const before = await (await server.request('/api/pipeline/pending-count')).json();
  console.log(`[badge] 确认前 count=${before.count}`);
  assert.strictEqual(before.count, 1);

  const pendingList = await (await server.request(`/api/pipeline/${workId}/pending`)).json();
  const ids = pendingList.knowledge.map((row) => row.id);

  const res = await server.request(`/api/pipeline/${workId}/pending/knowledge/confirm-batch`, {
    method: 'POST',
    body: { ids },
  });
  const body = await res.json();
  const matrix = await db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? AND character_id = ? AND fact_id = ?',
    [workId, characterId, factId]
  );
  const after = await (await server.request('/api/pipeline/pending-count')).json();

  console.log(
    `[batch] confirmed=${body.confirmed}；矩阵行数=${matrix.length}；确认后 count=${after.count}`
  );
  assert.strictEqual(body.confirmed, 1);
  assert.strictEqual(matrix.length, 1);
  assert.strictEqual(after.count, 0);
});

test('批量确认跳过校验不过的条目，不整批失败', async () => {
  // 换一组角色/事实：上一个用例已经在 chapter_seq=1 写过同一对，会被去重跳过
  const now = ts();
  const otherChar = crypto.randomUUID();
  const otherFact = crypto.randomUUID();
  await db.run(
    `INSERT INTO characters (id, work_id, name, created_at, modified_at) VALUES (?, ?, ?, ?, ?)`,
    [otherChar, workId, '袁绍', now, now]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [otherFact, workId, '袁绍据河北', '袁绍,河北', now, now]
  );

  const good = await addPending({ character: otherChar, fact: otherFact });
  const bad = await addPending({ character: null, fact: null });

  const res = await server.request(`/api/pipeline/${workId}/pending/knowledge/confirm-batch`, {
    method: 'POST',
    body: { ids: [good, bad] },
  });
  const body = await res.json();
  console.log(
    `[skip] confirmed=${body.confirmed}；skipped=${body.skipped.length}；reason=${body.skipped[0]?.reason}`
  );
  assert.strictEqual(body.confirmed, 1);
  assert.strictEqual(body.skipped.length, 1);
});
