'use strict';

/**
 * 风格参照测试。
 *
 * 盯住三件事：
 *   1. **样例原文绝不进库**——库里只有规则与摘要。
 *   2. **归属隔离**——别人的章节不能拿来当样例，别人的卡不能改不能删。
 *   3. **生效规则**——作品级整类替换全局级，数值取交集，禁用词取并集。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const aiConfig = require('../services/aiConfig');
const metrics = require('../services/style/metrics');
const rules = require('../services/style/rules');
const style = require('../services/style');
const { distill } = require('../services/style/distill');
const checkStyle = require('../services/skills/checkStyle');

let server;
let fakeModel;
let originalConfig;

/** 建一部作品，返回 work。 */
async function seedWork(title = '测试作品', cookie) {
  const res = await request('/api/works', { method: 'POST', body: { title } }, cookie);
  assert.strictEqual(res.status, 200);
  return res.json();
}

/** 建一章并写入正文。 */
async function seedChapter(workId, title, text, blocks, cookie) {
  const res = await request(
    `/api/works/${workId}/chapters`,
    { method: 'POST', body: { title } },
    cookie
  );
  assert.strictEqual(res.status, 200);
  const chapter = await res.json();

  const payload = blocks || [
    { id: 'b1', type: 'paragraph', content: text },
  ];
  await request(`/api/chapters/${chapter.id}`, { method: 'PUT', body: { blocks: payload } }, cookie);
  return chapter;
}

/** 发请求。给了 cookie 用指定会话，没给用默认会话。 */
function request(path, options, cookie) {
  return cookie ? server.requestAs(cookie, path, options) : server.request(path, options);
}

/**
 * 起一个干净用户。
 *
 * 规则卡是按用户隔离的：所有用例共用默认用户时，前面用例留下的全局卡
 * 会混进后面用例的生效规则，「作品级替换全局级」这类断言就永远不准。
 * 跟作用域有关的用例必须自己开一个用户。
 */
async function freshUser(phone) {
  const cookie = await server.loginAs(phone);
  const row = await db.get('SELECT id FROM users WHERE phone = ?', [phone]);
  return { cookie, userId: row ? row.id : '' };
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
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 维度计算
// ---------------------------------------------------------------------------

test('句长按中文标点切句，字数与平台口径一致', () => {
  const text = '他推开门。屋里没有开灯。他站了一会儿，才往前走了一步。';
  const m = metrics.measureSentenceLength(text);
  // 三句：句末的「，」不断句
  assert.strictEqual(m.count, 3);
  assert.ok(m.avg > 0);
  assert.ok(m.max >= m.avg);
});

test('对白占比：有块结构时按对话块算，纯文本时按引号估算', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', content: '这是一段叙述文字，长度差不多。' },
    { id: 'b', type: 'dialogue', content: '你来了。' },
  ];
  const withBlocks = metrics.measureDialogueRatio('任意文本', blocks);
  assert.ok(withBlocks > 0 && withBlocks < 100, `对话占比应落在 0-100，实际 ${withBlocks}`);

  const withQuotes = metrics.measureDialogueRatio('他说：“你来了。”然后就走了。');
  assert.ok(withQuotes > 0, '引号里的内容应被算成对白');
});

test('比喻密度按标记词计数，返回的是每千字的密度', () => {
  // 密度是「每千字多少处比喻」，不是命中次数。
  // 短文本上密度会很大，这是口径决定的，不是 bug。
  const short = metrics.measureImageryDensity('他像一阵风冲过去。');
  assert.ok(short > 0, '有比喻标记就该算出密度');

  assert.strictEqual(metrics.measureImageryDensity('他走过去，坐下。'), 0);

  // 同一处比喻放在更长的文本里，密度必须更低——否则「密度」这个口径就没意义了
  const long = metrics.measureImageryDensity('他像一阵风冲过去。' + '他走过去，坐下。'.repeat(20));
  assert.ok(long < short, `长文本的密度应低于短文本，实际 ${long} vs ${short}`);
});

// ---------------------------------------------------------------------------
// 规则合并
// ---------------------------------------------------------------------------

