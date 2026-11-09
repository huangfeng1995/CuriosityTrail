'use strict';

/**
 * 分段起稿的编排测试。
 *
 * 不发真实请求，用假的 runSegment 驱动完整流程，专盯用户点名的六件事：
 * 拼接不重复、中间组不收尾、最后一组才收束、续写只一次、
 * 调用超限能降级、缺拍只重写对应组。
 */

const test = require('node:test');
const assert = require('node:assert');

const segmentWriter = require('../services/agent/segmentWriter');
const { countWords } = require('../services/wordCount');

const TYPES = ['行动', '冲突', '转折', '揭示'];

function makePlan(beatCount, paragraphs = 3) {
  return {
    chapterGoal: '查清旧案的第一条线索',
    protagonistIntent: '进庙查案',
    obstacle: '庙祝拦门',
    cost: '交出信物',
    hook: '照片背面写着主角的名字',
    avoidRepeat: [],
    mainType: '揭示',
    beats: Array.from({ length: beatCount }, (_, i) => ({
      id: `B${i + 1}`,
      type: TYPES[i % TYPES.length],
      goal: `本拍目标${i + 1}`,
      obstacle: `本拍阻碍${i + 1}`,
      cost: `本拍代价${i + 1}`,
      delta: { variable: '处境', from: `起点${i + 1}`, to: `终点${i + 1}` },
      infoGain: `信息增量${i + 1}`,
      paragraphs,
      endHook: `小钩子${i + 1}`,
    })),
  };
}

/** 生成约 100 字 × count 段的假正文。 */
function body(label, count = 8, lastParagraph = '') {
  const sentence = '风雪压着庙檐，他把手按在门环上，指腹能摸到一层薄冰，门里有人轻轻咳了一声。';
  const rows = Array.from(
    { length: count },
    (_, i) => `${label}第${i + 1}段：${sentence}${sentence}${sentence}`
  );
  if (lastParagraph) rows.push(lastParagraph);
  return rows.join('\n\n');
}

/** 按顺序吐出预设回复，并记录每次调用的指令。 */
function makeRunner(replies) {
  const seen = [];
  let index = 0;
  const run = async (meta) => {
    seen.push(meta);
    const reply = replies[index] ?? replies[replies.length - 1];
    index += 1;
    const content = typeof reply === 'function' ? reply(meta) : reply;
    return { content, finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
  };
  run.seen = seen;
  return run;
}

test('8 拍按 3 拍一组切成 3 组，每组 2–4 拍', () => {
  const groups = segmentWriter.planSegments(makePlan(8));
  assert.deepStrictEqual(groups.map((g) => g.beatIds), [
    ['B1', 'B2', 'B3'],
    ['B4', 'B5', 'B6'],
    ['B7', 'B8'],
  ]);
  for (const group of groups) {
    assert.ok(group.beats.length >= 2 && group.beats.length <= 4, '每组 2–4 拍');
  }
  assert.strictEqual(groups.filter((g) => g.isLast).length, 1, '只有一组是最后一组');
});

test('每组指令都带完整节拍表引用、已写尾部与目标篇幅', () => {
  const plan = makePlan(8);
  const groups = segmentWriter.planSegments(plan);
  const middle = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups[1],
    groups,
    tail: '上一组最后一段原文。',
  });

  assert.match(middle, /完整节拍表见 system/, '每次调用都要带完整节拍表');
  assert.match(middle, /本组只写这几拍：B4、B5、B6/);
  assert.match(middle, /已经写完：B1、B2、B3/);
  assert.match(middle, /后面才写：B7、B8/);
  assert.match(middle, /上一组最后一段原文。/, '要带已写正文最后 2–3 段');
  assert.match(middle, /本组大致写 \d+ 字/);
  assert.match(middle, /不要提前收尾，不要总结，不要重复前文，不要埋全章钩子/);
  assert.match(middle, /禁止出现「就这样」「从此」/, '中间组要明确禁收尾');

  const last = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups[2],
    groups,
    tail: '上一组最后一段原文。',
  });
  assert.match(last, /可以收束本章/);
  assert.match(last, /章末钩子/);
});

test('交付只写一次：组指令给具体拍号，重复拍在重写里被点名', () => {
  const plan = makePlan(8);
  const groups = segmentWriter.planSegments(plan);
  const brief = { items: [], handoverBeat: 'B6' };

  const inGroup = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups.find((g) => g.beatIds.includes('B6')),
    groups,
    tail: '上一组最后一段原文。',
    brief,
  });
  assert.match(inGroup, /本章交付只发生一次，就落在本组的 B6 拍/);

  const other = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups.find((g) => !g.beatIds.includes('B6')),
    groups,
    tail: '上一组最后一段原文。',
    brief,
  });
  assert.match(other, /本章交付只发生一次，已在第 B6 拍完成/);

  const dupGroup = groups.find((g) => g.beatIds.includes('B4'));
  const rewrite = segmentWriter.buildBeatRewriteInstruction({
    plan,
    group: dupGroup,
    groups,
    problemIds: ['B4'],
    handoverDupIds: ['B4'],
    brief,
    tail: '上一组最后一段原文。',
    nextHead: '',
  });
  assert.match(rewrite, /B4：本章交付只发生一次，已在第 B6 拍完成/);
  assert.match(rewrite, /只保留递、接、握住手这类预备动作/);
});

