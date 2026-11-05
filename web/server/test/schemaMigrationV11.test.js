'use strict';

/**
 * 真实 v11 形态老库：表已存在，但缺 v12/v13 补的列。
 *
 * 线上 v11 的 work_anchors 没有 source_material_id。之前的单测都是「整表不存在」，
 * CREATE TABLE IF NOT EXISTS 会带着新列一起建好，所以掩盖了「索引早于补列」的顺序问题。
 * 这里必须先建表、后补列，让迁移真实走到 ensureColumn。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const LEGACY_COUNTS = { works: 1, work_anchors: 1, story_facts: 1 };

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV11Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 11;

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE work_anchors (
        id                 TEXT PRIMARY KEY,
        work_id            TEXT NOT NULL,
        kind               TEXT NOT NULL DEFAULT '',
        title              TEXT NOT NULL DEFAULT '',
        statement          TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'pending',
        confidence         TEXT NOT NULL DEFAULT 'confirmed',
        source_title       TEXT,
        source_locator     TEXT,
        immutable          INTEGER NOT NULL DEFAULT 1,
        created_at         TEXT NOT NULL,
        modified_at        TEXT NOT NULL
      );

      CREATE TABLE story_facts (
        id          TEXT PRIMARY KEY,
        work_id     TEXT NOT NULL,
        secret_id   TEXT,
        part_no     INTEGER NOT NULL DEFAULT 1,
        content     TEXT NOT NULL,
        keywords    TEXT,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      INSERT INTO works (id, title, created_at, modified_at) VALUES
        ('legacy-work', '旧作品', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO work_anchors
        (id, work_id, kind, title, statement, status, confidence, created_at, modified_at)
      VALUES
        ('legacy-anchor', 'legacy-work', 'event', '旧锚点', '迁移前数据', 'pending', 'confirmed',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      INSERT INTO story_facts
        (id, work_id, part_no, content, keywords, created_at, modified_at)
      VALUES
        ('legacy-fact', 'legacy-work', 1, '迁移前秘密', '', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z');
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
  await seedV11Db();
  db = require('../database');
  await db.ready;
  // 迁移日志在 require 时就已产生，这里补一条便于确认真的跑过迁移
  assert.ok(
    logs.some((line) => line.includes('数据库 schema 版本 11 → 13')),
    '应在真实 v11 库上执行增量迁移'
  );
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v11 真实形态：迁移不抛错，版本/列/默认值/索引/行数五项成立', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 13, '迁移后版本应为 13');

  const anchorColumns = await db.all('PRAGMA table_info(work_anchors)');
  const materialCol = anchorColumns.find((c) => c.name === 'source_material_id');
  assert.ok(materialCol, 'work_anchors 应补上 source_material_id');
  assert.strictEqual(materialCol.notnull, 1, 'source_material_id 必须 NOT NULL');
  assert.strictEqual(materialCol.dflt_value, "''", 'source_material_id 默认值必须是空串');

  const factColumns = await db.all('PRAGMA table_info(story_facts)');
  const factTypeCol = factColumns.find((c) => c.name === 'fact_type');
  assert.ok(factTypeCol, 'story_facts 应补上 fact_type');
  assert.strictEqual(factTypeCol.notnull, 1, 'fact_type 必须 NOT NULL');
  assert.strictEqual(factTypeCol.dflt_value, "'secret'", 'fact_type 默认值必须是 secret');

  const anchor = await db.get('SELECT source_material_id FROM work_anchors WHERE id = ?', [
    'legacy-anchor',
  ]);
  assert.strictEqual(anchor.source_material_id, '', '老锚点来源素材应为空串');

  const fact = await db.get('SELECT fact_type FROM story_facts WHERE id = ?', ['legacy-fact']);
  assert.strictEqual(fact.fact_type, 'secret', '老事实应落在 secret');

  const index = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_anchors_material'"
  );
  assert.ok(index, '补列后应建出 idx_work_anchors_material');

  for (const [table, expected] of Object.entries(LEGACY_COUNTS)) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
    assert.strictEqual(row.c, expected, `${table} 迁移后行数不能变化`);
  }
});

test('v11 真实形态：二次启动幂等，不再迁移且行数不变', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 13);

  for (const [table, expected] of Object.entries(LEGACY_COUNTS)) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
    assert.strictEqual(row.c, expected, `${table} 二次启动后行数不能变化`);
  }
});
