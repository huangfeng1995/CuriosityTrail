'use strict';

/**
 * 真实 v14 形态老库：card_proposals 已存在，但没有 origin_ref 列。
 *
 * v15 给它补这一列，用来记录这批提案是哪一次「采纳」产生的。
 * 撤销那段正文时按 origin_ref 把这一轮 pending 提案一并作废。
 *
 * 和老库迁移一样走 ensureColumn：CREATE TABLE IF NOT EXISTS 不会给
 * 已存在的表加列，所以这里先建出缺列的老表再让迁移跑，确保真的走到
 * ALTER TABLE 那一支；索引在 LATE_INDEXES 里补建。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

const LEGACY_PROPOSAL_COUNT = 2;

let logs = [];
const realLog = console.log;
console.log = (...args) => {
  logs.push(args.join(' '));
  realLog(...args);
};

function seedV14Db() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 14;

      CREATE TABLE card_proposals (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        work_id      TEXT NOT NULL,
        chapter_id   TEXT,
        block_id     TEXT,
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

      INSERT INTO card_proposals
        (id, user_id, work_id, chapter_id, block_id, kind, title, content,
         payload, source_quote, status, card_id, created_at, updated_at)
      VALUES
        ('p-1', 'u-1', 'w-1', 'ch-1', 'b-1', 'character', '老提案人物', '身份',
         '{}', '老提案人物推门进来', 'pending', '',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('p-2', 'u-1', 'w-1', 'ch-1', 'b-1', 'setting', '老提案设定', '地点',
         '{"category":"地点"}', '老提案设定在城西', 'dismissed', '',
         '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z');
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
  await seedV14Db();
  db = require('../database');
  await db.ready;
});

test.after(() => {
  console.log = realLog;
  env.cleanup();
});

test('v14 真实形态：card_proposals 补上 origin_ref，老行留空串，行数不变', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 15, '迁移后版本应为 15');

  const columns = await db.all('PRAGMA table_info(card_proposals)');
  const originCol = columns.find((c) => c.name === 'origin_ref');
  assert.ok(originCol, 'card_proposals 应补上 origin_ref 列');
  assert.strictEqual(originCol.notnull, 1, 'origin_ref 必须 NOT NULL');
  assert.strictEqual(originCol.dflt_value, "''", 'origin_ref 默认值必须是空串');

  const rows = await db.all(
    'SELECT id, status, origin_ref FROM card_proposals ORDER BY id'
  );
  assert.strictEqual(rows.length, LEGACY_PROPOSAL_COUNT, '提案行数不能变化');
  for (const row of rows) {
    assert.strictEqual(row.origin_ref, '', `老提案 ${row.id} 的 origin_ref 应为空串`);
  }
  // 老状态不能被迁移改动
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[1].status, 'dismissed');

  const indexes = await db.all('PRAGMA index_list(card_proposals)');
  assert.ok(
    indexes.some((i) => i.name === 'idx_card_proposals_origin'),
    '迁移后应建出 idx_card_proposals_origin'
  );
});

test('v14 真实形态：补列后可按来源作废，confirmed 不被 pending 过滤带走', async () => {
  await db.run(
    `UPDATE card_proposals SET status = 'confirmed' WHERE id = 'p-1'`
  );
  await db.run(
    `UPDATE card_proposals SET origin_ref = 'msg-9' WHERE id IN ('p-1','p-2')`
  );

  const result = await db.run(
    `UPDATE card_proposals
        SET status = 'dismissed'
      WHERE user_id = 'u-1' AND origin_ref = 'msg-9' AND status = 'pending'`
  );
  assert.strictEqual(result.changes, 0, 'confirmed 的行不应被按来源作废');

  const kept = await db.get(
    `SELECT status FROM card_proposals WHERE id = 'p-1'`
  );
  assert.strictEqual(kept.status, 'confirmed');
});

test('v14 真实形态：二次启动幂等，不再迁移且行数不变', async () => {
  await db.close();
  logs = [];
  await db.reopen();

  assert.ok(!logs.some((line) => line.includes('执行增量迁移')), '二次启动不应再迁移');

  const version = await db.all('PRAGMA user_version');
  assert.strictEqual(version[0].user_version, 15);

  const count = await db.get('SELECT COUNT(*) AS c FROM card_proposals');
  assert.strictEqual(count.c, LEGACY_PROPOSAL_COUNT, '二次启动后提案行数不能变化');
});
