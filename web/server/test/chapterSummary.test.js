'use strict';

/**
 * 章节摘要与全书进度。
 *
 * 盯住四件事：
 *   1. 摘要按结构落库，失败不覆盖上一版；
 *   2. 重新生成的阈值是「篇幅实质变化」，不是每次保存都调模型；
 *   3. 写手上下文只注入最近 4 章摘要，且带上确定的全书位置；
 *   4. 大纲有幕时按幕推断，没有时退回章号这类确定事实，不猜。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const aiConfig = require('../services/aiConfig');
const summaryService = require('../services/summaries/chapterSummary');
const { describeBookProgress, parseOutlinePlan } = require('../services/bookProgress');
const { assembleContext } = require('../services/context');

let server;
let fakeModel;
let originalConfig;
let seq = 0;

/** 一段足够长的正文：摘要门槛是 500 字。 */
const LONG_BODY = '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。'.repeat(30);

function summaryJson(progress = '林砚在城隍庙翻出一卷旧案，决定顺着封皮上的名字查下去。') {
  return JSON.stringify({
    progress,
    open_threads: '封皮上的名字是谁写的；旧案为何被藏在供桌下',
    setting: '雨夜，城隍庙',
    characters: ['林砚', '老周'],
  });
}

async function defaultUserId() {
  const row = await db.get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  assert.ok(row, '默认测试用户应当存在');
  return row.id;
}

async function insertWork(userId, { outline = '', targetWords = 0, title } = {}) {
  seq += 1;
  const id = `work-sum-${seq}`;
  const ts = new Date().toISOString();
  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', ?, ?, ?, ?)`,
    [id, userId, title || `摘要测试${seq}`, outline, targetWords, ts, ts]
  );
  return id;
}

