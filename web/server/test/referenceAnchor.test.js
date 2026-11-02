'use strict';

/**
 * 范文编排锚点的授权测试。
 *
 * 盯住三件事：
 *   1. **未授权不注入**——默认关闭，光打开开关不确认也不行。
 *   2. **授权后注入且不超限**——锚点必须紧挨节拍表，整块不超过 1500 字。
 *   3. **撤回后不再注入**——内容真的清空，不是只把开关拨回去。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

const app = require('../app');
const { ready, all, get } = require('../database');
const aiConfig = require('../services/aiConfig');
const referenceAnchor = require('../services/agent/referenceAnchor');

let server;
let fakeModel;
let originalConfig;
let seedSeq = 0;

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
        paragraphs: 9,
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
        paragraphs: 9,
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
        paragraphs: 9,
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
        paragraphs: 9,
        endHook: '县衙后门当晚抬出一口箱子',
      },
    ],
  });
}

function planWriterCheckQueue() {
  return [
    { content: validPlanJson(), finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '庙门半掩，主角在门槛外停了停。',
        reason: '按节拍表起稿',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '庙门半掩，主角在门槛外停了停' },
          { id: 'B2', evidence: '他问庙祝照片上是谁，庙祝不答' },
          { id: 'B3', evidence: '旧档中间缺了几页，断口很新' },
          { id: 'B4', evidence: '县衙后门抬出一口箱子' },
        ],
        missing: [],
        weak: [],
        hookPresent: true,
        chapterGoalMet: true,
      }),
      finishReason: 'stop',
    },
  ];
}

async function freshUser(phone) {
  const cookie = await server.loginAs(phone);
  const row = await get('SELECT id FROM users WHERE phone = ?', [phone]);
  return { cookie, userId: row.id };
}

async function seedChapter(userId) {
  seedSeq += 1;
  const workId = `work-anchor-${seedSeq}`;
  const chapterId = `chapter-anchor-${seedSeq}`;
  const now = new Date().toISOString();

  await require('../database').run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, `锚点测试作品${seedSeq}`, now, now]
  );
  await require('../database').run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    [chapterId, workId, `第${seedSeq}章`, seedSeq, '主角进庙查旧案。', now, now]
  );

  return { workId, chapterId };
}

/** 发一条消息，收集整条 SSE 流里的事件。 */
async function chatAs(cookie, message, extra = {}) {
  const res = await server.requestAs(cookie, '/api/ai/chat', {
    method: 'POST',
    body: { message, roleKey: 'writer', ...extra },
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

test.before(async () => {
  await ready;
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
  env.cleanup();
});

test('锚点正文与注入块都在 1500 字以内', () => {
  assert.ok(
    Array.from(referenceAnchor.ANCHOR_TEXT).length <= referenceAnchor.ANCHOR_MAX_CHARS,
    '精选锚点本身不能超过上限'
  );
  assert.ok(
    Array.from(referenceAnchor.formatAnchorBlock(referenceAnchor.ANCHOR_TEXT)).length <=
      referenceAnchor.ANCHOR_MAX_CHARS,
    '连同声明与来源一起也不能超过上限'
  );
});

test('默认关闭：未开启、未确认都不注入', async () => {
  const { cookie, userId } = await freshUser('13900000002');
  const { workId, chapterId } = await seedChapter(userId);

  const initial = await server.requestAs(cookie, '/api/anchor');
  assert.strictEqual(initial.status, 200);
  const before = await initial.json();
  assert.strictEqual(before.enabled, false, '默认不开启');
  assert.strictEqual(before.hasContent, false);

  // 只拨开关、不带确认回执，服务端必须拒绝
  const noConfirm = await server.requestAs(cookie, '/api/anchor', {
    method: 'POST',
    body: {},
  });
  assert.strictEqual(noConfirm.status, 400, '缺少确认必须拒绝');
  assert.match((await noConfirm.json()).error, /确认/);

  fakeModel.setQueue(planWriterCheckQueue());
  const callBefore = fakeModel.calls.length;
  await chatAs(cookie, '按大纲写这一章', { workId, chapterId });

  const writerSystem = String(fakeModel.calls[callBefore + 1].messages[0].content || '');
  assert.ok(!writerSystem.includes('## 范文编排锚点'), '未授权时绝不能注入锚点');
  assert.ok(!writerSystem.includes('质量参照，不要照抄句子'), '未授权时连声明都不该出现');
});

test('确认开启后注入，紧挨节拍表且长度不超限', async () => {
  const { cookie, userId } = await freshUser('13900000003');
  const { workId, chapterId } = await seedChapter(userId);

  const enabledRes = await server.requestAs(cookie, '/api/anchor', {
    method: 'POST',
    body: { confirmed: true },
  });
  assert.strictEqual(enabledRes.status, 200);
  const enabled = await enabledRes.json();
  assert.strictEqual(enabled.enabled, true);
  assert.strictEqual(enabled.source.file, 'docs/superpowers/baseline/sample.md');
  assert.strictEqual(enabled.source.paragraphs, 45);
  assert.strictEqual(enabled.source.chars, 5047);
  assert.ok(enabled.chars <= enabled.maxChars);

  // 再开一次只能覆盖同一行，不能出现第二张
  await server.requestAs(cookie, '/api/anchor', {
    method: 'POST',
    body: { confirmed: true },
  });
  const rows = await all('SELECT user_id FROM reference_anchors WHERE user_id = ?', [userId]);
  assert.strictEqual(rows.length, 1, '一个作者只允许存在一张锚点');

  fakeModel.setQueue(planWriterCheckQueue());
  const callBefore = fakeModel.calls.length;
  await chatAs(cookie, '按大纲写这一章', { workId, chapterId });

  const writerSystem = String(fakeModel.calls[callBefore + 1].messages[0].content || '');
  const planIndex = writerSystem.indexOf('## 本章节拍表（硬约束，必须覆盖）');
  const anchorIndex = writerSystem.indexOf('## 范文编排锚点');
  assert.ok(planIndex >= 0, '节拍表应当在写手 system 里');
  assert.ok(anchorIndex >= 0, '授权后应当注入锚点');
  assert.ok(anchorIndex > planIndex, '锚点要紧挨节拍表之后');

  const anchorBlock = writerSystem.slice(anchorIndex);
  assert.match(anchorBlock, /质量参照，不要照抄句子，要照它的编排方式/, '必须写明这是参照不是抄写');
  assert.match(anchorBlock, /目标—阻碍—代价/, '要保留编排示范');
  assert.ok(
    Array.from(anchorBlock).length <= referenceAnchor.ANCHOR_MAX_CHARS,
    `注入块不能超过 1500 字，实际 ${Array.from(anchorBlock).length}`
  );
});

test('撤回后清空内容并留标记，不再注入', async () => {
  const { cookie, userId } = await freshUser('13900000004');
  const { workId, chapterId } = await seedChapter(userId);

  await server.requestAs(cookie, '/api/anchor', {
    method: 'POST',
    body: { confirmed: true },
  });
  const withdrawnRes = await server.requestAs(cookie, '/api/anchor', { method: 'DELETE' });
  assert.strictEqual(withdrawnRes.status, 200);
  const withdrawn = await withdrawnRes.json();
  assert.strictEqual(withdrawn.enabled, false);
  assert.strictEqual(withdrawn.hasContent, false);
  assert.ok(withdrawn.withdrawnAt, '撤回要留下时间标记');
  assert.strictEqual(withdrawn.source, null);

  // 库里也不能残留正文：只关开关、留内容等于埋了一颗静默复活的雷
  const row = await get(
    'SELECT enabled, content, source FROM reference_anchors WHERE user_id = ?',
    [userId]
  );
  assert.strictEqual(row.enabled, 0);
  assert.strictEqual(row.content, null, '撤回后锚点正文必须清空');
  assert.strictEqual(row.source, null);

  fakeModel.setQueue(planWriterCheckQueue());
  const callBefore = fakeModel.calls.length;
  await chatAs(cookie, '按大纲写这一章', { workId, chapterId });

  const writerSystem = String(fakeModel.calls[callBefore + 1].messages[0].content || '');
  assert.ok(!writerSystem.includes('## 范文编排锚点'), '撤回后不得再注入');
});