test('多卡合并：数值取交集，禁用词取并集', () => {
  const { rules: merged } = rules.mergeRules([
    { kind: 'good', rules: { metrics: { sentenceLength: { min: 5, max: 30 } }, bannedWords: ['仿佛'] } },
    { kind: 'good', rules: { metrics: { sentenceLength: { min: 10, max: 25 } }, bannedWords: ['不禁'] } },
  ]);

  assert.strictEqual(merged.metrics.sentenceLength.min, 10);
  assert.strictEqual(merged.metrics.sentenceLength.max, 25);
  assert.deepStrictEqual(merged.bannedWords.sort(), ['不禁', '仿佛']);
});

test('规则冲突时退回并集并记录冲突', () => {
  const { rules: merged, conflicts } = rules.mergeRules([
    { kind: 'good', rules: { metrics: { sentenceLength: { min: 30 } } } },
    { kind: 'good', rules: { metrics: { sentenceLength: { max: 20 } } } },
  ]);

  assert.strictEqual(conflicts.length, 1, '应当记录一处冲突');
  assert.strictEqual(merged.metrics.sentenceLength.min, 30);
  assert.strictEqual(merged.metrics.sentenceLength.max, 20);
});

test('脏规则被归一化掉：非数字的指标、非字符串的词表都不进结果', () => {
  const normalized = rules.normalizeRules({
    summary: '  白描  ',
    metrics: { sentenceLength: { min: 'abc', max: 20 }, bogus: { min: 1 } },
    bannedWords: ['仿佛', 42, '', '仿佛'],
    notes: '不是数组',
  });

  assert.strictEqual(normalized.summary, '白描');
  assert.strictEqual(normalized.metrics.sentenceLength.min, undefined);
  assert.strictEqual(normalized.metrics.sentenceLength.max, 20);
  assert.strictEqual(normalized.metrics.bogus, undefined);
  assert.deepStrictEqual(normalized.bannedWords, ['仿佛']);
  assert.deepStrictEqual(normalized.notes, []);
});

// ---------------------------------------------------------------------------
// 蒸馏
// ---------------------------------------------------------------------------

test('蒸馏产出归一化后的规则', async () => {
  const provider = {
    async chat() {
      return {
        content: JSON.stringify({
          summary: '短句为主',
          metrics: { sentenceLength: { min: 8, max: 20 } },
          bannedWords: ['仿佛'],
          notes: ['不用比喻'],
        }),
      };
    },
  };

  const result = await distill({
    provider,
    kind: 'good',
    text: '他推开门。屋里没有开灯。他站了一会儿。',
  });

  assert.strictEqual(result.summary, '短句为主');
  assert.strictEqual(result.metrics.sentenceLength.max, 20);
  assert.deepStrictEqual(result.bannedWords, ['仿佛']);
});

test('蒸馏失败（模型没给出可解析的规则）时抛错，不返回半张卡', async () => {
  const provider = {
    async chat() {
      return { content: '这不是 JSON' };
    },
  };

  await assert.rejects(
    () => distill({ provider, kind: 'good', text: '一段文字。' }),
    /规则|解析/
  );
});

test('蒸馏出空规则时抛错——写进库会让作者以为设好了', async () => {
  const provider = {
    async chat() {
      return { content: JSON.stringify({ summary: '', metrics: {}, bannedWords: [], notes: [] }) };
    },
  };

  await assert.rejects(() => distill({ provider, kind: 'good', text: '一段文字。' }));
});

// ---------------------------------------------------------------------------
// 路由：建卡 / 原文不入库
// ---------------------------------------------------------------------------

