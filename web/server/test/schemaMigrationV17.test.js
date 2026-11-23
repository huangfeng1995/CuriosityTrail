'use strict';

/**
 * 真实 v16 形态老库：card_proposals 的 CHECK 只允许 character/setting/plot。
 *
 * v17 放开第四种 kind（inspiration）。SQLite 改不了 CHECK，只能重建表，
 * 所以这个文件盯的是重建路径本身：老提案一行不能丢、字段原样保留、
 * 两个索引重建后仍在、二次启动不再重复重建。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const WORK_ID = 'w-v16';
const OLD_PROPOSALS = [
  {
    id: 'p-v16-1',
    kind: 'character',
    title: '林砚',
    content: '冒雨进庙查旧案的年轻人',
    payload: '{"role":"查案人"}',
    source_quote: '林砚把伞靠在门边',
    status: 'pending',
    block_id: 'b1',
    origin_ref: 'msg-1',
    card_id: '',
  },
  {
    id: 'p-v16-2',
    kind: 'plot',
    title: '发现旧案卷宗',
    content: '林砚在供桌下翻出一卷旧案',
    payload: '{}',
    source_quote: '翻出一卷旧案',
    status: 'confirmed',
    block_id: null,
    origin_ref: 'msg-0',
    card_id: 'pc-1',
  },
];

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV16Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 16;

      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        phone      TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO users (id, phone, created_at)
      VALUES ('u-v16', '13800000016', '2026-01-01T00:00:00.000Z');

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
      INSERT INTO works (id, user_id, title, created_at, modified_at)
      VALUES ('${WORK_ID}', 'u-v16', '迁移前就存在的作品',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      -- v16 时代的提案表：CHECK 里没有 inspiration
      CREATE TABLE card_proposals (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        work_id      TEXT NOT NULL,
        chapter_id   TEXT,
        block_id     TEXT,
        origin_ref   TEXT DEFAULT '',
        kind         TEXT NOT NULL CHECK (kind IN ('character','setting','plot')),
        title        TEXT NOT NULL,
        content      TEXT,
        payload      TEXT,
        source_quote TEXT,
        status       TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','confirmed','dismissed')),
        card_id      TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX idx_card_proposals_work
        ON card_proposals(work_id, status, created_at);
      CREATE INDEX idx_card_proposals_origin
        ON card_proposals(user_id, origin_ref, status);

      ${OLD_PROPOSALS.map(
        (p) => `INSERT INTO card_proposals
          (id, user_id, work_id, chapter_id, block_id, origin_ref, kind, title,
           content, payload, source_quote, status, card_id, created_at, updated_at)
        VALUES ('${p.id}', 'u-v16', '${WORK_ID}', NULL, ${
          p.block_id ? `'${p.block_id}'` : 'NULL'
        }, '${p.origin_ref}', '${p.kind}', '${p.title}', '${p.content}',
                '${p.payload}', '${p.source_quote}', '${p.status}',
                ${p.card_id ? `'${p.card_id}'` : "''"},
                '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');`
      ).join('\n')}
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

test.before(async () => {
  await seedV16Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v16 真实形态：重建后放开 inspiration，老提案一行不丢', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 17, '迁移后版本应为 17');

  const table = await db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'card_proposals'"
  );
  assert.match(table.sql, /'inspiration'/, 'CHECK 应包含 inspiration');
  assert.match(table.sql, /'character'/, '原有 kind 不能丢');

  const rows = await db.all('SELECT * FROM card_proposals ORDER BY id');
  assert.strictEqual(rows.length, OLD_PROPOSALS.length, '老提案不能丢行');
  for (const expected of OLD_PROPOSALS) {
    const actual = rows.find((r) => r.id === expected.id);
    assert.ok(actual, `提案 ${expected.id} 应保留`);
    assert.strictEqual(actual.kind, expected.kind);
    assert.strictEqual(actual.title, expected.title);
    assert.strictEqual(actual.content, expected.content);
    assert.strictEqual(actual.payload, expected.payload);
    assert.strictEqual(actual.source_quote, expected.source_quote);
    assert.strictEqual(actual.status, expected.status);
    assert.strictEqual(actual.block_id, expected.block_id);
    assert.strictEqual(actual.origin_ref, expected.origin_ref);
    assert.strictEqual(actual.card_id, expected.card_id);
    assert.strictEqual(actual.updated_at, '2026-01-02T00:00:00.000Z');
  }
});

test('v16 真实形态：重建后两个索引都在', async () => {
  const indexes = (await db.all('PRAGMA index_list(card_proposals)')).map((i) => i.name);
  assert.ok(indexes.includes('idx_card_proposals_work'), '按作品的索引应补建');
  assert.ok(indexes.includes('idx_card_proposals_origin'), '按来源的索引应补建');
});

test('v16 真实形态：新 CHECK 接受 inspiration，仍拒绝未知 kind', async () => {
  const ts = '2026-02-01T00:00:00.000Z';
  await db.run(
    `INSERT INTO card_proposals
       (id, user_id, work_id, chapter_id, block_id, origin_ref, kind, title,
        content, payload, source_quote, status, card_id, created_at, updated_at)
     VALUES ('p-v17-1', 'u-v16', ?, NULL, NULL, 'msg-2', 'inspiration',
             '伞骨像一截旧年表', '雨声里数伞骨，可以当第二卷的意象', '{"tags":"伏笔"}',
             '', 'pending', '', ?, ?)`,
    [WORK_ID, ts, ts]
  );

  const row = await db.get('SELECT kind, title FROM card_proposals WHERE id = ?', ['p-v17-1']);
  assert.strictEqual(row.kind, 'inspiration');

  await assert.rejects(
    db.run(
      `INSERT INTO card_proposals
         (id, user_id, work_id, kind, title, status, created_at, updated_at)
       VALUES ('p-v17-bad', 'u-v16', ?, 'unknown', '不存在的类型', 'pending', ?, ?)`,
      [WORK_ID, ts, ts]
    ),
    /CHECK/,
    '未知 kind 仍应被 CHECK 拒绝'
  );
});

test('v16 真实形态：二次启动幂等，不重复重建也不丢行', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 17);

  const count = await db.get('SELECT COUNT(*) AS c FROM card_proposals');
  assert.strictEqual(count.c, OLD_PROPOSALS.length + 1, '二次启动后提案行数不能变化');

  const table = await db.get(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'card_proposals'"
  );
  assert.match(table.sql, /'inspiration'/, '二次启动不应把表退回旧 CHECK');
});
