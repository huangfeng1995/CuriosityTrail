'use strict';

/**
 * HP10：险露 节拍类型与 scale/pressure 配额。
 *
 * 覆盖 P.8.1 / PV12 相邻章断言：
 *   - 每章至多 1 拍 险露；
 *   - 相邻两章不得同为 险露（上一章 mainType 带进校验）；
 *   - 险露 只在模板启用时可用（allowedTypes）；
 *   - 一章 large 与 pressure=动作 各至多 1 拍；
 *   - 两次规划仍非法时丢弃 mainType、保留节拍，不整份作废。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  BEAT_TYPES,
  DANGER_TYPE,
  validateBeatPlan,
  salvageBeatPlan,
  generateBeatPlan,
} = require('../services/agent/beatPlan');

const SIX_TYPES = BEAT_TYPES.filter((type) => type !== DANGER_TYPE);

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
    wordShare: 25,
    endHook: `第${index + 1}拍留下一个未决动作`,
    entities: [],
    ...extra,
  };
}

function makePlan(overrides = {}) {
  const types = overrides.types || ['行动', '冲突', '揭示', '过渡'];
  const beats = types.map((type, index) => makeBeat(index, type, overrides.beatExtra || {}));
  return {
    chapterGoal: '主角在府中试探密诏的下落',
    protagonistIntent: '拿到密诏的位置',
    obstacle: '府中耳目众多',
    cost: '暴露自己也在找密诏',
    hook: '门外忽然传来脚步声',
    avoidRepeat: [],
    mainType: overrides.mainType || '冲突',
    beats,
    ...overrides.plan,
  };
}

test('BEAT_TYPES 扩到七类，险露 单拍可带 scale/pressure', () => {
  assert.ok(BEAT_TYPES.includes(DANGER_TYPE));
  assert.strictEqual(BEAT_TYPES.length, 7);

  const plan = makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' });
  plan.beats[1].scale = 'medium';
  plan.beats[1].pressure = '心理';

  const result = validateBeatPlan(plan, { mode: 'outline', allowedTypes: BEAT_TYPES });
  assert.strictEqual(result.ok, true, result.errors.join('；'));
  assert.strictEqual(result.plan.beats[1].type, '险露');
  assert.strictEqual(result.plan.beats[1].scale, 'medium');
  assert.strictEqual(result.plan.beats[1].pressure, '心理');
  assert.strictEqual(result.plan.beats[0].scale, 'small', '未给 scale 时默认 small');
});

test('每章至多 1 拍 险露', () => {
  const plan = makePlan({ types: ['险露', '险露', '揭示', '过渡'], mainType: '险露' });
  const result = validateBeatPlan(plan, { mode: 'outline', allowedTypes: BEAT_TYPES });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('至多 1 拍 险露')));
});

test('相邻两章不得同为 险露：上一章 mainType 传进校验', () => {
  const plan = makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' });
  const result = validateBeatPlan(plan, {
    mode: 'outline',
    allowedTypes: BEAT_TYPES,
    previousMainType: '险露',
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('相邻两章不得同为 险露')));
});

test('非历史悬疑作品：allowedTypes 不含 险露 时判非法', () => {
  const plan = makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '行动' });
  const result = validateBeatPlan(plan, { mode: 'outline', allowedTypes: SIX_TYPES });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('type 不合法')));
});

test('一章 large 与 pressure=动作 各至多 1 拍', () => {
  const plan = makePlan({
    types: ['行动', '冲突', '揭示', '过渡'],
    beatExtra: { scale: 'large', pressure: '动作' },
  });
  const result = validateBeatPlan(plan, { mode: 'outline', allowedTypes: BEAT_TYPES });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((err) => err.includes('large 不得超过 1 拍')));
  assert.ok(result.errors.some((err) => err.includes('pressure=动作 不得超过 1 拍')));
});

test('修复：相邻章仍非法时丢弃 mainType 但保留节拍', () => {
  const plan = makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' });
  const salvaged = salvageBeatPlan(plan, {
    mode: 'outline',
    allowedTypes: BEAT_TYPES,
    previousMainType: '险露',
  });
  assert.ok(salvaged, '不应整份作废');
  assert.notStrictEqual(salvaged.mainType, '险露', 'mainType 必须换掉');
  assert.ok(salvaged.beats.some((beat) => beat.type === '险露'), '险露 节拍要保留');
  assert.strictEqual(salvaged.beats.length, 4);
});

test('修复：多余 险露/large/动作 就地降级，不丢事件链', () => {
  const plan = makePlan({
    types: ['险露', '险露', '揭示', '过渡'],
    mainType: '险露',
    beatExtra: { scale: 'large', pressure: '动作' },
  });
  const salvaged = salvageBeatPlan(plan, { mode: 'outline', allowedTypes: BEAT_TYPES });
  assert.ok(salvaged);
  assert.strictEqual(salvaged.beats.filter((beat) => beat.type === '险露').length, 1);
  assert.strictEqual(salvaged.beats.filter((beat) => beat.scale === 'large').length, 1);
  assert.strictEqual(salvaged.beats.filter((beat) => beat.pressure === '动作').length, 1);
  assert.strictEqual(salvaged.beats.length, 4);
});

test('修复：非模板作品里的 险露 被降级为普通类型', () => {
  const plan = makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' });
  const salvaged = salvageBeatPlan(plan, { mode: 'outline', allowedTypes: SIX_TYPES });
  assert.ok(salvaged);
  assert.ok(!salvaged.beats.some((beat) => beat.type === '险露'));
  assert.ok(SIX_TYPES.includes(salvaged.mainType));
});

test('规划调用：相邻章冲突时重试一次，第二次合格即采用', async () => {
  const first = JSON.stringify(makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' }));
  const second = JSON.stringify(makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '行动' }));
  const calls = [];
  const provider = {
    async chat(params) {
      calls.push(params);
      return { content: calls.length === 1 ? first : second, finishReason: 'stop' };
    },
  };

  const result = await generateBeatPlan({
    provider,
    systemPrompt: '上下文',
    instruction: '写第二章',
    planMode: 'outline',
    allowedTypes: BEAT_TYPES,
    previousMainType: '险露',
  });

  assert.strictEqual(calls.length, 2, '应只重试一次');
  assert.match(calls[0].messages[0].content, /上一章 mainType=险露/);
  assert.strictEqual(result.plan && result.plan.mainType, '行动');
  assert.ok(result.plan.beats.some((beat) => beat.type === '险露'));
});

test('规划调用：两次都相邻冲突时按修复版交付，mainType 不再 险露', async () => {
  const invalid = JSON.stringify(
    makePlan({ types: ['行动', '险露', '揭示', '过渡'], mainType: '险露' })
  );
  const calls = [];
  const provider = {
    async chat(params) {
      calls.push(params);
      return { content: invalid, finishReason: 'stop' };
    },
  };

  const result = await generateBeatPlan({
    provider,
    systemPrompt: '上下文',
    instruction: '写第二章',
    planMode: 'outline',
    allowedTypes: BEAT_TYPES,
    previousMainType: '险露',
  });

  assert.strictEqual(calls.length, 2);
  assert.ok(result.plan, '修复版不能丢');
  assert.strictEqual(result.reason, 'salvaged');
  assert.notStrictEqual(result.plan.mainType, '险露');
});
