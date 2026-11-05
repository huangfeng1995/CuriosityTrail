'use strict';

/**
 * HP1：模板开关与 schema 7 → 8 迁移。
 *
 * 本文件先造一个版本 7 的老库（只含 works / chapters / characters 的旧列），
 * 再加载 database.js 让增量迁移真实跑一遍，避免直接动 data/ 下的生产库。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const sqlite3 = require('sqlite3');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const dbFile = path.join(env.dataDir, 'curiosity.db');

// 迁移前的老库固定造这些行；迁移后必须一条不少。
const LEGACY_COUNTS = { works: 2, chapters: 2, characters: 2 };

/**
 * 造一个 schema 版本 7 的老库。
 *
 * 故意使用旧列结构：works 没有 user_id / target_words / template，
 * chapters 没有 outline / word_count，characters 没有来源列。
 * 这样迁移里的 ensureColumn 路径才会真正被走到。
 */
function seedLegacyDb() {
  return new Promise((resolve, reject) => {
    const raw = new sqlite3.Database(dbFile);
    raw.exec(
      `
      PRAGMA user_version = 7;

      CREATE TABLE works (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        genre       TEXT,
        synopsis    TEXT,
        outline     TEXT,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE chapters (
        id          TEXT PRIMARY KEY,
        work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        volume      TEXT,
        status      TEXT DEFAULT 'draft',
        content     TEXT,
        blocks      TEXT,
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE characters (
        id          TEXT PRIMARY KEY,
        work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
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
        created_at  TEXT NOT NULL,
        modified_at TEXT NOT NULL
      );

      INSERT INTO works (id, title, genre, synopsis, outline, created_at, modified_at) VALUES
        ('legacy-work-1', '旧作品一', '悬疑', '迁移前数据', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('legacy-work-2', '旧作品二', '武侠', '迁移前数据', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

      INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, created_at, modified_at) VALUES
        ('legacy-ch-1', 'legacy-work-1', '第一章', 1, '', 'draft', '旧正文一', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('legacy-ch-2', 'legacy-work-2', '第一章', 1, '', 'draft', '旧正文二', '[]', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

      INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at) VALUES
        ('legacy-c-1', 'legacy-work-1', '陈默', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('legacy-c-2', 'legacy-work-2', '沈砚', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
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
let isPipelineEnabled;
let assembleContext;
let userId;

test.before(async () => {
  await seedLegacyDb();

  db = require('../database');
  await db.ready;
  app = require('../app');
  ({ isPipelineEnabled } = require('../services/pipeline/gate'));
  ({ assembleContext } = require('../services/context'));

  server = await startServer(app);
  const row = await db.get('SELECT id FROM users WHERE phone = ?', ['13900000001']);
  userId = row.id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 迁移
// ---------------------------------------------------------------------------

test('迁移：user_version 7 → 13，原有数据行数不变，works 补上 template', async () => {
  const version = await db.get('PRAGMA user_version');
  assert.strictEqual(version.user_version, 13, '迁移后版本号应为 13');

  for (const [table, expected] of Object.entries(LEGACY_COUNTS)) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
    assert.strictEqual(row.c, expected, `${table} 迁移后行数不能变化`);
  }

  const columns = await db.all('PRAGMA table_info(works)');
  const templateCol = columns.find((c) => c.name === 'template');
  assert.ok(templateCol, 'works 应补上 template 列');
  assert.strictEqual(templateCol.notnull, 1, 'template 必须是 NOT NULL');
  assert.strictEqual(templateCol.dflt_value, "''", "template 默认值必须是空串");

  const rows = await db.all('SELECT DISTINCT template FROM works');
  assert.deepStrictEqual(rows.map((r) => r.template), [''], '老作品应落在未启用状态');

  const tables = await db.all(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name IN ('work_anchors','work_blank_areas','anchor_violations')`
  );
  assert.strictEqual(tables.length, 3, '三张锚点表都应创建');
});

// ---------------------------------------------------------------------------
// 开关
// ---------------------------------------------------------------------------

test('isPipelineEnabled：只有白名单模板为 true', () => {
  assert.strictEqual(isPipelineEnabled({ template: '' }), false);
  assert.strictEqual(isPipelineEnabled({ template: 'history_thriller' }), true);
  assert.strictEqual(isPipelineEnabled({ template: 'mystery' }), false);
  assert.strictEqual(isPipelineEnabled({ template: undefined }), false);
  assert.strictEqual(isPipelineEnabled(null), false);
});

// ---------------------------------------------------------------------------
// CHECK 约束
// ---------------------------------------------------------------------------

test('work_anchors：sourced 缺书名或条目直接被数据库拒绝', async () => {
  await assert.rejects(
    db.run(
      `INSERT INTO work_anchors
         (id, work_id, kind, subject, claim, confidence, source_title, source_locator, created_at, modified_at)
       VALUES (?, ?, 'person', '曹操', '曹操卒于建安二十五年正月', 'sourced', '三国志', NULL, ?, ?)`,
      ['anchor-no-locator', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
    ),
    /CHECK constraint failed/i
  );

  await assert.rejects(
    db.run(
      `INSERT INTO work_anchors
         (id, work_id, kind, subject, claim, confidence, source_title, source_locator, created_at, modified_at)
       VALUES (?, ?, 'person', '曹操', '曹操卒于建安二十五年正月', 'sourced', '', '武帝纪', ?, ?)`,
      ['anchor-empty-title', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
    ),
    /CHECK constraint failed/i
  );

  // 补齐出处后可以入库
  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, source_title, source_locator, created_at, modified_at)
     VALUES (?, ?, 'person', '曹操', '曹操卒于建安二十五年正月', 'sourced', '三国志', '武帝纪', ?, ?)`,
    ['anchor-ok', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );
});

test('work_anchors：blank 不能 immutable', async () => {
  await assert.rejects(
    db.run(
      `INSERT INTO work_anchors
         (id, work_id, kind, subject, claim, confidence, immutable, created_at, modified_at)
       VALUES (?, ?, 'event', '杨俊赴许都日期', '具体日期无载', 'blank', 1, ?, ?)`,
      ['anchor-blank-bad', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
    ),
    /CHECK constraint failed/i
  );

  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, immutable, created_at, modified_at)
     VALUES (?, ?, 'event', '杨俊赴许都日期', '具体日期无载', 'blank', 0, ?, ?)`,
    ['anchor-blank-ok', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );
});

test('work_blank_areas 与 anchor_violations：CHECK 约束生效', async () => {
  await assert.rejects(
    db.run(
      `INSERT INTO work_blank_areas (id, work_id, topic, status, created_at, modified_at)
       VALUES (?, ?, '空白区', 'pending', ?, ?)`,
      ['blank-area-bad', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
    ),
    /CHECK constraint failed/i
  );
  await db.run(
    `INSERT INTO work_blank_areas (id, work_id, topic, status, created_at, modified_at)
     VALUES (?, ?, '空白区', 'active', ?, ?)`,
    ['blank-area-ok', 'legacy-work-1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );

  await assert.rejects(
    db.run(
      `INSERT INTO anchor_violations (id, work_id, rule_type, severity, quote, created_at)
       VALUES (?, ?, 'presence_forbidden', 'error', '曹操端坐堂上。', ?)`,
      ['violation-bad', 'legacy-work-1', '2026-01-01T00:00:00.000Z']
    ),
    /CHECK constraint failed/i
  );
  await db.run(
    `INSERT INTO anchor_violations (id, work_id, rule_type, severity, quote, created_at)
     VALUES (?, ?, 'presence_forbidden', 'block', '曹操端坐堂上。', ?)`,
    ['violation-ok', 'legacy-work-1', '2026-01-01T00:00:00.000Z']
  );
});

// ---------------------------------------------------------------------------
// 写入口白名单
// ---------------------------------------------------------------------------

test('POST /api/works：非法 template 返回 400', async () => {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: '非法模板作品', template: 'mystery' },
  });
  assert.strictEqual(res.status, 400);

  const numeric = await server.request('/api/works', {
    method: 'POST',
    body: { title: '数字模板作品', template: 1 },
  });
  assert.strictEqual(numeric.status, 400);

  const ok = await server.request('/api/works', {
    method: 'POST',
    body: { title: '历史悬疑作品', template: 'history_thriller' },
  });
  assert.strictEqual(ok.status, 200);
  const work = await ok.json();
  assert.strictEqual(work.template, 'history_thriller');
});

test('PUT /api/works/:id：template 只接受空串或白名单值', async () => {
  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: '模板切换作品' },
  });
  assert.strictEqual(created.status, 200);
  const work = await created.json();
  assert.strictEqual(work.template, '', '不传 template 时应为未启用');

  const bad = await server.request(`/api/works/${work.id}`, {
    method: 'PUT',
    body: { template: 'history_thriler' },
  });
  assert.strictEqual(bad.status, 400, '拼错的模板名必须被拒绝');

  const on = await server.request(`/api/works/${work.id}`, {
    method: 'PUT',
    body: { template: 'history_thriller' },
  });
  assert.strictEqual(on.status, 200);
  assert.strictEqual((await on.json()).template, 'history_thriller');

  const off = await server.request(`/api/works/${work.id}`, {
    method: 'PUT',
    body: { template: '' },
  });
  assert.strictEqual(off.status, 200);
  assert.strictEqual((await off.json()).template, '', '可以随时关闭');
});

