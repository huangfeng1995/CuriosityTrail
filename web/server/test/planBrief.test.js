'use strict';

/**
 * 分场 brief 测试。
 *
 * 盯住四件事：
 *   1. 粗提纲也要能推出「交弓 / 托付 / 长辈到场」这类具体动作；
 *   2. 追溯不到输入的条目不能进 brief，inferred 项不能当硬约束；
 *   3. 节拍表覆盖校验能报出 loss/mustPresent/mustWithhold 的缺项；
 *   4. brief 为空/失败时回落旧行为，不改变原链路。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  validatePlanBrief,
  formatPlanBrief,
  briefCoverage,
  briefWriterBlock,
  partitionCoverage,
  buildReplanInstruction,
  generatePlanBrief,
} = require('../services/agent/planBrief');
const { validateBeatPlan } = require('../services/agent/beatPlan');

/** 一段故意写得很粗的提纲：只有「父亲来接他，全家告别」。 */
const ROUGH_OUTLINE = '父亲来接他，全家告别。';

function roughBrief() {
  return {
    items: [
      {
        kind: 'loss',
        text: '交出犀角弓',
        keywords: ['犀角弓', '交出'],
        source: '设定',
        inferred: false,
      },
      {
        kind: 'mustPresent',
        text: '司马防到场并当面托付',
        keywords: ['司马防', '托付'],
        source: '人物卡',
        inferred: false,
      },
      {
        kind: 'mustWithhold',
        text: '不得解释司马防为何要保他',
        keywords: ['司马防', '为何', '保他'],
        source: '设定',
        inferred: false,
      },
      {
        kind: 'mustReveal',
        text: '杨平年龄、籍贯与寄养在司马家的原因',
        keywords: ['年龄', '籍贯', '寄养'],
        source: '素材',
        inferred: false,
      },
      {
        kind: 'evidence',
        text: '符传形制异常',
        keywords: ['符传', '形制'],
        source: '素材',
        inferred: false,
      },
      {
        kind: 'mustPresent',
        text: '司马朗随行',
        keywords: ['司马朗'],
        inferred: true,
      },
      {
        kind: 'loss',
        text: '把家传玉佩送出去',
        keywords: ['玉佩'],
      },
    ],
  };
}

/** 只有 B4 的 cost 命中了「犀角弓」的节拍表。 */
function planCoveringOnlyLoss() {
  return validateBeatPlan({
    chapterGoal: '杨平在司马府完成告别并离城',
    protagonistIntent: '跟父亲走',
    obstacle: '司马防不肯放人',
    cost: '交出犀角弓',
    hook: '马车驶向许都',
    avoidRepeat: [],
    mainType: '决定',
    beats: [
      {
        id: 'B1',
        type: '行动',
        goal: '司马防在堂上接见杨平',
        obstacle: '门禁森严，符传核验迟迟不放行',
        cost: '在门外等了一个时辰',
        delta: { variable: '处境', from: '被挡在府门外', to: '得以入内见人' },
        infoGain: '守门人反复核对符传上的形制',
        paragraphs: 10,
        endHook: '堂内传来司马防的咳嗽声',
      },
      {
        id: 'B2',
        type: '冲突',
        goal: '说清来意',
        obstacle: '司马防不愿正面回应',
        cost: '话说得越来越重',
        delta: { variable: '关系', from: '客气寒暄', to: '当面顶撞' },
        infoGain: '司马防提到了杨平的寄养旧事',
        paragraphs: 10,
        endHook: '司马防忽然沉默',
      },
      {
        id: 'B3',
        type: '转折',
        goal: '听完司马防的安排',
        obstacle: '外头催行的车马已到',
        cost: '没来得及追问',
        delta: { variable: '信息', from: '以为只是暂住', to: '知道此去不再回来' },
        infoGain: '随行的箱笼只有一只旧弓',
        paragraphs: 10,
        endHook: '管家把一只长匣放到案上',
      },
      {
        id: 'B4',
        type: '决定',
        goal: '接过长匣并辞行',
        obstacle: '司马防坚持要他亲手拿走',
        cost: '把父亲给的犀角弓交出去，换回一只旧弓',
        delta: { variable: '决心', from: '想留下', to: '决定离城' },
        infoGain: '犀角弓的弓弭上刻着司马氏的族记',
        paragraphs: 10,
        endHook: '车队在城门外停下',
      },
    ],
  }).plan;
}

test('粗提纲 → brief：能推出交弓/托付/长辈到场，追溯不到的条目被丢弃', () => {
  const out = validatePlanBrief(roughBrief());

  assert.strictEqual(out.ok, true);
  const items = out.brief.items;
  assert.ok(
    items.some((x) => x.kind === 'loss' && x.text.includes('犀角弓')),
    '粗提纲必须能推出「交出犀角弓」'
  );
    assert.ok(
    items.some((x) => x.kind === 'mustPresent' && x.text.includes('司马防')),
    '长辈/托付人必须到场'
  );
  assert.ok(
    items.some((x) => x.kind === 'mustWithhold' && x.text.includes('不得解释')),
    '必须 withhold 的信息要进 brief'
  );
  assert.ok(
    !items.some((x) => x.text.includes('玉佩')),
    '没有来源且未标 inferred 的条目不能进 brief'
  );
  assert.ok(
    out.brief.dropped.some((x) => x.includes('玉佩') && x.includes('来源')),
    '丢弃原因要能定位到不可追溯的条目'
  );

  const inferred = items.find((x) => x.text.includes('司马朗'));
  assert.strictEqual(inferred.inferred, true);
  assert.strictEqual(inferred.source, 'inferred');
});

