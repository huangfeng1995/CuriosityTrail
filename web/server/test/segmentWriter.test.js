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
  const rewrite = segmentWriter.buildGroupRewriteInstruction({
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
    assert.match(instruction, /段落长度随叙事节奏自然变化/);
    assert.match(instruction, /不要每段都写成同一个长度/, '不能给段落锚点，否则模型会一路往上限靠');
    assert.match(instruction, /关键交流必须写成直接引语/, '关键对话必须用人物原话');
    assert.match(instruction, /不要用「他说他问我是否……」这类转述代替关键对话/);
    assert.match(instruction, /每次对话都要推动一次变化/);
    assert.match(instruction, /每一拍都要有变量变化、信息增量和代价/);
    assert.match(instruction, /交稿前自检/);
    assert.match(instruction, /含标点/, '字数口径必须写明含标点');

    assert.doesNotMatch(instruction, /14%–22%/, '对白占比已降级为诊断指标，不能再当门槛');
    assert.doesNotMatch(instruction, /不少于 25 字/, '段落下限已降级为诊断指标');
    assert.doesNotMatch(instruction, /段均以/, '不能给段落均长锚点');
    assert.doesNotMatch(instruction, /目标的 105%/, '续写不再设 105% 硬线');
  }
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

test('续写只补差额，不再按 105% 硬线裁剪正文', async () => {
  const plan = makePlan(4);
  const runner = makeRunner([
    '只写了一句。',
    body('续', 30),
    body('乙', 4),
  ]);

  const draft = await segmentWriter.draftInSegments({ plan, runSegment: runner });

  assert.match(runner.seen[1].instruction, /写到本组目标/);
  assert.match(runner.seen[1].instruction, /就停/);
  assert.match(draft.content, /续第30段/, '续写正文不被代码裁掉，取舍交给写作侧');
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
