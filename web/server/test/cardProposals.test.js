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
const cardProposals = require('../services/cards/proposals');

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

/** 批量扫描：一次带多个 block，带来源采纳。 */
async function scanBlocks(body) {
  const res = await server.request('/api/card-proposals/scan', {
    method: 'POST',
    body,
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

// ---------------------------------------------------------------------------
// 6. 保存触发的批量扫描：多 block 合并识别，提案落回证据所在 block
// ---------------------------------------------------------------------------

test('批量扫描：多个 block 合并成一次识别，提案按证据落回各自 block 并带 originRef', async () => {
  fakeModel.setDefault({ content: proposalJson() });

  const { workId, chapterId } = await seedChapter();

  const data = await scanBlocks({
    workId,
    chapterId,
    originRef: 'msg-batch-1',
    blocks: [
      { blockId: 'b1', text: '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。' },
      { blockId: 'b2', text: '他在供桌下翻出一卷旧案，封皮上的字被潮气洇开了。' },
    ],
  });

  assert.strictEqual(data.proposals.length, 3, '三个实体都应有提案');
  for (const p of data.proposals) {
    assert.strictEqual(p.originRef, 'msg-batch-1', '提案应记录来源采纳');
  }

  const byKind = Object.fromEntries(data.proposals.map((p) => [p.kind, p]));
  assert.strictEqual(byKind.character.blockId, 'b1', '人物证据在 b1');
  assert.strictEqual(byKind.setting.blockId, 'b1', '设定证据在 b1');
  assert.strictEqual(byKind.plot.blockId, 'b2', '情节证据在 b2');
});

// ---------------------------------------------------------------------------
// 7. 撤销连带作废：只作废本轮 pending，已确认的卡片不回滚
// ---------------------------------------------------------------------------

test('撤销采纳：本轮 pending 提案一并作废，已确认的卡片保留', async () => {
  fakeModel.setDefault({ content: proposalJson() });

  const { workId, chapterId } = await seedChapter();
  const data = await scanBlocks({
    workId,
    chapterId,
    originRef: 'msg-revert-1',
    blocks: [
      { blockId: 'b1', text: '林砚把伞靠在门边，抬头看见城隍庙的门槛上积着水。' },
      { blockId: 'b2', text: '他在供桌下翻出一卷旧案，封皮上的字被潮气洇开了。' },
    ],
  });

  const character = data.proposals.find((p) => p.kind === 'character');
  const setting = data.proposals.find((p) => p.kind === 'setting');
  const plot = data.proposals.find((p) => p.kind === 'plot');

  // 作者已经确认了人物卡：撤稿不回滚这条已经点过的确认
  const confirmRes = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: { ids: [character.id] },
  });
  assert.strictEqual(confirmRes.status, 200);

  const res = await server.request('/api/card-proposals/dismiss-source', {
    method: 'POST',
    body: { originRef: 'msg-revert-1' },
  });
  assert.strictEqual(res.status, 200);
  const result = await res.json();
  assert.strictEqual(result.dismissed, 2, '两条 pending 应被作废');
  assert.strictEqual(result.confirmed, 1, '已确认的应被保留并单独计数');

  const rows = await all(
    'SELECT id, status FROM card_proposals WHERE work_id = ?',
    [workId]
  );
  const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.strictEqual(status[character.id], 'confirmed', '已确认的提案状态不变');
  assert.strictEqual(status[setting.id], 'dismissed');
  assert.strictEqual(status[plot.id], 'dismissed');

  const characterRow = await get(
    'SELECT id FROM characters WHERE work_id = ? AND name = ?',
    [workId, '林砚']
  );
  assert.ok(characterRow, '已确认的人物卡不能被撤稿回滚');

  // 被作废的提案不能再被确认成卡
  const lateConfirm = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: { ids: [setting.id] },
  });
  assert.strictEqual(lateConfirm.status, 200);
  const late = await lateConfirm.json();
  assert.ok(late.results[0].error, '被作废的提案应拒绝确认');

  const settings = await all('SELECT id FROM settings WHERE work_id = ?', [workId]);
  assert.strictEqual(settings.length, 0, '作废后不能留下设定卡');
});

// ---------------------------------------------------------------------------
// 5. B：生成即记录 → 采纳补出处
// ---------------------------------------------------------------------------

