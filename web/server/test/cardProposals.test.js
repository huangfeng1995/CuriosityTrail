'use strict';

/**
 * 卡片沉淀闭环测试。
 *
 * 盯住四件事：
 *   1. 识别失败/超时必须静默，不阻塞、不报错；
 *   2. 未确认的提案不能被上下文装配当事实注入；
 *   3. 确认后写入现有卡片表，并在下一轮装配里出现；
 *   4. 丢弃的提案不落库。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

const app = require('../app');
const { ready, all, get } = require('../database');
const aiConfig = require('../services/aiConfig');
const { assembleContext } = require('../services/context');
const { recognize } = require('../services/cards/recognizer');

let server;
let fakeModel;
let originalConfig;
let seedSeq = 0;

/** 造一部作品与一章正文。body 默认不含任何待确认的名字。 */
async function seedChapter(body = '雨落在青石板上，巷口没有一个人。') {
  const user = await get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  assert.ok(user, '默认测试用户应当存在');

  seedSeq += 1;
  const workId = `work-cp-${seedSeq}`;
  const chapterId = `chapter-cp-${seedSeq}`;
  const now = new Date().toISOString();

  await require('../database').run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, user.id, `测试作品${seedSeq}`, now, now]
  );
  await require('../database').run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', ?, ?, '', 0, ?, ?)`,
    [
      chapterId,
      workId,
      '第一章',
      body,
      JSON.stringify([{ id: 'b1', type: 'paragraph', content: body }]),
      now,
      now,
    ]
  );

  return { workId, chapterId, userId: user.id };
}

/** 一段够长、含三个候选实体的正文。 */
const APPLIED_TEXT =
  '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。' +
  '他在供桌下翻出一卷旧案，封皮上的字被潮气洇开了。';

/** 模型应当给出的提案。 */
function proposalJson() {
  return JSON.stringify({
    proposals: [
      {
        kind: 'character',
        title: '林砚',
        content: '冒雨进庙查旧案的年轻人',
        role: '查案人',
        source_quote: '林砚把伞靠在门边',
      },
      {
        kind: 'setting',
        title: '城隍庙',
        category: '地点',
        content: '积水的旧庙，供桌下有旧案卷宗',
        source_quote: '城隍庙的门槛上积着水',
      },
      {
        kind: 'plot',
        title: '发现旧案卷宗',
        content: '林砚在供桌下翻出一卷旧案',
        source_quote: '翻出一卷旧案',
      },
    ],
  });
}

