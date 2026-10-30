'use strict';

/**
 * 上下文装配测试。
 *
 * 盯住一件事：**空章节时，模型必须知道该怎么写**。
 *
 * 不说的话模型只能靠猜：它会给出 action="append" 加一个指向
 * 不存在段落的 target，前端回写时找不到落点，作者看到的是
 * "当前章节还没有正文"，AI 写的内容就这么丢了。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser } = require('./helpers');

const env = setupTempEnv();

const db = require('../database');
const {
  assembleContext,
  trimHistory,
  applyBudget,
} = require('../services/context');

test('空章节：明确告诉模型正文会作为第一段插入', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-empty';
  const chapterId = 'chapter-empty';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '测试作品', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第一章', now, now]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;
  assert.ok(system.includes('本章还没有正文'), '应说明本章还没有正文');
  assert.ok(system.includes('insert'), '应告诉模型用 insert 落笔');
  assert.ok(system.includes('不要编造块ID'), '应要求模型不要编造块ID');
});

test('有正文的章节：照常注入正文与段落索引', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-body';
  const chapterId = 'chapter-body';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '测试作品二', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', ?, ?, '', 0, ?, ?)`,
    [
      chapterId,
      workId,
      '第一章',
      '十点整，雨落下来。',
      JSON.stringify([
        { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
      ]),
      now,
      now,
    ]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;
  assert.ok(system.includes('十点整，雨落下来。'), '应注入章节正文');
  assert.ok(system.includes('[b1]'), '应注入段落索引');
  assert.ok(!system.includes('本章还没有正文'), '有正文时不该说本章没有正文');
});

test('历史裁剪：超预算时保留最近消息，并从 user 开始', () => {
  const history = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a'.repeat(100) },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'b'.repeat(100) },
  ];

  // 预算放不下最早的 q1 + a，但能放下 q2 + b
  const { rows, omitted } = trimHistory(history, 150);
  assert.strictEqual(omitted, 2, '应省略前两条');
  assert.strictEqual(rows.length, 2, '只保留最近一轮');
  assert.strictEqual(rows[0].role, 'user', '必须从 user 消息开始');
  assert.strictEqual(rows[0].content, 'q2');
});

test('历史裁剪：未超预算时原样保留', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ];
  const { rows, omitted } = trimHistory(history, 1000);
  assert.strictEqual(omitted, 0);
  assert.deepStrictEqual(rows, history);
});

test('上下文预算：超预算先丢低优先级分区，角色提示词不动', () => {
  const parts = [
    { text: 'role-prompt', priority: 1 },
    { text: `## 正文\n${'c'.repeat(200)}`, priority: 2 },
    { text: `## 灵感\n${'i'.repeat(100)}`, priority: 6 },
  ];

  const fitted = applyBudget(parts, 200);
  assert.strictEqual(fitted[0].text, 'role-prompt', '最高优先级不能被截');
  assert.ok(fitted[2].text === '', '最低优先级的灵感整段让位');
  assert.ok(fitted[1].text.length > 0, '正文保留');
});

test.after(async () => {
  env.cleanup();
});
