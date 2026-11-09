'use strict';

/**
 * HP8：历史悬疑流水线端到端集成（PV1–PV10）。
 *
 * 用真实链路跑一遍：真实 Express 路由 + 临时 SQLite + 假 provider。
 * 每个 PV 都打印实际观测值，不做「应该通过」式的空断言。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const aiConfig = require('../services/aiConfig');
const { assembleContext } = require('../services/context');

let server;
let fakeModel;
let originalConfig;
let userId;

/** 闭环作品：一条作品同时覆盖锚点、写章、知情扫描与关闭回退。 */
let workId;
/** 第 45 章：锚点在界内；第 39 章：锚点在界外。 */
const CH45 = 'hp8-ch-45';
const CH39 = 'hp8-ch-39';
const CH1 = 'hp8-ch-1';
const CH2 = 'hp8-ch-2';
const CH3 = 'hp8-ch-3';
const CH4 = 'hp8-ch-4';

const CHAR_ID = 'hp8-char-yang';
const FACT_KNOWN_SEQ3 = 'hp8-fact-recommend';
const FACT_SCAN = 'hp8-fact-secret';
const EVIDENCE_ID = 'hp8-evidence-letter';

let caoAnchorId = '';
let blankAnchorId = '';
let baselineClosedSystem = '';
let pendingKnowledgeId = '';

function jsonResponse(payload) {
  return { content: JSON.stringify(payload), finishReason: 'stop' };
}

async function settleBackground() {
  let previous = -1;
  for (let i = 0; i < 12; i += 1) {
    if (fakeModel.calls.length === previous) return;
    previous = fakeModel.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function chat(message, extra = {}) {
  const res = await server.request('/api/ai/chat', {
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

async function assemble(chapterId, extra = {}) {
  return assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    userId,
    ...extra,
  });
}

function systemOf(result) {
  return result.messages[0].content;
}

async function insertChapter(id, seq, { title, outline = '', content = '' }) {
  const now = new Date().toISOString();
  const blocks = content
    ? JSON.stringify([{ id: `b-${id}`, type: 'paragraph', content }])
    : '[]';
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', ?, ?, ?, 0, ?, ?)`,
    [id, workId, title, seq, content, blocks, outline, now, now]
  );
}

/** 一份合格的节拍表：四拍、合计 40 段。 */
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

/** 20 段 × 约 120 字，避免分段写作时触发续写。 */
function segmentBody(label, extraParagraph = '') {
  const sentence = '风雪压着庙檐，他把手按在门环上，指腹能摸到一层薄冰，门里有人轻轻咳了一声。';
  const rows = Array.from(
    { length: 20 },
    (_, i) => `${label}第${i + 1}段：${sentence}${sentence}${sentence}`
  );
  if (extraParagraph) rows.push(extraParagraph);
  return rows.join('\n\n');
}

/** 规划成功 → 两组正文 → 覆盖自检。 */
function planningQueue() {
  return [
    { content: validPlanJson(), finishReason: 'stop' },
    jsonResponse({
      action: 'append',
      content: '曹操端坐堂上，众客屏息。\n\n' + segmentBody('第一组'),
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
        { id: 'B1', evidence: '曹操端坐堂上，众客屏息' },
        { id: 'B2', evidence: '他问庙祝照片上是谁' },
        { id: 'B3', evidence: '旧档中间缺了几页' },
        { id: 'B4', evidence: '县衙后门抬出一口箱子' },
      ],
      missing: [],
      weak: [],
      hookPresent: true,
      chapterGoalMet: true,
    }),
  ];
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

  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'stop' });
  server = await startServer(app);

  const user = await db.get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  assert.ok(user, '默认测试用户应当存在');
  userId = user.id;

  // 作品先以「未启用」状态创建，用于 PV1 的逐字节基线。
  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: 'HP8 端到端闭环' },
  });
  assert.strictEqual(created.status, 200);
  const work = await created.json();
  workId = work.id;
  assert.strictEqual(work.template, '', '新作品默认不启用模板');

  await insertChapter(CH1, 1, {
    title: '第一章：举荐信',
    outline: '杨平在府中与人密谈。',
    content: '杨平道：我知道司马懿举荐过我。那封举荐信的封泥是青色的。',
  });
  await insertChapter(CH2, 2, {
    title: '第二章',
    outline: '杨平在府中与人密谈。',
    content: '杨平在廊下等了半个时辰。',
  });
  await insertChapter(CH3, 3, {
    title: '第三章',
    outline: '杨平在府中与人密谈。',
    content: '杨平在灯下猜了一遍又一遍。',
  });
  await insertChapter(CH4, 4, {
    title: '第四章',
    outline: '杨平在府中与人密谈。',
    content: '夜色压在瓦上，杨平没有睡。',
  });
  await insertChapter(CH39, 39, {
    title: '第三十九章',
    outline: '曹操夜宴，司马懿在侧。',
  });
  await insertChapter(CH45, 45, {
    title: '第四十五章',
    outline: '曹操夜宴，司马懿在侧。',
  });

  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, '', ?, ?)`,
    [CHAR_ID, workId, '杨平', now, now]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [
      FACT_KNOWN_SEQ3,
      workId,
      '司马懿曾向曹操举荐他，此事只有曹操与荀彧知道',
      '举荐,曹操',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:01.000Z',
    ]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [
      FACT_SCAN,
      workId,
      '司马懿私藏了先帝的密诏，只有他一人知道',
      '密诏',
      '2026-01-01T00:00:02.000Z',
      '2026-01-01T00:00:02.000Z',
    ]
  );
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, 3, 'knows', ?)`,
    ['hp8-km-f2', workId, CHAR_ID, FACT_KNOWN_SEQ3, now]
  );
  await db.run(
    `INSERT INTO evidence_items
       (id, work_id, title, holder_kind, holder_character_id, fact_id,
        seen_by, status, created_at, modified_at)
     VALUES (?, ?, '举荐信', 'character', ?, ?, '[]', 'active', ?, ?)`,
    [EVIDENCE_ID, workId, CHAR_ID, FACT_KNOWN_SEQ3, now, now]
  );
});

