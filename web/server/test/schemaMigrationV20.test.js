'use strict';

/**
 * 真实 v19 形态老库：已有设定风险清单，但还没有 chapter_plans。
 *
 * v20 只新增一张空表与一个索引：风险条目、作品、章节、摘要必须逐项保留；
 * 二次启动不再迁移，已有拍表行不被清空。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const WORK_ID = 'w-v19';
const CHAPTER_ID = 'c-v19';
const RISK_ID = 'r-v19';
const CHAPTER_BODY = '杨平把密诏藏进袖中，转身走进雪里。';
const SUMMARY = JSON.stringify({
  progress: '杨平带着密诏离府。',
  open_threads: '密诏何时暴露',
  setting: '雪夜长街',
  characters: ['杨平'],
});

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV19Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 19;

      CREATE TABLE users (
        id         TEXT PRIMARY KEY,
        phone      TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO users (id, phone, created_at)
      VALUES ('u-v19', '13800000019', '2026-01-01T00:00:00.000Z');

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        template    TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );
      INSERT INTO works (id, user_id, title, template, created_at, modified_at)
      VALUES ('${WORK_ID}', 'u-v19', '迁移前的作品', 'history_thriller',
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
              '${CHAPTER_BODY}', '[]', '作者的大纲',
              '${SUMMARY.replace(/'/g, "''")}', 300, '2026-02-01T00:00:00.000Z', 140,
              '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

      CREATE TABLE setting_risks (
        id            TEXT PRIMARY KEY,
        work_id       TEXT NOT NULL,
        category      TEXT NOT NULL CHECK (category IN ('institution','evidence','time','human')),
        title         TEXT NOT NULL,
        detail        TEXT NOT NULL,
        earliest_break_chapter INTEGER,
        fix           TEXT,
        severity      TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('block','warn')),
        anchor_id     TEXT,
        status        TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','accepted','dismissed')),
        created_at    TEXT NOT NULL,
        modified_at   TEXT NOT NULL
      );
      INSERT INTO setting_risks
        (id, work_id, category, title, detail, earliest_break_chapter, fix, severity,
         anchor_id, status, created_at, modified_at)
      VALUES ('${RISK_ID}', '${WORK_ID}', 'time', '三日路程不成立',
              '因为两地车程需七日，第三章却要当日往返，时间线冲突。', 3,
              '延长行程', 'warn', NULL, 'open',
              '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
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
  await seedV19Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v19 真实形态：新增 chapter_plans，风险/作品/章节/摘要逐项不变', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 21, '迁移后版本应为 21');

  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_plans'"
  );
  assert.ok(table, 'chapter_plans 必须存在');

  const index = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_chapter_plans_chapter'"
  );
  assert.ok(index, 'chapter_plans 索引必须在补列之后建好');

  const planCount = await db.get('SELECT COUNT(*) AS c FROM chapter_plans');
  assert.strictEqual(planCount.c, 0, '新表只能是空表');

  const risk = await db.get('SELECT * FROM setting_risks WHERE id = ?', [RISK_ID]);
  assert.strictEqual(risk.title, '三日路程不成立');
  assert.strictEqual(risk.status, 'open', '老风险条目不能丢、状态不能变');

  const chapter = await db.get('SELECT * FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.strictEqual(chapter.content, CHAPTER_BODY);
  assert.deepStrictEqual(JSON.parse(chapter.summary).open_threads, '密诏何时暴露');
  assert.strictEqual(chapter.summary_words, 300);
});

test('v19 真实形态：二次启动幂等，拍表与风险都不被清空', async () => {
  await db.run(
    `INSERT INTO chapter_plans
       (id, work_id, chapter_id, plan, brief, status, options, chosen,
        outline_hash, body_hash, created_at, updated_at)
     VALUES ('p1', ?, ?, '{"mainType":"揭示","beats":[]}', NULL, 'confirmed', '[]', NULL,
             'outline-hash', 'body-hash', '2026-03-02T00:00:00.000Z',
             '2026-03-02T00:00:00.000Z')`,
    [WORK_ID, CHAPTER_ID]
  );

  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');
  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 21);

  const plan = await db.get('SELECT status FROM chapter_plans WHERE id = ?', ['p1']);
  assert.strictEqual(plan.status, 'confirmed');
  const risk = await db.get('SELECT title FROM setting_risks WHERE id = ?', [RISK_ID]);
  assert.strictEqual(risk.title, '三日路程不成立');
  const chapter = await db.get('SELECT summary FROM chapters WHERE id = ?', [CHAPTER_ID]);
  assert.match(chapter.summary, /密诏/);
});