test('编排与可读性要求写进起稿、续写与重写指令，不再有数字门槛', () => {
  const plan = makePlan(4);
  const groups = segmentWriter.planSegments(plan);

  const middle = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups[0],
    groups,
    tail: '上一组最后一段原文。',
  });
  const last = segmentWriter.buildSegmentInstruction({
    plan,
    group: groups[1],
    groups,
    tail: '上一组最后一段原文。',
  });
  const continuation = segmentWriter.buildContinuationInstruction({
    plan,
    group: groups[0],
    groups,
    tail: '上一组最后一段原文。',
    remainingParagraphs: 4,
    remainingChars: 400,
  });
  const rewrite = segmentWriter.buildBeatRewriteInstruction({
    plan,
    group: groups[1],
    groups,
    problemIds: ['B3'],
    tail: '上一组最后一段原文。',
    nextHead: '',
  });

  for (const instruction of [middle, last, continuation, rewrite]) {
    assert.match(instruction, /全章按长章体量写/);
    assert.match(instruction, /4800–5600 字/);
    assert.match(instruction, /每拍段数按节拍表给的段数为准/, '段数按拍，允许 ±2');
    assert.match(instruction, /每个自然段 80–140 字（含标点）/, '段长是硬约束，不再只描述风格');
    assert.match(instruction, /禁止连续 3 段不足 20 字/);
    assert.match(instruction, /一段写一个小场景/, '段落要按小场景成段，不能切成碎片');
    assert.match(instruction, /段内 3–6 句/);
    assert.match(instruction, /对白必须与动作\/叙述合并在同一段/, '对白不得连续独立成段');
    assert.match(instruction, /引号统一用全角 “”，禁止使用「」/);
    assert.match(instruction, /关键交流必须写成直接引语/, '关键对话必须用人物原话');
    assert.match(instruction, /不要用「他说他问我是否……」这类转述代替关键对话/);
    assert.match(instruction, /每次对话都要推动一次变化/);
    assert.match(instruction, /每一拍都要有变量变化、信息增量和代价/);
    assert.match(instruction, /交稿前自检/);
    assert.match(instruction, /含标点/, '字数口径必须写明含标点');
    assert.match(instruction, /段数按本组各拍计划（±2 段）/, '自检也要核对段数');

    assert.doesNotMatch(instruction, /14%–22%/, '对白占比已降级为诊断指标，不能再当门槛');
    assert.doesNotMatch(instruction, /不少于 25 字/, '段落下限已降级为诊断指标');
    assert.doesNotMatch(instruction, /段均以/, '不能给段落均长锚点');
    assert.doesNotMatch(instruction, /目标的 105%/, '续写不再设 105% 硬线');
  }

  for (const instruction of [last, continuation, rewrite]) {
    assert.match(instruction, /不得复述已完成内容/);
    assert.match(instruction, /开头第一句必须接着.*最后一个动作/, '接续必须从最后一个动作往下写');
    assert.match(
      instruction,
      /不要从「回忆」「找灵感」「重新交代」的角度重开/,
      '续写不能从找灵感的角度重讲'
    );
  }
  assert.match(continuation, /按各拍计划段数（±2 段）落段/, '续写也要按拍段落数收口');
  // 分组重写加双向约束：既不许超段数，也不许从「太长」翻成「太少」。
  assert.match(rewrite, /本组段数必须落在 \d+–\d+ 段（双向约束：不能超，也不能为了拆段反而写少）/);
});

