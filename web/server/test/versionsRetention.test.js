'use strict';

/**
 * 版本保留策略。
 *
 * 盯住三件事：
 *   1. 每章最近 N 份 + 最近 D 天每天一份，取并集；
 *   2. 手动快照永远不删；
 *   3. 重复执行幂等，且从不动章节当前正文。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser } = require('./helpers');

const env = setupTempEnv();

let db;
let versions;
const workId = 'work-retention';
const chapterId = 'chapter-retention';
const now = new Date().toISOString();

function daysAgo(days, hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function insertVersion({ id, createdAt, manual = 0 }) {
  await db.run(
    `INSERT INTO chapter_versions
       (id, chapter_id, work_id, title, blocks, content, label, manual, word_count, created_at)
     VALUES (?, ?, ?, '第一章', '[]', ?, ?, ?, 0, ?)`,
    [id, chapterId, workId, `内容-${id}`, manual ? '手动存档' : '自动快照', manual, createdAt]
  );
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  versions = require('../services/versions');

  const userId = (await createUser()).id;
  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '保留策略测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', '当前正文不能被清理动到', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  // 最近 20 天，每天两份（10:00 / 18:00）
  for (let day = 0; day < 20; day += 1) {
    for (const hour of [10, 18]) {
      await insertVersion({
        id: `auto-${day}-${hour}`,
        createdAt: daysAgo(day, hour),
      });
    }
  }

  // 一条很早的手动存档，位置在 30 天前
  await insertVersion({ id: 'manual-old', createdAt: daysAgo(30, 12), manual: 1 });
});

test.after(() => {
  env.cleanup();
});

test('保留最近 10 份 + 最近 14 天每天最新一份，手动快照不动', async () => {
  const deleted = await versions.pruneAutoVersions(chapterId);
  assert.strictEqual(deleted, 21, '应删除 21 份旧自动快照');

  const rows = await db.all(
    'SELECT id, manual FROM chapter_versions WHERE chapter_id = ? ORDER BY id',
    [chapterId]
  );
  const ids = new Set(rows.map((r) => r.id));

  // 最近 10 份（day 0-4）全留
  for (let day = 0; day < 5; day += 1) {
    assert.ok(ids.has(`auto-${day}-10`), `day${day} 10:00 在最近 10 份内，应保留`);
    assert.ok(ids.has(`auto-${day}-18`), `day${day} 18:00 在最近 10 份内，应保留`);
  }

  // 第 5-13 天每天只留最新一份
  for (let day = 5; day < 14; day += 1) {
    assert.ok(ids.has(`auto-${day}-18`), `day${day} 的当天最新一份应保留`);
    assert.ok(!ids.has(`auto-${day}-10`), `day${day} 的较早一份应被清理`);
  }

  // 第 14 天以后既不在最近 10 份，也超出 14 天窗口
  assert.ok(!ids.has('auto-19-18'), '20 天前的快照应被清理');

  // 今天最新一份必须保留
  assert.ok(ids.has('auto-0-18'), '当天最新一份不能被误删');

  // 手动快照永远保留
  assert.ok(ids.has('manual-old'));

  assert.strictEqual(rows.length, 20, '19 份自动 + 1 份手动');
});

test('重复清理幂等，且不影响章节当前正文', async () => {
  const before = await db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]);
  const deleted = await versions.pruneAutoVersions(chapterId);
  assert.strictEqual(deleted, 0, '第二次清理不应再删任何行');

  const rows = await db.all('SELECT id FROM chapter_versions WHERE chapter_id = ?', [chapterId]);
  assert.strictEqual(rows.length, 20);

  const after = await db.get('SELECT content FROM chapters WHERE id = ?', [chapterId]);
  assert.strictEqual(after.content, before.content);
  assert.strictEqual(after.content, '当前正文不能被清理动到');
});