test.after(async () => {
  try {
    await settleBackground();
  } catch (e) {
    // 收尾等待失败不影响断言结果
  }
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) aiConfig.updateConfig(originalConfig);
  env.cleanup();
});

// ---------------------------------------------------------------------------
// PV1：关闭模板 / PV6：无锚点分区 / PV10：无知情分区
// ---------------------------------------------------------------------------

test('PV1：关闭模板同数据两跑逐字节相等，且无锚点/知情分区', async () => {
  const first = await assemble(CH4);
  const second = await assemble(CH4);

  const body = systemOf(first);
  assert.strictEqual(body, systemOf(second), '同一份数据两次装配必须逐字节相等');
  assert.strictEqual(first.meta.pipeline, false);
  assert.doesNotMatch(body, /## 历史锚点/);
  assert.doesNotMatch(body, /## 本章知情边界/);

  baselineClosedSystem = body;
  console.log(
    '[PV1] 关闭态两跑相等 = true；长度 =',
    body.length,
    '；pipeline =',
    first.meta.pipeline,
    '；含历史锚点 =',
    /## 历史锚点/.test(body),
    '；含知情边界 =',
    /## 本章知情边界/.test(body)
  );
});

test('PV2：缺出处的 sourced 整批 422，零入库；随后正常导入并激活锚点', async () => {
  const enabled = await server.request(`/api/works/${workId}`, {
    method: 'PUT',
    body: { template: 'history_thriller' },
  });
  assert.strictEqual(enabled.status, 200);
  assert.strictEqual((await enabled.json()).template, 'history_thriller');

  const before = await db.get(
    'SELECT COUNT(*) AS c FROM work_anchors WHERE work_id = ?',
    [workId]
  );

  // 一条合法 + 一条缺 source_title：整批拒绝，合法那条也不许落库。
  const invalid = await server.request(`/api/pipeline/${workId}/anchors/import`, {
    method: 'POST',
    body: {
      candidates: [
        {
          kind: 'person',
          subject: '曹操',
          claim: '建安二十五年正月，曹操还军洛阳，此后不再亲临许都',
          confidence: 'sourced',
          source_title: '三国志·武帝纪',
          source_locator: '卷二十五·建安二十五年',
          immutable: true,
          rules: [
            {
              rule_type: 'presence_forbidden',
              params: { persons: ['曹操'], from_seq: 40 },
            },
          ],
        },
        {
          kind: 'event',
          subject: '许都旧案',
          claim: '旧档缺页',
          confidence: 'sourced',
          source_locator: '卷二十一·旧档',
          immutable: true,
        },
      ],
    },
  });
  assert.strictEqual(invalid.status, 422, '缺书名必须整批 422');
  const stillZero = await db.get(
    'SELECT COUNT(*) AS c FROM work_anchors WHERE work_id = ?',
    [workId]
  );
  assert.strictEqual(stillZero.c, before.c, '整批拒绝时零写入');

  const valid = await server.request(`/api/pipeline/${workId}/anchors/import`, {
    method: 'POST',
    body: {
      candidates: [
        {
          kind: 'person',
          subject: '曹操',
          claim: '建安二十五年正月，曹操还军洛阳，此后不再亲临许都',
          confidence: 'sourced',
          source_title: '三国志·武帝纪',
          source_locator: '卷二十五·建安二十五年',
          immutable: true,
          rules: [
            {
              rule_type: 'presence_forbidden',
              params: { persons: ['曹操'], from_seq: 40 },
            },
          ],
        },
        {
          kind: 'time',
          subject: '建安二十五年',
          claim: '曹操卒年',
          confidence: 'blank',
          why_blank: '卒月各书不一',
          usable_for: '避开精确月份',
        },
      ],
    },
  });
  assert.strictEqual(valid.status, 200);
  const payload = await valid.json();
  assert.strictEqual(payload.imported, 2);
  assert.strictEqual(payload.blankAreas, 1);
  caoAnchorId = payload.anchors[0].id;
  blankAnchorId = payload.anchors[1].id;

  const activated = await server.request(
    `/api/pipeline/${workId}/anchors/${caoAnchorId}/activate`,
    { method: 'POST' }
  );
  assert.strictEqual(activated.status, 200);
  assert.strictEqual((await activated.json()).status, 'active');

  console.log(
    '[PV2] 非法批 = 422；非法批后行数 =',
    stillZero.c,
    '；合法批 imported =',
    payload.imported,
    '；blankAreas =',
    payload.blankAreas,
    '；曹操锚点 status = active'
  );
});

test('PV3：blank 强设 immutable 被路由与 DB CHECK 双重拒绝', async () => {
  const before = await db.get(
    'SELECT COUNT(*) AS c FROM work_anchors WHERE work_id = ?',
    [workId]
  );

  const res = await server.request(`/api/pipeline/${workId}/anchors/import`, {
    method: 'POST',
    body: {
      candidates: [
        {
          kind: 'time',
          subject: '杨俊赴许都日期',
          claim: '日期无载',
          confidence: 'blank',
          immutable: true,
          why_blank: '史料只记月份',
        },
      ],
    },
  });
  assert.strictEqual(res.status, 422);
  const after = await db.get(
    'SELECT COUNT(*) AS c FROM work_anchors WHERE work_id = ?',
    [workId]
  );
  assert.strictEqual(after.c, before.c, '路由拒绝时零写入');

  await assert.rejects(
    db.run('UPDATE work_anchors SET immutable = 1 WHERE id = ?', [blankAnchorId]),
    /CHECK constraint failed/i,
    '数据库 CHECK 必须拦住 blank + immutable'
  );

  const blank = await db.get('SELECT immutable FROM work_anchors WHERE id = ?', [
    blankAnchorId,
  ]);
  assert.strictEqual(blank.immutable, 0, '拒绝后原值仍是 0');

  console.log(
    '[PV3] 路由状态 =',
    res.status,
    '；写入前后行数 =',
    before.c,
    '→',
    after.c,
    '；DB UPDATE blank→immutable 被 CHECK 拒绝 = true'
  );
});

// ---------------------------------------------------------------------------
// PV4 / PV5：章末锚点检查（界内命中、界外不命中）
// ---------------------------------------------------------------------------

test('PV4：第 45 章写到曹操 → 命中 1 条，quote 可 slice 回原句', async () => {
  await settleBackground();
  fakeModel.setQueue(planningQueue());

  const events = await chat('写这一章', { workId, chapterId: CH45 });
  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action');
  assert.strictEqual(action.action, 'append');
  assert.match(action.content, /曹操端坐堂上/);

  // 规划成功：节拍覆盖齐全；但 brief 没有 MW 项，悬念这一项要如实标注。
  assert.ok(action.beatCheck, '规划成功时应带覆盖报告');
  assert.deepStrictEqual(action.beatCheck.missing, []);
  assert.ok(action.beatCheck.covered.length >= 4);
  // 规划本身成功，但 brief 没有 MW 项：悬念自检没有守卫目标，必须写明。
  assert.strictEqual(action.planDegraded, 'withhold:unmapped:无MW项');

  const violationEvent = events.find((e) => e.type === 'anchor_violation');
  assert.ok(violationEvent, '应当下发 anchor_violation 事件');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.strictEqual(done.anchorViolations.length, 1, '第 45 章只应命中 1 条');

  const violation = done.anchorViolations[0];
  assert.strictEqual(violation.anchorId, caoAnchorId);
  assert.strictEqual(violation.ruleType, 'presence_forbidden');
  assert.strictEqual(violation.severity, 'block');
  assert.ok(violation.quote.includes('曹操'));
  assert.strictEqual(
    action.content.slice(violation.offset, violation.offset + violation.quote.length),
    violation.quote,
    'quote 必须能按 offset 逐字 slice 回正文'
  );

  const stored = await db.all(
    'SELECT * FROM anchor_violations WHERE work_id = ? AND chapter_id = ?',
    [workId, CH45]
  );
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].severity, 'block');

  console.log(
    '[PV4] violations =',
    done.anchorViolations.length,
    '；quote =',
    JSON.stringify(violation.quote),
    '；slice 回原句 = true；severity =',
    violation.severity,
    '；beatCheck.covered =',
    action.beatCheck.covered.length,
    '；missing =',
    JSON.stringify(action.beatCheck.missing),
    '；planDegraded =',
    JSON.stringify(action.planDegraded)
  );
});