test('brief 覆盖校验：loss 已覆盖，mustPresent/mustWithhold 被报缺', () => {
  const brief = validatePlanBrief(roughBrief()).brief;
  const plan = planCoveringOnlyLoss();
  const coverage = briefCoverage(brief, plan);

  assert.strictEqual(coverage.hardTotal, 3, '硬约束只有 loss/mustPresent/mustWithhold 三类');
  assert.ok(coverage.covered.includes('L1'), 'B4 的 cost 已写「犀角弓」，loss 应算覆盖');
  assert.ok(
    coverage.missing.some((x) => x.kind === 'mustPresent' && x.text.includes('司马防')),
    '司马防没有落到任何一拍，必须报缺'
  );
  assert.ok(
    coverage.missing.some((x) => x.kind === 'mustWithhold'),
    'mustWithhold 没有落到任何一拍，必须报缺'
  );

  // 唯一的 inferred 项（司马朗随行）不参与硬覆盖：没有覆盖也不算缺。
  assert.ok(!coverage.missing.some((x) => x.text.includes('司马朗')));
});

test('brief 写手块：具体到物/到人，inferred 只进建议行', () => {
  const brief = validatePlanBrief(roughBrief()).brief;
  const block = briefWriterBlock(brief);

  assert.match(block, /本章不可逆损失\/交出物：交出犀角弓/);
  assert.match(block, /必须到场：司马防到场并当面托付/);
  assert.match(block, /不得解释（必须 withhold）：不得解释司马防为何要保他/);
  assert.match(block, /必须交代（每项至少一句）：杨平年龄、籍贯与寄养在司马家的原因/);

  const hardPart = block.split('- 建议')[0];
  assert.ok(!hardPart.includes('司马朗'), 'inferred 项不能出现在硬约束部分');
  assert.match(block, /- 建议（inferred，可不用.*）：司马朗随行/);
});

test('重排指令：缺项带可落点，且禁止新增输入里没有的人物', () => {
  const brief = validatePlanBrief(roughBrief()).brief;
  const plan = planCoveringOnlyLoss();
  const coverage = briefCoverage(brief, plan);
  const partitioned = partitionCoverage(plan, coverage);

  assert.ok(partitioned.length >= 2);
  assert.ok(partitioned.every((x) => x.targetBeats.length > 0 || x.hint.includes('新增一拍')));

  const instruction = buildReplanInstruction(partitioned);
  assert.match(instruction, /没有覆盖分场 brief/);
  assert.match(instruction, /司马防/);
  assert.match(instruction, /不得解释/);
  assert.match(instruction, /不要为了覆盖新增输入里没有的人物或事件/);
});

test('回落：brief 为空时格式化与覆盖校验都是空操作', () => {
  assert.strictEqual(formatPlanBrief(null), '');
  assert.strictEqual(formatPlanBrief({ items: [] }), '');
  assert.strictEqual(briefWriterBlock(null), '');

  const coverage = briefCoverage(null, planCoveringOnlyLoss());
  assert.deepStrictEqual(coverage.covered, []);
  assert.deepStrictEqual(coverage.missing, []);
  assert.strictEqual(coverage.hardTotal, 0);

  assert.strictEqual(buildReplanInstruction([]), '');
});

test('生成：粗提纲走 provider 能拿到 brief，且 system 带 brief 提示词', async () => {
  const calls = [];
  const provider = {
    async chat(options) {
      calls.push(options);
      return { content: JSON.stringify(roughBrief()), finishReason: 'stop' };
    },
  };

  const out = await generatePlanBrief({
    provider,
    systemPrompt: '人物卡：司马防；设定：犀角弓',
    instruction: ROUGH_OUTLINE,
  });

  assert.ok(out.brief);
  assert.strictEqual(out.brief.items.filter((x) => !x.inferred).length, 5);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].jsonOutput, true);
  assert.match(String(calls[0].messages[0].content), /章节分场 brief 规划器/);
  assert.match(String(calls[0].messages[1].content), /父亲来接他/);
});

test('回落：brief 生成失败返回 null，不抛给路由', async () => {
  const invalid = {
    async chat() {
      return { content: '不是 JSON', finishReason: 'stop' };
    },
  };
  const out = await generatePlanBrief({
    provider: invalid,
    systemPrompt: '上下文',
    instruction: ROUGH_OUTLINE,
  });
  assert.strictEqual(out.brief, null);
  assert.strictEqual(out.reason, 'invalid');
  assert.strictEqual(formatPlanBrief(out.brief), '');

  const broken = {
    async chat() {
      throw new Error('上游挂了');
    },
  };
  const out2 = await generatePlanBrief({
    provider: broken,
    systemPrompt: '上下文',
    instruction: ROUGH_OUTLINE,
  });
  assert.strictEqual(out2.brief, null);
  assert.strictEqual(out2.reason, 'error');
});