test('S2 篇幅配额：组指令带每拍目标汉字数与 85% 未完成线，扩写只补不推进', () => {
  const plan = makePlan(6, 5);
  const functions = ['opening', 'discussion', 'identity', 'father', 'farewell', 'departure'];
  const shares = [9, 14, 30, 15.5, 25, 6.5];
  plan.beats = plan.beats.map((beat, index) => ({
    ...beat,
    function: functions[index],
    wordShare: shares[index],
    targetChars: Math.round(shares[index] * 50),
  }));
  const groups = segmentWriter.planSegments(plan);
  const group = groups.find((item) => item.beatIds.includes('B3'));

  const draft = segmentWriter.buildSegmentInstruction({
    plan,
    group,
    groups,
    tail: '上一组最后一段原文。',
  });
  assert.match(draft, /## 本组各拍目标（纯汉字，不含标点）/);
  assert.match(draft, /B3（identity）：目标 1500 个汉字（纯汉字不含标点），段数 3–7 段/);
  assert.match(draft, /不足 1275 字视为未完成/);

  const continuation = segmentWriter.buildContinuationInstruction({
    plan,
    group,
    groups,
    tail: '上一组最后一段原文。',
    remainingParagraphs: 3,
    remainingChars: 500,
  });
  assert.match(continuation, /B3（identity）：目标 1500 个汉字/);

  const rewrite = segmentWriter.buildBeatRewriteInstruction({
    plan,
    group,
    groups,
    problemIds: [],
    expandShots: [{ id: 'B3', chars: 597, target: 1500 }],
    tail: '上一组最后一段原文。',
    nextHead: '',
  });
  assert.match(rewrite, /## 扩写（只补不推进）/);
  assert.match(rewrite, /B3：当前 597 个汉字 → 目标 1500 个汉字/);
  assert.match(rewrite, /只补细节、环境、动作、对话与人物心理，不推进情节、不新增事件、不提前揭示/);
  assert.match(rewrite, /这些拍节拍齐全，只是篇幅不足/);
  assert.match(rewrite, /不许用加空段、拆句、加标点凑字数/);
  assert.match(rewrite, /扩写后必须仍满足每段 80–140 字、本拍段数在计划区间 ±2/);
});

/** 六拍计划，B3（identity）目标 1500 汉字 = 30% × 5000。 */
function shotQuotaPlan() {
  const plan = makePlan(6, 5);
  const functions = ['opening', 'discussion', 'identity', 'father', 'farewell', 'departure'];
  const shares = [9, 14, 30, 15.5, 25, 6.5];
  plan.beats = plan.beats.map((beat, index) => ({
    ...beat,
    function: functions[index],
    wordShare: shares[index],
    targetChars: Math.round(shares[index] * 50),
  }));
  return plan;
}

/** checkWordShares 的最小形状：篇幅判定只需要 id 与纯汉字数。 */
function shotReport(charsById) {
  return {
    applicable: true,
    beats: Object.entries(charsById).map(([id, chars]) => ({ id, chars, target: 0 })),
  };
}

test('S2 扩写触发：B3 目标 1500 实际 600 → 判不足并进入扩写', () => {
  const plan = shotQuotaPlan();
  const report = shotReport({ B1: 450, B2: 700, B3: 600, B4: 775, B5: 1250, B6: 325 });

  assert.deepStrictEqual(
    segmentWriter.findShortShots(plan, report),
    [{ id: 'B3', chars: 600, target: 1500 }],
    '只有 B3 低于 1275（1500 × 85%），必须触发扩写'
  );

  const under = segmentWriter.underFilledShots(plan, report);
  assert.deepStrictEqual(under, [
    { beatId: 'B3', chars: 600, target: 1500, note: '【篇幅自检：第B3拍 600/1500】' },
  ]);
});

test('S2 扩写不触发：B3 目标 1500 实际 1400（93%）→ 不扩写', () => {
  const plan = shotQuotaPlan();
  const report = shotReport({ B1: 450, B2: 700, B3: 1400, B4: 775, B5: 1250, B6: 325 });

  assert.deepStrictEqual(
    segmentWriter.findShortShots(plan, report),
    [],
    '1400 已过 85% 线（1275），不该再占一次扩写调用'
  );
});

test('S2 扩写一次后仍不足：1300 → 不再重试，但记 underFilledShots', () => {
  const plan = shotQuotaPlan();
  const report = shotReport({ B3: 1300 });

  assert.deepStrictEqual(
    segmentWriter.findShortShots(plan, report),
    [],
    '1300 已过 85%，扩写只允许一次，不能再触发'
  );
  assert.deepStrictEqual(
    segmentWriter.underFilledShots(plan, report, ['B3']),
    [{ beatId: 'B3', chars: 1300, target: 1500, note: '【篇幅自检：第B3拍 1300/1500】' }],
    '扩写过的拍没到目标，交付时必须显式记录'
  );
});

test('U2 记录口径：扩写过的拍 1450/1500（96.7%）不再记，1400（93.3%）仍记', () => {
  const plan = shotQuotaPlan();

  assert.deepStrictEqual(
    segmentWriter.underFilledShots(plan, shotReport({ B3: 1450 }), ['B3']),
    [],
    '95%–100% 的尾差不打扰作者'
  );
  assert.deepStrictEqual(
    segmentWriter.underFilledShots(plan, shotReport({ B3: 1400 }), ['B3']),
    [{ beatId: 'B3', chars: 1400, target: 1500, note: '【篇幅自检：第B3拍 1400/1500】' }],
    '低于 95% 仍要如实记录'
  );
});

test('U1 扩写指令只点名不足的拍，写死计划段数与 80–140，禁止合并凑字数', () => {
  const instruction = segmentWriter.buildExpandInstruction({
    group: { index: 0 },
    groups: [{}, {}],
    beats: [{ id: 'B3', paragraphs: 12 }],
    shots: [{ id: 'B3', chars: 709, target: 1500 }],
  });

  assert.match(instruction, /只扩写第 1\/2 组中的 B3/);
  assert.match(instruction, /B3：本拍必须 12 段（容差 ±2），每段 80–140 字/);
  assert.match(instruction, /当前 709 个汉字，目标 1500 个汉字/);
  assert.match(instruction, /禁止把两段合并成一段来凑字数/);
  assert.ok(!/B4/.test(instruction), '不得点名其他拍');
});

test('U1 只替换点名拍的段落，同组其他拍原样保留', () => {
  const group = {
    index: 0,
    beatIds: ['B1', 'B2'],
    beats: [{ id: 'B1', paragraphs: 2 }, { id: 'B2', paragraphs: 2 }],
    content: ['甲'.repeat(90), '乙'.repeat(90), '丙'.repeat(90), '丁'.repeat(90)].join('\n\n'),
  };

  const replaced = segmentWriter.spliceExpandedBeats(group, [
    { id: 'B2', paragraphs: ['戊'.repeat(100), '己'.repeat(100)] },
  ]);

  assert.strictEqual(replaced, true);
  const rows = group.content.split('\n\n');
  assert.strictEqual(rows.length, 4);
  assert.match(rows[0], /^甲/);
  assert.match(rows[1], /^乙/);
  assert.match(rows[2], /^戊/);
  assert.match(rows[3], /^己/);
});

/** 两拍、每拍 5 段、每段 90 字，形态与计划完全对齐。 */
function expandablePlan() {
  return {
    beats: [
      { id: 'B1', paragraphs: 5, targetChars: 700 },
      { id: 'B2', paragraphs: 5, targetChars: 700 },
    ],
  };
}

function expandableGroup() {
  return {
    index: 0,
    beatIds: ['B1', 'B2'],
    beats: [
      { id: 'B1', paragraphs: 5 },
      { id: 'B2', paragraphs: 5 },
    ],
    content: Array.from({ length: 10 }, () => '原'.repeat(90)).join('\n\n'),
  };
}

test('U1 扩写不收敛时内部再扩一次，段数补齐后接受', async () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  let attempts = 0;
  const runSegment = async () => {
    attempts += 1;
    const paragraphs = attempts === 1
      ? ['短'.repeat(30)]
      : Array.from({ length: 5 }, () => '补'.repeat(100));
    return { content: '', parsed: { beats: [{ id: 'B2', paragraphs }] }, finishReason: 'stop' };
  };

  const out = await segmentWriter.expandMissingBeats({
    plan,
    groups,
    expandShots: [{ id: 'B2', chars: 300, target: 700 }],
    runSegment,
  });

  assert.strictEqual(out.callCount, 2, '第一次不合规，必须再扩一次');
  assert.deepStrictEqual(out.unconverged, []);
  assert.strictEqual(out.expanded.length, 1);
  assert.strictEqual(out.expanded[0].attempt, 2);
  assert.strictEqual(out.calls.filter((call) => call.kind === 'expand').length, 2);
});

test('U1 两次都不合规：保留原稿并记 unconverged', async () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  const before = groups[0].content;
  const runSegment = async () => ({
    content: '',
    parsed: { beats: [{ id: 'B2', paragraphs: ['短'.repeat(30), '短'.repeat(30)] }] },
    finishReason: 'stop',
  });

  const out = await segmentWriter.expandMissingBeats({
    plan,
    groups,
    expandShots: [{ id: 'B2', chars: 300, target: 700 }],
    runSegment,
  });

  assert.strictEqual(groups[0].content, before, '不合规的正文不能写回');
  assert.strictEqual(out.unconverged.length, 1);
  assert.strictEqual(out.unconverged[0].beatIds[0], 'B2');
  assert.ok(out.unconverged[0].problems.length > 0);
});