test('B 生成即记录：草稿提案 block_id 为空，同来源重复触发不堆提案', async () => {
  const { workId, chapterId, userId } = await seedChapter();
  const provider = { chat: async () => ({ content: proposalJson() }) };

  const first = await cardProposals.createDraftProposals({
    userId,
    workId,
    chapterId,
    originRef: 'msg-draft-1',
    text: APPLIED_TEXT,
    provider,
  });

  assert.strictEqual(first.length, 3, '应落三条草稿提案');
  assert.ok(
    first.every((row) => row.stage === 'draft' && !row.blockId && row.chapterId === chapterId),
    '草稿没有 block_id，但已经知道是哪一章'
  );

  const again = await cardProposals.createDraftProposals({
    userId,
    workId,
    chapterId,
    originRef: 'msg-draft-1',
    text: APPLIED_TEXT,
    provider,
  });
  assert.deepStrictEqual(again, [], '同一来源重复触发直接返回空');

  const rows = await all(
    'SELECT id FROM card_proposals WHERE user_id = ? AND origin_ref = ?',
    [userId, 'msg-draft-1']
  );
  assert.strictEqual(rows.length, 3, '库里不能堆出第二批');

  // 重新生成：上一版草稿 pending 作废，确认过的不动。
  const next = await cardProposals.createDraftProposals({
    userId,
    workId,
    chapterId,
    originRef: 'msg-draft-2',
    replacedOriginRef: 'msg-draft-1',
    text: APPLIED_TEXT,
    provider,
  });
  assert.strictEqual(next.length, 3, '新版来源可以重新落提案');

  const oldRows = await all(
    "SELECT status, block_id FROM card_proposals WHERE user_id = ? AND origin_ref = 'msg-draft-1'",
    [userId]
  );
  assert.ok(oldRows.every((row) => row.status === 'dismissed' && !row.block_id), '旧草稿 pending 应作废');
});

test('B 采纳后补出处：草稿变成已进正文，且不再调用识别模型', async () => {
  const { workId, chapterId, userId } = await seedChapter();
  const provider = { chat: async () => ({ content: proposalJson() }) };

  await cardProposals.createDraftProposals({
    userId,
    workId,
    chapterId,
    originRef: 'msg-draft-3',
    text: APPLIED_TEXT,
    provider,
  });

  // 识别端点若被调用就会 500；promotion 命中时不该走到那里。
  fakeModel.setDefault({ httpStatus: 500, errorMessage: '不该再识别一次' });

  const res = await server.request('/api/card-proposals/scan', {
    method: 'POST',
    body: {
      workId,
      chapterId,
      blockId: 'b9',
      originRef: 'msg-draft-3',
      text: APPLIED_TEXT,
    },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.promoted, 3, '三条草稿都应补上出处');
  assert.strictEqual(data.proposals.length, 3);
  assert.ok(
    data.proposals.every((row) => row.stage === 'adopted' && row.blockId === 'b9'),
    '来源标记应变成已进正文，并落到具体段落'
  );

  const rows = await all(
    "SELECT block_id, status FROM card_proposals WHERE user_id = ? AND origin_ref = 'msg-draft-3'",
    [userId]
  );
  assert.ok(rows.every((row) => row.block_id === 'b9' && row.status === 'pending'));
});

test('B 撤销来源：草稿 pending 一并作废，已确认的保留', async () => {
  const { workId, chapterId, userId } = await seedChapter();
  const provider = { chat: async () => ({ content: proposalJson() }) };

  const drafts = await cardProposals.createDraftProposals({
    userId,
    workId,
    chapterId,
    originRef: 'msg-draft-4',
    text: APPLIED_TEXT,
    provider,
  });

  const confirmRes = await server.request('/api/card-proposals/confirm', {
    method: 'POST',
    body: { ids: [drafts[0].id] },
  });
  assert.strictEqual(confirmRes.status, 200);

  const res = await server.request('/api/card-proposals/dismiss-source', {
    method: 'POST',
    body: { originRef: 'msg-draft-4' },
  });
  const result = await res.json();

  assert.strictEqual(result.dismissed, 2, '两条草稿 pending 应被作废');
  assert.strictEqual(result.confirmed, 1, '已确认的应保留');

  const rows = await all(
    'SELECT id, status FROM card_proposals WHERE user_id = ? AND origin_ref = ?',
    [userId, 'msg-draft-4']
  );
  const status = Object.fromEntries(rows.map((row) => [row.id, row.status]));
  assert.strictEqual(status[drafts[0].id], 'confirmed');
  assert.strictEqual(status[drafts[1].id], 'dismissed');
  assert.strictEqual(status[drafts[2].id], 'dismissed');
});
