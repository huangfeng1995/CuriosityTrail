'use strict';

/**
 * 待确认队列：知情变化 + 锚点冲突。
 *
 * 覆盖作者侧闭环的关键闸门：
 *   - 列表只返回 pending / 未驳回的条目
 *   - 确认知情变化才写 knowledge_matrix，且 chapter_seq 取原扫描章
 *   - 实体没解析出来的条目不能确认
 *   - 重复确认不覆盖已有记录
 *   - block 级冲突不能驳回，warn 级可以
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let app;
let server;

async function createWork(title) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title, template: 'history_thriller' },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function addChapter(workId, { id, seq, title = '第 1 章' }) {
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [id, workId, title, seq, TS, TS]
  );
}

async function addCharacter(workId, { id, name }) {
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, '', ?, ?)`,
    [id, workId, name, TS, TS]
  );
}

async function addFact(workId, { id, content }) {
  await db.run(
    `INSERT INTO story_facts
       (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, '', ?, ?)`,
    [id, workId, content, TS, TS]
  );
}

async function addPending(workId, chapterId, overrides = {}) {
  const id = overrides.id || crypto.randomUUID();
  await db.run(
    `INSERT INTO knowledge_pending
       (id, work_id, chapter_id, chapter_seq, character_id, character_name,
        fact_id, fact_label, from_state, to_state, evidence, reason,
        status, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      workId,
      chapterId,
      overrides.chapterSeq || 1,
      overrides.characterId ?? null,
      overrides.characterName || '司马懿',
      overrides.factId ?? null,
      overrides.factLabel || 'F1',
      overrides.fromState || 'partial',
      overrides.toState || 'knows',
      overrides.evidence || '他知道了。',
      overrides.reason || '需作者确认：knows 不能自动生效',
      TS,
      TS,
    ]
  );
  return id;
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

test('列表只返回 pending 知情变化与未驳回冲突', async () => {
  const work = await createWork('待确认列表');
  await addChapter(work.id, { id: 'list-ch', seq: 1 });
  await addCharacter(work.id, { id: 'list-char', name: '司马懿' });
  await addFact(work.id, { id: 'list-fact', content: '他见过密诏' });

  const pendingId = await addPending(work.id, 'list-ch', {
    characterId: 'list-char',
    factId: 'list-fact',
  });
  await addPending(work.id, 'list-ch', {
    id: 'already-dismissed',
    characterId: 'list-char',
    factId: 'list-fact',
  });
  await db.run(
    "UPDATE knowledge_pending SET status = 'dismissed' WHERE id = 'already-dismissed'"
  );

  await db.run(
    `INSERT INTO anchor_violations
       (id, work_id, chapter_id, rule_type, severity, quote, offset_start, detail, dismissed, created_at)
     VALUES ('list-warn', ?, 'list-ch', 'term_forbidden', 'warn', '有人说出了「密诏」。', 3, '', 0, ?)`,
    [work.id, TS]
  );
  await db.run(
    `INSERT INTO anchor_violations
       (id, work_id, chapter_id, rule_type, severity, quote, offset_start, detail, dismissed, created_at)
     VALUES ('list-dismissed', ?, 'list-ch', 'term_forbidden', 'warn', '旧冲突', 0, '', 1, ?)`,
    [work.id, TS]
  );

  const res = await server.request(`/api/pipeline/${work.id}/pending`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.equal(body.knowledge.length, 1);
  assert.equal(body.knowledge[0].id, pendingId);
  assert.equal(body.knowledge[0].characterName, '司马懿');
  assert.equal(body.knowledge[0].chapterSeq, 1);
  assert.equal(body.knowledge[0].factLabel, 'F1');

  assert.equal(body.violations.length, 1);
  assert.equal(body.violations[0].id, 'list-warn');
  assert.equal(body.violations[0].chapterSeq, 1);
});

test('确认知情变化：写入 knowledge_matrix，chapter_seq 取扫描章', async () => {
  const work = await createWork('确认落库');
  await addChapter(work.id, { id: 'confirm-ch', seq: 2 });
  await addCharacter(work.id, { id: 'confirm-char', name: '司马懿' });
  await addFact(work.id, { id: 'confirm-fact', content: '他见过密诏' });
  const pendingId = await addPending(work.id, 'confirm-ch', {
    chapterSeq: 2,
    characterId: 'confirm-char',
    factId: 'confirm-fact',
    toState: 'knows',
  });

  const res = await server.request(
    `/api/pipeline/${work.id}/pending/knowledge/${pendingId}/confirm`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 200);

  const row = await db.get(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? AND chapter_seq = 2',
    [work.id]
  );
  assert.equal(row.character_id, 'confirm-char');
  assert.equal(row.fact_id, 'confirm-fact');
  assert.equal(row.state, 'knows');
  assert.equal(row.source_chapter_id, 'confirm-ch');
  assert.equal(row.note, '他知道了。');

  const pending = await db.get('SELECT status FROM knowledge_pending WHERE id = ?', [
    pendingId,
  ]);
  assert.equal(pending.status, 'confirmed');

  const list = await server.request(`/api/pipeline/${work.id}/pending`);
  assert.equal((await list.json()).knowledge.length, 0);
});

test('重复确认：已有本章记录时 409，不覆盖', async () => {
  const work = await createWork('重复确认');
  await addChapter(work.id, { id: 'dup-ch', seq: 1 });
  await addCharacter(work.id, { id: 'dup-char', name: '司马懿' });
  await addFact(work.id, { id: 'dup-fact', content: '他见过密诏' });
  const pendingId = await addPending(work.id, 'dup-ch', {
    characterId: 'dup-char',
    factId: 'dup-fact',
  });

  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, 'dup-char', 'dup-fact', 1, 'suspects', ?)`,
    [crypto.randomUUID(), work.id, TS]
  );

  const res = await server.request(
    `/api/pipeline/${work.id}/pending/knowledge/${pendingId}/confirm`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 409);

  const rows = await db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? AND chapter_seq = 1',
    [work.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'suspects');
});

test('实体未解析：确认被 422 拦下，零写入', async () => {
  const work = await createWork('实体缺失');
  await addChapter(work.id, { id: 'entity-ch', seq: 1 });
  const pendingId = await addPending(work.id, 'entity-ch', {
    characterName: '不存在的角色',
    characterId: null,
    factId: null,
  });

  const res = await server.request(
    `/api/pipeline/${work.id}/pending/knowledge/${pendingId}/confirm`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 422);

  const rows = await db.all('SELECT * FROM knowledge_matrix WHERE work_id = ?', [work.id]);
  assert.equal(rows.length, 0);

  const pending = await db.get('SELECT status FROM knowledge_pending WHERE id = ?', [
    pendingId,
  ]);
  assert.equal(pending.status, 'pending');
});

test('驳回知情变化：只改 pending，不写矩阵', async () => {
  const work = await createWork('驳回知情');
  await addChapter(work.id, { id: 'dismiss-ch', seq: 1 });
  await addCharacter(work.id, { id: 'dismiss-char', name: '司马懿' });
  await addFact(work.id, { id: 'dismiss-fact', content: '他见过密诏' });
  const pendingId = await addPending(work.id, 'dismiss-ch', {
    characterId: 'dismiss-char',
    factId: 'dismiss-fact',
  });

  const res = await server.request(
    `/api/pipeline/${work.id}/pending/knowledge/${pendingId}/dismiss`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 200);

  const pending = await db.get('SELECT status FROM knowledge_pending WHERE id = ?', [
    pendingId,
  ]);
  assert.equal(pending.status, 'dismissed');
  const rows = await db.all('SELECT * FROM knowledge_matrix WHERE work_id = ?', [work.id]);
  assert.equal(rows.length, 0);
});

test('锚点冲突：block 不能驳回，warn 可以', async () => {
  const work = await createWork('冲突驳回');
  await addChapter(work.id, { id: 'viol-ch', seq: 1 });
  for (const [id, severity] of [
    ['viol-block', 'block'],
    ['viol-warn', 'warn'],
  ]) {
    await db.run(
      `INSERT INTO anchor_violations
         (id, work_id, chapter_id, rule_type, severity, quote, offset_start, detail, dismissed, created_at)
       VALUES (?, ?, 'viol-ch', 'presence_forbidden', ?, '曹操端坐堂上。', 0, '', 0, ?)`,
      [id, work.id, severity, TS]
    );
  }

  const blocked = await server.request(`/api/pipeline/${work.id}/violations/viol-block/dismiss`, {
    method: 'POST',
  });
  assert.strictEqual(blocked.status, 409);

  const warn = await server.request(`/api/pipeline/${work.id}/violations/viol-warn/dismiss`, {
    method: 'POST',
  });
  assert.strictEqual(warn.status, 200);

  const list = await server.request(`/api/pipeline/${work.id}/pending`);
  const body = await list.json();
  assert.deepEqual(
    body.violations.map((v) => v.id),
    ['viol-block']
  );
});
