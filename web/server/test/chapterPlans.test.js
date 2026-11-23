'use strict';

/**
 * HP11：chapter_plans 落库与复用。
 *
 * 断言三件事：
 *   1. 规划成功后拍表落库（同一章只有一行，重跑更新它）；
 *   2. 同章大纲/正文都没变时，第二次直接复用，不再调用 brief 与规划；
 *   3. 大纲或正文任一变化，计划视为过期，必须重新规划。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');
const { segmentBody } = require('./segmentBodyFixture');

const env = setupTempEnv();

let db;
let app;
let server;
let fakeModel;
let originalConfig;
let workId;
let chapterId;

function jsonResponse(payload) {
  return { content: JSON.stringify(payload), finishReason: 'stop' };
}

function validPlanJson() {
  return JSON.stringify({
    chapterGoal: '主角查清旧案的第一条线索',
    protagonistIntent: '进庙查案',
    obstacle: '庙祝拦门',
    cost: '交出随身信物',
    hook: '照片背面写着主角的名字',
    avoidRepeat: [],
    mainType: '揭示',
    beats: [
      {
        id: 'B1',
        type: '行动',
        goal: '进入城隍庙',
        obstacle: '庙祝拦着不让进',
        cost: '押上唯一的信物',
        delta: { variable: '处境', from: '被挡在庙外', to: '进入内殿' },
        infoGain: '庙里供着的不是城隍像，而是一张旧照片',
        paragraphs: 10,
        endHook: '照片上的人穿着现任知县的官服',
      },
      {
        id: 'B2',
        type: '冲突',
        goal: '问出照片来历',
        obstacle: '庙祝闪烁其词',
        cost: '被赶出庙门',
        delta: { variable: '关系', from: '互相试探', to: '彻底翻脸' },
        infoGain: '旧案发生在二十年前，当时知县尚未到任',
        paragraphs: 10,
        endHook: '庙祝说漏了「那年冬天」四个字',
      },
      {
        id: 'B3',
        type: '转折',
        goal: '从旧档里找出那年冬天的记录',
        obstacle: '档案被抽走了关键几页',
        cost: '惊动管档的主簿',
        delta: { variable: '信息', from: '以为只是一桩旧案', to: '发现有人一直在抹掉它' },
        infoGain: '缺失的几页正好是案发前后三个月',
        paragraphs: 10,
        endHook: '主簿当夜就请了病假',
      },
      {
        id: 'B4',
        type: '揭示',
        goal: '确认照片上的人是谁',
        obstacle: '照片已被人提前取走',
        cost: '失去当面指认的机会',
        delta: { variable: '决心', from: '只想查清线索', to: '决定把这桩旧案翻到底' },
        infoGain: '取走照片的人留下了与知县相同的印泥',
        paragraphs: 10,
        endHook: '县衙后门当晚抬出一口箱子',
      },
    ],
  });
}

/** 规划成功 → 两组正文 → 覆盖自检。 */
function planningQueue() {
  return [
    { content: validPlanJson(), finishReason: 'stop' },
    jsonResponse({
      action: 'append',
      content: segmentBody('第一组'),
      reason: '按节拍表写第一组',
      citations: [],
    }),
    jsonResponse({
      action: 'append',
      content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
      reason: '按节拍表写第二组并收束',
      citations: [],
    }),
    jsonResponse({
      covered: [
        { id: 'B1', evidence: '庙门半掩，主角在门槛外停了停' },
        { id: 'B2', evidence: '他问庙祝照片上是谁' },
        { id: 'B3', evidence: '旧档中间缺了几页' },
        { id: 'B4', evidence: '县衙后门当晚抬出一口箱子' },
      ],
      missing: [],
      weak: [],
      hookPresent: true,
      chapterGoalMet: true,
    }),
  ];
}

/** 复用轮次只需要写正文与自检，不再有规划响应。 */
function writingOnlyQueue() {
  return planningQueue().slice(1);
}

