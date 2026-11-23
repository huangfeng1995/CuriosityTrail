'use strict';

/**
 * HP12：关键抉择暂停点。
 *
 * 验收（PV12）：
 *   1. 规划出「决定 + critical + 2–3 选项」时，规划完成后**不调用写手**，
 *      SSE 发 plan_ready，计划行落成 awaiting_choice；
 *   2. 作者选定后，用同一句话恢复，拍表直接复用（0 次规划调用），
 *      写手 system 里追加「本节拍已定：label；后果：consequence」；
 *   3. 断流/关页面不丢：awaiting_choice 的计划可以重新取到、再次暂停；
 *   4. 放行（不选）与放弃（abandoned）都按状态机走，不自动降级。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

let db;
let app;
let server;
let fakeModel;
let originalConfig;
let workId;
let chapterId;

const OPTIONS = [
  { id: 'o1', label: '当场交出照片', consequence: '庙祝放他走，但知县知道有人查到了照片' },
  { id: 'o2', label: '谎称照片已烧掉', consequence: '暂时脱身，庙祝却记住了他的脸' },
  { id: 'o3', label: '夺门而出带走照片', consequence: '拿到证据，从此被县衙通缉' },
];

function jsonResponse(payload) {
  return { content: JSON.stringify(payload), finishReason: 'stop' };
}

/** 第二拍是 critical 决定：规划完成后必须停下来等作者选。 */
function criticalPlanJson() {
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
        entities: [],
      },
      {
        id: 'B2',
        type: '决定',
        critical: true,
        options: OPTIONS,
        goal: '处理手里这张照片',
        obstacle: '庙祝逼他当场交出来',
        cost: '无论怎么选都会留下把柄',
        delta: { variable: '决心', from: '只想查清线索', to: '决定把命押上去' },
        infoGain: '庙祝认得照片背面的字迹',
        paragraphs: 10,
        endHook: '庙门外传来马蹄声',
        entities: [],
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
        entities: [],
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
        entities: [],
      },
    ],
  });
}

function segmentBody(label, extraParagraph = '') {
  const sentence = '风雪压着庙檐，他把手按在门环上，指腹能摸到一层薄冰，门里有人轻轻咳了一声。';
  const anchors = {
    2: '庙门半掩，主角在门槛外停了停。他问庙祝照片上是谁，庙祝不答。',
    11: '旧档中间缺了几页，断口很新。',
  };
  const rows = Array.from(
    { length: extraParagraph ? 19 : 20 },
    (_, i) => anchors[i] || `${label}第${i + 1}段：${sentence}${sentence}${sentence}`
  );
  if (extraParagraph) rows.push(extraParagraph);
  return rows.join('\n\n');
}

/** 恢复轮次：只有两组正文 + 覆盖自检，没有规划。 */
function writingQueue() {
  return [
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

async function chat(message, extra = {}) {
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message, roleKey: 'writer', workId, chapterId, ...extra },
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

function writerSystemPrompts() {
  return fakeModel.calls
    .map((body) => String(body?.messages?.[0]?.content || ''))
    .filter((system) => system.includes('## 本章节拍表'));
}

async function planRow() {
  return db.get(
    'SELECT * FROM chapter_plans WHERE chapter_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
    [chapterId]
  );
}

async function choose(planId, optionId) {
  const body = optionId === undefined ? {} : { optionId };
  const res = await server.request(`/api/chapters/${chapterId}/plans/${planId}/choose`, {
    method: 'POST',
    body,
  });
  return res;
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
    body: { title: '暂停点作品', template: 'history_thriller' },
  });
  assert.strictEqual(created.status, 200);
  workId = (await created.json()).id;

  chapterId = 'pause-ch1';
  const now = new Date().toISOString();
  // 大纲超过 40 字：走 outline 模式，不受六类功能拍与范文份额牵连，
  // 这样「暂停只调了 1 次模型」才是一个纯净的断言。
  const outline =
    '主角进庙查到一张旧照片，知县当夜派人来取，他必须在交出与藏起之间当场决定。';
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline,
        word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    [chapterId, workId, outline, now, now]
  );
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) require('../services/aiConfig').updateConfig(originalConfig);
  env.cleanup();
});