/** 两拍共用一组、每拍 5 段的完整计划与正文，重写测试用。 */
function rewriteFixture() {
  const plan = makePlan(2, 5);
  const groups = segmentWriter.planSegments(plan);
  groups[0].content = body('原', 10);
  return { plan, groups };
}

/** 返回结构化拍 JSON 的假回复（模拟 segmentRun 解析后的 parsed）。 */
function parsedRunner(replies) {
  const seen = [];
  let index = 0;
  const run = async (meta) => {
    seen.push(meta);
    const payload = replies[index] ?? replies[replies.length - 1];
    index += 1;
    return { content: '', parsed: payload, finishReason: 'stop', usage: {} };
  };
  run.seen = seen;
  return run;
}

function beatReply(id, paragraphs) {
  return { action: 'rewrite', beats: [{ id, paragraphs }] };
}

test('V1 单拍违规只替换该拍，同组其他拍字节级不变', async () => {
  const { plan, groups } = rewriteFixture();
  const before = segmentWriter.splitParagraphs(groups[0].content);
  const ranges = segmentWriter.beatParagraphRanges(groups[0].beats, before.length);
  const b1Before = before.slice(ranges[0][0], ranges[0][1]);

  const runner = parsedRunner([
    beatReply('B2', Array.from({ length: 5 }, () => '改'.repeat(100))),
  ]);
  const out = await segmentWriter.rewriteMissingGroups({
    plan,
    groups,
    coverage: { covered: [], missing: ['B2'], weak: [] },
    runSegment: runner,
    callCount: 0,
    maxCalls: 8,
  });

  assert.strictEqual(runner.seen.length, 1, '只重写一组一次');
  assert.match(runner.seen[0].instruction, /只重写这一组里的指定拍/);
  const after = segmentWriter.splitParagraphs(out.groups[0].content);
  assert.deepStrictEqual(
    after.slice(0, b1Before.length),
    b1Before,
    'B1 的段落必须与重写前逐字相同'
  );
  assert.ok(
    after.slice(b1Before.length).every((paragraph) => paragraph.startsWith('改')),
    '只替换被点名的 B2'
  );
});

test('V1 同拍同时有形态与禁写问题：合并成一次请求，不重写两遍', async () => {
  const { plan, groups } = rewriteFixture();
  const runner = parsedRunner([
    beatReply('B2', Array.from({ length: 5 }, () => '改'.repeat(100))),
  ]);

  await segmentWriter.rewriteMissingGroups({
    plan,
    groups,
    coverage: { covered: [], missing: [], weak: [] },
    mustWithholdIds: ['B2'],
    shapeViolations: [{ beatId: 'B2', kind: 'count', expected: 5, actual: 9, tolerance: 2 }],
    runSegment: runner,
    callCount: 0,
    maxCalls: 8,
  });

  assert.strictEqual(runner.seen.length, 1, '同一拍的双重违规只能发一次请求');
  const instruction = runner.seen[0].instruction;
  assert.match(instruction, /B2：本拍只写形制细节/, '禁写要求必须带上');
  assert.match(instruction, /B2：.*段落形态不合规/, '形态要求必须合并在同一行');
});

test('V1 重写后总字数少 15% 以上：记录缩水拍与差值', async () => {
  const { plan, groups } = rewriteFixture();
  const runner = parsedRunner([beatReply('B2', ['短'.repeat(10)])]);

  const out = await segmentWriter.rewriteMissingGroups({
    plan,
    groups,
    coverage: { covered: [], missing: ['B2'], weak: [] },
    runSegment: runner,
    callCount: 0,
    maxCalls: 8,
  });

  assert.ok(out.shrink, '整体缩水超过 15% 必须显式记录');
  assert.ok(out.shrink.after < out.shrink.before * 0.85, 'after 必须低于 before 的 85%');
  assert.strictEqual(out.shrink.beats[0].beatId, 'B2', '要标出缩水拍');
  assert.ok(out.shrink.beats[0].delta < 0, '要给出差值');
});

test('V2 扩写后重算：新掉到 85% 以下的拍补进第二遍', async () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  let calls = 0;
  const runSegment = async () => {
    calls += 1;
    const id = calls === 1 ? 'B1' : 'B2';
    return {
      content: '',
      parsed: { beats: [{ id, paragraphs: Array.from({ length: 5 }, () => '补'.repeat(100)) }] },
      finishReason: 'stop',
    };
  };

  const out = await segmentWriter.expandMissingBeats({
    plan,
    groups,
    expandShots: [{ id: 'B1', chars: 300, target: 700 }],
    runSegment,
    measureShots: () => ({
      applicable: true,
      beats: [
        { id: 'B1', chars: 500, target: 700 },
        { id: 'B2', chars: 300, target: 700 },
      ],
    }),
  });

  assert.strictEqual(out.callCount, 2, '补入的新不足拍要再扩一次');
  assert.deepStrictEqual(out.supplement.map((shot) => shot.id), ['B2']);
  assert.strictEqual(out.expanded.length, 2, '两遍各记一次扩写成功');
});

