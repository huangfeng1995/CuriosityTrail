'use strict';

/**
 * 删除作品的回归测试。
 *
 * 覆盖两件事：
 *  1. 删除成功后 works 行真的消失，关联表计数归零；
 *  2. 删除中途失败时返回非 200，且所有数据完整保留（事务整体回滚）。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

const app = require('../app');
const { ready, get, run } = require('../database');

let server;

const TS = '2026-11-28T00:00:00.000Z';

/** 直接建一部作品，返回带 user_id 的行。 */
async function createWork(title) {
  const res = await server.request('/api/works', { method: 'POST', body: { title } });
  assert.strictEqual(res.status, 200);
  const work = await res.json();
  const row = await get('SELECT user_id FROM works WHERE id = ?', [work.id]);
  return { ...work, user_id: row.user_id };
}

/** 给作品塞满各类关联数据，返回用于断言的计数表。 */
async function seedRelations(work) {
  const chapterId = `chap-${work.id}`;
  const conversationId = `conv-${work.id}`;

  await run(
    `INSERT INTO chapters (id, work_id, title, seq, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, ?, ?)`,
    [chapterId, work.id, TS, TS]
  );
  await run(
    `INSERT INTO chapter_versions (id, chapter_id, work_id, created_at) VALUES (?, ?, ?, ?)`,
    [`ver-${work.id}`, chapterId, work.id, TS]
  );
  await run(
    `INSERT INTO conversations (id, work_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [conversationId, work.id, work.user_id, TS, TS]
  );
  await run(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'assistant', '正文', ?)`,
    [`msg-${work.id}`, conversationId, TS]
  );
  await run(
    `INSERT INTO characters (id, work_id, name, created_at, modified_at)
     VALUES (?, ?, '陈默', ?, ?)`,
    [`char-${work.id}`, work.id, TS, TS]
  );
  await run(
    `INSERT INTO settings (id, work_id, category, name, content, created_at, modified_at)
     VALUES (?, ?, '世界', '许都', '都城', ?, ?)`,
    [`set-${work.id}`, work.id, TS, TS]
  );
  await run(
    `INSERT INTO plot_cards (id, work_id, title, created_at, modified_at)
     VALUES (?, ?, '旧案', ?, ?)`,
    [`plot-${work.id}`, work.id, TS, TS]
  );
  await run(
    `INSERT INTO card_proposals (id, user_id, work_id, kind, title, created_at, updated_at)
     VALUES (?, ?, ?, 'character', '提案', ?, ?)`,
    [`prop-${work.id}`, work.user_id, work.id, TS, TS]
  );
  await run(
    `INSERT INTO materials (id, title, work_id, user_id, created_at, modified_at)
     VALUES (?, '素材', ?, ?, ?, ?)`,
    [`mat-${work.id}`, work.id, work.user_id, TS, TS]
  );
  await run(
    `INSERT INTO writing_events (id, work_id, day, created_at) VALUES (?, ?, '2026-11-28', ?)`,
    [`evt-${work.id}`, work.id, TS]
  );
  await run(
    `INSERT INTO chapter_plans (id, work_id, chapter_id, plan, created_at, updated_at)
     VALUES (?, ?, ?, '{"beats":[]}', ?, ?)`,
    [`plan-${work.id}`, work.id, chapterId, TS, TS]
  );
  await run(
    `INSERT INTO consistency_findings
       (id, user_id, work_id, fingerprint, title, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, 'fp', '冲突', ?, ?, ?, ?)`,
    [`find-${work.id}`, work.user_id, work.id, TS, TS, TS, TS]
  );

  return {
    work_id: [
      'chapters',
      'chapter_versions',
      'conversations',
      'characters',
      'settings',
      'plot_cards',
      'card_proposals',
      'materials',
      'writing_events',
      'chapter_plans',
      'consistency_findings',
    ],
    conversationId,
  };
}

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('删除作品：works 行消失、列表不含、关联表计数归零', async () => {
  const work = await createWork('要删的作品');
  const { work_id: scopedTables, conversationId } = await seedRelations(work);

  const del = await server.request(`/api/works/${work.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(await del.json(), { ok: true });

  const detail = await server.request(`/api/works/${work.id}`);
  assert.strictEqual(detail.status, 404, '删除后 GET 该作品必须 404');

  const list = await (await server.request('/api/works')).json();
  assert.ok(!list.some((row) => row.id === work.id), '列表里不能还有已删除的作品');

  for (const table of scopedTables) {
    const row = await get(`SELECT COUNT(*) AS c FROM ${table} WHERE work_id = ?`, [work.id]);
    assert.strictEqual(row.c, 0, `${table} 应清空`);
  }
  const messages = await get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', [
    conversationId,
  ]);
  assert.strictEqual(messages.c, 0, '会话下的消息应一并清空');
});

test('删除失败：返回非 200，作品与关联数据完整保留', async () => {
  const work = await createWork('不能删的作品');
  const { conversationId } = await seedRelations(work);

  // 用触发器模拟「删到 works 这一步失败」，验证前面删掉的子表也会回滚。
  await run(
    "CREATE TRIGGER block_work_delete BEFORE DELETE ON works BEGIN SELECT RAISE(ABORT, 'blocked'); END"
  );
  let res;
  try {
    res = await server.request(`/api/works/${work.id}`, { method: 'DELETE' });
  } finally {
    await run('DROP TRIGGER IF EXISTS block_work_delete');
  }

  assert.strictEqual(res.status, 500, '失败不能返回 200');
  const body = await res.json();
  assert.strictEqual(body.code, 'WORK_DELETE_FAILED');
  assert.ok(body.error);

  const detail = await server.request(`/api/works/${work.id}`);
  assert.strictEqual(detail.status, 200, '失败后作品必须还在');

  const chapter = await get('SELECT COUNT(*) AS c FROM chapters WHERE work_id = ?', [work.id]);
  assert.strictEqual(chapter.c, 1, '章节不能被回滚前的中间状态删掉');
  const messages = await get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', [
    conversationId,
  ]);
  assert.strictEqual(messages.c, 1, '消息必须完整保留');
});