async function scan(workId, chapterId, text = APPLIED_TEXT, blockId = 'b1') {
  const res = await server.request('/api/card-proposals/scan', {
    method: 'POST',
    body: { workId, chapterId, blockId, text },
  });
  assert.strictEqual(res.status, 200, '识别接口无论成败都应返回 200');
  return res.json();
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

// ---------------------------------------------------------------------------
// 1. 识别失败静默
// ---------------------------------------------------------------------------

test('识别上游报错时静默返回空提案，不写库', async () => {
  fakeModel.setDefault({ httpStatus: 500, errorMessage: '上游挂了' });

  const { workId, chapterId, userId } = await seedChapter();
  const data = await scan(workId, chapterId);

  assert.deepStrictEqual(data.proposals, [], '失败时不返回任何提案');

  const rows = await all(
    'SELECT id FROM card_proposals WHERE user_id = ? AND work_id = ?',
    [userId, workId]
  );
  assert.strictEqual(rows.length, 0, '失败不应留下任何提案');
});

test('识别超时静默：模型不返回时按超时放弃，且不重试', async () => {
  const started = Date.now();
  const proposals = await recognize({
    text: APPLIED_TEXT,
    provider: { chat: () => new Promise(() => {}) },
    timeoutMs: 50,
  });

  assert.deepStrictEqual(proposals, [], '超时应返回空数组');
  assert.ok(Date.now() - started < 2000, '超时后必须立刻返回，不能等模型');
});

// ---------------------------------------------------------------------------
// 2. 未确认不注入
// ---------------------------------------------------------------------------

test('提案未确认时不进卡片表，也不会被写手上下文注入', async () => {
  fakeModel.setDefault({ content: proposalJson() });

  const { workId, chapterId, userId } = await seedChapter();
  const data = await scan(workId, chapterId);
  assert.strictEqual(data.proposals.length, 3, '应生成三条提案');

  const characters = await all(
    'SELECT id FROM characters WHERE work_id = ?',
    [workId]
  );
  const settings = await all('SELECT id FROM settings WHERE work_id = ?', [workId]);
  assert.strictEqual(characters.length, 0, '未确认不能写人物卡');
  assert.strictEqual(settings.length, 0, '未确认不能写设定卡');

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;
  assert.ok(!system.includes('【林砚】'), '未确认的人物不能被注入');
  assert.ok(!system.includes('【城隍庙·'), '未确认的设定不能被注入');
});

// ---------------------------------------------------------------------------
// 3. 确认后注入
// ---------------------------------------------------------------------------

test('确认后写入卡片表并记录来源，下一轮写手 system 里能读到', async () => {
  fakeModel.setDefault({ content: proposalJson() });

  // 本章正文刻意不写「林砚」「城隍庙」：注入只能靠来源章匹配
  const { workId, chapterId, userId } = await seedChapter(
    '雨落在青石板上，巷口没有一个人。'
  );
  const data = await scan(workId, chapterId);
  const character = data.proposals.find((p) => p.kind === 'character');
  const setting = data.proposals.find((p) => p.kind === 'setting');

  const res = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: {
      ids: [character.id, setting.id],
      edits: { [character.id]: { title: '林砚' } },
    },
  });
  assert.strictEqual(res.status, 200);
  const confirmed = await res.json();
  assert.strictEqual(confirmed.results.length, 2);

  const characterRow = await get(
    'SELECT * FROM characters WHERE work_id = ? AND name = ?',
    [workId, '林砚']
  );
  assert.ok(characterRow, '人物卡应已写入');
  assert.strictEqual(characterRow.source_chapter_id, chapterId, '应记录来源章节');
  assert.strictEqual(characterRow.source_block_id, 'b1', '应记录来源块');

  const settingRow = await get(
    'SELECT * FROM settings WHERE work_id = ? AND name = ?',
    [workId, '城隍庙']
  );
  assert.ok(settingRow, '设定卡应已写入');
  assert.strictEqual(settingRow.source_chapter_id, chapterId);
  assert.strictEqual(settingRow.category, '地点');

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;
  assert.ok(system.includes('【林砚】'), '确认的人物应出现在写手 system 里');
  assert.ok(system.includes('【城隍庙·地点】'), '确认的设定应出现在写手 system 里');
});

// ---------------------------------------------------------------------------
// 4. 丢弃不落库
// ---------------------------------------------------------------------------

test('丢弃的提案只改状态，不写卡片表', async () => {
  fakeModel.setDefault({ content: proposalJson() });

  const { workId, chapterId, userId } = await seedChapter();
  const data = await scan(workId, chapterId);
  const plot = data.proposals.find((p) => p.kind === 'plot');

  const res = await server.request('/api/card-proposals/dismiss', {
    method: 'POST',
    body: { ids: [plot.id] },
  });
  assert.strictEqual(res.status, 200);

  const row = await get('SELECT * FROM card_proposals WHERE id = ?', [plot.id]);
  assert.strictEqual(row.status, 'dismissed');

  const plots = await all('SELECT id FROM plot_cards WHERE work_id = ?', [workId]);
  assert.strictEqual(plots.length, 0, '丢弃不能写情节卡');

  // 已丢弃的提案也不能再被确认
  const confirmRes = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: { ids: [plot.id] },
  });
  assert.strictEqual(confirmRes.status, 200);
  const confirmed = await confirmRes.json();
  assert.ok(confirmed.results[0].error, '已丢弃的提案应拒绝确认');
});

// ---------------------------------------------------------------------------
// 5. 批量确认上限
// ---------------------------------------------------------------------------

test('批量确认超过 5 条时拒绝', async () => {
  const res = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: { ids: ['a', 'b', 'c', 'd', 'e', 'f'] },
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /5/);
});
