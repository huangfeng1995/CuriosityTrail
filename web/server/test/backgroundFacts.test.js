'use strict';

/**
 * 主角背景事实（mustReveal）测试。
 *
 * 两态断言：
 *   - 缺背景事实：首次出场章 body 没有年龄/籍贯/寄养 → mustReveal 逐项报缺；
 *   - 补齐后：同一 body 加入对应句子 → missing 为空。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let server;
let backgroundFacts;

const PROTAGONIST = { id: 'c1', name: '杨平', aliases: '', role: '主角' };

const FACTS = [
  { id: 'f1', content: '杨平今年十四岁', keywords: '十四岁' },
  { id: 'f2', content: '杨平是河内获嘉人', keywords: '获嘉' },
  { id: 'f3', content: '杨平因战乱寄养在司马防家', keywords: '寄养' },
];

function factRows() {
  return FACTS.map((fact) => ({ ...fact, fact_type: 'background' }));
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  backgroundFacts = require('../services/pipeline/backgroundFacts');
  const app = require('../app');
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

async function seedWork(name) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: name, template: 'history_thriller' },
  });
  assert.strictEqual(res.status, 200);
  const work = await res.json();
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, role, created_at, modified_at)
     VALUES (?, ?, ?, '', '主角', ?, ?)`,
    [`c1-${work.id}`, work.id, '杨平', TS, TS]
  );
  return work;
}

test('没有任何背景事实：首次出场章标出「背景事实尚未入库」', () => {
  const check = backgroundFacts.checkMustReveal({ facts: [], body: '杨平跟着父亲上车。' });
  assert.strictEqual(check.total, 0);
  assert.deepStrictEqual(check.missing, []);

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: [],
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body: '杨平跟着父亲上车。',
  });
  assert.strictEqual(chapter.applicable, true, '首次出场章必须让作者看到缺失');
  assert.strictEqual(chapter.missing.length, 1);
  assert.strictEqual(chapter.missing[0].notIngested, true);
  assert.match(chapter.missing[0].content, /尚未入库/);
});

test('有背景事实但正文不交代：逐项报缺，触发 beatCheck 标出', () => {
  const check = backgroundFacts.checkMustReveal({
    facts: factRows(),
    body: '杨平跟着父亲上车，车队出了城门。',
  });
  assert.strictEqual(check.total, 3);
  assert.strictEqual(check.covered, 0);
  assert.deepStrictEqual(
    check.missing.map((item) => item.content),
    ['杨平今年十四岁', '杨平是河内获嘉人', '杨平因战乱寄养在司马防家']
  );

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body: '杨平跟着父亲上车，车队出了城门。',
  });
  assert.strictEqual(chapter.applicable, true, '主角首次出场且正文没交代 → 适用');
  assert.strictEqual(chapter.missing.length, 3);
});

test('补齐背景事实后：同一正文加句子 → missing 为空', () => {
  const body =
    '杨平今年十四岁，是河内获嘉人。三年前因战乱被寄养在司马防家，如今要跟着父亲回许都。';
  const check = backgroundFacts.checkMustReveal({ facts: factRows(), body });
  assert.strictEqual(check.total, 3);
  assert.strictEqual(check.covered, 3);
  assert.deepStrictEqual(check.missing, []);

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body,
  });
  assert.strictEqual(chapter.applicable, true);
  assert.deepStrictEqual(chapter.missing, []);
});

test('年龄必须出现年龄表述：十八了算交代，十八年不算', () => {
  const facts = [{ id: 'f1', content: '杨平今年十八岁', keywords: '十八岁,年龄', fact_type: 'background' }];

  const covered = backgroundFacts.checkMustReveal({
    facts,
    body: '司马懿嗤了一声：「十八了，还跟个妇人一样心软。」',
  });
  assert.strictEqual(covered.covered, 1, '「十八了」是年龄表述，应算交代');
  assert.deepStrictEqual(covered.missing, []);

  const yearOnly = backgroundFacts.checkMustReveal({
    facts,
    body: '他在温县住了十八年，日子过得不算差。',
  });
  assert.strictEqual(yearOnly.missing.length, 1, '「十八年」不是年龄，不能算交代');

  const wordOnly = backgroundFacts.checkMustReveal({
    facts,
    body: '他从不提自己的年龄。',
  });
  assert.strictEqual(wordOnly.missing.length, 1, '只出现「年龄」这个词不算交代');
});

test('信息释放时间表：早于 revealAt 出现算提前释放，未出现按拍报缺', () => {
  const plan = {
    beats: ['B1', 'B2', 'B3', 'B4'].map((id) => ({ id, paragraphs: 2 })),
  };
  const brief = {
    items: [{ kind: 'mustReveal', text: '杨平今年十四岁', revealAt: 'B3' }],
  };
  const body = [
    '杨平今年十四岁。',
    '风从城门那边吹过来，卷起地上的碎草。',
    '车队在门口等着，马鼻子里喷出白气。',
    '父亲没有说话，只把手按在车辕上。',
    '他抬头看了一眼灰白的天。',
    '巷子里很安静，连狗都没有叫。',
    '远处有人敲钟，一声比一声远。',
    '他把手缩回袖子里，跟着往前走了两步。',
  ].join('\n\n');

  const check = backgroundFacts.checkMustReveal({
    facts: factRows(),
    body,
    plan,
    brief,
  });

  assert.strictEqual(check.premature.length, 1, '第一段就把年龄说完了，属于提前释放');
  assert.strictEqual(check.premature[0].content, '杨平今年十四岁');
  assert.strictEqual(check.premature[0].actualBeat, 'B1');
  assert.strictEqual(check.premature[0].earliestBeat, 'B3');
  assert.deepStrictEqual(
    check.missing.map((item) => item.content),
    ['杨平是河内获嘉人', '杨平因战乱寄养在司马防家']
  );
  assert.deepStrictEqual(
    check.missing.map((item) => item.revealBeat),
    ['B4', 'B4'],
    '没给 revealAt 的事实从后半段起按一拍一项排'
  );

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body,
    plan,
    brief,
  });
  assert.strictEqual(chapter.applicable, true);
  assert.strictEqual(chapter.premature.length, 1, 'mustRevealForChapter 必须把提前释放带出来');
});

test('信息释放时间表：在 revealAt 之后交代才算覆盖', () => {
  const plan = {
    beats: ['B1', 'B2', 'B3', 'B4'].map((id) => ({ id, paragraphs: 2 })),
  };
  const brief = {
    items: [{ kind: 'mustReveal', text: '杨平今年十四岁', revealAt: 'B3' }],
  };
  const body = [
    '风从城门那边吹过来，卷起地上的碎草。',
    '车队在门口等着，马鼻子里喷出白气。',
    '父亲没有说话，只把手按在车辕上。',
    '他抬头看了一眼灰白的天。',
    '杨平今年十四岁。',
    '巷子里很安静，连狗都没有叫。',
    '远处有人敲钟，一声比一声远。',
    '他把手缩回袖子里，跟着往前走了两步。',
  ].join('\n\n');

  const check = backgroundFacts.checkMustReveal({ facts: factRows(), body, plan, brief });

  assert.deepStrictEqual(check.premature, []);
  assert.ok(!check.missing.some((item) => item.content.includes('十四岁')), '到点说了就不算缺');
});

test('第二章节起继续守：主角在前文出现过也仍逐项报缺', () => {
  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: ['上一章：杨平在县衙门口站了很久，今年十四岁，是河内获嘉人。'],
    body: '杨平跟着父亲上车。',
  });
  assert.strictEqual(chapter.applicable, true, '主角再次出场不再是免检理由');
  assert.deepStrictEqual(
    chapter.missing.map((item) => item.content),
    ['杨平今年十四岁', '杨平是河内获嘉人', '杨平因战乱寄养在司马防家'],
    '缺失只看本章正文；前章交代过也不能把本章的检查关掉'
  );
});

test('第二章节起继续守：更早章节已出现主角，本章提前释放照样报 premature', () => {
  const plan = {
    beats: ['B1', 'B2', 'B3', 'B4'].map((id) => ({ id, paragraphs: 2 })),
  };
  const brief = {
    items: [{ kind: 'mustReveal', text: '杨平今年十四岁', revealAt: 'B3' }],
  };
  const body = [
    '杨平今年十四岁。',
    '风从城门那边吹过来，卷起地上的碎草。',
    '车队在门口等着，马鼻子里喷出白气。',
    '父亲没有说话，只把手按在车辕上。',
    '他抬头看了一眼灰白的天。',
    '巷子里很安静，连狗都没有叫。',
    '远处有人敲钟，一声比一声远。',
    '他把手缩回袖子里，跟着往前走了两步。',
  ].join('\n\n');

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: ['上一章：杨平在县衙门口站了很久。'],
    body,
    plan,
    brief,
  });

  assert.strictEqual(chapter.applicable, true);
  assert.strictEqual(chapter.premature.length, 1, '续章也要守住 revealAt');
  assert.strictEqual(chapter.premature[0].actualBeat, 'B1');
});

test('素材升格：幂等 + missing 标记保留，重复升格不产生重复行', async () => {
  const work = await seedWork('背景事实升格');
  const userId = work.user_id;
  await db.run(
    `INSERT INTO materials
       (id, user_id, title, body, source, source_url, file_path, tags, work_id, provenance,
        confidence, origin, status, created_by, search_log, char_count, page_count, created_at, modified_at)
     VALUES ('m1', ?, '杨平身世', '杨平今年十四岁，河内获嘉人，幼年寄养司马家。', '', '', '', '年龄,籍贯', ?, '', 'missing', 'user', 'active', 'user', '', 0, 0, ?, ?)`,
    [userId, work.id, TS, TS]
  );

  const first = await backgroundFacts.upgradeBackgroundFacts({
    userId,
    workId: work.id,
    materialIds: ['m1'],
  });
  assert.strictEqual(first.created.length, 1);
  assert.ok(first.created[0].keywords.includes('证据不足'), 'missing 素材要留证据不足标记');

  const second = await backgroundFacts.upgradeBackgroundFacts({
    userId,
    workId: work.id,
    materialIds: ['m1'],
  });
  assert.strictEqual(second.created.length, 0, '同素材重复升格不能产生新行');
  assert.strictEqual(second.skipped.length, 1);

  const rows = await db.all(
    "SELECT * FROM story_facts WHERE work_id = ? AND fact_type = 'background'",
    [work.id]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].fact_type, 'background');
});

// ---------------------------------------------------------------------------
// C：background 与 mustWithhold 撞同一条信息 → mustWithhold 优先
// ---------------------------------------------------------------------------

test('C 冲突事实不进 mustReveal，记入 backgroundWithheld；非冲突事实照常交代', () => {
  const facts = [
    { id: 'f9', fact_type: 'background', content: '杨俊被司空征辟，实为曹操借河内豪族牵制河北', keywords: '征辟,河北,牵制' },
    { id: 'f10', fact_type: 'background', content: '杨平今年十八岁', keywords: '十八岁' },
  ];
  const brief = {
    items: [
      {
        id: 'MW1',
        kind: 'mustWithhold',
        text: '不得解释父亲被司空征辟的用意',
        keywords: ['征辟', '牵制'],
        source: '本章大纲',
      },
    ],
  };

  const merged = backgroundFacts.mergeIntoBrief(brief, facts);
  const reveals = merged.items.filter((item) => item.kind === 'mustReveal').map((item) => item.text);
  assert.ok(
    !reveals.some((text) => text.includes('牵制河北')),
    '与 mustWithhold 冲突的事实不能同时要求交代'
  );
  assert.ok(reveals.some((text) => text.includes('十八岁')), '非冲突事实仍要交代');
  assert.strictEqual(merged.backgroundWithheld.length, 1);
  assert.strictEqual(merged.backgroundWithheld[0].factId, 'f9');
  assert.strictEqual(merged.backgroundWithheld[0].withholdId, 'MW1');
  assert.match(merged.backgroundWithheld[0].reason, /mustWithhold 优先/);
});

test('C 自检不再把被 withhold 压住的事实报成「未交代」', () => {
  const facts = [
    { id: 'f9', fact_type: 'background', content: '杨俊被司空征辟，实为曹操借河内豪族牵制河北', keywords: '征辟,河北,牵制' },
    { id: 'f10', fact_type: 'background', content: '杨平今年十八岁', keywords: '十八岁' },
  ];
  const brief = backgroundFacts.mergeIntoBrief(
    {
      items: [
        {
          id: 'MW1',
          kind: 'mustWithhold',
          text: '不得解释父亲被司空征辟的用意',
          keywords: ['征辟', '牵制'],
        },
      ],
    },
    facts
  );
  const body = '杨平十八岁那年，头一回走进许都。';

  const check = backgroundFacts.checkMustReveal({ facts, body, plan: null, brief });
  assert.strictEqual(check.total, 1, '只检查没被压住的那条');
  assert.strictEqual(check.covered, 1);
  assert.deepStrictEqual(check.missing, []);
  assert.strictEqual(check.withheld.length, 1);
});

test('C 全部背景事实都被 withhold 压住时，不报「尚未入库」', () => {
  const facts = [
    { id: 'f9', fact_type: 'background', content: '杨俊被司空征辟，实为曹操借河内豪族牵制河北', keywords: '征辟,河北,牵制' },
  ];
  const brief = backgroundFacts.mergeIntoBrief(
    {
      items: [
        {
          id: 'MW1',
          kind: 'mustWithhold',
          text: '不得解释父亲被司空征辟的用意',
          keywords: ['征辟', '牵制'],
        },
      ],
    },
    facts
  );
  const check = backgroundFacts.mustRevealForChapter({
    facts,
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲走进司空府。',
    body: '杨平没有说话。',
    plan: null,
    brief,
  });
  assert.strictEqual(check.applicable, true);
  assert.deepStrictEqual(check.missing, [], '不能报成 notIngested');
  assert.strictEqual(check.withheld.length, 1);
});

test('C 只共享同场人物/地名不算同一条信息，不能误压背景事实', () => {
  const facts = [
    {
      id: 'f1',
      fact_type: 'background',
      content: '杨平今年十八岁，自幼寄养在温县司马防家。',
      keywords: '十八岁,寄养,温县',
    },
  ];
  const brief = {
    items: [
      {
        id: 'MW1',
        kind: 'mustWithhold',
        text: '不得解释内室争执的内容与争执双方各是谁，只写声音断续、字句听不真切',
        keywords: ['内室', '争执', '声音'],
      },
      {
        id: 'MW3',
        kind: 'mustWithhold',
        text: '不得解释司马防在温县所忧的具体是哪一方势力，也不得让杨平此时明白许都的局势',
        keywords: ['司马防', '温县', '势力'],
      },
    ],
  };
  const merged = backgroundFacts.mergeIntoBrief(brief, facts);
  assert.ok(
    merged.items.some((item) => item.kind === 'mustReveal' && item.text.includes('十八岁')),
    '年龄/寄养与「所忧势力」不是同一条信息，仍要交代'
  );
  assert.strictEqual(merged.backgroundWithheld, undefined, '不能误判成冲突');
});

test('C 关键词包含与 9 字公共子串都能认出「征辟-牵制河北」是同一条信息', () => {
  const facts = [
    {
      id: 'f2',
      fact_type: 'background',
      content: '杨俊此次被司空征辟，实为曹操借河内豪族牵制河北；这层用意在抵达许都之前不得点破。',
      keywords: '司空征辟,河内豪族,牵制河北',
    },
    {
      id: 'f1',
      fact_type: 'background',
      content: '杨平今年十八岁，生于光和四年，自幼寄养在温县司马防家。',
      keywords: '十八岁,光和四年,寄养,温县',
    },
  ];
  const brief = {
    items: [
      {
        id: 'MW2',
        kind: 'mustWithhold',
        text: '不得点破曹操征辟杨俊是为借河内豪族牵制河北的用意',
        keywords: ['征辟', '河内'],
      },
      {
        id: 'MW3',
        kind: 'mustWithhold',
        text: '不得解释司马防在温县所忧的具体是哪一方势力，也不得让杨平此时明白许都的局势',
        keywords: ['许都', '局势'],
      },
    ],
  };
  const merged = backgroundFacts.mergeIntoBrief(brief, facts);
  assert.strictEqual(merged.backgroundWithheld.length, 1);
  assert.strictEqual(merged.backgroundWithheld[0].factId, 'f2');
  assert.strictEqual(merged.backgroundWithheld[0].withholdId, 'MW2');
  assert.ok(
    merged.items.some((item) => item.kind === 'mustReveal' && item.text.includes('十八岁')),
    '年龄/寄养事实照常交代'
  );
});