async function chat(message) {
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message, roleKey: 'writer', workId, chapterId },
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().startsWith('data:'))
    .map((chunk) => {
      const payload = chunk.slice(5).trim();
      return payload === '[DONE]' ? { type: 'done' } : JSON.parse(payload);
    });
}

function planningCallCount() {
  return fakeModel.calls.filter((body) =>
    String(body?.messages?.[0]?.content || '').includes('你是章节节拍规划器')
  ).length;
}

async function planRow() {
  return db.get('SELECT * FROM chapter_plans WHERE chapter_id = ?', [chapterId]);
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  app = require('../app');

  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();
  const aiConfig = require('../services/aiConfig');
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
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'stop' });

  server = await startServer(app);
  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: '拍表复用作品', template: 'history_thriller' },
  });
  assert.strictEqual(created.status, 200);
  workId = (await created.json()).id;

  chapterId = 'plan-ch1';
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline,
        word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', '', '[]', '主角进庙查旧案。', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) require('../services/aiConfig').updateConfig(originalConfig);
  env.cleanup();
});

test('规划成功后拍表落库：同一章只有一行', async () => {
  fakeModel.setQueue(planningQueue());
  const events = await chat('写这一章');
  assert.ok(events.find((event) => event.type === 'action'));

  const row = await planRow();
  assert.ok(row, '规划成功后必须有 chapter_plans 行');
  const plan = JSON.parse(row.plan);
  assert.strictEqual(plan.beats.length, 4);
  assert.strictEqual(row.status, 'confirmed');
  assert.ok(row.outline_hash, '要记大纲指纹');
  assert.strictEqual(row.body_hash.length, 40, '要记正文指纹');

  const count = await db.get(
    'SELECT COUNT(*) AS c FROM chapter_plans WHERE chapter_id = ?',
    [chapterId]
  );
  assert.strictEqual(count.c, 1);
});

test('同章同大纲/正文：直接复用，不再调用 brief 与规划', async () => {
  const before = planningCallCount();
  const beforeBrief = fakeModel.briefCalls.length;
  const beforeRow = await planRow();

  fakeModel.setQueue(writingOnlyQueue());
  const events = await chat('再写一遍这一章');
  assert.ok(events.find((event) => event.type === 'action'));

  assert.strictEqual(planningCallCount(), before, '复用轮次不能再调用规划');
  assert.strictEqual(fakeModel.briefCalls.length, beforeBrief, '复用轮次不能再调用 brief');

  const afterRow = await planRow();
  assert.strictEqual(afterRow.updated_at, beforeRow.updated_at, '复用不重写计划行');
});

test('大纲改过：计划过期，必须重新规划', async () => {
  await db.run('UPDATE chapters SET outline = ? WHERE id = ?', ['新的短大纲，仍然不超过四十字。', chapterId]);
  const before = planningCallCount();

  fakeModel.setQueue(planningQueue());
  await chat('大纲改了，重排');

  assert.strictEqual(planningCallCount(), before + 1, '大纲变化必须重排一次');
  const row = await planRow();
  assert.notStrictEqual(row.outline_hash, '', '新计划要记录新的大纲指纹');
});

test('正文改过：计划过期，必须重新规划', async () => {
  await db.run('UPDATE chapters SET content = ?, blocks = ? WHERE id = ?', [
    '作者刚补的一段正文。',
    JSON.stringify([{ id: 'b1', type: 'paragraph', content: '作者刚补的一段正文。' }]),
    chapterId,
  ]);
  const before = planningCallCount();

  fakeModel.setQueue(planningQueue());
  await chat('正文改了，重排');

  assert.strictEqual(planningCallCount(), before + 1, '正文变化必须重排一次');
  const row = await planRow();
  const expected = require('crypto')
    .createHash('sha1')
    .update(JSON.stringify([{ id: 'b1', type: 'paragraph', content: '作者刚补的一段正文。' }]))
    .digest('hex');
  assert.strictEqual(row.body_hash, expected, '正文指纹必须按 blocks 记录');
});