test('规划出关键抉择：只调规划、不调写手，plan_ready 带 3 个选项', async () => {
  const beforeCalls = fakeModel.calls.length;
  fakeModel.setQueue([{ content: criticalPlanJson(), finishReason: 'stop' }]);

  const events = await chat('写这一章');

  // PV12：provider 调用次数 = 1（只有规划），写手一次都没跑。
  assert.strictEqual(fakeModel.calls.length - beforeCalls, 1, '规划后不得调用写手');
  assert.ok(!events.find((event) => event.type === 'action'), '不应有正文交付');

  const ready = events.find((event) => event.type === 'plan_ready');
  assert.ok(ready, '必须发 plan_ready');
  assert.strictEqual(ready.beatId, 'B2');
  assert.strictEqual(ready.options.length, 3);
  assert.deepStrictEqual(
    ready.options.map((option) => option.id),
    ['o1', 'o2', 'o3']
  );
  assert.ok(ready.beats.length >= 4, 'plan_ready 要带整份拍表，作者要能看一眼');

  const done = events.filter((event) => event.type === 'done').pop();
  assert.strictEqual(done.stopReason, 'plan_paused');

  const row = await planRow();
  assert.strictEqual(row.status, 'awaiting_choice');
  assert.strictEqual(row.chosen, null);
  assert.strictEqual(JSON.parse(row.options).length, 3, '选项要随计划行落库');
});

test('待选计划可以按章取回：断流/关页面回来还能选', async () => {
  const res = await server.request(`/api/chapters/${chapterId}/plans/pending`);
  assert.strictEqual(res.status, 200);
  const { pending } = await res.json();
  assert.ok(pending, 'awaiting_choice 的计划必须能取回');
  assert.strictEqual(pending.beatId, 'B2');
  assert.strictEqual(pending.options.length, 3);
});

test('未选就重进：再次暂停，不替作者做决定', async () => {
  const beforePlan = planningCallCount();
  const beforeCalls = fakeModel.calls.length;

  const events = await chat('继续写这一章');

  assert.strictEqual(fakeModel.calls.length - beforeCalls, 0, '复用计划不该再调模型');
  assert.strictEqual(planningCallCount(), beforePlan, '未过期计划不重新规划');
  const ready = events.find((event) => event.type === 'plan_ready');
  assert.ok(ready, '仍停在 awaiting_choice，必须把面板再给一次');
  assert.ok(!events.find((event) => event.type === 'action'), '仍未选定，不得开写');
});

test('非法选项被拒绝：计划保持 awaiting_choice', async () => {
  const row = await planRow();
  const res = await choose(row.id, 'o-not-exist');
  assert.strictEqual(res.status, 422);
  const after = await planRow();
  assert.strictEqual(after.status, 'awaiting_choice');
  assert.strictEqual(after.chosen, null);
});

test('选定后恢复：复用拍表、注入「本节拍已定」，正文照常交付', async () => {
  const row = await planRow();
  const chosen = OPTIONS[1];

  const res = await choose(row.id, chosen.id);
  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.strictEqual(payload.status, 'confirmed');
  assert.strictEqual(payload.option.label, chosen.label);

  const afterChoose = await planRow();
  assert.strictEqual(afterChoose.status, 'confirmed');
  assert.strictEqual(afterChoose.chosen, chosen.id);

  const beforePlan = planningCallCount();
  fakeModel.setQueue(writingQueue());
  const events = await chat('写这一章', { resumePlanId: row.id });

  assert.ok(events.find((event) => event.type === 'action'), '选定后必须继续写作');
  assert.strictEqual(planningCallCount(), beforePlan, '恢复不得重新规划');

  const systems = writerSystemPrompts();
  assert.ok(systems.length > 0, '写手必须被调用');
  const constraint = systems.find((system) => system.includes('## 本节拍已定'));
  assert.ok(constraint, '选定项要作为硬约束进写手 system');
  assert.ok(constraint.includes(chosen.label));
  assert.ok(constraint.includes(chosen.consequence));
  // 未选的选项不该出现在写手提示里，否则模型会自己挑一个。
  assert.ok(!constraint.includes(OPTIONS[2].label), '未选选项不得进入写手提示');
});

