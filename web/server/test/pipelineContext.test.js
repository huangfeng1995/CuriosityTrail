'use strict';

/**
 * HP3：历史锚点注入。
 *
 * 验收重点：
 *   * 关闭态零查询、零段落，system 与改动前逐字节相同
 *   * 只注入 status='active'，draft/rejected 不出现
 *   * 整段 ≤800 字，超限有「已省略 N 条」
 *   * 预算预扣不挤掉正文
 *   * 启用但库为空时不产生空标题段落
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let app;
let server;
let assembleContext;
let userId;

async function createWork(template = 'history_thriller', title = '锚点注入作品') {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title, template },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function addChapter(workId, { id, seq = 1, title, outline = '', content = '', blocks = '[]' }) {
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', ?, ?, ?, 0, ?, ?)`,
    [id, workId, title, seq, content, blocks, outline, TS, TS]
  );
}

async function addAnchor(workId, data) {
  const id = data.id || crypto.randomUUID();
  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence,
        source_title, source_locator, source_quote, rules, immutable,
        status, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '[]', ?, ?, ?, ?)`,
    [
      id,
      workId,
      data.kind || 'person',
      data.subject,
      data.claim,
      data.confidence || 'sourced',
      data.source_title || null,
      data.source_locator || null,
      data.immutable ?? (data.confidence === 'blank' ? 0 : 1),
      data.status || 'active',
      data.created_at || TS,
      TS,
    ]
  );
  return id;
}

function anchorSection(system) {
  const head = system.indexOf('## 历史锚点（本章硬约束）');
  if (head < 0) return '';
  const rest = system.slice(head);
  const end = rest.indexOf('\n\n---\n\n');
  return end >= 0 ? rest.slice(0, end) : rest;
}

async function assemble(workId, chapterId, extra = {}) {
  return assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
    ...extra,
  });
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  app = require('../app');
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
// 1. 关闭态
// ---------------------------------------------------------------------------

test('关闭态：插入 active 锚点后 system 逐字不变，且无历史锚点段落', async () => {
  const work = await createWork('', '关闭态作品');
  await addChapter(work.id, {
    id: 'off-ch-1',
    title: '曹操夜宴',
    outline: '曹操与司马懿密谈。',
  });

  const before = await assemble(work.id, 'off-ch-1');
  assert.strictEqual(before.meta.pipeline, false);

  await addAnchor(work.id, {
    id: 'off-anchor-active',
    subject: '曹操',
    claim: '曹操卒于建安二十五年正月',
    confidence: 'sourced',
    source_title: '三国志',
    source_locator: '武帝纪',
    status: 'active',
  });

  const after = await assemble(work.id, 'off-ch-1');
  assert.strictEqual(
    after.messages[0].content,
    before.messages[0].content,
    '关闭模板后 system 必须逐字相同'
  );
  assert.ok(!after.messages[0].content.includes('## 历史锚点'));
  assert.strictEqual(after.meta.pipeline, false);
});

// ---------------------------------------------------------------------------
// 2. 只注入 active
// ---------------------------------------------------------------------------

test('启用态：只注入 active，pending / rejected 不出现', async () => {
  const work = await createWork();
  await addChapter(work.id, {
    id: 'on-ch-1',
    title: '曹操夜宴',
    outline: '曹操与司马懿密谈，司空府来人，杨俊赴许都。',
  });

  await addAnchor(work.id, {
    id: 'a-sourced',
    subject: '曹操',
    claim: '曹操卒于建安二十五年正月',
    confidence: 'sourced',
    source_title: '三国志',
    source_locator: '武帝纪',
    status: 'active',
  });
  await addAnchor(work.id, {
    id: 'a-inferable',
    subject: '司空',
    claim: '一般认为司空府征辟属吏需符传',
    confidence: 'inferable',
    source_title: '后汉书',
    status: 'active',
  });
  await addAnchor(work.id, {
    id: 'a-blank',
    subject: '杨俊',
    claim: '杨俊赴许都的具体日期无载',
    confidence: 'blank',
    status: 'active',
  });
  await addAnchor(work.id, {
    id: 'a-pending',
    subject: '曹操',
    claim: '待确认的曹操条目',
    confidence: 'sourced',
    source_title: '魏略',
    source_locator: '武帝纪',
    status: 'pending',
  });
  await addAnchor(work.id, {
    id: 'a-rejected',
    subject: '曹操',
    claim: '已拒绝的曹操条目',
    confidence: 'sourced',
    source_title: '魏略',
    source_locator: '武帝纪',
    status: 'rejected',
  });

  const result = await assemble(work.id, 'on-ch-1');
  const system = result.messages[0].content;
  assert.strictEqual(result.meta.pipeline, true);

  const lines = system.match(/^\[(?:有出处|可推定|空白·可虚构)\].*$/gm) || [];
  assert.strictEqual(lines.length, 3, '只应出现 3 条 active 锚点');
  assert.ok(lines[0].startsWith('[有出处]'));
  assert.ok(lines[1].startsWith('[可推定]'));
  assert.ok(lines[2].startsWith('[空白·可虚构]'));

  assert.ok(system.includes('曹操卒于建安二十五年正月'));
  assert.ok(system.includes('一般认为司空府征辟属吏需符传'));
  assert.ok(system.includes('杨俊赴许都的具体日期无载'));
  assert.ok(!system.includes('待确认的曹操条目'), 'pending 不得注入');
  assert.ok(!system.includes('已拒绝的曹操条目'), 'rejected 不得注入');
});

// ---------------------------------------------------------------------------
// 3. 超限
// ---------------------------------------------------------------------------

test('超限：20 条锚点整段 ≤800 字，且出现「已省略」', async () => {
  const work = await createWork('history_thriller', '超限作品');
  await addChapter(work.id, { id: 'limit-ch-1', title: '曹操夜宴' });

  const claim = `曹操${'甲'.repeat(88)}`;
  for (let i = 0; i < 20; i += 1) {
    await addAnchor(work.id, {
      id: `limit-${String(i).padStart(2, '0')}`,
      subject: '曹操',
      claim,
      confidence: 'sourced',
      source_title: '史料',
      source_locator: `卷${i}`,
      status: 'active',
      created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
  }

  const result = await assemble(work.id, 'limit-ch-1');
  const section = anchorSection(result.messages[0].content);
  assert.ok(section.startsWith('## 历史锚点（本章硬约束）'));
  assert.ok(section.length <= 800, `锚点段应 ≤800 字，实际 ${section.length}`);
  assert.ok(section.includes('已省略'), '超限必须标注省略条数');
  assert.match(section, /已省略 \d+ 条/);

  const lines = section.match(/^\[有出处\].*$/gm) || [];
  assert.ok(lines.length <= 12, '最多展示 12 条');
  assert.ok(lines.length < 20);
});

// ---------------------------------------------------------------------------
// 4. 预算预扣
// ---------------------------------------------------------------------------

test('预扣：长正文不被裁断，锚点自己吃掉 800 字额度', async () => {
  const work = await createWork('history_thriller', '预算作品');
  const body = `曹操夜宴。${'正'.repeat(11890)}`;
  await addChapter(work.id, {
    id: 'budget-ch-1',
    title: '曹操夜宴',
    content: body,
  });

  await addAnchor(work.id, {
    id: 'budget-anchor',
    subject: '曹操',
    claim: `曹操被刺。${'乙'.repeat(500)}`,
    confidence: 'sourced',
    source_title: '史料',
    source_locator: '卷一',
    status: 'active',
  });

  const retrieval = Array.from({ length: 8 }, (_, i) => ({
    title: `资料${i}`,
    source: '素材',
    snippet: '丙'.repeat(1000),
  }));
  const memoryRefs = Array.from({ length: 6 }, (_, i) => ({
    label: `记忆${i}`,
    preview: '丁'.repeat(500),
  }));

  const result = await assemble(work.id, 'budget-ch-1', { retrieval, memoryRefs });
  const system = result.messages[0].content;

  assert.ok(
    system.includes(`## 当前章节正文\n${body}`),
    '正文必须完整保留，不能被锚点预扣挤断'
  );
  assert.ok(anchorSection(system).startsWith('## 历史锚点（本章硬约束）'), '锚点应注入');
  assert.ok(anchorSection(system).length <= 800);
  // 预算按分区文本计，分区之间还有 '\n\n---\n\n' 分隔符开销，留 200 字余量
  assert.ok(system.length <= 24200, `system 总长应受预算约束，实际 ${system.length}`);
});

// ---------------------------------------------------------------------------
// 5. 启用但无锚点
// ---------------------------------------------------------------------------

test('启用但库为空：不产生空标题段落，anchorCount=0', async () => {
  const work = await createWork('history_thriller', '空锚点作品');
  await addChapter(work.id, { id: 'empty-ch-1', title: '无锚点一章' });

  const result = await assemble(work.id, 'empty-ch-1');
  assert.strictEqual(result.meta.pipeline, true);
  assert.strictEqual(result.meta.anchorCount, 0);
  const system = result.messages[0].content;
  assert.ok(!system.includes('## 历史锚点'), '没有锚点就不要出现空标题');
});

// ---------------------------------------------------------------------------
// 6. 零命中兜底
// ---------------------------------------------------------------------------

test('零命中兜底：主体只在正文提到时也注入，并带说明行', async () => {
  // 这就是作者的历史投诉场景：大纲与标题都没写「曹操」，
  // 只有正文里出现了。按旧的 subject 规则会一条都不注入，界面上完全看不出来。
  const work = await createWork('history_thriller', '兜底作品');
  await addChapter(work.id, {
    id: 'fallback-ch-1',
    title: '夜宴',
    outline: '司马懿与来客密谈，未提姓名。',
    content: '曹操端坐堂上，众客屏息。',
  });

  // time/office 的不可变锚点必须排在兜底清单最前面
  await addAnchor(work.id, {
    id: 'fallback-time',
    kind: 'time',
    subject: '建安四年',
    claim: '本年号用于纪年，正文不得出现更晚的年份',
    confidence: 'sourced',
    source_title: '后汉书',
    source_locator: '献帝纪',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
  });

  // 若干与本章主体无关、但仍在库里的 active 锚点，用来证明 N 是按 800 字放下的最大值
  for (let i = 0; i < 7; i += 1) {
    await addAnchor(work.id, {
      id: `fallback-person-${i}`,
      kind: 'person',
      subject: ['丁仪', '审配', '郭图', '许攸', '张绣', '贾诩', '程昱'][i],
      claim: `${['丁仪', '审配', '郭图', '许攸', '张绣', '贾诩', '程昱'][i]}的生平断言。${'甲'.repeat(100)}`,
      confidence: i === 0 ? 'inferable' : 'sourced',
      source_title: '三国志',
      source_locator: `卷${i + 1}`,
      status: 'active',
      created_at: `2026-01-01T00:00:0${i + 1}.000Z`,
    });
  }

  const result = await assemble(work.id, 'fallback-ch-1');
  const section = anchorSection(result.messages[0].content);

  assert.ok(section.startsWith('## 历史锚点（本章硬约束）'), '零命中时也必须注入');
  assert.ok(
    section.includes('以下锚点未命中本章主体，作为全局约束带入'),
    '兜底必须在段首说明这些锚点不是按本章主体挑的'
  );
  assert.ok(section.includes('本年号用于纪年'), '不可变 time 锚点必须带上');
  assert.ok(section.length <= 800, `兜底段也应 ≤800 字，实际 ${section.length}`);

  const lines = section.match(/^\[(?:有出处|可推定|空白·可虚构)\].*$/gm) || [];
  assert.ok(lines.length > 0, '兜底不能只留说明行');
  assert.ok(lines.length >= 2);
  assert.ok(lines.length <= 12, '最多展示 12 条');
  assert.ok(
    lines[0].includes('本年号用于纪年'),
    'time/office 不可变锚点必须排在兜底清单最前面'
  );
  assert.strictEqual(result.meta.anchorCount, lines.length, 'anchorCount 等于实际注入条数');
});

test('zero hit 且库全为空：无段落，anchorCount=0', async () => {
  const work = await createWork('history_thriller', '零命中空库');
  await addChapter(work.id, {
    id: 'zero-empty-ch-1',
    title: '夜宴',
    outline: '司马懿与来客密谈。',
    content: '曹操端坐堂上。',
  });

  const result = await assemble(work.id, 'zero-empty-ch-1');
  const system = result.messages[0].content;
  assert.strictEqual(result.meta.anchorCount, 0);
  assert.ok(!system.includes('## 历史锚点'), '空库不得凭空生成锚点段落');
});

test('命中部分：anchorCount 等于实际注入条数，未命中条目不出现', async () => {
  const work = await createWork('history_thriller', '部分命中');
  await addChapter(work.id, {
    id: 'partial-ch-1',
    title: '曹操夜宴',
    outline: '曹操与司马懿密谈。',
  });

  await addAnchor(work.id, {
    id: 'partial-caocao',
    subject: '曹操',
    claim: '曹操进位魏公在后方可写',
    confidence: 'sourced',
    source_title: '三国志',
    source_locator: '武帝纪',
    status: 'active',
  });
  await addAnchor(work.id, {
    id: 'partial-sima',
    subject: '司马懿',
    claim: '司马懿此时尚为文学掾',
    confidence: 'inferable',
    source_title: '晋书',
    status: 'active',
  });
  await addAnchor(work.id, {
    id: 'partial-yuanshao',
    subject: '袁绍',
    claim: '袁绍已亡于官渡之后',
    confidence: 'sourced',
    source_title: '三国志',
    source_locator: '袁绍传',
    status: 'active',
  });

  const result = await assemble(work.id, 'partial-ch-1');
  const section = anchorSection(result.messages[0].content);
  const lines = section.match(/^\[(?:有出处|可推定|空白·可虚构)\].*$/gm) || [];

  assert.strictEqual(lines.length, 2, '只有命中本章主体的 2 条');
  assert.strictEqual(result.meta.anchorCount, 2);
  assert.ok(!section.includes('袁绍已亡于官渡之后'), '未命中的锚点不得注入');
  assert.ok(!section.includes('以下锚点未命中本章主体'), '有命中时不走兜底说明');
});