test('添加样例后规则入库，原文不出现在库里任何字段', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      summary: '冷硬短句',
      metrics: { sentenceLength: { min: 8, max: 22 } },
      bannedWords: ['眸色一暗'],
      notes: [],
    }),
  });

  const secret = '这段文字绝对不能进库 xyzzy';
  const res = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'good', title: '第三章开头', content: secret },
  });
  assert.strictEqual(res.status, 200);
  const card = await res.json();

  assert.strictEqual(card.kind, 'good');
  assert.strictEqual(card.title, '第三章开头');
  assert.strictEqual(card.rules.metrics.sentenceLength.max, 22);

  // 库里不能有原文
  const rows = await db.all('SELECT * FROM style_cards WHERE id = ?', [card.id]);
  assert.strictEqual(rows.length, 1);
  const dumped = JSON.stringify(rows[0]);
  assert.ok(!dumped.includes('xyzzy'), '原文不能进库');
  assert.ok(!dumped.includes(secret), '原文不能进库');
  // 粘贴的样例连摘要都不留：短样例的「摘要」就是全文，
  // 粘贴的原文可能来自别人的作品，留片段等于替对方长期保管。
  assert.strictEqual(rows[0].excerpt, '', '粘贴样例不留摘要');
});

test('从自己写过的章节取样例，来源标注与摘要都在', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      summary: '白描',
      metrics: { dialogueRatio: { min: 10, max: 40 } },
      bannedWords: [],
      notes: [],
    }),
  });

  const work = await seedWork('有章节的作品');
  await seedChapter(work.id, '第一章', '雨落下来。他站在门口，没有进去。');

  const res = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'good', title: '第一章开头', chapterId: work.id },
  });
  // chapterId 传的是作品 id，应该 404
  assert.strictEqual(res.status, 404);

  const chaptersRes = await server.request('/api/style/chapters');
  const chapters = await chaptersRes.json();
  assert.ok(chapters.length >= 1);
  assert.ok(chapters[0].workTitle);

  const okRes = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'good', title: '第一章开头', chapterId: chapters[0].id },
  });
  assert.strictEqual(okRes.status, 200);
  const card = await okRes.json();
  assert.strictEqual(card.source, 'chapter');
  assert.strictEqual(card.chapterId, chapters[0].id);
  assert.ok(card.excerpt.length > 0);
});

test('蒸馏失败时不写卡，返回可读错误', async () => {
  fakeModel.setDefault({ content: '完全不是 JSON' });

  const before = await db.all('SELECT COUNT(*) AS n FROM style_cards');
  const res = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'bad', title: '失败的样例', content: '一段文字。' },
  });

  assert.strictEqual(res.status, 502);
  const body = await res.json();
  assert.ok(body.error && body.error.length > 0, '要给出可读的错误');

  const after = await db.all('SELECT COUNT(*) AS n FROM style_cards');
  assert.strictEqual(after[0].n, before[0].n, '失败的蒸馏不能留下半张卡');
});

test('样例类型必须是 good 或 bad', async () => {
  const res = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'unknown', title: 'x', content: 'y' },
  });
  assert.strictEqual(res.status, 400);
});

// ---------------------------------------------------------------------------
// 归属隔离
// ---------------------------------------------------------------------------

test('不能拿别人的章节当样例', async () => {
  fakeModel.setDefault({ content: JSON.stringify({ summary: 'x', metrics: {}, bannedWords: [], notes: [] }) });

  const otherCookie = await server.loginAs('13900000009');
  const otherWorkRes = await server.requestAs(otherCookie, '/api/works', {
    method: 'POST',
    body: { title: '别人的作品' },
  });
  const otherWork = await otherWorkRes.json();
  const otherChapterRes = await server.requestAs(otherCookie, `/api/works/${otherWork.id}/chapters`, {
    method: 'POST',
    body: { title: '别人的第一章' },
  });
  const otherChapter = await otherChapterRes.json();

  // 拿别人的 chapterId 向自己的接口提交
  const res = await server.request('/api/style/cards', {
    method: 'POST',
    body: { kind: 'good', title: '偷来的', chapterId: otherChapter.id },
  });
  assert.strictEqual(res.status, 404);
});