test('PV5：同样的正文放到第 39 章（界外）→ 0 条命中', async () => {
  await settleBackground();
  fakeModel.setQueue([
    // 两次不合格规划 → 降级直写，仍然走真实的章末断言。
    { content: JSON.stringify({ beats: [] }), finishReason: 'stop' },
    { content: JSON.stringify({ chapterGoal: '只有目标' }), finishReason: 'stop' },
    jsonResponse({
      action: 'append',
      content: '曹操端坐堂上，众客屏息。',
      reason: '直写',
      citations: [],
    }),
  ]);

  const events = await chat('写这一章', { workId, chapterId: CH39 });
  const action = events.find((e) => e.type === 'action');
  assert.ok(action);
  assert.match(action.content, /曹操端坐堂上/);
  assert.strictEqual(action.planDegraded, 'invalid');
  assert.ok(!events.find((e) => e.type === 'anchor_violation'));

  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.strictEqual(done.anchorViolations.length, 0, '界外不应产生冲突');

  const stored = await db.all(
    'SELECT * FROM anchor_violations WHERE work_id = ? AND chapter_id = ?',
    [workId, CH39]
  );
  assert.strictEqual(stored.length, 0);

  console.log(
    '[PV5] violations =',
    done.anchorViolations.length,
    '；anchor_violation 事件 = false；planDegraded =',
    JSON.stringify(action.planDegraded),
    '；DB 冲突行 =',
    stored.length
  );
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// PV7：chapter_seq=3 的 knows 行，第 2/3 章看不到内容，第 4 章看得到
// ------------------------------------------------------------------------------------------------------------------------------------------

test('PV7：chapter_seq=3 的 knows 在第 2、3 章不可见，第 4 章可见', async () => {
  const ch2 = systemOf(await assemble(CH2));
  const ch3 = systemOf(await assemble(CH3));
  const ch4 = systemOf(await assemble(CH4));

  const shortTitle = '司马懿曾向曹操举荐他';
  const fullContent = '此事只有曹操与荀彧知道';
  for (const [name, text] of [
    ['第 2 章', ch2],
    ['第 3 章', ch3],
  ]) {
    assert.match(text, /## 本章知情边界/);
    assert.ok(text.includes(`F1（${shortTitle}）`), `${name}应只给短标题`);
    assert.ok(!text.includes(fullContent), `${name}不能拿到事实正文`);
    assert.ok(!text.includes('关键词：举荐,曹操'), `${name}不能拿到关键词`);
  }

  assert.ok(ch4.includes(fullContent), '第 4 章应看到事实正文');
  assert.ok(ch4.includes('关键词：举荐,曹操'), '第 4 章应看到关键词');
  assert.match(ch4, /【杨平】已知：F1/);

  console.log(
    '[PV7] ch2 含正文 =',
    ch2.includes(fullContent),
    '；ch3 含正文 =',
    ch3.includes(fullContent),
    '；ch4 含正文 =',
    ch4.includes(fullContent),
    '；ch4 已知行 =',
    /【杨平】已知：F1/.test(ch4)
  );
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// PV9：seen_by 为空的证据进入人工核对清单，不自动判死
// ------------------------------------------------------------------------------------------------------------------------------------------

test('PV9：seen_by=[] 的证据出现在边界里（无人见过），扫描空结果不写矩阵', async () => {
  const ch4 = systemOf(await assemble(CH4));
  const evidenceLine = '证据：E1（举荐信：杨平持有，无人见过）';
  assert.ok(ch4.includes(evidenceLine), '证据行必须出现在知情边界');

  const beforeRows = await db.get(
    'SELECT COUNT(*) AS c FROM knowledge_matrix WHERE work_id = ?',
    [workId]
  );
  const beforePending = await db.get(
    'SELECT COUNT(*) AS c FROM knowledge_pending WHERE work_id = ?',
    [workId]
  );

  await settleBackground();
  fakeModel.setQueue([jsonResponse({ transitions: [] })]);
  const res = await server.request(`/api/pipeline/${workId}/knowledge/scan`, {
    method: 'POST',
    body: {
      chapterId: CH1,
      chapterSeq: 1,
      text: '杨平道：我知道司马懿举荐过我。那封举荐信的封泥是青色的。',
    },
  });
  assert.strictEqual(res.status, 200);
  const scan = await res.json();
  assert.strictEqual(scan.failed, false);
  assert.deepStrictEqual(scan.applied, []);
  assert.deepStrictEqual(scan.pending, []);

  const afterRows = await db.get(
    'SELECT COUNT(*) AS c FROM knowledge_matrix WHERE work_id = ?',
    [workId]
  );
  const afterPending = await db.get(
    'SELECT COUNT(*) AS c FROM knowledge_pending WHERE work_id = ?',
    [workId]
  );
  assert.strictEqual(afterRows.c, beforeRows.c, '空扫描不得自动写矩阵');
  assert.strictEqual(afterPending.c, beforePending.c, '空扫描不得造 pending');

  console.log(
    '[PV9] 证据行 =',
    JSON.stringify(evidenceLine),
    '；scan applied =',
    scan.applied.length,
    '；pending =',
    scan.pending.length,
    '；矩阵行数 =',
    beforeRows.c,
    '→',
    afterRows.c,
    '；不自动判死 = true'
  );
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// PV8：证据句通过但 unknown→knows 跳级 → 进 pending；确认后落行，下一章可见
// ------------------------------------------------------------------------------------------------------------------------------------------

test('PV8：跳级进 pending，确认后矩阵落行，下一章注入能看到事实', async () => {
  const beforeConfirm = systemOf(await assemble(CH4));
  const fullContent = '司马懿私藏了先帝的密诏，只有他一人知道';
  assert.ok(!beforeConfirm.includes(fullContent), '未确认时第 4 章仍应注入「未知」');
  assert.match(beforeConfirm, /未知：F2（司马懿私藏了先帝的密诏）/);

  await settleBackground();
  fakeModel.setQueue([
    jsonResponse({
      transitions: [
        {
          character: '杨平',
          factId: 'F2',
          toState: 'knows',
          evidence: '杨平道：我知道司马懿举荐过我',
        },
      ],
    }),
  ]);
  const scanRes = await server.request(`/api/pipeline/${workId}/knowledge/scan`, {
    method: 'POST',
    body: {
      chapterId: CH1,
      chapterSeq: 1,
      text: '杨平道：我知道司马懿举荐过我。那封举荐信的封泥是青色的。',
    },
  });
  assert.strictEqual(scanRes.status, 200);
  const scan = await scanRes.json();
  assert.strictEqual(scan.failed, false);
  assert.strictEqual(scan.applied.length, 0, '跳级不能自动落库');
  assert.strictEqual(scan.pending.length, 1);
  assert.strictEqual(scan.knowledgePendingCount, 1);
  assert.strictEqual(scan.pending[0].reason, '跳级');
  assert.strictEqual(scan.pending[0].source, 'model_only', '候选之外由模型单独指出');
  const pendingRes = await server.request(`/api/pipeline/${workId}/pending`);
  assert.strictEqual(pendingRes.status, 200);
  const pending = await pendingRes.json();
  assert.strictEqual(pending.knowledge.length, 1);
  assert.strictEqual(pending.knowledge[0].characterName, '杨平');
  assert.strictEqual(pending.knowledge[0].factLabel, 'F2');
  assert.strictEqual(pending.knowledge[0].status, 'pending');
  pendingKnowledgeId = pending.knowledge[0].id;

  const matrixBefore = await db.get(
    `SELECT COUNT(*) AS c FROM knowledge_matrix
     WHERE work_id = ? AND character_id = ? AND fact_id = ?`,
    [workId, CHAR_ID, FACT_SCAN]
  );
  assert.strictEqual(matrixBefore.c, 0, '确认前矩阵不能有 F2 行');

  const confirmed = await server.request(
    `/api/pipeline/${workId}/pending/knowledge/${pendingKnowledgeId}/confirm`,
    { method: 'POST' }
  );
  assert.strictEqual(confirmed.status, 200);

  const row = await db.get(
    `SELECT * FROM knowledge_matrix
     WHERE work_id = ? AND character_id = ? AND fact_id = ?`,
    [workId, CHAR_ID, FACT_SCAN]
  );
  assert.ok(row, '确认后必须落行');
  assert.strictEqual(row.chapter_seq, 1);
  assert.strictEqual(row.state, 'knows');

  const afterConfirm = systemOf(await assemble(CH4));
  assert.ok(afterConfirm.includes(fullContent), '确认后第 4 章应看到 F2 正文');
  assert.ok(afterConfirm.includes('关键词：密诏'));
  assert.match(afterConfirm, /【杨平】已知：F1（[^）]*）、F2/);

  console.log(
    '[PV8] scan applied =',
    scan.applied.length,
    '；pending =',
    scan.pending.length,
    '；reason =',
    JSON.stringify(scan.pending[0].reason),
    '；confirm 前矩阵 F2 行 =',
    matrixBefore.c,
    '；confirm 后 =',
    `${row.chapter_seq}/${row.state}`,
    '；第 4 章含 F2 正文 前/后 =',
    beforeConfirm.includes(fullContent),
    '→',
    afterConfirm.includes(fullContent)
  );
});

// ------------------------------------------------------------------------------------------------------------------------------------------
// 收口：关闭模板后全链路回到基线
// ------------------------------------------------------------------------------------------------------------------------------------------

test('PV1/PV6/PV10 收口：关闭模板后注入逐字节回到基线，扫描接口 404', async () => {
  const closed = await server.request(`/api/works/${workId}`, {
    method: 'PUT',
    body: { template: '' },
  });
  assert.strictEqual(closed.status, 200);
  assert.strictEqual((await closed.json()).template, '');

  const result = await assemble(CH4);
  const body = systemOf(result);
  assert.strictEqual(body, baselineClosedSystem, '关闭后必须与启用前的基线逐字节相等');
  assert.strictEqual(result.meta.pipeline, false);
  assert.strictEqual(result.meta.anchorCount, 0);
  assert.strictEqual(result.meta.knowledgeCount, 0);
  assert.doesNotMatch(body, /## 历史锚点/);
  assert.doesNotMatch(body, /## 本章知情边界/);

  const scan = await server.request(`/api/pipeline/${workId}/knowledge/scan`, {
    method: 'POST',
    body: { chapterId: CH1, chapterSeq: 1, text: '任意正文' },
  });
  assert.strictEqual(scan.status, 404, '关闭模板后扫描必须 404');

  const pending = await server.request(`/api/pipeline/${workId}/pending`);
  assert.strictEqual(pending.status, 404, '关闭模板后待确认必须 404');

  // 数据仍在库里：关闭只是不注入/不开放接口，不是删除。
  const rows = await db.get(
    'SELECT COUNT(*) AS c FROM knowledge_matrix WHERE work_id = ?',
    [workId]
  );
  const violations = await db.get(
    'SELECT COUNT(*) AS c FROM anchor_violations WHERE work_id = ?',
    [workId]
  );
  assert.strictEqual(rows.c, 2, 'F2 与 F3 的矩阵行应保留');
  assert.strictEqual(violations.c, 1, '第 45 章的冲突行应保留');

  console.log(
    '[PV1/PV6/PV10] 关闭后与基线相等 = true；长度 =',
    body.length,
    '；pipeline =',
    result.meta.pipeline,
    '；anchorCount =',
    result.meta.anchorCount,
    '；knowledgeCount =',
    result.meta.knowledgeCount,
    '；scan = 404；pending = 404；矩阵行保留 =',
    rows.c,
    '；冲突行保留 =',
    violations.c
  );
});
