'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();

const { ready, close, run } = require('../database');
const skill = require('../services/skills/auditForeshadowing');
const { extractKeywords, recallChapters, splitByFirstAppearance, STATUS, JUDGE_FAILED } = skill._internal;

test.before(async () => {
  await ready;
});

test.after(async () => {
  await close().catch(() => {});
  env.cleanup();
});

test('关键词来自标题与备注两部分', () => {
  const kws = extractKeywords({ title: '铜钥匙', content: '第 3 章随尸体出现，后来收进铁盒' });
  assert.ok(kws.includes('铜钥匙'), '标题整串要在');
  assert.ok(kws.some((k) => k.includes('铁盒')), '备注里的短语也要在');
});

test('备注里的关键词能召回章节——只匹配标题会漏召', () => {
  // 备注里要有分隔符，否则整串会被当成一个关键词。
  // 正文里说的是「铁盒」，卡片标题只写了「铜钥匙」，
  // 只匹配标题的话这条伏笔就漏了——必须靠备注里的「铁盒」召回。
  const cards = [{ id: 'c1', title: '铜钥匙', content: '收进、铁盒，藏在床下' }];
  const chapters = [
    { id: 'ch1', title: '第三章', seq: 3, content: '陈默把铁盒里的东西塞进背包。' },
    { id: 'ch2', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' },
  ];

  const recalled = recallChapters(cards, chapters);
  const rec = recalled.get('c1');
  assert.strictEqual(rec.hits.length, 1);
  assert.strictEqual(rec.hits[0].chapter.id, 'ch1');
});

test('关键词一个都没命中的卡不得被断言为未回收', () => {
  const cards = [{ id: 'c1', title: '银钥匙', content: '' }];
  const chapters = [{ id: 'ch1', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' }];

  const rec = recallChapters(cards, chapters).get('c1');
  assert.strictEqual(rec.hits.length, 0, '不该召回到任何章节');
  // 关键断言：命中为 0 时，不能走到「未回收」那一档
  assert.notStrictEqual(STATUS.NOT_FOUND, STATUS.UNRECOVERED);
});

test('能分出首次出场章与后续再次出场章', () => {
  const card = { id: 'c1', title: '铜钥匙', content: '', chapter_id: 'ch1' };
  const hits = [
    { chapter: { id: 'ch2', seq: 7 }, hitWords: ['铜钥匙'] },
    { chapter: { id: 'ch1', seq: 3 }, hitWords: ['铜钥匙'] },
  ];
  const { first, later } = splitByFirstAppearance(card, hits);
  assert.strictEqual(first.chapter.id, 'ch1', '卡片挂着的章就是埋下点');
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].chapter.id, 'ch2');
});

test('卡片没挂章节时，首次出场章取章节序号最早的那一章', () => {
  // hits 的排序主键是命中关键词数，不是章节顺序：
  // 末位恰恰是命中最少的一章，拿它当"最早"是错的。
  const card = { id: 'c1', title: '铜钥匙', content: '' };
  const hits = [
    { chapter: { id: 'ch7', seq: 7 }, hitWords: ['铜钥匙', '铁盒'] },
    { chapter: { id: 'ch1', seq: 1 }, hitWords: ['铜钥匙'] },
  ];
  const { first, later } = splitByFirstAppearance(card, hits);
  assert.strictEqual(first.chapter.id, 'ch1', '不管命中多少，序号最早的就是埋下点');
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].chapter.id, 'ch7');
});

// ---------------------------------------------------------------------------
// 技能主体（run）
//
// 上面测的是规则层的纯函数，这里测的是整条链路：
// 哪些卡会被处理、哪些卡不调模型、降级时结果长什么样。
// ---------------------------------------------------------------------------

/**
 * 造一部带伏笔卡的作品。
 *
 * 伏笔卡挂在作品上，卡的 kind 必须是 'foreshadow'——
 * 技能只处理这一类卡，普通的情节卡不算伏笔。
 *
 * 同一个测试文件里的所有用例共用一个库，所以 id 必须每次都不同，
 * 否则第二个用例会撞上第一个用例留下的行。
 */
let seedNo = 0;

async function seedWork({ cards, chapters }) {
  const now = new Date().toISOString();
  seedNo += 1;
  const tag = `s${seedNo}`;
  const userId = `u_${tag}`;
  const workId = `w_${tag}`;

  await run(
    'INSERT INTO users (id, phone, nickname, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, `139${String(seedNo).padStart(8, '0')}`, '测试', 'user', now]
  );
  await run(
    `INSERT INTO works (id, user_id, title, created_at, modified_at) VALUES (?, ?, ?, ?, ?)`,
    [workId, userId, '测试作品', now, now]
  );

  for (const ch of chapters) {
    await run(
      `INSERT INTO chapters (id, work_id, title, seq, status, content, blocks, created_at, modified_at)
       VALUES (?, ?, ?, ?, 'draft', ?, NULL, ?, ?)`,
      [`${ch.id}_${tag}`, workId, ch.title, ch.seq, ch.content, now, now]
    );
  }

  for (const card of cards) {
    await run(
      `INSERT INTO plot_cards (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
       VALUES (?, ?, ?, ?, 'foreshadow', ?, ?, 'todo', ?, ?)`,
      [`${card.id}_${tag}`, workId, null, card.title, card.content || '', card.seq || 0, now, now]
    );
  }

  return { userId, workId, tag };
}

/**
 * 假模型层：记录每次被调用的卡片 id，按预设返回判定结果。
 */