test('不能改也不能删别人的规则卡', async () => {
  const otherCookie = await server.loginAs('13900000010');
  const otherWorkRes = await server.requestAs(otherCookie, '/api/works', {
    method: 'POST',
    body: { title: '别人的作品二' },
  });
  const otherWork = await otherWorkRes.json();

  const cardRes = await server.requestAs(otherCookie, '/api/style/cards', {
    method: 'POST',
    body: { kind: 'good', title: '别人的卡', content: '一段文字。' },
  });
  const card = await cardRes.json();
  assert.ok(card.id);

  const putRes = await server.request(`/api/style/cards/${card.id}`, {
    method: 'PUT',
    body: { title: '改掉' },
  });
  assert.strictEqual(putRes.status, 404);

  const delRes = await server.request(`/api/style/cards/${card.id}`, { method: 'DELETE' });
  assert.strictEqual(delRes.status, 404);

  const still = await server.requestAs(otherCookie, `/api/style/cards?workId=${otherWork.id}`);
  const body = await still.json();
  assert.ok(body.cards.some((c) => c.id === card.id), '别人的卡不该被删掉');
});

// ---------------------------------------------------------------------------
// 生效规则
// ---------------------------------------------------------------------------

test('作品级规则整类替换全局级', async () => {
  const { cookie, userId } = await freshUser('13900000021');
  const work = await seedWork('作用域测试', cookie);

  // 全局 good 卡
  const globalRes = await request(
    '/api/style/cards',
    { method: 'POST', body: { kind: 'good', title: '全局好样例', content: '一段文字。' } },
    cookie
  );
  const globalCard = await globalRes.json();
  await request(
    `/api/style/cards/${globalCard.id}`,
    {
      method: 'PUT',
      body: { rules: { summary: '全局风格', metrics: { sentenceLength: { min: 5, max: 40 } } } },
    },
    cookie
  );

  // 作品级 good 卡
  const scopedRes = await request(
    '/api/style/cards',
    {
      method: 'POST',
      body: { kind: 'good', title: '作品好样例', content: '另一段文字。', workId: work.id },
    },
    cookie
  );
  const scopedCard = await scopedRes.json();
  await request(
    `/api/style/cards/${scopedCard.id}`,
    {
      method: 'PUT',
      body: { rules: { summary: '作品风格', metrics: { sentenceLength: { min: 8, max: 20 } } } },
    },
    cookie
  );

  const effective = await style.resolveEffectiveStyle(userId, work.id);
  assert.strictEqual(effective.good.cards.length, 1);
  assert.strictEqual(effective.good.cards[0].id, scopedCard.id, '作品级应当整类替换全局级');
  assert.strictEqual(effective.good.rules.summary, '作品风格');

  // 换一部作品：回到全局级
  const other = await seedWork('另一部作品', cookie);
  const otherEffective = await style.resolveEffectiveStyle(userId, other.id);
  assert.strictEqual(otherEffective.good.cards.length, 1);
  assert.strictEqual(otherEffective.good.cards[0].id, globalCard.id);
});

test('作品级只有 bad 卡时，good 仍取全局级', async () => {
  const { cookie, userId } = await freshUser('13900000022');
  const work = await seedWork('混合作用域', cookie);

  const goodRes = await request(
    '/api/style/cards',
    { method: 'POST', body: { kind: 'good', title: '全局好样例二', content: '一段文字。' } },
    cookie
  );
  const goodCard = await goodRes.json();

  const badRes = await request(
    '/api/style/cards',
    {
      method: 'POST',
      body: { kind: 'bad', title: '作品坏样例', content: '另一段文字。', workId: work.id },
    },
    cookie
  );
  const badCard = await badRes.json();

  const effective = await style.resolveEffectiveStyle(userId, work.id);
  assert.strictEqual(effective.good.cards.length, 1);
  assert.strictEqual(effective.good.cards[0].id, goodCard.id, 'good 应当仍取全局级');
  assert.strictEqual(effective.bad.cards.length, 1);
  assert.strictEqual(effective.bad.cards[0].id, badCard.id);
});

test('停用的卡不参与生效', async () => {
  const { cookie, userId } = await freshUser('13900000023');
  const work = await seedWork('停用测试', cookie);

  const res = await request(
    '/api/style/cards',
    { method: 'POST', body: { kind: 'good', title: '要停用的卡', content: '一段文字。' } },
    cookie
  );
  const card = await res.json();

  await request(`/api/style/cards/${card.id}`, { method: 'PUT', body: { enabled: false } }, cookie);

  const effective = await style.resolveEffectiveStyle(userId, work.id);
  assert.ok(!effective.good.cards.some((c) => c.id === card.id), '停用的卡不该生效');
});

