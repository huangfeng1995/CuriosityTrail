'use strict';

/**
 * 真实 v17 形态老库：chapters 没有摘要列。
 *
 * v18 只给 chapters 补三列空值（summary / summary_words / summary_updated_at），
 * 不重建表、不碰正文与既有字段，也不需要新索引。
 * 这个文件盯的是：老章节一行不丢、正文逐字不变、二次启动不再迁移。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const WORK_ID = 'w-v17';
const CHAPTER_ID = 'c-v17';
const CHAPTER_BODY = '雨落在青石板上，巷口没有一个人。林砚把伞靠在门边。';

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV17Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 17;

      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        phone      TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO users (id, phone, created_at)
      VALUES ('u-v17', '13800000017', '2026-01-01T00:00:00.000Z');

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
      INSERT INTO works (id, user_id, title, created_at, modified_at)
      VALUES ('${WORK_ID}', 'u-v17', '迁移前就存在的作品',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      -- v17 时代的章节表：没有 summary 三列
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
      INSERT INTO chapters
        (id, work_id, title, seq, volume, status, content, blocks, outline,
         word_count, created_at, modified_at)
      VALUES ('${CHAPTER_ID}', '${WORK_ID}', '第一章', 1, '第一卷', 'done',
              '${CHAPTER_BODY}', '[]', '作者原来写的大纲', 120,
              '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
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
  await seedV17Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v17 真实形态：补上摘要三列，老章节正文与字段逐项不变', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 21, '迁移后版本应为 21');

  const columns = await db.all('PRAGMA table_info(chapters)');
  const names = columns.map((c) => c.name);
  for (const column of ['summary', 'summary_words', 'summary_updated_at']) {
    assert.ok(names.includes(column), `chapters 应补上 ${column}`);
  }
  const wordsCol = columns.find((c) => c.name === 'summary_words');
  assert.strictEqual(wordsCol.dflt_value, '0', 'summary_words 默认 0');

  const row = await db.get('SELECT * FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.ok(row, '老章节不能丢');
  assert.strictEqual(row.title, '第一章');
  assert.strictEqual(row.content, CHAPTER_BODY, '正文必须逐字保留');
  assert.strictEqual(row.volume, '第一卷');
  assert.strictEqual(row.status, 'done');
  assert.strictEqual(row.outline, '作者原来写的大纲');
  assert.strictEqual(row.word_count, 120);
  assert.strictEqual(row.summary, null, '老章不回填摘要');
  assert.strictEqual(row.summary_words, 0);
  assert.strictEqual(row.summary_updated_at, null);
});

test('v17 真实形态：摘要可写入并读回，行数不变', async () => {
  const summary = JSON.stringify({
    progress: '林砚在雨夜进城隍庙查旧案。',
    open_threads: '旧案卷宗是谁藏的',
    setting: '雨夜，青石巷',
    characters: ['林砚'],
  });
  const ts = '2026-03-01T00:00:00.000Z';

  await db.run(
    'UPDATE chapters SET summary = ?, summary_words = ?, summary_updated_at = ? WHERE id = ?',
    [summary, 450, ts, CHAPTER_ID]
  );

  const row = await db.get(
    'SELECT summary, summary_words, summary_updated_at FROM chapters WHERE id = ?',
    [CHAPTER_ID]
  );
  assert.strictEqual(JSON.parse(row.summary).progress, '林砚在雨夜进城隍庙查旧案。');
  assert.strictEqual(row.summary_words, 450);
  assert.strictEqual(row.summary_updated_at, ts);

  const count = await db.get('SELECT COUNT(*) AS c FROM chapters');
  assert.strictEqual(count.c, 1, '章节行数不能变化');
});

test('v17 真实形态：二次启动幂等，摘要不被清空', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 21);

  const row = await db.get('SELECT summary, summary_words FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.match(row.summary, /旧案/, '二次启动后摘要不能丢');
  assert.strictEqual(row.summary_words, 450);
});
