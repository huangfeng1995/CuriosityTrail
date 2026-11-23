'use strict';

/**
 * 上下文装配测试。
 *
 * 盯住一件事：**空章节时，模型必须知道该怎么写**。
 *
 * 不说的话模型只能靠猜：它会给出 action="append" 加一个指向
 * 不存在段落的 target，前端回写时找不到落点，作者看到的是
 * "当前章节还没有正文"，AI 写的内容就这么丢了。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser } = require('./helpers');

const env = setupTempEnv();

const db = require('../database');
const {
  assembleContext,
  trimHistory,
  applyBudget,
} = require('../services/context');

test('空章节：明确告诉模型正文会作为第一段插入', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-empty';
  const chapterId = 'chapter-empty';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '测试作品', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第一章', now, now]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;
  assert.ok(system.includes('本章还没有正文'), '应说明本章还没有正文');
  assert.ok(system.includes('insert'), '应告诉模型用 insert 落笔');
  assert.ok(system.includes('不要编造块ID'), '应要求模型不要编造块ID');
});

test('有正文的章节：照常注入正文与段落索引', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-body';
  const chapterId = 'chapter-body';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '测试作品二', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', ?, ?, '', 0, ?, ?)`,
    [
      chapterId,
      workId,
      '第一章',
      '十点整，雨落下来。',
      JSON.stringify([
        { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
      ]),
      now,
      now,
    ]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;
  assert.ok(system.includes('十点整，雨落下来。'), '应注入章节正文');
  assert.ok(system.includes('[b1]'), '应注入段落索引');
  assert.ok(!system.includes('本章还没有正文'), '有正文时不该说本章没有正文');
});

test('空章节：按大纲与上一章出场注入人物卡，高重要性设定全量注入', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-empty-cards';
  const prevId = 'chapter-prev-cards';
  const chapterId = 'chapter-empty-cards';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', ?, 0, ?, ?)`,
    [workId, userId, '测试作品三', '林砚在城隍庙查一桩旧案，老周会来找他。', now, now]
  );

  // 上一章确实出场过「老周」（周岑的别名），本章还是空白
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'done', ?, ?, '', 0, ?, ?)`,
    [
      prevId,
      workId,
      '第一章',
      '老周推门进来，手里拎着一盏马灯。',
      JSON.stringify([
        { id: 'p1', type: 'paragraph', content: '老周推门进来，手里拎着一盏马灯。' },
      ]),
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 2, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第二章', now, now]
  );

  const characters = [
    { id: 'c1', name: '林砚', aliases: '' },       // 只在大纲里出现
    { id: 'c2', name: '周岑', aliases: '老周' },   // 只在上一章出现（用别名）
    { id: 'c3', name: '程雾', aliases: '' },       // 两处都没出现
  ];
  for (const c of characters) {
    await db.run(
      `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.id, workId, c.name, c.aliases, now, now]
    );
  }

  await db.run(
    `INSERT INTO settings (id, work_id, category, name, content, importance, created_at, modified_at)
     VALUES (?, ?, '地点', '城隍庙', '城中最老的庙，梁上还留着弹孔。', 4, ?, ?)`,
    ['s1', workId, now, now]
  );
  await db.run(
    `INSERT INTO settings (id, work_id, category, name, content, importance, created_at, modified_at)
     VALUES (?, ?, '背景', '年号', '故事发生在旧历年间。', 2, ?, ?)`,
    ['s2', workId, now, now]
  );

  const { messages, meta } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  const system = messages[0].content;

  assert.strictEqual(meta.emptyChapter, true, '应识别为空章');
  assert.strictEqual(meta.previousChapter, prevId, '应记录上一章');
  assert.deepStrictEqual(
    meta.characters.sort(),
    ['周岑', '林砚'].sort(),
    '只注入大纲与上一章出场过的人物，不注入没出现过的'
  );
  assert.ok(system.includes('【林砚】'), '大纲里的人物应注入');
  assert.ok(system.includes('【周岑】'), '上一章出场的人物应注入');
  assert.ok(!system.includes('【程雾】'), '两处都没出现的人物不该注入');
  assert.ok(system.includes('城隍庙'), '高重要性设定应全量注入');
  assert.ok(!system.includes('【年号'), '低重要性且未出现的设定不该注入');
  assert.ok(system.includes('本章还没有正文'), '仍要说明本章还没有正文');
});

test('情节卡进入写手上下文：本章卡与全书卡都可见，非写手不注入', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-plot-cards';
  const chapterId = 'chapter-plot-cards';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '情节卡测试', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第七章', now, now]
  );

  await db.run(
    `INSERT INTO plot_cards
       (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
     VALUES (?, ?, ?, ?, 'plot', ?, 0, 'todo', ?, ?)`,
    [
      'pc-chapter',
      workId,
      chapterId,
      '档案室的第三份验尸报告',
      '陈默用老周给的钥匙打开档案柜，发现报告末页被人撕走。',
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO plot_cards
       (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
     VALUES (?, ?, NULL, ?, 'foreshadow', ?, 1, 'done', ?, ?)`,
    ['pc-work', workId, '周父当年在河内做过县吏', '这条伏笔到第九章才收。', now, now]
  );

  const { messages, meta } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;

  assert.strictEqual(meta.plotCards, 2);
  assert.ok(system.includes('## 本章情节卡'), '写手上下文必须有情节卡分区');
  assert.ok(
    system.includes('[本章/情节] 档案室的第三份验尸报告（待写：本章要写出）'),
    '本章卡要标清来源与「本章要写出」'
  );
  assert.ok(system.includes('陈默用老周给的钥匙打开档案柜'), '卡里的备注要进 prompt');
  assert.ok(
    system.includes('[全书/伏笔] 周父当年在河内做过县吏（已完成：只承接，不重演）'),
    '全书级卡也要进，并标明已完成只承接'
  );
  assert.ok(system.includes('「已完成」的节点只承接，不得重演'), '已完成节点要限制重演');
  assert.ok(system.includes('卡里没有的人名、物名、关键道具不得新增'), '卡外实体要禁止新增');

  const reviewer = await assembleContext({
    workId,
    chapterId,
    roleKey: 'reviewer',
    scope: 'chapter',
    userId,
  });
  assert.ok(!reviewer.messages[0].content.includes('## 本章情节卡'), '非写手角色不注入情节卡');
  assert.strictEqual(reviewer.meta.plotCards, 0);
});

test('本章没有情节卡时退回旧上下文，不出现情节卡分区', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-no-plot-cards';
  const chapterId = 'chapter-no-plot-cards';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '无卡测试', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第一章', now, now]
  );

  const { messages, meta } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });

  assert.strictEqual(meta.plotCards, 0);
  assert.ok(!messages[0].content.includes('## 本章情节卡'), '没卡时不应凭空出现分区');
});

test('情节卡读取上限：本章最多 8 张、全书最多 4 张', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-plot-card-limits';
  const chapterId = 'chapter-plot-card-limits';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '上限测试', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, '第一章', now, now]
  );

  for (let i = 0; i < 10; i += 1) {
    await db.run(
      `INSERT INTO plot_cards
         (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
       VALUES (?, ?, ?, ?, 'plot', '', ?, 'todo', ?, ?)`,
      [`pc-ch-${i}`, workId, chapterId, `本章卡${i}`, i, now, now]
    );
  }
  for (let i = 0; i < 5; i += 1) {
    await db.run(
      `INSERT INTO plot_cards
         (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
       VALUES (?, ?, NULL, ?, 'plot', '', ?, 'todo', ?, ?)`,
      [`pc-work-${i}`, workId, `全书卡${i}`, 100 + i, now, now]
    );
  }

  const cards = await require('../services/plotCards').listForContext(workId, chapterId);

  assert.strictEqual(cards.length, 12);
  assert.deepStrictEqual(
    cards.map((card) => card.id),
    [
      ...Array.from({ length: 8 }, (_, i) => `pc-ch-${i}`),
      ...Array.from({ length: 4 }, (_, i) => `pc-work-${i}`),
    ],
    '先本章卡后全书卡，各自按上限截断'
  );
});

test('历史裁剪：超预算时保留最近消息，并从 user 开始', () => {
  const history = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a'.repeat(100) },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'b'.repeat(100) },
  ];

  // 预算放不下最早的 q1 + a，但能放下 q2 + b
  const { rows, omitted } = trimHistory(history, 150);
  assert.strictEqual(omitted, 2, '应省略前两条');
  assert.strictEqual(rows.length, 2, '只保留最近一轮');
  assert.strictEqual(rows[0].role, 'user', '必须从 user 消息开始');
  assert.strictEqual(rows[0].content, 'q2');
});

test('历史裁剪：未超预算时原样保留', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ];
  const { rows, omitted } = trimHistory(history, 1000);
  assert.strictEqual(omitted, 0);
  assert.deepStrictEqual(rows, history);
});

test('上下文预算：超预算先丢低优先级分区，角色提示词不动', () => {
  const parts = [
    { text: 'role-prompt', priority: 1 },
    { text: `## 正文\n${'c'.repeat(200)}`, priority: 2 },
    { text: `## 灵感\n${'i'.repeat(100)}`, priority: 6 },
  ];

  const fitted = applyBudget(parts, 200);
  assert.strictEqual(fitted[0].text, 'role-prompt', '最高优先级不能被截');
  assert.ok(fitted[2].text === '', '最低优先级的灵感整段让位');
  assert.ok(fitted[1].text.length > 0, '正文保留');
});

test('跨章承接：写作上下文注入上一章原文结尾', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-prev-body';
  const prevId = 'prev-body-1';
  const chapterId = 'prev-body-2';
  const prevTail = '他把门闩上，雪声一下子隔在屋外。';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '承接测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'done', ?, ?, '', 0, ?, ?)`,
    [
      prevId,
      workId,
      prevTail,
      JSON.stringify([{ id: 'p1', type: 'paragraph', content: prevTail }]),
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第二章', 2, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  const { messages, meta } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;

  assert.ok(system.includes('## 跨章承接：第 1 章《第一章》落点与原文'));
  assert.ok(system.includes(prevTail), '上一章原文必须真的进 prompt');
  assert.ok(system.includes('末句（语气参照，不要照抄）'), '要给出末句语气锚点');
  assert.strictEqual(meta.previousChapter, prevId);
});

test('跨章承接：紧邻上一章为空时回退到最近有正文的前章', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-prev-fallback';
  const firstId = 'fallback-1';
  const emptyId = 'fallback-2';
  const chapterId = 'fallback-3';
  const firstTail = '灯芯爆了一下，他把密诏压进砚台底下。';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '回退测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'done', ?, ?, '', 0, ?, ?)`,
    [
      firstId,
      workId,
      firstTail,
      JSON.stringify([{ id: 'f1', type: 'paragraph', content: firstTail }]),
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第二章', 2, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [emptyId, workId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第三章', 3, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  const { messages, meta } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;

  assert.strictEqual(meta.previousChapter, firstId, '应跳过空章回退到第一章');
  assert.ok(system.includes('第 1 章《第一章》'), '标题必须指明回退到了哪一章');
  assert.ok(system.includes(firstTail), '回退后的正文必须进 prompt');
  assert.ok(!system.includes('第 2 章《第二章》'), '不能把空章当成承接对象');
});

test('跨章承接块：时间地点与在场人物来自上一章摘要，原文兜底', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-prev-handoff';
  const prevId = 'handoff-1';
  const chapterId = 'handoff-2';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '落点测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES ('handoff-c1', ?, '周岑', '老周', ?, ?)`,
    [workId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, summary, summary_words, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'done', ?, '[]', '', ?, 900, ?, ?)`,
    [
      prevId,
      workId,
      '老周推门进来，抖掉肩上的雪。他把灯挑亮，说密诏已经不在了。',
      JSON.stringify({
        progress: '老周带来密诏失踪的消息。',
        open_threads: '密诏被谁取走',
        setting: '雪夜，城隍庙后殿',
        characters: ['周岑'],
      }),
      now,
      now,
    ]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第二章', 2, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const system = messages[0].content;

  assert.ok(system.includes('时间地点：雪夜，城隍庙后殿'));
  assert.ok(system.includes('在场人物：周岑'));
  assert.ok(system.includes('未解：密诏被谁取走'));
  assert.ok(system.includes('末句（语气参照，不要照抄）：他把灯挑亮，说密诏已经不在了。'));
});

test('跨章承接：规划上下文只给上一章结尾摘要，不注入整章', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-prev-plan';
  const prevId = 'plan-prev-1';
  const chapterId = 'plan-prev-2';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '规划承接测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'done', ?, ?, '', 0, ?, ?)`,
    [prevId, workId, '雪压着屋脊，他数到第三声更鼓才合眼。', '[]', now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第二章', 2, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  const { messages } = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
    includeChapterBody: false,
  });
  const system = messages[0].content;

  assert.ok(system.includes('## 上一章结尾（前情摘要）'));
  assert.ok(system.includes('更鼓'), '规划也要能看到上一章结尾原文');
  assert.ok(!system.includes('## 当前章节正文'), '规划不注入整章正文');
});

test('默认文风基线：写手上下文注入 sample.md 实测口径，其他角色不注入', async () => {
  await db.ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-style-baseline';
  const chapterId = 'style-baseline-1';

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, '基线测试', '', '', '', 0, ?, ?)`,
    [workId, userId, now, now]
  );
  await db.run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章', 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );

  const writer = await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
  });
  const writerSystem = writer.messages[0].content;
  assert.strictEqual(writer.meta.styleBaseline, true);
  assert.ok(writerSystem.includes('## 文风基线（范文 sample.md 实测）'));
  assert.ok(writerSystem.includes('段均 112 字'), '段均必须来自实测，不是手写形容词');
  assert.ok(writerSystem.includes('对白约占 18%'));
  assert.ok(writerSystem.includes('≤12 字短句约 12%'));

  const editor = await assembleContext({
    workId,
    chapterId,
    roleKey: 'editor',
    scope: 'chapter',
    userId,
  });
  assert.strictEqual(editor.meta.styleBaseline, false);
  assert.ok(!editor.messages[0].content.includes('## 文风基线'), '基线只给写手');
});

test.after(async () => {
  env.cleanup();
});
