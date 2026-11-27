'use strict';

/**
 * 真实 v15 形态老库：没有 consistency_findings 表。
 *
 * v16 新建这张表，用来把一致性检查的结论持久化（open/adopted/dismissed）。
 * 老数据一行都不能动，二次启动不能再迁移。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const WORK_ID = 'w-v15';
const WORK_TITLE = '迁移前就存在的作品';

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV15Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 15;

      -- v15 时代已有的表与数据：迁移只做增量，不允许重建或丢行
      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        title       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      INSERT INTO works (id, user_id, title, created_at, modified_at)
      VALUES ('${WORK_ID}', 'u-v15', '${WORK_TITLE}',
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

test.before(async () => {
  await seedV15Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v15 真实形态：新建 consistency_findings，老作品不丢', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 21, '迁移后版本应为 21');

  const columns = await db.all('PRAGMA table_info(consistency_findings)');
  const names = columns.map((c) => c.name);
  for (const column of [
    'id',
    'user_id',
    'work_id',
    'fingerprint',
    'source',
    'type',
    'severity',
    'title',
    'detail',
    'target',
    'chapter_id',
    'chapter_seq',
    'chapter_title',
    'block_id',
    'quote',
    'status',
    'first_seen_at',
    'last_seen_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(names.includes(column), `consistency_findings 缺少 ${column}`);
  }

  const statusCol = columns.find((c) => c.name === 'status');
  assert.strictEqual(statusCol.notnull, 1);
  assert.match(statusCol.dflt_value, /'open'/, 'status 默认应为 open');

  const indexes = await db.all('PRAGMA index_list(consistency_findings)');
  assert.ok(
    indexes.some((i) => i.name === 'idx_consistency_findings_work'),
    '应建出按作品查询的索引'
  );
  // UNIQUE(user_id, work_id, fingerprint) 会生成一个自动索引
  assert.ok(
    indexes.some((i) => i.unique === 1),
    '应按 (user_id, work_id, fingerprint) 唯一'
  );

  const work = await db.get('SELECT id, title FROM works WHERE id = ?', [WORK_ID]);
  assert.ok(work, '老作品不能丢');
  assert.strictEqual(work.title, WORK_TITLE);
});

test('v15 真实形态：结论状态机可直接写入与读取', async () => {
  const ts = '2026-02-01T00:00:00.000Z';
  await db.run(
    `INSERT INTO consistency_findings
       (id, user_id, work_id, fingerprint, source, type, severity, title,
        detail, target, chapter_id, chapter_seq, chapter_title, block_id,
        quote, status, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'cross_chapter', 'ai', 'high', ?, '', '', ?, 2, ?, '',
             '', 'dismissed', ?, ?, ?, ?)`,
    [
      'f-1',
      'u-v15',
      WORK_ID,
      'cross_chapter|ai|时间线冲突|2',
      '时间线冲突',
      'ch-2',
      '伞',
      ts,
      ts,
      ts,
      ts,
    ]
  );

  const row = await db.get('SELECT status, chapter_seq FROM consistency_findings WHERE id = ?', [
    'f-1',
  ]);
  assert.strictEqual(row.status, 'dismissed');
  assert.strictEqual(row.chapter_seq, 2);

  // 同一指纹不能插第二次（唯一约束是「重跑不复活」的基础）
  await assert.rejects(
    db.run(
      `INSERT INTO consistency_findings
         (id, user_id, work_id, fingerprint, source, title, status,
          first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ('f-2', 'u-v15', ?, 'cross_chapter|ai|时间线冲突|2',
               'cross_chapter', '时间线冲突', 'open', ?, ?, ?, ?)`,
      [WORK_ID, ts, ts, ts, ts]
    ),
    /UNIQUE/,
    '同指纹重复插入应被唯一约束拒绝'
  );
});

test('v15 真实形态：二次启动幂等，结论行数不变', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 21);

  const count = await db.get('SELECT COUNT(*) AS c FROM consistency_findings');
  assert.strictEqual(count.c, 1, '二次启动后结论行数不能变化');
});
