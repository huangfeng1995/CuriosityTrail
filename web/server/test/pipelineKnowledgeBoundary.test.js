'use strict';

/**
 * 知情边界只读视图：作者看到的必须和模型看到的一致。
 *
 * 关键语义：编辑第 N 章时只能看到 chapter_seq <= N-1 的状态，
 * 本章写完后才生效的记录不能提前显示，否则作者会以为 AI 已经知道了。
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

async function createWork(title, template = 'history_thriller') {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title, template },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function addChapter(workId, { id, seq, title = '第 3 章' }) {
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

async function addKnowledge(workId, characterId, factId, chapterSeq, state) {
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), workId, characterId, factId, chapterSeq, state, TS]
  );
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

test('第 N 章只看到 chapter_seq <= N-1 的状态', async () => {
  const work = await createWork('边界只读');
  await addChapter(work.id, { id: 'bd-ch', seq: 3 });
  await addCharacter(work.id, { id: 'bd-sima', name: '司马懿' });
  await addCharacter(work.id, { id: 'bd-cao', name: '曹操' });
  await addFact(work.id, { id: 'bd-f1', content: '司马懿曾向曹操举荐人才，此事后来被记入晋书。' });
  await addFact(work.id, { id: 'bd-f2', content: '曹操临终前留下一封未送出的密诏。' });

  // 第 2 章末尾已知 → 编辑第 3 章时可见
  await addKnowledge(work.id, 'bd-sima', 'bd-f1', 2, 'knows');
  // 第 3 章写完后才公开 → 编辑第 3 章时不可见
  await addKnowledge(work.id, 'bd-sima', 'bd-f2', 3, 'exposed');

  const res = await server.request(
    `/api/pipeline/${work.id}/knowledge/boundary?chapterId=bd-ch`
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.equal(body.chapterSeq, 3);
  assert.equal(body.chapterTitle, '第 3 章');

  const sima = body.characters.find((c) => c.name === '司马懿');
  assert.deepEqual(
    sima.known.map((f) => f.label),
    ['F1']
  );
  assert.deepEqual(
    sima.unknown.map((f) => f.label),
    ['F2']
  );
  assert.equal(sima.known[0].state, 'knows');

  const cao = body.characters.find((c) => c.name === '曹操');
  assert.equal(cao.known.length, 0);
  assert.equal(cao.unknown.length, 2);
});

test('短标题截断按句读断句，不留下孤立单字', async () => {
  const work = await createWork('短标题');
  await addChapter(work.id, { id: 'title-ch', seq: 1 });
  await addCharacter(work.id, { id: 'title-char', name: '司马懿' });
  await addFact(work.id, {
    id: 'title-f1',
    content: '司马懿曾向曹操举荐他，此后才有后面的故事。',
  });

  const res = await server.request(
    `/api/pipeline/${work.id}/knowledge/boundary?chapterId=title-ch`
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const sima = body.characters.find((c) => c.name === '司马懿');
  const title = sima.unknown[0].title;

  // 断在「，」前面，不能以标点结尾，也不能只剩一个孤立字
  assert.equal(title, '司马懿曾向曹操举荐他');
  assert.ok(!/[。，、；：！？]$/.test(title));
  assert.ok(!/。，、；：！？.$/.test(title));
});

test('模板未启用：boundary 返回 404', async () => {
  const work = await createWork('未启用边界', '');
  await addChapter(work.id, { id: 'off-ch', seq: 1 });

  const res = await server.request(
    `/api/pipeline/${work.id}/knowledge/boundary?chapterId=off-ch`
  );
  assert.strictEqual(res.status, 404);
});

test('章节不属于该作品：404', async () => {
  const work = await createWork('章节越界');
  const other = await createWork('别的作品');
  await addChapter(other.id, { id: 'other-ch', seq: 1 });

  const res = await server.request(
    `/api/pipeline/${work.id}/knowledge/boundary?chapterId=other-ch`
  );
  assert.strictEqual(res.status, 404);
});