test('V2 补完仍不足：不再循环，记 underFilledShots', async () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  const report = {
    applicable: true,
    beats: [
      { id: 'B1', chars: 500, target: 700 },
      { id: 'B2', chars: 300, target: 700 },
    ],
  };
  const runSegment = async () => ({
    content: '',
    parsed: {
      beats: [
        { id: 'B1', paragraphs: Array.from({ length: 5 }, () => '补'.repeat(100)) },
        { id: 'B2', paragraphs: Array.from({ length: 5 }, () => '补'.repeat(100)) },
      ],
    },
    finishReason: 'stop',
  });

  const out = await segmentWriter.expandMissingBeats({
    plan,
    groups,
    expandShots: [{ id: 'B1', chars: 300, target: 700 }],
    runSegment,
    measureShots: () => report,
  });

  assert.strictEqual(out.callCount, 2, '同一轮最多补一次，不能开第三遍');
  const under = segmentWriter.underFilledShots(
    plan,
    report,
    ['B1', 'B2']
  );
  assert.ok(
    under.some((shot) => shot.beatId === 'B2'),
    '补完仍不足的拍要记进 underFilledShots'
  );
});

test('V3 扩写指令写明每段至少两句、不少于 90 字，并给示例', () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  const instruction = segmentWriter.buildExpandInstruction({
    group: groups[0],
    groups,
    beats: groups[0].beats,
    shots: [
      { id: 'B1', chars: 300, target: 700 },
      { id: 'B2', chars: 300, target: 700 },
    ],
  });

  assert.match(instruction, /每段至少两句/);
  assert.match(instruction, /不少于 90 字/);
  assert.match(instruction, /示例（单段约 100 字）/);
  assert.match(instruction, /每段 80–140 字（含标点）/);
});

test('V3 两次被拒：expandRejected 记下两次实际段长', async () => {
  const plan = expandablePlan();
  const groups = [expandableGroup()];
  const runSegment = async () => ({
    content: '',
    parsed: { beats: [{ id: 'B2', paragraphs: ['短'.repeat(30), '短'.repeat(30)] }] },
    finishReason: 'stop',
  });

  const out = await segmentWriter.expandMissingBeats({
    plan,
    groups,
    expandShots: [{ id: 'B2', chars: 300, target: 700 }],
    runSegment,
  });

  assert.strictEqual(out.expandRejected.length, 1);
  assert.strictEqual(out.expandRejected[0].beatId, 'B2');
  assert.deepStrictEqual(out.expandRejected[0].attempts, [[30, 30], [30, 30]]);
  assert.ok(out.expandRejected[0].problems.length > 0);
});

/** 固定 100 字一段的正文，用来精确验证 80% 门槛。 */
function fixedBody(count) {
  return Array.from({ length: count }, () => '字'.repeat(100)).join('\n\n');
}

test('续写门槛按组目标的 80%：70% 要续写，90% 不续写', () => {
  const base = {
    isLast: false,
    continued: false,
    targetChars: 1000,
    targetParagraphs: 10,
  };

  assert.strictEqual(
    segmentWriter.needsContinuation({ ...base, content: fixedBody(7) }),
    true,
    '700/1000 低于 80%，应当续写'
  );
  assert.strictEqual(
    segmentWriter.needsContinuation({ ...base, content: fixedBody(9) }),
    false,
    '900/1000 达到 80%，不应续写'
  );
});

test('组目标按计划段数分预算，合计落在 5000 附近而不是越写越长', () => {
  for (const paragraphsPerBeat of [6, 7]) {
    const plan = makePlan(7, paragraphsPerBeat);
    const groups = segmentWriter.planSegments(plan);
    const total = groups.reduce((sum, g) => sum + g.targetChars, 0);
    assert.ok(total >= 4800 && total <= 5200, `计划段数 ${paragraphsPerBeat * 7} 时组目标合计 ${total}`);
    assert.ok(!('avgCharsPerParagraph' in groups[0]), '不再保留每段均值锚点');
  }
});