function fakeJudgeProvider(verdicts = {}) {
  const calls = [];
  return {
    calls,
    async chat({ messages }) {
      const userMsg = messages[messages.length - 1].content;
      const ids = (userMsg.match(/卡片 id=(\S+)/g) || []).map((s) => s.replace('卡片 id=', ''));
      calls.push(ids);
      return {
        content: JSON.stringify({
          results: ids.map((id) => ({
            id,
            status: verdicts[id] || STATUS.RECOVERED,
            evidence: '证据',
          })),
        }),
      };
    },
  };
}

test('params.target 命中时只处理那一张卡', async () => {
  const { userId, workId, tag } = await seedWork({
    cards: [
      { id: 'c1', title: '铜钥匙', content: '' },
      { id: 'c2', title: '铁盒', content: '' },
    ],
    chapters: [
      { id: 'ch1', title: '第三章', seq: 3, content: '陈默把铜钥匙和铁盒塞进背包。' },
    ],
  });

  const provider = fakeJudgeProvider();
  const result = await skill.run({ target: '铜钥匙' }, { userId, workId, provider });

  assert.strictEqual(result.findings.length, 1, '只该处理点名的那张卡');
  assert.strictEqual(result.findings[0].card, '铜钥匙');
  // 只喂了那张卡给模型
  assert.deepStrictEqual(provider.calls.flat(), [`c1_${tag}`]);
});

test('关键词一个都没命中的卡不调模型，且归入未定位到原文', async () => {
  const { userId, workId, tag } = await seedWork({
    cards: [
      { id: 'c1', title: '铜钥匙', content: '' },
      { id: 'c2', title: '银钥匙', content: '' },
    ],
    chapters: [
      { id: 'ch1', title: '第三章', seq: 3, content: '陈默把铜钥匙塞进背包。' },
    ],
  });

  const provider = fakeJudgeProvider();
  const result = await skill.run({}, { userId, workId, provider });

  // 银钥匙在正文里一个关键词都没命中 → 不该花钱调模型
  assert.deepStrictEqual(provider.calls.flat(), [`c1_${tag}`], '只把召回到片段的卡喂给模型');

  const notFound = result.findings.find((f) => f.id === `c2_${tag}`);
  assert.strictEqual(notFound.status, STATUS.NOT_FOUND, '没搜到的卡归入未定位到原文');
  assert.notStrictEqual(notFound.status, STATUS.UNRECOVERED, '不能断言成未回收');
});

test('降级 provider 下结果带 degraded 标记', async () => {
  const { userId, workId } = await seedWork({
    cards: [{ id: 'c1', title: '铜钥匙', content: '' }],
    chapters: [{ id: 'ch1', title: '第三章', seq: 3, content: '陈默把铜钥匙收进铁盒。' }],
  });

  const provider = fakeJudgeProvider();
  const result = await skill.run({}, { userId, workId, provider, degraded: true });

  assert.strictEqual(result.degraded, true, '降级必须标出来，不能静默降级');
  assert.match(result.summary, /本地模型/, '摘要里要提示可信度有限');
});

test('模型没给出可解析的判定时标为「未能判定」，不得冒充「未定位到原文」', async () => {
  // 模型这次被 1200 token 截断，JSON 是残缺的。
  // 原来的实现会把整批卡片都填成「未定位到原文」——
  // 作者读到的是"全书没有相关段落"这个事实错误，
  // 而真实原因只是模型没写完。两者必须分开。
  const { userId, workId } = await seedWork({
    cards: [{ id: 'c1', title: '铜钥匙', content: '' }],
    chapters: [{ id: 'ch1', title: '第三章', seq: 3, content: '陈默把铜钥匙收进铁盒。' }],
  });

  const provider = {
    async chat() {
      return { content: '{"results":[{"id":"', finishReason: 'length' };
    },
  };

  const result = await skill.run({}, { userId, workId, provider });
  const finding = result.findings.find((f) => f.card === '铜钥匙');

  assert.strictEqual(finding.status, JUDGE_FAILED, '没判出来就是没判出来，不能落成结论');
  assert.notStrictEqual(finding.status, STATUS.NOT_FOUND, '不得冒充「未定位到原文」');
  assert.match(finding.evidence, /截断/, '要说明是截断导致的，作者才知道该怎么办');
  assert.match(result.summary, /未能判定/, '摘要里要让作者看见有几条没判出来');
});

test('模型漏掉某张卡时，那张卡标为「未能判定」而不是「未定位到原文」', async () => {
  const { userId, workId, tag } = await seedWork({
    cards: [
      { id: 'c1', title: '铜钥匙', content: '' },
      { id: 'c2', title: '铁盒', content: '' },
    ],
    chapters: [{ id: 'ch1', title: '第三章', seq: 3, content: '陈默把铜钥匙收进铁盒。' }],
  });

  // 只回了第一张卡的判定，第二张被漏掉
  const provider = {
    async chat() {
      return {
        content: JSON.stringify({
          results: [{ id: `c1_${tag}`, status: STATUS.RECOVERED, evidence: '证据' }],
        }),
        finishReason: 'stop',
      };
    },
  };

  const result = await skill.run({}, { userId, workId, provider });
  const missed = result.findings.find((f) => f.id === `c2_${tag}`);

  assert.strictEqual(missed.status, JUDGE_FAILED, '漏答的卡要标成未能判定');
  assert.match(missed.evidence, /漏掉/, '要说明模型漏了这张卡');
});
