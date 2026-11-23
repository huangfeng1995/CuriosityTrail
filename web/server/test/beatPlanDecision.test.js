'use strict';

/**
 * HP12：关键抉择拍（critical + options）的校验与修复。
 *
 * 暂停点能不能停下来，完全取决于这份拍表是否合规：
 *   - 只有「决定」拍可以设 critical；
 *   - 必须给 2–3 个选项，每项带 label 与 consequence；
 *   - 一章只允许一个暂停点；
 *   - 修复时保留第一拍，其余就地降级，不丢事件链；
 *   - 交给写手的拍表不带选项（否则模型会自己挑一个）。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  DECISION_TYPE,
  validateBeatPlan,
  salvageBeatPlan,
  formatBeatPlan,
} = require('../services/agent/beatPlan');

const OPTIONS = [
  { id: 'o1', label: '交出密诏', consequence: '保住性命，但密诏落入对方手里' },
  { id: 'o2', label: '烧掉密诏', consequence: '线索断了，对方也拿不到证据' },
  { id: 'o3', label: '带着密诏出逃', consequence: '成为通缉犯，但保留翻案的凭据' },
];

function makeBeat(index, type, extra = {}) {
  return {
    id: `B${index + 1}`,
    function: '试探',
    type,
    goal: `第${index + 1}拍的目标`,
    obstacle: `第${index + 1}拍的阻碍`,
    turn: `第${index + 1}拍的转折`,
    cost: `第${index + 1}拍的代价`,
    delta: { variable: '信息', from: '未知', to: '半知' },
    infoGain: '这一拍拿到了新的线索信息',
    paragraphs: 6,
    endHook: `第${index + 1}拍留下一个未决动作`,
    entities: [],
    ...extra,
  };
}

function makePlan(types = ['行动', '决定', '揭示', '过渡']) {
  return {
    chapterGoal: '主角在府中决定密诏的去向',
    protagonistIntent: '拿到密诏并决定怎么处理',
    obstacle: '府中耳目众多',
    cost: '暴露自己也在找密诏',
    hook: '门外忽然传来脚步声',
    avoidRepeat: [],
    mainType: '决定',
    beats: types.map((type, index) => makeBeat(index, type)),
  };
}

test('决定 + critical + 3 选项：通过并保留 critical/options', () => {
  const plan = makePlan();
  plan.beats[1].critical = true;
  plan.beats[1].options = OPTIONS;

  const result = validateBeatPlan(plan, { mode: 'outline' });
  assert.strictEqual(result.ok, true, result.errors.join('；'));
  assert.strictEqual(result.plan.beats[1].critical, true);
  assert.deepStrictEqual(result.plan.beats[1].options, OPTIONS);
  assert.strictEqual(result.plan.beats[0].critical, false);
  assert.deepStrictEqual(result.plan.beats[0].options, []);
});

test('critical 选项不足 2 个：整份不通过', () => {
  const plan = makePlan();
  plan.beats[1].critical = true;
  plan.beats[1].options = [OPTIONS[0]];

  const result = validateBeatPlan(plan, { mode: 'outline' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('2–3 个')));
});

test('选项缺 consequence：视为无效，按选项不足处理', () => {
  const plan = makePlan();
  plan.beats[1].critical = true;
  plan.beats[1].options = [OPTIONS[0], { id: 'o2', label: '烧掉密诏' }];

  const result = validateBeatPlan(plan, { mode: 'outline' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('2–3 个')));
});

test('非决定拍设 critical：不通过', () => {
  const plan = makePlan();
  plan.beats[0].critical = true;
  plan.beats[0].options = OPTIONS;

  const result = validateBeatPlan(plan, { mode: 'outline' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('只有 type=决定')));
});

test('两拍都 critical：不通过（一次只能停在一个抉择上）', () => {
  const plan = makePlan();
  plan.beats[1].critical = true;
  plan.beats[1].options = OPTIONS;
  plan.beats[2].type = DECISION_TYPE;
  plan.beats[2].critical = true;
  plan.beats[2].options = OPTIONS;
  plan.mainType = DECISION_TYPE;

  const result = validateBeatPlan(plan, { mode: 'outline' });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('至多 1 拍 critical')));
});

test('salvage：保留第一拍 critical，第二拍降级，其余选项清空', () => {
  const plan = makePlan(['行动', '决定', '决定', '过渡']);
  plan.mainType = '决定';
  plan.beats[1].critical = true;
  plan.beats[1].options = OPTIONS;
  plan.beats[2].critical = true;
  plan.beats[2].options = OPTIONS;
  plan.beats[0].options = OPTIONS; // 非 critical 拍带 options 也要清掉

  const salvaged = salvageBeatPlan(plan, { mode: 'outline' });
  assert.ok(salvaged, '修复必须给出可用拍表');
  assert.strictEqual(salvaged.beats[1].critical, true);
  assert.deepStrictEqual(salvaged.beats[1].options, OPTIONS);
  assert.strictEqual(salvaged.beats[2].critical, false);
  assert.deepStrictEqual(salvaged.beats[2].options, []);
  assert.deepStrictEqual(salvaged.beats[0].options, []);
});

test('formatBeatPlan：给写手的拍表不带选项', () => {
  const plan = makePlan();
  plan.beats[1].critical = true;
  plan.beats[1].options = OPTIONS;

  const block = formatBeatPlan(plan);
  assert.ok(block.includes('## 本章节拍表'));
  assert.ok(block.includes('"critical":true'));
  assert.ok(!block.includes(OPTIONS[0].label), '选项只给作者看，不进写手提示');
});