test('拼接不重复前文：下一组重抄上一组尾段时只保留一份', async () => {
  const plan = makePlan(4, 10);
  const runner = makeRunner([
    body('甲', 20, '共同尾段。'),
    '共同尾段。\n\n' + body('乙', 20),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(draft.content.split('共同尾段。').length - 1, 1, '重复段只能出现一次');
  assert.match(runner.seen[1].instruction, /共同尾段。/, '第二组指令要带上上一组尾部');
});

test('本组写到下一组标志事件时，代码侧截到该段之前', async () => {
  const plan = makePlan(6, 10);
  const marker = '门环在门槛上敲了三下，这是下一组才出现的暗号';
  plan.beats[3].endHook = marker;
  plan.beats[3].infoGain = '下一组才知道：庙祝袖口绣着县衙的纹样';

  const runner = makeRunner([
    body('甲', 20, `${marker}。`),
    body('乙', 20, '章末钩子。'),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(draft.boundaryTrimmed, 1, '应当识别并截断一次越界');
  assert.ok(!draft.content.includes(marker), '下一组的标志事件不能留在本组正文');
  assert.ok(!draft.content.includes('庙祝袖口绣着县衙的纹样'), '下一组的信息增量也不能提前出现');
  assert.strictEqual(draft.groups[0].content.split(marker).length - 1, 0);
  assert.match(runner.seen[0].instruction, /本组硬边界/, '指令里要写清本组只能写到哪里');
  assert.match(runner.seen[0].instruction, new RegExp(marker), '指令里要列出下一组的标志事件');
});

test('续写从中间整段复述时只保留一份，不把重复段拼进正文', async () => {
  const plan = makePlan(4, 10);
  const repeated = '他把报告页面重新打开，滚到底，那一行「建议人工复核」还在，字很小，嵌在表格最后一行。';
  const runner = makeRunner([
    `只写了一句。\n\n${repeated}`,
    `他先喝了口水。\n\n${repeated}\n\n${body('续', 20)}`,
    body('乙', 20),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(draft.content.split(repeated).length - 1, 1, '同一整段只能出现一次');
  assert.match(draft.content, /他先喝了口水/, '续写新增的内容不能被误删');
});

test('中间组不出现收尾语气，最后一组才收束并埋钩子', async () => {
  const plan = makePlan(4, 10);
  const runner = makeRunner([
    body('甲', 20, '就这样，这一天结束了。'),
    body('甲续', 20),
    body('乙', 20, '照片背面写着主角的名字。'),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.ok(!draft.content.includes('就这样'), '中间组的收尾语气必须清掉');
  assert.match(draft.content, /照片背面写着主角的名字/, '章末钩子要在最后一组');
  assert.strictEqual(runner.seen[0].group.index, 0);
  assert.match(runner.seen[0].instruction, /禁止出现「就这样」「从此」/);
  assert.match(runner.seen[1].instruction, /接着写，不要重开/, '收尾语气命中后要续写');
  assert.match(runner.seen[2].instruction, /可以收束本章/);
});

test('某组提前收尾只续写一次，续写后再短也不重试', async () => {
  const plan = makePlan(4, 10);
  const runner = makeRunner([
    '他只写了两句。',
    '又补了一句。',
    body('乙', 20),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(runner.seen.length, 3, '第一组：起稿 + 一次续写；第二组起稿');
  assert.strictEqual(draft.continuations, 1, '每组最多续写一次');
  assert.strictEqual(runner.seen.filter((s) => s.kind === 'continuation').length, 1);
  assert.match(runner.seen[1].instruction, /接着写，不要重开/);
  assert.match(runner.seen[1].instruction, /不要重开/);
  assert.match(draft.content, /又补了一句/);
});

test('总调用超限时降级交付并打徽标，不无限重试', async () => {
  const plan = makePlan(8);
  const runner = makeRunner([body('甲', 8), body('乙', 8), body('丙', 8)]);

  const draft = await segmentWriter.draftInSegments({
    plan,
    runSegment: runner,
    maxCalls: 2,
  });

  assert.strictEqual(runner.seen.length, 2, '到达上限后不再发起调用');
  assert.strictEqual(draft.degraded, 'call_limit');
  assert.strictEqual(draft.callCount, 2);
  assert.ok(draft.content.includes('甲第1段'));
  assert.ok(!draft.content.includes('丙第1段'), '没写到的组不能凭空出现');
  assert.match(segmentWriter.segmentBadge(draft.degraded), /调用次数达到上限/);
});

test('缺拍只重写对应组，其他组正文原样保留', async () => {
  const plan = makePlan(4);
  const draftRunner = makeRunner([body('甲', 8), body('乙', 8)]);
  const draft = await segmentWriter.draftInSegments({ plan, runSegment: draftRunner });

  const beforeGroup = draft.groups[0].content;
  const rewriteRunner = makeRunner(['重写这一组：\n\n' + body('乙改', 8, '章末抬出一口箱子。')]);

  const rewritten = await segmentWriter.rewriteMissingGroups({
    plan,
    groups: draft.groups,
    coverage: {
      covered: [{ id: 'B1' }, { id: 'B2' }, { id: 'B4' }],
      missing: ['B3'],
      weak: [],
    },
    runSegment: rewriteRunner,
    callCount: draft.callCount,
    maxCalls: 8,
  });

  assert.strictEqual(rewriteRunner.seen.length, 1, '只对该缺拍所在的组发起一次重写');
  assert.strictEqual(rewriteRunner.seen[0].group.index, 1);
  assert.strictEqual(rewritten.rewroteGroups, 1);
  assert.match(rewriteRunner.seen[0].instruction, /B3/);
  assert.match(rewriteRunner.seen[0].instruction, /只重写这一组/);
  assert.match(rewriteRunner.seen[0].instruction, /不要整章重来/);

  assert.strictEqual(rewritten.groups[0].content, beforeGroup, '没有缺拍的组不能被改写');
  assert.match(rewritten.content, /甲第1段/, '第一组原样保留');
  assert.match(rewritten.content, /乙改第1段/, '第二组换成重写版');
  assert.match(rewritten.content, /章末抬出一口箱子/);
});

test('悬念违规只重写违规拍所在组，不整章重来', async () => {
  const plan = makePlan(4);
  const draftRunner = makeRunner([body('甲', 8), body('乙', 8)]);
  const draft = await segmentWriter.draftInSegments({ plan, runSegment: draftRunner });

  const beforeGroup = draft.groups[0].content;
  const rewriteRunner = makeRunner(['重写这一组：\n\n' + body('乙改', 8, '章末抬出一口箱子。')]);

  const rewritten = await segmentWriter.rewriteMissingGroups({
    plan,
    groups: draft.groups,
    coverage: { covered: [], missing: [], weak: [] },
    mustWithholdIds: ['B4'],
    runSegment: rewriteRunner,
    callCount: draft.callCount,
    maxCalls: 8,
  });

  assert.strictEqual(rewriteRunner.seen.length, 1, '只对违规拍所在的组发起一次重写');
  assert.strictEqual(rewriteRunner.seen[0].group.index, 1);
  assert.strictEqual(rewritten.rewroteGroups, 1);
  assert.match(
    rewriteRunner.seen[0].instruction,
    /B4：本拍只写形制细节与人物反应，不写制度结论，不替读者解释/
  );
  assert.match(rewriteRunner.seen[0].instruction, /只重写这一组/);
  assert.strictEqual(rewritten.groups[0].content, beforeGroup, '违规拍之外的组不能被改写');
  assert.match(rewritten.content, /甲第1段/, '第一组原样保留');
  assert.match(rewritten.content, /乙改第1段/, '第二组换成重写版');
});

test('不变项数值冲突只重写冲突拍所在组，指令点名期望值与实际值', async () => {
  const plan = makePlan(4);
  const draftRunner = makeRunner([body('甲', 8), body('乙', 8)]);
  const draft = await segmentWriter.draftInSegments({ plan, runSegment: draftRunner });

  const rewriteRunner = makeRunner(['重写这一组：\n\n' + body('乙改', 8, '章末抬出一口箱子。')]);
  const rewritten = await segmentWriter.rewriteMissingGroups({
    plan,
    groups: draft.groups,
    coverage: { covered: [], missing: [], weak: [] },
    invariantConflicts: [
      { beatId: 'B4', label: '寄养年数', expected: '十一年', actual: '十五年' },
    ],
    runSegment: rewriteRunner,
    callCount: draft.callCount,
    maxCalls: 8,
  });

  assert.strictEqual(rewriteRunner.seen.length, 1);
  assert.strictEqual(rewriteRunner.seen[0].group.index, 1);
  assert.match(rewriteRunner.seen[0].instruction, /B4：本拍数值与全章不变项冲突/);
  assert.match(rewriteRunner.seen[0].instruction, /寄养年数应写「十一年」，正文写成了「十五年」/);
  assert.strictEqual(rewritten.groups[0].content, draft.groups[0].content, '未冲突的组不改写');
});

test('续写只补差额，不再按 105% 硬线裁剪正文', async () => {
  const plan = makePlan(4);
  const runner = makeRunner([
    '只写了一句。',
    body('续', 30),
    body('乙', 4),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.match(runner.seen[1].instruction, /再补约 \d+ 字/);
  assert.match(runner.seen[1].instruction, /补到目标就停/);
  assert.match(draft.content, /续第30段/, '续写正文不被代码裁掉，取舍交给写作侧');
});

test('续写指令只带最后一个场景的最后一段，不给整组正文', () => {
  const plan = makePlan(4, 10);
  const groups = segmentWriter.planSegments(plan);
  const group = groups[0];
  const first = '第一段写的是老周在工位边上敲缸子，说名单是上面定的。';
  const middle = '第二段写的是陈默把核对表另存了一份，文件名加了日期。';
  const last = '最后一段写到他伸手去够手机，屏幕朝下扣在桌面上。';
  group.content = `${first}\n\n${middle}\n\n${last}`;

  const instruction = segmentWriter.buildContinuationInstruction({
    plan,
    group,
    groups,
    tail: segmentWriter.continuationAnchor(group.content),
    remainingChars: 300,
  });

  assert.match(instruction, new RegExp(last), '锚点要带最后一段');
  assert.ok(!instruction.includes(first), '不能把第一段带进续写调用');
  assert.ok(!instruction.includes(middle), '不能把中间段带进续写调用');
  assert.match(instruction, /本组其他已写正文不提供/, '要明确只给锚点');
  assert.match(instruction, /不要凭记忆复述/);
  assert.match(instruction, /已经写了 \d+ 字/, '要写清已经写了多少、还差多少');
});

test('续写第一段若是复述已有段落，整段续写直接丢弃', async () => {
  const plan = makePlan(4, 10);
  const initial = '他在前台签完字，把访客牌挂在脖子上，电梯里只有他一个人。';
  const runner = makeRunner([
    `${initial}\n\n他只写了两段。`,
    `${initial.replace('一个人', '一个人影')}\n\n新的续写段落：他推门进去，殿里只有一盏灯，灯芯爆了一下。`,
    body('乙', 30),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(draft.continuationDropped, 1, '复述的续写要整段丢弃并记数');
  assert.ok(!draft.content.includes('新的续写段落'), '丢弃是整段丢弃，不是删掉重复段后保留后半截');
  assert.strictEqual(draft.content.split(initial).length - 1, 1, '原有正文保持一份，不被续写污染');
  assert.strictEqual(draft.continuations, 0);
});

test('场景内无对白的相邻短段可以合并，含对白和跨场景一律不合并', () => {
  const first = '他把车票塞进外套内袋，拉上拉链，又按了按。';
  const second = '站台的风从隧道口灌进来，吹得广告牌边角啪啪响。';
  const dialogue = '「几点的车？」她问。';
  const reaction = '他没答，低头看了一眼表。';
  const nextScene = '第二天清晨，车站里人不多。';

  const merged = segmentWriter.mergeSceneParagraphs([
    first,
    second,
    dialogue,
    reaction,
    nextScene,
  ]);

  assert.strictEqual(merged.length, 4, '只合并了前两段');
  assert.strictEqual(merged[0], `${first}${second}`, '合并是直接接上，不插空行');
  assert.deepStrictEqual(merged.slice(1), [dialogue, reaction, nextScene], '含对白段和跨场景段原样保留');

  const long = ['字'.repeat(70) + '。', '字'.repeat(60) + '。'];
  assert.strictEqual(
    segmentWriter.mergeSceneParagraphs(long).length,
    2,
    '合并后超过 120 字就不合并'
  );

  assert.deepStrictEqual(
    segmentWriter.mergeSceneParagraphs([first, second], { enabled: false }),
    [first, second],
    '开关关闭时一段都不合并'
  );
});

test('起草默认按场景合并段落，同时保留合并前的形态，可关闭', async () => {
  const runOnce = async (mergeScenes) => {
    const plan = makePlan(2, 10);
    const first = '他沿着走廊往东走，路过一间关着门的会议室，又停下来听了听。';
    const second = '走廊尽头是茶水间，水壶还在保温，指示灯亮着。';
    const runner = makeRunner([
      `${first}\n\n${second}\n\n${body('乙', 2)}`,
    ]);
    return segmentWriter.draftInSegments({
      plan,
      runSegment: runner,
      maxCalls: 1,
      mergeScenes,
    });
  };

  const merged = await runOnce(true);
  assert.strictEqual(merged.mergeScenes, true);
  assert.strictEqual(merged.mergedParagraphs, 1, '前两段短且无对白，合并成一段');
  assert.strictEqual(segmentWriter.splitParagraphs(merged.contentBeforeMerge).length, 4);
  assert.strictEqual(segmentWriter.splitParagraphs(merged.content).length, 3);

  const raw = await runOnce(false);
  assert.strictEqual(raw.mergeScenes, false);
  assert.strictEqual(raw.mergedParagraphs, 0);
  assert.strictEqual(raw.content, raw.contentBeforeMerge, '关闭后交付的就是未合并正文');
});

test('全章超过 7000 字安全上限时截到最后一个完整段并标记', async () => {
  const plan = makePlan(8);
  const runner = makeRunner([body('甲', 60), body('乙', 60), body('丙', 60)]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.strictEqual(draft.truncated, true);
  assert.ok(draft.originalChars > segmentWriter.MAX_CHAPTER_CHARS);
  assert.ok(draft.chars <= segmentWriter.MAX_CHAPTER_CHARS);
  const last = segmentWriter.splitParagraphs(draft.content).pop();
  assert.match(last, /[。！？]$/, '截断必须落在完整段，不能切半句');
});

// ---------------------------------------------------------------------------
// P3 段落形态自检：段数、段长、连续短段、对白独立成段、引号
// ---------------------------------------------------------------------------

function shapeRows(count = 12, mutate = () => {}) {
  const longSentence =
    '风雪压着庙檐，他把手按在门环上，指腹能摸到一层薄冰，门里有人轻轻咳了一声。';
  const rows = Array.from({ length: count }, (_, i) => `第${i + 1}段：${longSentence}${longSentence}${longSentence}`);
  mutate(rows);
  return rows.join('\n\n');
}

test('段落形态：合格正文（每拍 3 段、段长 80–140）不报违规', () => {
  const plan = makePlan(4, 3);
  const result = segmentWriter.checkParagraphShape(plan, shapeRows(12));

  assert.strictEqual(result.applicable, true);
  assert.strictEqual(result.totalParagraphs, 12);
  assert.deepStrictEqual(result.violations, []);
  assert.ok(result.avgChars >= 80 && result.avgChars <= 140);
});

test('段落形态：连续 3 段不足 20 字判违规，两段带前后动作是例外', () => {
  const plan = makePlan(4, 3);

  const threeShort = shapeRows(12, (rows) => {
    rows[3] = '他停住。';
    rows[4] = '他没动。';
    rows[5] = '风停了。';
  });
  const bad = segmentWriter.checkParagraphShape(plan, threeShort);
  assert.ok(bad.violations.some((row) => row.kind === 'short_run'), '连续短段必须被抓到');

  const twoTalk = shapeRows(12, (rows) => {
    rows[3] = '“走吧。”';
    rows[4] = '“这就走。”';
  });
  const ok = segmentWriter.checkParagraphShape(plan, twoTalk);
  assert.ok(!ok.violations.some((row) => row.kind === 'dialogue_stack'), '两句以内且前后有动作句应放行');
});

test('段落形态：20–79 字碎片段、超过 140 字长段、连续独立对白、直角引号都要报', () => {
  const plan = makePlan(4, 3);

  const fragment = segmentWriter.checkParagraphShape(
    plan,
    shapeRows(12, (rows) => {
      rows[2] = '他把门环按下去，门里有人应了一声，随后脚步声往后退。';
    })
  );
  assert.ok(fragment.violations.some((row) => row.kind === 'fragment'));

  const tooLong = segmentWriter.checkParagraphShape(
    plan,
    shapeRows(12, (rows) => {
      rows[1] = `${rows[1]}${rows[1]}`;
    })
  );
  assert.ok(tooLong.violations.some((row) => row.kind === 'too_long'));

  const talks = segmentWriter.checkParagraphShape(
    plan,
    shapeRows(12, (rows) => {
      rows[4] = '“走吧。”';
      rows[5] = '“这就走。”';
      rows[6] = '“不等了。”';
    })
  );
  assert.ok(talks.violations.some((row) => row.kind === 'dialogue_stack'), '连续 3 段独立对白必须被抓到');

  const quotes = segmentWriter.checkParagraphShape(
    plan,
    shapeRows(12, (rows) => {
      rows[7] = '他说「走吧」，把门推开了。';
    })
  );
  assert.ok(quotes.violations.some((row) => row.kind === 'corner_quote'));
});

test('段落形态：每拍段数超过计划 ±2 也要报，并定位到拍', () => {
  const plan = makePlan(2, 3);
  const result = segmentWriter.checkParagraphShape(plan, shapeRows(12));

  const counts = result.violations.filter((row) => row.kind === 'count');
  assert.strictEqual(counts.length, 2, '两拍各写了 6 段，计划 3 段，都超 ±2');
  assert.deepStrictEqual(counts.map((row) => row.beatId).sort(), ['B1', 'B2']);
});

test('段落形态违规只重写违规拍所在组，指令给出段数与合并要求', async () => {
  const plan = makePlan(4);
  const draftRunner = makeRunner([body('甲', 8), body('乙', 8)]);
  const draft = await segmentWriter.draftInSegments({ plan, runSegment: draftRunner });

  const beforeGroup = draft.groups[0].content;
  const rewriteRunner = makeRunner(['重写这一组：\n\n' + body('乙改', 8, '章末抬出一口箱子。')]);

  const rewritten = await segmentWriter.rewriteMissingGroups({
    plan,
    groups: draft.groups,
    coverage: { covered: [], missing: [], weak: [] },
    shapeViolations: [
      { beatId: 'B4', kind: 'count', expected: 3, actual: 9, tolerance: 2 },
      { beatId: 'B4', kind: 'fragment', chars: 40, sample: '他把门环按下去。' },
    ],
    runSegment: rewriteRunner,
    callCount: draft.callCount,
    maxCalls: 8,
  });

  assert.strictEqual(rewriteRunner.seen.length, 1, '只重写违规拍所在组');
  assert.strictEqual(rewriteRunner.seen[0].group.index, 1);
  assert.match(rewriteRunner.seen[0].instruction, /B4：.*段落形态不合规/);
  assert.match(rewriteRunner.seen[0].instruction, /实际 9 段，目标是 3±2 段/);
  assert.match(rewriteRunner.seen[0].instruction, /每段 80–140 字（含标点）/);
  assert.match(rewriteRunner.seen[0].instruction, /重写后本拍段数必须落在 \d+–\d+ 段/);
  assert.match(rewriteRunner.seen[0].instruction, /不许把「太长」翻成「太少」/);
  assert.strictEqual(rewritten.groups[0].content, beforeGroup, '违规拍之外的组不能被改写');
});
