'use strict';

/**
 * 真实 v18 形态老库：已升级到章节摘要，但还没有 setting_risks。
 *
 * v19 只新增一张空表与一个索引，不重建任何已有表：
 * 作品、章节、正文、摘要必须逐项保留；二次启动不再迁移。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const WORK_ID = 'w-v18';
const CHAPTER_ID = 'c-v18';
const CHAPTER_BODY = '雪落在城头，杨平把密诏藏进袖中。';
const SUMMARY = JSON.stringify({
  progress: '杨平拿到密诏。',
  open_threads: '密诏何时暴露',
  setting: '雪夜城头',
  characters: ['杨平'],
});

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV18Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 18;

      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        phone      TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO users (id, phone, created_at)
      VALUES ('u-v18', '13800000018', '2026-01-01T00:00:00.000Z');

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        template    TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
      INSERT INTO works (id, user_id, title, template, created_at, modified_at)
      VALUES ('${WORK_ID}', 'u-v18', '迁移前就存在的作品', 'history_thriller',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      CREATE TABLE chapters (
        id                 TEXT PRIMARY KEY,
        work_id            TEXT NOT NULL,
        title              TEXT NOT NULL,
        seq                INTEGER NOT NULL,
        volume             TEXT,
        status             TEXT DEFAULT 'draft',
        content            TEXT,
        blocks             TEXT,
        outline            TEXT,
        summary            TEXT,
        summary_words      INTEGER DEFAULT 0,
        summary_updated_at TEXT,
        word_count         INTEGER DEFAULT 0,
        created_at         TEXT NOT NULL,
        modified_at        TEXT NOT NULL
      );
      INSERT INTO chapters
        (id, work_id, title, seq, volume, status, content, blocks, outline,
         summary, summary_words, summary_updated_at, word_count, created_at, modified_at)
      VALUES ('${CHAPTER_ID}', '${WORK_ID}', '第一章', 1, '第一卷', 'done',
              '${CHAPTER_BODY}', '[]', '作者原来写的大纲',
              '${SUMMARY.replace(/'/g, "''")}', 260, '2026-02-01T00:00:00.000Z', 120,
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
  await seedV18Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v18 真实形态：新增 setting_risks，老作品/章节/摘要逐项不变', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 21, '迁移后版本应为 21');

  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'setting_risks'"
  );
  assert.ok(table, 'setting_risks 必须存在');

  const index = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_setting_risks_work'"
  );
  assert.ok(index, '索引必须在补列之后建好');

  const planTable = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_plans'"
  );
  assert.ok(planTable, 'chapter_plans 必须存在（v20 与 v19 一并执行）');

  const chapter = await db.get('SELECT * FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.strictEqual(chapter.content, CHAPTER_BODY, '正文必须逐字保留');
  assert.strictEqual(chapter.outline, '作者原来写的大纲');
  assert.deepStrictEqual(JSON.parse(chapter.summary).open_threads, '密诏何时暴露');
  assert.strictEqual(chapter.summary_words, 260);

  const work = await db.get('SELECT title, template FROM works WHERE id = ?', [WORK_ID]);
  assert.strictEqual(work.title, '迁移前就存在的作品');
  assert.strictEqual(work.template, 'history_thriller');

  const count = await db.get('SELECT COUNT(*) AS c FROM setting_risks');
  assert.strictEqual(count.c, 0, '新表只能是空表');
});

test('v18 真实形态：二次启动幂等，摘要与风险表不被清空', async () => {
  await db.run(
    `INSERT INTO setting_risks
       (id, work_id, category, title, detail, earliest_break_chapter, fix, severity,
        status, created_at, modified_at)
     VALUES ('r1', ?, 'time', '时间线冲突', '因为两章相隔三日，与七日路程设定冲突。', 3,
             '延长行程', 'warn', 'open', '2026-03-01T00:00:00.000Z',
             '2026-03-01T00:00:00.000Z')`,
    [WORK_ID]
  );

  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');
  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 21);

  const risk = await db.get('SELECT title FROM setting_risks WHERE id = ?', ['r1']);
  assert.strictEqual(risk.title, '时间线冲突');
  const chapter = await db.get('SELECT summary FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.match(chapter.summary, /密诏/);
});
