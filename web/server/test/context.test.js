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
const { assembleContext } = require('../services/context');

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

test.after(async () => {
  env.cleanup();
});
