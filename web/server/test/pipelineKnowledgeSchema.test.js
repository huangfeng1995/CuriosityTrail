'use strict';

/**
 * HP5：schema 8 → 9、人物卡四字段、秘密/事实/知情矩阵/证据表。
 *
 * 迁移测试沿用 HP1 的做法：先造一个版本 8 的老库，再加载 database.js
 * 让增量迁移真实跑一遍；knowledgeAt 的边界按 P.6.3 在数据层断言。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sqlite3 = require('sqlite3');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const LEGACY_COUNTS = { works: 1, chapters: 1, characters: 1 };

function seedLegacyDb() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 8;

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        genre       TEXT,
        synopsis    TEXT,
        outline     TEXT,
        template    TEXT NOT NULL DEFAULT '',
        target_words INTEGER DEFAULT 0,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE chapters (
        id          TEXT PRIMARY KEY,
        work_id     TEXT NOT NULL,
        title       TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        volume      TEXT,
        status      TEXT DEFAULT 'draft',
        content     TEXT,
        blocks      TEXT,
        outline     TEXT,
        word_count  INTEGER DEFAULT 0,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      -- v8 的人物卡：没有 canon / stance / bottom_line / weakness
      CREATE TABLE characters (
        id          TEXT PRIMARY KEY,
        work_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        aliases     TEXT,
        role        TEXT,
        identity    TEXT,
        personality TEXT,
        speech      TEXT,
        goal        TEXT,
        arc         TEXT,
        relations   TEXT,
        notes       TEXT,
        source_chapter_id TEXT,
        source_block_id   TEXT,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      INSERT INTO works
        (id, user_id, title, genre, synopsis, outline, template, target_words, created_at, modified_at)
      VALUES
        ('legacy-work-1', NULL, '旧作品', '悬疑', '迁移前数据', '', '', 0,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO chapters
        (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
      VALUES
        ('legacy-ch-1', 'legacy-work-1', '第一章', 1, '', 'draft', '旧正文', '[]', '', 0,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO characters
        (id, work_id, name, aliases, created_at, modified_at)
      VALUES
        ('legacy-c-1', 'legacy-work-1', '陈默', '',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      `,
      (err) => {
        raw.close();
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

let db;
let app;
let server;
let knowledgeAt;
let workId;
let characterId;
let migratedCounts;

test.before(async () => {
  await seedLegacyDb();

  db = require('../database');
  await db.ready;
  app = require('../app');
  ({ knowledgeAt } = require('../services/pipeline/knowledge'));

  // 迁移刚完成、测试尚未造新数据时记下行数
  migratedCounts = {};
  for (const table of Object.keys(LEGACY_COUNTS)) {
    migratedCounts[table] = (await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c;
  }

  server = await startServer(app);

  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: '知情矩阵作品', genre: '历史', template: 'history_thriller' },
  });
  assert.strictEqual(created.status, 200);
  const work = await created.json();
  workId = work.id;

  const charRes = await server.request('/api/characters', {
    method: 'POST',
    body: {
      workId,
      name: '杨俊',
      role: '校事',
      canon: '史实人物，早年经历为虚构',
      stance: '忠于司空',
      bottom_line: '不出卖同僚',
      weakness: '护短',
    },
  });
  assert.strictEqual(charRes.status, 200);
  const character = await charRes.json();
  characterId = character.id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test('迁移：user_version 8 → 13，行数不变，四列默认 NULL，新表存在', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 13);

  for (const [table, expected] of Object.entries(LEGACY_COUNTS)) {
    assert.strictEqual(migratedCounts[table], expected, `${table} 迁移后行数不能变化`);
  }

  const columns = await db.all('PRAGMA table_info(characters)');
  for (const name of ['canon', 'stance', 'bottom_line', 'weakness']) {
    const col = columns.find((c) => c.name === name);
    assert.ok(col, `characters 应补上 ${name}`);
    assert.strictEqual(col.notnull, 0, `${name} 必须允许 NULL`);
    assert.strictEqual(col.dflt_value, null, `${name} 不能有默认值`);
  }

  const legacy = await db.get('SELECT * FROM characters WHERE id = ?', ['legacy-c-1']);
  for (const name of ['canon', 'stance', 'bottom_line', 'weakness']) {
    assert.strictEqual(legacy[name], null, `老行 ${name} 必须是 NULL`);
  }

  const tables = await db.all(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN
       ('story_secrets','story_facts','knowledge_matrix','evidence_items','knowledge_pending')`
  );
  assert.strictEqual(tables.length, 5, '秘密/事实/矩阵/证据/待确认五表都应创建');
});

// ---------------------------------------------------------------------------
// 人物卡四字段透传
// ---------------------------------------------------------------------------

test('人物卡四字段：新增可写、读取原样返回、编辑可改', async () => {
  const rows = await (await server.request(`/api/characters?workId=${workId}`)).json();
  const created = rows.find((r) => r.id === characterId);
  assert.strictEqual(created.canon, '史实人物，早年经历为虚构');
  assert.strictEqual(created.stance, '忠于司空');
  assert.strictEqual(created.bottom_line, '不出卖同僚');
  assert.strictEqual(created.weakness, '护短');

  const updated = await server.request(`/api/characters/${characterId}`, {
    method: 'PUT',
    body: { stance: '动摇，开始替自己留后路', weakness: '多疑' },
  });
  assert.strictEqual(updated.status, 200);

  const after = await db.get('SELECT * FROM characters WHERE id = ?', [characterId]);
  assert.strictEqual(after.stance, '动摇，开始替自己留后路');
  assert.strictEqual(after.weakness, '多疑');
  assert.strictEqual(after.canon, '史实人物，早年经历为虚构', '未提交的字段保持原值');
});

test('人物卡四字段：不填时保持 NULL，不产生空串', async () => {
  const res = await server.request('/api/characters', {
    method: 'POST',
    body: { workId, name: '无名校事' },
  });
  assert.strictEqual(res.status, 200);
  const character = await res.json();

  const row = await db.get('SELECT * FROM characters WHERE id = ?', [character.id]);
  assert.strictEqual(row.canon, null);
  assert.strictEqual(row.stance, null);
  assert.strictEqual(row.bottom_line, null);
  assert.strictEqual(row.weakness, null);
});

// ---------------------------------------------------------------------------
// knowledgeAt：边界按 P.6.3
// ---------------------------------------------------------------------------

async function seedFactWithKnowledge(seq) {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO story_secrets (id, work_id, title, content, status, created_at, modified_at)
     VALUES ('secret-1', ?, '押人计划', '杨俊此行是替司空来押人', 'active', ?, ?)`,
    [workId, now, now]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, content, keywords, created_at, modified_at)
     VALUES ('fact-1', ?, 'secret-1', '杨俊此行是替司空来押人，不是升迁', '押人,司空', ?, ?)`,
    [workId, now, now]
  );
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES ('km-1', ?, ?, 'fact-1', ?, 'knows', ?)`,
    [workId, characterId, seq, now]
  );
}

test('knowledgeAt：chapter_seq=3 的行在第 2、3 章不可见，第 4 章可见', async () => {
  await seedFactWithKnowledge(3);

  assert.deepStrictEqual(await knowledgeAt(workId, 2), [], '第 2 章只能读到 <=1');
  assert.deepStrictEqual(await knowledgeAt(workId, 3), [], '第 3 章只能读到 <=2');
  const visible = await knowledgeAt(workId, 4);
  assert.strictEqual(visible.length, 1, '第 4 章应读到 <=3');
  assert.strictEqual(visible[0].fact_id, 'fact-1');
  assert.strictEqual(visible[0].state, 'knows');
});

test('knowledgeAt：同一事实取可见行里章序最大的一条', async () => {
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES ('km-2', ?, ?, 'fact-1', 5, 'exposed', ?)`,
    [workId, characterId, now]
  );

  const visible = await knowledgeAt(workId, 6);
  assert.strictEqual(visible.length, 1, '同一角色同一事实只返回最新状态');
  assert.strictEqual(visible[0].id, 'km-2');
  assert.strictEqual(visible[0].state, 'exposed');

  const before = await knowledgeAt(workId, 5);
  assert.strictEqual(before[0].id, 'km-1', '还没写到第 5 章结束时，仍是第 3 章的状态');
});

// ---------------------------------------------------------------------------
// 唯一约束
// ---------------------------------------------------------------------------

test('knowledge_matrix：同一角色/事实/章序重复落行被唯一约束拒绝', async () => {
  const now = new Date().toISOString();
  await assert.rejects(
    db.run(
      `INSERT INTO knowledge_matrix
         (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
       VALUES ('km-duplicate', ?, ?, 'fact-1', 3, 'suspects', ?)`,
      [workId, characterId, now]
    ),
    /UNIQUE constraint failed/i
  );
});