// ---------------------------------------------------------------------------
// 关闭态上下文
// ---------------------------------------------------------------------------

test('模板关闭：system 内容不受锚点表影响，且不出现新分区', async () => {
  const workId = 'gate-context-work';
  const chapterId = 'gate-context-chapter';
  const ts = '2026-01-01T00:00:00.000Z';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
     VALUES (?, ?, '关闭态作品', '悬疑', '一段旧案', '', 0, '', ?, ?)`,
    [workId, userId, ts, ts]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', ?, ?, '', 0, ?, ?)`,
    [
      chapterId,
      workId,
      '十点整，雨落下来。',
      JSON.stringify([{ id: 'g1', type: 'paragraph', content: '十点整，雨落下来。' }]),
      ts,
      ts,
    ]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, '陈默', '', ?, ?)`,
    ['gate-c-1', workId, ts, ts]
  );

  const params = { workId, chapterId, roleKey: 'writer', scope: 'chapter', userId };
  const before = await assembleContext(params);

  // 即使锚点库里已有 active 锚点，模板关闭时也必须一个字都不影响上下文。
  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, source_title, source_locator, status, created_at, modified_at)
     VALUES (?, ?, 'person', '曹操', '曹操卒于建安二十五年正月', 'sourced', '三国志', '武帝纪', 'active', ?, ?)`,
    ['gate-anchor', workId, ts, ts]
  );

  const after = await assembleContext(params);

  assert.strictEqual(
    after.messages[0].content,
    before.messages[0].content,
    '关闭模板后 system 内容必须逐字不变'
  );
  assert.ok(!after.messages[0].content.includes('## 历史锚点'), '关闭后不注入历史锚点');
  assert.ok(!after.messages[0].content.includes('## 本章知情边界'), '关闭后不注入知情边界');
});
