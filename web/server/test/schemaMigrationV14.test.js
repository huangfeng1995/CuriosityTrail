'use strict';

/**
 * 真实 v13 形态老库：messages 表已存在，但没有 status 列。
 *
 * messages 表是"每轮对话一行"的老表，线上从 v1 就有。
 * v14 给它补 status（complete/interrupted），走的是 ensureColumn：
 * 老表不会因为 CREATE TABLE IF NOT EXISTS 自动长出这一列。
 *
 * 这里先建出缺列的老表再让迁移跑，保证真的走到 ALTER TABLE 那一支，
 * 而不是新建库时一次性把列建好。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const LEGACY_MESSAGE_COUNT = 2;

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV13Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 13;

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        role_key        TEXT,
        action          TEXT,
        payload         TEXT,
        citations       TEXT,
        created_at      TEXT NOT NULL
      );

      CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

      INSERT INTO messages
        (id, conversation_id, role, content, role_key, action, payload, citations, created_at)
      VALUES
        ('m-1', 'c-1', 'user', '迁移前的老提问', 'writer', '', NULL, '[]', '2026-01-01T00:00:00.000Z'),
        ('m-2', 'c-1', 'assistant', '迁移前的老回答', 'writer', 'comment', NULL, '[]',
         '2026-01-01T00:00:01.000Z');
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
  await seedV13Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v13 真实形态：messages 补上 status，老消息落在 complete，行数不变', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 15, '迁移后版本应为 15（v14 与 v15 一并执行）');

  const columns = await db.all('PRAGMA table_info(messages)');
  const statusCol = columns.find((c) => c.name === 'status');
  assert.ok(statusCol, 'messages 应补上 status 列');
  assert.strictEqual(statusCol.notnull, 1, 'status 必须 NOT NULL');
  assert.strictEqual(statusCol.dflt_value, "'complete'", "status 默认值必须是 complete");

  const rows = await db.all('SELECT id, status FROM messages ORDER BY id');
  assert.strictEqual(rows.length, LEGACY_MESSAGE_COUNT, 'messages 行数不能变化');
  for (const row of rows) {
    assert.strictEqual(row.status, 'complete', `老消息 ${row.id} 应落在 complete`);
  }

  const count = await db.get('SELECT COUNT(*) AS c FROM messages');
  assert.strictEqual(count.c, LEGACY_MESSAGE_COUNT);
});

test('v13 真实形态：补列后写入非法状态被 CHECK 挡下', async () => {
  await assert.rejects(
    () => db.run("UPDATE messages SET status = 'bogus' WHERE id = 'm-1'"),
    /CHECK constraint failed/i,
    '非法状态必须被挡下，否则前端会收到没定义过的取值'
  );
});

test('v13 真实形态：二次启动幂等，不再迁移且行数不变', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 15);

  const count = await db.get('SELECT COUNT(*) AS c FROM messages');
  assert.strictEqual(count.c, LEGACY_MESSAGE_COUNT, '二次启动后 messages 行数不能变化');
});
