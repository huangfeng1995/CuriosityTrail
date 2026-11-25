/**
 * 实体接地的独立测试。
 *
 * 这一段原先内联在 /chat 里，只能靠整轮对话的集成测试覆盖。
 * 抽出来之后，规划模式、可用拍型、上一章主类型、人物别名解析
 * 都可以直接断言，不必启动一轮模型调用。
 */

const { test, before } = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser } = require('./helpers');

const env = setupTempEnv();

const db = require('../database');
const {
  buildPlanGrounding,
  MIN_OUTLINE_CHARS_FOR_PLAN,
} = require('../services/agent/planGrounding');

const LONG_OUTLINE = '第一场：雪夜入城，杨平在城门下遇见旧识，得知父亲已死。\n第二场：他回到住处，发现弓不见了，追问苍头。';
const SHORT_OUTLINE = '主角进庙查旧案';

async function seed() {
  await db.ready;
  const now = new Date().toISOString();
  const userId = (await createUser()).id;

  // 普通作品：未启用历史悬疑模板
  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, '', ?, ?)`,
    ['w-plain', userId, '普通作品', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    ['c-plain-1', 'w-plain', '第一章', LONG_OUTLINE, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 2, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    ['c-plain-2', 'w-plain', '第二章', SHORT_OUTLINE, now, now]
  );

  // 启用模板的作品：第一章有正文与已落库拍表，供第二章读「上一章 mainType」
  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, 'history_thriller', ?, ?)`,
    ['w-thriller', userId, '悬疑作品', now, now]
  );
  const prevTail = `雪停时他把弓收进鞘里。${'甲'.repeat(900)}END`;
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'done', ?, ?, ?, 0, ?, ?)`,
    [
      'c-thriller-1',
      'w-thriller',
      '第一章',
      prevTail,
      JSON.stringify([{ id: 'p1', type: 'paragraph', content: prevTail }]),
      LONG_OUTLINE,
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 2, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    ['c-thriller-2', 'w-thriller', '第二章', LONG_OUTLINE, now, now]
  );
  await db.run(
    `INSERT INTO chapter_plans
       (id, work_id, chapter_id, plan, brief, status, options, chosen,
        outline_hash, body_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', 'confirmed', '[]', '', '', '', ?, ?)`,
    ['plan-1', 'w-thriller', 'c-thriller-1', JSON.stringify({ mainType: '险露' }), now, now]
  );

  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['char-1', 'w-plain', '沈砚', '沈兄，砚哥、小沈|阿砚;沈', now, now]
  );
}

// 落库是异步的：测试开始前必须先等插入完成，否则会读到空库。
const seeded = seed();
before(async () => {
  await seeded;
});

test('大纲足够长时按大纲模式，短前提退回六类兜底', async () => {
  const long = await buildPlanGrounding({
    workId: 'w-plain',
    chapterId: 'c-plain-1',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-plain'])).user_id,
    message: '写第二章',
  });
  assert.equal(long.planMode, 'outline');

  const short = await buildPlanGrounding({
    workId: 'w-plain',
    chapterId: 'c-plain-2',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-plain'])).user_id,
    message: '写第二章',
  });
  assert.equal(short.planMode, 'reference');
  assert.ok(SHORT_OUTLINE.length < MIN_OUTLINE_CHARS_FOR_PLAN);
});

test('人物姓名与别名去重拆分，单字别名被过滤', async () => {
  const ctx = await buildPlanGrounding({
    workId: 'w-plain',
    chapterId: 'c-plain-1',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-plain'])).user_id,
    message: '写第一章',
  });
  assert.deepEqual(
    [...ctx.planCharacterNames].sort(),
    ['小沈', '沈兄', '沈砚', '砚哥', '阿砚'].sort()
  );
});

test('未启用模板：险露拍不可用，也不读上一章主类型', async () => {
  const ctx = await buildPlanGrounding({
    workId: 'w-plain',
    chapterId: 'c-plain-1',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-plain'])).user_id,
    message: '写第一章',
  });
  assert.equal(ctx.pipelineEnabled, false);
  assert.ok(!ctx.allowedBeatTypes.includes('险露'));
  assert.equal(ctx.previousMainType, '');
});

test('启用模板：险露拍可用，并读到上一章 mainType', async () => {
  const ctx = await buildPlanGrounding({
    workId: 'w-thriller',
    chapterId: 'c-thriller-2',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-thriller'])).user_id,
    message: '写第二章',
  });
  assert.equal(ctx.pipelineEnabled, true);
  assert.ok(ctx.allowedBeatTypes.includes('险露'));
  assert.equal(ctx.previousMainType, '险露');
});

test('上一章结尾只取末尾 800 字，情节卡原样进入接地语料', async () => {
  const cards = [{ id: 'pc1', title: '雪夜入城', content: '杨平在城门下遇见旧识' }];
  const ctx = await buildPlanGrounding({
    workId: 'w-thriller',
    chapterId: 'c-thriller-2',
    userId: (await db.get('SELECT user_id FROM works WHERE id = ?', ['w-thriller'])).user_id,
    message: '写第二章',
    plotCards: cards,
  });
  assert.equal(ctx.planGround.previousChapter.length, 800);
  assert.ok(ctx.planGround.previousChapter.endsWith('END'), '应保留上一章末尾');
  assert.deepEqual(ctx.planGround.plotCards, cards);
});

test('作品或章节不存在时降级为空材料，不抛错', async () => {
  const ctx = await buildPlanGrounding({
    workId: 'w-missing',
    chapterId: 'c-missing',
    userId: 'u-missing',
    message: '写点什么',
  });
  assert.equal(ctx.planGround.outline, '');
  assert.equal(ctx.planMode, 'reference');
  assert.deepEqual(ctx.planGround.characters, []);
  assert.deepEqual(ctx.planCharacterNames, []);
  assert.equal(ctx.pipelineEnabled, false);
});