async function insertChapter({
  workId,
  chapterSeq,
  title,
  volume = '',
  status = 'draft',
  content = '',
  summary = null,
  summaryWords = 0,
}) {
  seq += 1;
  const id = `chapter-sum-${seq}`;
  const ts = new Date().toISOString();
  const blocks = content
    ? JSON.stringify([{ id: 'b1', type: 'paragraph', content }])
    : '[]';
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline,
        summary, summary_words, summary_updated_at, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?, ?)`,
    [
      id,
      workId,
      title,
      chapterSeq,
      volume,
      status,
      content,
      blocks,
      summary,
      summaryWords,
      summary ? ts : null,
      ts,
      ts,
    ]
  );
  return id;
}

test.before(async () => {
  await db.ready;
  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();

  originalConfig = JSON.parse(JSON.stringify(aiConfig.getConfig()));
  aiConfig.updateConfig({
    provider: 'deepseek',
    deepseek: {
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'deepseek-flash',
      thinking: false,
    },
  });

  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) aiConfig.updateConfig(originalConfig);
  summaryService.clearTimers();
  await summaryService.allPending();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 1. 生成与落库
// ---------------------------------------------------------------------------

test('生成摘要：一次调用，按结构落库并记下字数快照', async () => {
  const userId = await defaultUserId();
  const workId = await insertWork(userId);
  const chapterId = await insertChapter({ workId, chapterSeq: 1, title: '雨夜', content: LONG_BODY });

  let calls = 0;
  const provider = {
    chat: async () => {
      calls += 1;
      return { content: summaryJson() };
    },
  };

  const result = await summaryService.summarizeChapter({
    userId,
    workId,
    chapterId,
    provider,
  });

  assert.strictEqual(calls, 1, '一章只调用一次模型');
  assert.ok(result.summary, '应返回解析后的摘要');
  assert.strictEqual(result.summary.characters.length, 2);

  const row = await db.get('SELECT summary, summary_words, summary_updated_at FROM chapters WHERE id = ?', [
    chapterId,
  ]);
  const stored = JSON.parse(row.summary);
  assert.match(stored.progress, /旧案/, '推进要落库');
  assert.match(stored.open_threads, /旧案/, '未解要落库');
  assert.strictEqual(stored.setting, '雨夜，城隍庙');
  assert.strictEqual(row.summary_words, result.words, '字数快照应与生成时一致');
  assert.ok(row.summary_updated_at, '应记录生成时间');
});

test('模型输出不合法：保留上一版摘要，不写半成品', async () => {
  const userId = await defaultUserId();
  const workId = await insertWork(userId);
  const old = summaryJson('上一版摘要');
  const chapterId = await insertChapter({
    workId,
    chapterSeq: 2,
    title: '旧稿',
    content: LONG_BODY,
    summary: old,
    summaryWords: LONG_BODY.length,
  });

  const result = await summaryService.summarizeChapter({
    userId,
    workId,
    chapterId,
    force: true,
    provider: { chat: async () => ({ content: '这不是 JSON' }) },
  });

  assert.ok(result.skipped, '解析失败应跳过');
  assert.strictEqual(result.reason, 'parse');

  const row = await db.get('SELECT summary FROM chapters WHERE id = ?', [chapterId]);
  assert.strictEqual(row.summary, old, '上一版摘要必须原样保留');
});

test('重新生成阈值：太短不调、增幅不足不调、实质变化才调', () => {
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: null }, 499),
    false,
    '不足 500 字不生成'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: null }, 500),
    true,
    '首次达到门槛应生成'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: '{}', summary_words: 1000, status: 'draft' }, 1200),
    false,
    '只加 200 字不值得重算'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: '{}', summary_words: 1000, status: 'draft' }, 1400),
    false,
    '只加 400 字不值得重算'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: '{}', summary_words: 1000, status: 'draft' }, 1600),
    true,
    '增幅达到 50% 应重算'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: '{}', summary_words: 3000, status: 'draft' }, 3200),
    false,
    '大章小幅修改不重算'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: '{}', summary_words: 3000, status: 'done' }, 3030),
    true,
    '完结章有实质修改就重算'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: null }, 0, { force: true }),
    false,
    '手动触发也不能总结空章'
  );
  assert.strictEqual(
    summaryService.needsRegeneration({ summary: null }, 120, { force: true }),
    true,
    '手动触发跳过篇幅门槛'
  );
});

// ---------------------------------------------------------------------------
// 2. 上下文注入
// ---------------------------------------------------------------------------

test('写手上下文：只注入最近 4 章摘要，并给出确定的章号位置', async () => {
  const userId = await defaultUserId();
  const workId = await insertWork(userId);

  for (let i = 1; i <= 7; i += 1) {
    await insertChapter({
      workId,
      chapterSeq: i,
      title: `章${i}`,
      status: i < 7 ? 'done' : 'draft',
      content: i === 7 ? LONG_BODY : '',
      summary: i < 7
        ? JSON.stringify({
            progress: `第${i}章推进`,
            open_threads: `第${i}章未解`,
            setting: `地点${i}`,
            characters: ['林砚'],
          })
        : null,
      summaryWords: i < 7 ? 1200 : 0,
    });
  }

  const chapter7 = await db.get('SELECT id FROM chapters WHERE work_id = ? AND seq = 7', [workId]);
  const { messages, meta } = await assembleContext({
    workId,
    chapterId: chapter7.id,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;

  assert.ok(system.includes('## 全书进度'), '应注入全书进度');
  assert.ok(
    system.includes('当前：第 7 章（全书现有 7 章，前面已有 6 章）'),
    '没有大纲时只给确定的章号事实'
  );
  assert.ok(!system.includes('幕：'), '没有幕信息时不能编造');
  assert.strictEqual(meta.bookProgress.level, 'chapter');
  assert.strictEqual(meta.bookProgress.act, null);

  assert.strictEqual(meta.recentSummaries, 4, '最多注入 4 章');
  for (const i of [3, 4, 5, 6]) {
    assert.ok(system.includes(`第 ${i} 章《章${i}》｜推进：第${i}章推进`), `应注入第 ${i} 章摘要`);
  }
  assert.ok(!system.includes('第 2 章《章2》｜推进'), '更早的摘要不注入');
  assert.ok(!system.includes('第 1 章《章1》｜推进'), '更早的摘要不注入');
});

test('大纲有幕和章号区间：推断当前幕与离最后一幕的距离', async () => {
  const userId = await defaultUserId();
  const outline = [
    '第一幕 起势（第1-2章）',
    '第二幕 追索（第3-5章）',
    '第三幕 收束（第6-7章）',
  ].join('\n');
  const workId = await insertWork(userId, { outline, targetWords: 20000 });

  const chapters = [];
  for (let i = 1; i <= 7; i += 1) {
    const id = await insertChapter({ workId, chapterSeq: i, title: `章${i}` });
    chapters.push({ id, seq: i, volume: '', status: 'draft', word_count: 1000 });
  }

  const chapter4 = chapters[3];
  const info = describeBookProgress({ work: { outline, target_words: 20000 }, chapter: chapter4, chapters });

  assert.strictEqual(info.level, 'act');
  assert.deepStrictEqual(info.act, { index: 2, total: 3, remaining: 1 });
  assert.match(info.text, /幕：第 2 幕（大纲共 3 幕），距最后一幕还有 1 幕/);
  assert.match(info.text, /篇幅：已写 7000 字 \/ 目标 20000 字/);
});

test('大纲解析：只认幕/卷标题，普通段落里的「第X章」不算结构', () => {
  const plan = parseOutlinePlan(
    [
      '故事从一场雨开始。',
      '## 第一卷 青石巷（第1-8章）',
      '这一卷主要铺垫人物关系。',
      '第二卷 旧案（第9-16章）',
      '第一幕 起势（第1-4章）',
      '第二幕 反转（第5-8章）',
    ].join('\n')
  );

  assert.strictEqual(plan.volumes.length, 2);
  assert.strictEqual(plan.acts.length, 2);
  assert.deepStrictEqual(
    { start: plan.volumes[1].start, end: plan.volumes[1].end },
    { start: 9, end: 16 }
  );
});

// ---------------------------------------------------------------------------
// 3. 路由：手动重生成
// ---------------------------------------------------------------------------

test('POST /api/chapters/:id/summary：手动生成成功并写入摘要', async () => {
  fakeModel.setDefault({ content: summaryJson('手动生成的摘要：林砚决定夜探旧宅。') });

  const userId = await defaultUserId();
  const workId = await insertWork(userId);
  const chapterId = await insertChapter({
    workId,
    chapterSeq: 1,
    title: '手动',
    content: LONG_BODY,
  });

  const res = await server.request(`/api/chapters/${chapterId}/summary`, {
    method: 'POST',
    body: {},
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.ok, true, '手动生成应成功');
  assert.match(data.summary.progress, /夜探旧宅/);

  const row = await db.get('SELECT summary FROM chapters WHERE id = ?', [chapterId]);
  assert.match(JSON.parse(row.summary).progress, /夜探旧宅/);
});

test('POST /api/chapters/:id/summary：空章不调用模型，返回可读原因', async () => {
  const userId = await defaultUserId();
  const workId = await insertWork(userId);
  const chapterId = await insertChapter({ workId, chapterSeq: 1, title: '空白' });

  const before = fakeModel.calls.length;
  const res = await server.request(`/api/chapters/${chapterId}/summary`, {
    method: 'POST',
    body: {},
  });
  const data = await res.json();

  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.ok, false);
  assert.strictEqual(data.reason, 'threshold');
  assert.strictEqual(fakeModel.calls.length, before, '空章不应产生模型调用');
});