// ---------------------------------------------------------------------------
// 上下文注入
// ---------------------------------------------------------------------------

test('上下文里有文风要求段，且排在角色提示词之后', async () => {
  const { cookie, userId } = await freshUser('13900000024');
  const work = await seedWork('注入测试', cookie);
  await request(
    '/api/style/cards',
    { method: 'POST', body: { kind: 'good', title: '注入用样例', content: '一段文字。' } },
    cookie
  );
  await request(
    '/api/style/cards',
    { method: 'POST', body: { kind: 'bad', title: '注入用坏样例', content: '另一段文字。' } },
    cookie
  );

  const { assembleContext } = require('../services/context');
  const { messages, meta } = await assembleContext({
    workId: work.id,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;
  assert.ok(system.includes('## 文风要求'), '应注入文风要求段');
  assert.ok(system.includes('要学的'), '好样例的规则应在提示里');
  assert.ok(system.includes('要避开的'), '坏样例的规则应在提示里');
  assert.ok(meta.styleRules, 'meta 应标记有生效规则');

  const styleIdx = system.indexOf('## 文风要求');
  const roleIdx = system.indexOf('你是');
  assert.ok(roleIdx >= 0 && styleIdx > roleIdx, '文风要求应排在角色提示词之后');
});

test('没有规则时不注入空段', async () => {
  const { userId } = await freshUser('13900000025');
  const { assembleContext } = require('../services/context');
  const work = await seedWork('无规则测试');
  const { messages } = await assembleContext({
    workId: work.id,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  assert.ok(!messages[0].content.includes('## 文风要求'));
});

// ---------------------------------------------------------------------------
// check_style 技能
// ---------------------------------------------------------------------------

test('文风自查能查出禁用词与超长句', async () => {
  const { cookie, userId } = await freshUser('13900000026');
  const work = await seedWork('自查测试', cookie);

  // 直接写一张规则卡
  const card = await style.createCard({
    userId,
    kind: 'good',
    title: '严格规则',
    rules: {
      summary: '很短很紧',
      metrics: { sentenceLength: { min: 5, max: 12 } },
      bannedWords: ['眸色一暗'],
      notes: [],
    },
  });
  assert.ok(card.id);

  const longText =
    '他推开门走进去，屋子里所有的灯都熄着，只有窗外那点微弱的月光勉强照在桌角上，那个角落里堆着许多年没有动过的旧书和一只缺了口的瓷杯，杯底还留着一点早已干涸的褐色痕迹。他站在那里看了很久很久，久到自己都忘了原本想要找的东西究竟是什么。';

  const result = await checkStyle.run({ target: longText }, { userId, workId: work.id });
  assert.ok(result.findings.length >= 1, '应至少查出一处违规');

  const lengthFinding = result.findings.find((f) => f.dimension === 'sentenceLength');
  assert.ok(lengthFinding, '应查出句长超标');
  assert.ok(lengthFinding.samples && lengthFinding.samples.length, '应给出最长的几句供核对');

  const banned = await checkStyle.run(
    { target: '他抬起头，眸色一暗，什么也没说。' },
    { userId, workId: work.id }
  );
  const bannedFinding = banned.findings.find((f) => f.dimension === 'bannedWords');
  assert.ok(bannedFinding, '应查出禁用词');
  assert.match(bannedFinding.label, /眸色一暗/);
});

test('没有规则时明确说没有可核对的项', async () => {
  const { userId } = await freshUser('13900000027');
  const result = await checkStyle.run({ target: '一段文字。' }, { userId });
  assert.match(result.summary, /还没有设定文风规则/);
  assert.strictEqual(result.findings.length, 0);
});

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 取当前默认登录用户的 id（server 默认用 13900000001 登录）。 */
async function currentUserId() {
  const row = await db.get('SELECT id FROM users WHERE phone = ?', ['13900000001']);
  return row ? row.id : '';
}