test('放行：不选也确认，写手按原计划写、不追加已定约束', async () => {
  // 造一份新的待选计划：改大纲触发重排。
  await db.run('UPDATE chapters SET outline = ? WHERE id = ?', [
    '主角夜探县衙，撞见主簿在烧一批旧档，他必须在当场拦下与放走之间做出决定。',
    chapterId,
  ]);
  fakeModel.setQueue([{ content: criticalPlanJson(), finishReason: 'stop' }]);
  await chat('按新大纲重排');
  const paused = await planRow();
  assert.strictEqual(paused.status, 'awaiting_choice');

  const res = await choose(paused.id, undefined);
  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.strictEqual(payload.status, 'confirmed');
  assert.strictEqual(payload.option, null);

  fakeModel.setQueue(writingQueue());
  const events = await chat('按新大纲重排', { resumePlanId: paused.id });
  assert.ok(events.find((event) => event.type === 'action'));
  const systems = writerSystemPrompts();
  assert.ok(systems.length > 0);
  assert.ok(
    !systems[systems.length - 1].includes('## 本节拍已定'),
    '放行不追加选项约束'
  );
});

test('模板关闭：拍表照常落库，但不暂停、不注入已定约束', async () => {
  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: '无模板作品', template: '' },
  });
  assert.strictEqual(created.status, 200);
  const plainWorkId = (await created.json()).id;
  const plainChapterId = 'pause-plain-ch1';
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline,
        word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', '', '[]', ?, 0, ?, ?)`,
    [
      plainChapterId,
      plainWorkId,
      '主角进庙查到一张旧照片，知县当夜派人来取，他必须在交出与藏起之间当场决定。',
      now,
      now,
    ]
  );

  fakeModel.setQueue([
    { content: criticalPlanJson(), finishReason: 'stop' },
    ...writingQueue(),
  ]);
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: {
      message: '写这一章',
      roleKey: 'writer',
      workId: plainWorkId,
      chapterId: plainChapterId,
    },
  });
  assert.strictEqual(res.status, 200);
  const events = (await res.text())
    .split('\n\n')
    .filter((chunk) => chunk.trim().startsWith('data:'))
    .map((chunk) => {
      const payload = chunk.slice(5).trim();
      return payload === '[DONE]' ? { type: 'done' } : JSON.parse(payload);
    });

  assert.ok(!events.find((event) => event.type === 'plan_ready'), '模板关闭时不得暂停');
  assert.ok(events.find((event) => event.type === 'action'), '应当直接交付正文');
  const systems = fakeModel.calls
    .map((body) => String(body?.messages?.[0]?.content || ''))
    .filter((system) => system.includes('## 本章节拍表'));
  assert.ok(systems.length > 0);
  assert.ok(
    !systems[systems.length - 1].includes('## 本节拍已定'),
    '模板关闭时不得注入停顿点约束'
  );
});

test('放弃：计划转 abandoned，再写会重新规划', async () => {
  await db.run('UPDATE chapters SET outline = ? WHERE id = ?', [
    '主角追查照片来源，在庙祝与主簿之间做出取舍，并在当夜做出最终决定。',
    chapterId,
  ]);
  fakeModel.setQueue([{ content: criticalPlanJson(), finishReason: 'stop' }]);
  await chat('重新规划');
  const paused = await planRow();
  assert.strictEqual(paused.status, 'awaiting_choice');

  const res = await server.request(
    `/api/chapters/${chapterId}/plans/${paused.id}/abandon`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 200);
  const abandoned = await planRow();
  assert.strictEqual(abandoned.status, 'abandoned');

  // abandoned 不参与复用：下一次写作必须重新规划。
  const beforePlan = planningCallCount();
  fakeModel.setQueue([{ content: criticalPlanJson(), finishReason: 'stop' }]);
  const events = await chat('放弃后重来');
  assert.strictEqual(planningCallCount(), beforePlan + 1, '放弃后必须重新规划');
  assert.ok(events.find((event) => event.type === 'plan_ready'), '重排后仍有关键抉择就再停');
});
