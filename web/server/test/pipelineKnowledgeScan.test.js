'use strict';

/**
 * HP7：知情扫描与证据句闸门（P.6.5 / PV8）。
 *
 * 主场景：
 *   1. suspects 证据句逐字命中 → 自动落库
 *   2. 证据句不存在 → 进 pending，不落库
 *   3. 跳级（unknown→knows）→ 进 pending
 *   4. knows 校验全过 → 仍然只进 pending（静默失效守卫）
 *   5. exposed 不自动落库、不扩散到其他角色
 *   6. 扫描失败 → 零写入，旧边界不变
 *   7. chapterSeq 与章节不一致 → 4xx，零写入
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let app;
let server;
let userId;
// 业务模块必须在 setupTempEnv() 之后加载：config.js 在加载时就固化 DATA_DIR
// 与短信开发模式，提前 require 会让登录走真实短信从而 503。
let scanKnowledge;
let ScanInputError;

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

async function addCharacter(workId, { id, name, aliases = '' }) {
  await db.run(
    `INSERT INTO characters
       (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, workId, name, aliases, TS, TS]
  );
}

async function addFact(workId, { id, content, keywords = '' }) {
  await db.run(
    `INSERT INTO story_facts
       (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    [id, workId, content, keywords, TS, TS]
  );
}

async function addKnowledge(workId, characterId, factId, chapterSeq, state) {
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [require('crypto').randomUUID(), workId, characterId, factId, chapterSeq, state, TS]
  );
}

function fakeProvider(transitions) {
  return {
    chat: async () => ({ content: JSON.stringify({ transitions }) }),
  };
}

function brokenProvider() {
  return {
    chat: async () => {
      throw new Error('provider down');
    },
  };
}

async function matrixRows(workId, seq) {
  return db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? AND chapter_seq = ?',
    [workId, seq]
  );
}

async function pendingRows(workId) {
  return db.all(
    "SELECT * FROM knowledge_pending WHERE work_id = ? AND status = 'pending'",
    [workId]
  );
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  app = require('../app');
  ({ scanKnowledge, ScanInputError } = require('../services/pipeline/knowledgeScan'));
  server = await startServer(app);
  const row = await db.get('SELECT id FROM users WHERE phone = ?', ['13900000001']);
  userId = row.id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 1. 证据句逐字命中 → 自动落库
// ---------------------------------------------------------------------------

test('证据句逐字命中：自动写入 knowledge_matrix，chapter_seq=本章', async () => {
  const work = await createWork('扫描命中');
  await addChapter(work.id, { id: 'hit-ch', seq: 1 });
  await addCharacter(work.id, { id: 'hit-sima', name: '司马懿' });
  await addFact(work.id, { id: 'hit-f1', content: '司马懿见过密诏', keywords: '密诏' });

  const text = '夜里，司马懿见过密诏后沉默不语。';
  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'hit-ch',
    chapterSeq: 1,
    text,
    provider: fakeProvider([
      {
        character: '司马懿',
        factId: 'F1',
        toState: 'suspects',
        evidence: '司马懿见过密诏',
      },
    ]),
  });

  assert.strictEqual(result.failed, false);
  assert.strictEqual(result.applied.length, 1);
  assert.strictEqual(result.pending.length, 0);
  assert.strictEqual(result.knowledgePendingCount, 0);
  const rows = await matrixRows(work.id, 1);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].state, 'suspects');
  assert.strictEqual(rows[0].chapter_seq, 1);
  assert.strictEqual((await pendingRows(work.id)).length, 0);
});

// ---------------------------------------------------------------------------
// 2. 证据句不存在 → pending，不落库
// ---------------------------------------------------------------------------

test('证据句不在正文中：进 pending，不写 knowledge_matrix', async () => {
  const work = await createWork('扫描证据缺失');
  await addChapter(work.id, { id: 'noev-ch', seq: 1 });
  await addCharacter(work.id, { id: 'noev-sima', name: '司马懿' });
  await addFact(work.id, { id: 'noev-f1', content: '司马懿见过密诏' });

  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'noev-ch',
    chapterSeq: 1,
    text: '夜里，司马懿见过书信后沉默不语。',
    provider: fakeProvider([
      {
        character: '司马懿',
        factId: 'F1',
        toState: 'suspects',
        evidence: '司马懿见过密诏',
      },
    ]),
  });

  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.pending.length, 1);
  assert.strictEqual(result.pending[0].reason, '证据句不在正文中');
  assert.strictEqual((await matrixRows(work.id, 1)).length, 0);
  const pending = await pendingRows(work.id);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].status, 'pending');
});

// ---------------------------------------------------------------------------
// 3. 跳级 → pending
// ---------------------------------------------------------------------------

test('跳级（unknown → knows）：进 pending，不写 knowledge_matrix', async () => {
  const work = await createWork('扫描跳级');
  await addChapter(work.id, { id: 'jump-ch', seq: 1 });
  await addCharacter(work.id, { id: 'jump-sima', name: '司马懿' });
  await addFact(work.id, { id: 'jump-f1', content: '司马懿见过密诏' });

  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'jump-ch',
    chapterSeq: 1,
    text: '司马懿见过密诏，脸色骤变。',
    provider: fakeProvider([
      {
        character: '司马懿',
        factId: 'F1',
        toState: 'knows',
        evidence: '司马懿见过密诏',
      },
    ]),
  });

  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.pending.length, 1);
  assert.strictEqual(result.pending[0].reason, '跳级');
  assert.strictEqual((await matrixRows(work.id, 1)).length, 0);
});

// ---------------------------------------------------------------------------
// 4. knows 校验全过 → 仍然只进 pending（静默失效守卫）
// ---------------------------------------------------------------------------

test('knows 校验全过：仍然只进 pending，不写 knowledge_matrix', async () => {
  const work = await createWork('扫描确知需确认');
  await addChapter(work.id, { id: 'know-ch', seq: 2 });
  await addCharacter(work.id, { id: 'know-sima', name: '司马懿' });
  await addFact(work.id, { id: 'know-f1', content: '司马懿见过密诏' });
  // 上一章已经是半知，这次 partial → knows 正好升一级，四条校验全过。
  await addKnowledge(work.id, 'know-sima', 'know-f1', 1, 'partial');

  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'know-ch',
    chapterSeq: 2,
    text: '司马懿见过密诏，终于确认是真的。',
    provider: fakeProvider([
      {
        character: '司马懿',
        factId: 'F1',
        toState: 'knows',
        evidence: '司马懿见过密诏',
      },
    ]),
  });

  assert.strictEqual(result.failed, false);
  assert.strictEqual(result.applied.length, 0, '「已知」不能静默自动落库');
  assert.strictEqual(result.pending.length, 1);
  assert.strictEqual(result.knowledgePendingCount, 1);
  assert.strictEqual(result.pending[0].reason, '需作者确认：knows 不能自动生效');
  assert.strictEqual((await matrixRows(work.id, 2)).length, 0, '绝不能写 knowledge_matrix');
  assert.strictEqual((await pendingRows(work.id)).length, 1);
});

// ---------------------------------------------------------------------------
// 5. exposed 不自动落库、不扩散到其他角色
// ---------------------------------------------------------------------------

test('exposed 只进 pending，不落库、不扩散到其他角色', async () => {
  const work = await createWork('扫描不扩散');
  await addChapter(work.id, { id: 'spread-ch', seq: 2 });
  await addCharacter(work.id, { id: 'spread-sima', name: '司马懿' });
  await addCharacter(work.id, { id: 'spread-yang', name: '杨平' });
  await addFact(work.id, { id: 'spread-f1', content: '司马懿见过密诏' });
  await addKnowledge(work.id, 'spread-sima', 'spread-f1', 1, 'knows');

  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'spread-ch',
    chapterSeq: 2,
    text: '司马懿当众念出密诏，满座哗然。',
    provider: fakeProvider([
      {
        character: '司马懿',
        factId: 'F1',
        toState: 'exposed',
        evidence: '司马懿当众念出密诏',
      },
    ]),
  });

  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.pending.length, 1);
  assert.strictEqual(result.knowledgePendingCount, 1);
  assert.strictEqual(result.pending[0].reason, '需作者确认：exposed 不能自动生效');
  assert.strictEqual((await matrixRows(work.id, 2)).length, 0);

  // 杨平没有在正文里看到/被告知，任何一张表都不该出现他的行。
  const yangRows = await db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? AND character_id = ?',
    [work.id, 'spread-yang']
  );
  assert.strictEqual(yangRows.length, 0);
  const yangPending = await db.all(
    'SELECT * FROM knowledge_pending WHERE work_id = ? AND character_id = ?',
    [work.id, 'spread-yang']
  );
  assert.strictEqual(yangPending.length, 0, 'exposed 不得扩散出其他角色的 pending');
});

// ---------------------------------------------------------------------------
// 6. 扫描失败 → 零写入，旧边界不变
// ---------------------------------------------------------------------------

test('扫描失败：零写入，旧边界保持不变', async () => {
  const work = await createWork('扫描失败');
  await addChapter(work.id, { id: 'fail-ch', seq: 2 });
  await addCharacter(work.id, { id: 'fail-sima', name: '司马懿' });
  await addFact(work.id, { id: 'fail-f1', content: '司马懿见过密诏' });
  await addKnowledge(work.id, 'fail-sima', 'fail-f1', 1, 'knows');

  const before = await db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? ORDER BY chapter_seq ASC, id ASC',
    [work.id]
  );

  const result = await scanKnowledge({
    workId: work.id,
    chapterId: 'fail-ch',
    chapterSeq: 2,
    text: '司马懿见过密诏，脸色骤变。',
    provider: brokenProvider(),
  });

  assert.strictEqual(result.failed, true);
  assert.strictEqual(result.applied.length, 0);
  assert.strictEqual(result.pending.length, 0);

  const after = await db.all(
    'SELECT * FROM knowledge_matrix WHERE work_id = ? ORDER BY chapter_seq ASC, id ASC',
    [work.id]
  );
  assert.deepStrictEqual(
    after.map((r) => `${r.chapter_seq}:${r.state}`),
    before.map((r) => `${r.chapter_seq}:${r.state}`),
    '旧边界不能被失败扫描改动'
  );
  assert.strictEqual((await pendingRows(work.id)).length, 0);
});

// ---------------------------------------------------------------------------
// 7. chapterSeq 与章节不一致 → 400，零写入
// ---------------------------------------------------------------------------

test('chapterSeq 与章节不一致：拒绝请求，零写入', async () => {
  const work = await createWork('扫描章号不符');
  await addChapter(work.id, { id: 'seq-ch', seq: 2 });
  await addCharacter(work.id, { id: 'seq-sima', name: '司马懿' });
  await addFact(work.id, { id: 'seq-f1', content: '司马懿见过密诏' });

  await assert.rejects(
    () =>
      scanKnowledge({
        workId: work.id,
        chapterId: 'seq-ch',
        chapterSeq: 9,
        text: '司马懿见过密诏。',
        provider: fakeProvider([
          {
            character: '司马懿',
            factId: 'F1',
            toState: 'suspects',
            evidence: '司马懿见过密诏',
          },
        ]),
      }),
    (err) => {
      assert.ok(err instanceof ScanInputError);
      assert.strictEqual(err.status, 400);
      assert.match(err.message, /chapterSeq 与章节不一致/);
      return true;
    }
  );

  assert.strictEqual((await matrixRows(work.id, 2)).length, 0);
  assert.strictEqual((await pendingRows(work.id)).length, 0);
});
