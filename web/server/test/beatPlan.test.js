'use strict';

/**
 * 节拍规划与覆盖自检测试。
 *
 * 盯住四件事：
 *   1. 节拍表 JSON 结构不合格时必须拒绝，不能把缺代价/缺钩子的表交给写手；
 *   2. 自检报告的 missing 必须以节拍表为准重算，不能照抄模型自相矛盾的列表；
 *   3. 缺拍重写指令要逐条列出缺失拍的关键要素；
 *   4. 规划/自检失败一律返回 null，让路由能降级直写，不把整轮拖挂。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  validateBeatPlan,
  validateCoverage,
  formatBeatPlan,
  buildRewriteInstruction,
  beatBadge,
  generateBeatPlan,
  checkBeatCoverage,
} = require('../services/agent/beatPlan');

/**
 * 一份合格的四拍节拍表。段落合计 40（全章配额下限，对齐 5000 字长章）。
 */
function makePlan(overrides = {}) {
  return {
    chapterGoal: '主角查清旧案的第一条线索',
    protagonistIntent: '进庙查案',
    obstacle: '庙祝拦门',
    cost: '交出随身信物',
    hook: '照片背面写着主角的名字',
    avoidRepeat: [],
    mainType: '揭示',
    beats: [
      {
        id: 'B1',
        type: '行动',
        goal: '进入城隍庙',
        obstacle: '庙祝拦着不让进',
        cost: '把唯一的信物押在门口',
        delta: { variable: '处境', from: '被挡在庙外', to: '得以进入内殿' },
        infoGain: '庙里供着的不是城隍像，而是一张旧照片',
        paragraphs: 10,
        endHook: '照片上的人穿着现任知县的官服',
      },
      {
        id: 'B2',
        type: '冲突',
        goal: '问出照片来历',
        obstacle: '庙祝闪烁其词',
        cost: '激怒庙祝，被赶出去',
        delta: { variable: '关系', from: '互相试探', to: '彻底翻脸' },
        infoGain: '旧案发生在二十年前，当时知县尚未到任',
        paragraphs: 10,
        endHook: '庙祝说漏了「那年冬天」四个字',
      },
      {
        id: 'B3',
        type: '转折',
        goal: '从旧档里找出那年冬天的记录',
        obstacle: '档案被抽走了关键几页',
        cost: '惊动了管档的主簿',
        delta: { variable: '信息', from: '以为只是一桩旧案', to: '发现有人一直在抹掉它' },
        infoGain: '缺失的几页正好是案发前后三个月',
        paragraphs: 10,
        endHook: '主簿当夜就请了病假',
      },
      {
        id: 'B4',
        type: '揭示',
        goal: '确认照片上的人是谁',
        obstacle: '照片已被人提前取走',
        cost: '失去当面指认的机会',
        delta: { variable: '决心', from: '只想查清线索', to: '决定把这桩旧案翻到底' },
        infoGain: '取走照片的人留下了与知县相同的印泥',
        paragraphs: 10,
        endHook: '县衙后门当晚抬出一口箱子',
      },
    ],
    ...overrides,
  };
}

test('合格节拍表通过校验并归一化', () => {
  const result = validateBeatPlan(makePlan());

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(result.plan.beats.length, 4);
  assert.strictEqual(result.plan.totalParagraphs, 40);
  assert.deepStrictEqual(result.plan.beats[0].delta, {
    variable: '处境',
    from: '被挡在庙外',
    to: '得以进入内殿',
  });
});

test('节拍数越界、缺字段、缺 endHook、段数越界都会被拒绝', () => {
  const cases = [
    ['拍数太少', makePlan({ beats: makePlan().beats.slice(0, 3) }), /节拍数必须在 4–8/],
    [
      '缺 endHook',
      makePlan({
        beats: makePlan().beats.map((b, i) => (i === 0 ? { ...b, endHook: '' } : b)),
      }),
      /endHook 不能为空/,
    ],
    [
      '全章段数太少',
      makePlan({ beats: makePlan().beats.map((b) => ({ ...b, paragraphs: 1 })) }),
      /全章段落数必须在 40–55/,
    ],
    [
      '单拍段落少于 3',
      makePlan({
        beats: makePlan().beats.map((b, i) => (i === 0 ? { ...b, paragraphs: 2 } : b)),
      }),
      /paragraphs 必须是 3–10/,
    ],
    [
      '单拍段落多于 10',
      makePlan({
        beats: makePlan().beats.map((b, i) => (i === 0 ? { ...b, paragraphs: 11 } : b)),
      }),
      /paragraphs 必须是 3–10/,
    ],
    [
      '全章段数太多',
      makePlan({
        beats: [...makePlan().beats, ...makePlan().beats.slice(0, 2)].map((b, i) => ({
          ...b,
          id: `B${i + 1}`,
          paragraphs: 10,
        })),
      }),
      /全章段落数必须在 40–55/,
    ],
    [
      'infoGain 太短',
      makePlan({ beats: makePlan().beats.map((b, i) => (i === 0 ? { ...b, infoGain: '很短' } : b)) }),
      /infoGain 至少 8 个字/,
    ],
    [
      'delta 前后相同',
      makePlan({
        beats: makePlan().beats.map((b, i) =>
          i === 0 ? { ...b, delta: { ...b.delta, to: b.delta.from } } : b
        ),
      }),
      /delta.from 与 to 不能相同/,
    ],
    [
      'mainType 不在节拍里',
      makePlan({ mainType: '过渡' }),
      /mainType 必须与某一个节拍的 type 相同/,
    ],
    ['空钩子', makePlan({ hook: '欲知后事如何，且听下回分解' }), /空钩/],
  ];

  for (const [name, candidate, pattern] of cases) {
    const result = validateBeatPlan(candidate);
    assert.strictEqual(result.ok, false, `${name} 应当被拒绝`);
    assert.match(result.errors.join('；'), pattern, `${name} 的错误信息应能定位原因`);
  }
});

test('非 JSON / 非对象输入直接拒绝', () => {
  for (const input of ['这不是 JSON', '[]', null, 42]) {
    const result = validateBeatPlan(input);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  }
});

test('自检：模型漏报的拍要按节拍表补回 missing，并保留 30 字以内的证据', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = validateCoverage(
    {
      covered: [
        { id: 'B1', evidence: '林砚在门槛外站了一会儿，才伸手推门' },
        { id: 'B2', evidence: '老周不答，只说香案后头还有一箱旧档' },
      ],
      missing: ['B4'],
      weak: [],
      hookPresent: true,
      chapterGoalMet: false,
    },
    plan
  );

  assert.ok(coverage, '合法自检结果应当返回报告');
  assert.deepStrictEqual(coverage.covered, ['B1', 'B2']);
  assert.deepStrictEqual(coverage.missing, ['B3', 'B4'], 'B3 没被提到，必须按节拍表判为缺失');
  assert.deepStrictEqual(coverage.evidence, [
    { id: 'B1', evidence: '林砚在门槛外站了一会儿，才伸手推门' },
    { id: 'B2', evidence: '老周不答，只说香案后头还有一箱旧档' },
  ]);
  assert.strictEqual(coverage.hookPresent, true);
  assert.strictEqual(coverage.chapterGoalMet, false);
});

test('自检：没有证据的 covered 不算覆盖，证据超长会被截到 30 字', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = validateCoverage(
    {
      covered: [
        { id: 'B1', evidence: '' },
        { id: 'B2', evidence: '这是一段明显超过三十个字的证据'.repeat(3) },
        'B3',
      ],
      missing: [],
      weak: [],
    },
    plan
  );

  assert.ok(coverage);
  assert.deepStrictEqual(coverage.covered, ['B2']);
  assert.deepStrictEqual(coverage.missing, ['B1', 'B3', 'B4'], '没证据的拍要落回 missing');
  assert.strictEqual(Array.from(coverage.evidence[0].evidence).length, 30, '证据必须截到 30 字');
});

test('自检：covered 与 missing 自相矛盾时以 covered 为准', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = validateCoverage(
    {
      covered: [
        { id: 'B1', evidence: 'B1 的正文原句' },
        { id: 'B2', evidence: 'B2 的正文原句' },
        { id: 'B3', evidence: 'B3 的正文原句' },
        { id: 'B4', evidence: 'B4 的正文原句' },
      ],
      missing: ['B2'],
      weak: [],
    },
    plan
  );

  assert.deepStrictEqual(coverage.missing, [], '已判 covered 的拍不能同时算缺失');
});

test('自检：weak 的拍既不算覆盖也不算缺失', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = validateCoverage(
    {
      covered: [
        { id: 'B1', evidence: 'B1 的正文原句' },
        { id: 'B2', evidence: 'B2 的正文原句' },
      ],
      missing: [],
      weak: [{ id: 'B3', reason: '只有事件，没有写出信息变化' }],
    },
    plan
  );

  assert.deepStrictEqual(coverage.covered, ['B1', 'B2']);
  assert.deepStrictEqual(coverage.missing, ['B4']);
  assert.deepStrictEqual(coverage.weak, [{ id: 'B3', reason: '只有事件，没有写出信息变化' }]);
});

test('自检：编造的 id 与坏输入一律忽略', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = validateCoverage(
    {
      covered: [
        { id: 'B1', evidence: 'B1 的正文原句' },
        { id: 'B9', evidence: '不存在的拍' },
      ],
      weak: [{ id: 'B9' }],
    },
    plan
  );
  assert.ok(coverage);
  assert.ok(!coverage.covered.includes('B9'), '不存在的 id 不能混进报告');
  assert.ok(!coverage.missing.includes('B9'));

  assert.strictEqual(validateCoverage('不是 JSON', plan), null);
  assert.strictEqual(validateCoverage({ covered: [] }, null), null);
});

test('重写指令逐条列出缺失拍的要素，并要求重写全文', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const coverage = {
    covered: ['B1', 'B2', 'B3'],
    missing: ['B4'],
    weak: [],
    hookPresent: false,
    chapterGoalMet: true,
  };

  const instruction = buildRewriteInstruction(plan, coverage);

  assert.match(instruction, /缺失：B4/);
  assert.match(instruction, /B4/);
  assert.match(instruction, /确认照片上的人是谁/, '要说明缺拍的目标');
  assert.match(instruction, /照片已被人提前取走/, '要说明缺拍的阻碍');
  assert.match(instruction, /只想查清线索/, '要说明变量起点');
  assert.match(instruction, /把这桩旧案翻到底/, '要说明变量终点');
  assert.match(instruction, /重写全文/, '要求整篇重写，不让模型局部拼接');
});

test('formatBeatPlan 输出硬约束标题与节拍表 JSON', () => {
  const plan = validateBeatPlan(makePlan()).plan;
  const block = formatBeatPlan(plan);

  assert.match(block, /## 本章节拍表（硬约束，必须覆盖）/);
  assert.match(block, /正文里不要写节拍编号/);
  assert.ok(block.includes('"chapterGoal"'), '节拍表要以 JSON 形式交给写手');
  assert.ok(block.includes('"B4"'));
  assert.strictEqual(formatBeatPlan(null), '');
});

test('编排徽标只在真正有问题时出现', () => {
  assert.strictEqual(beatBadge({ coverage: null, checkError: 'timeout' }), '【编排自检：未自检】');
  assert.strictEqual(beatBadge({ coverage: null, truncated: true }), '【编排自检：未自检（截断）】');
  assert.strictEqual(
    beatBadge({ coverage: null, checkError: 'time_budget' }),
    '【编排自检：未自检（时间不足）】'
  );
  assert.strictEqual(
    beatBadge({ coverage: null, checkError: 'recheck' }),
    '【编排自检：已重写，复核未完成】',
    '复核失败时不能拿重写前的旧报告冒充当前结论'
  );
  assert.strictEqual(
    beatBadge({ coverage: { missing: [] }, rewrote: true }),
    '',
    '覆盖齐全时不打扰作者'
  );
  assert.strictEqual(
    beatBadge({ coverage: { missing: ['B4'] } }),
    '【编排自检：缺 B4】'
  );
  assert.strictEqual(
    beatBadge({ coverage: { missing: ['B4'] }, rewrote: true }),
    '【编排自检：重写后仍缺 B4】'
  );
  assert.strictEqual(
    beatBadge({ coverage: { missing: ['B4'] }, rewriteFailed: true }),
    '【编排自检：重写失败，保留第一版；缺 B4】'
  );
});

// ---------------------------------------------------------------------------
// provider 调用：失败必须降级为 null，不能抛给路由
// ---------------------------------------------------------------------------

test('规划：第一次不合格时带错误清单重试，第二次合格即返回', async () => {
  const queue = [
    { content: '{"beats":[]}' },
    { content: JSON.stringify(makePlan()) },
  ];
  const calls = [];
  const provider = {
    async chat(options) {
      calls.push(options);
      const next = queue.shift();
      return { content: next.content, finishReason: 'stop' };
    },
  };

  const out = await generateBeatPlan({
    provider,
    systemPrompt: '写手上下文',
    instruction: '写第一章',
  });

  assert.ok(out.plan, '第二次合格时应当拿到节拍表');
  assert.strictEqual(calls.length, 2, '不合格才重试，且最多两次');
  assert.deepStrictEqual(calls[0].jsonOutput, true);
  assert.strictEqual(calls[0].maxTokens, 2000);
  assert.match(String(calls[0].messages[1].content), /写第一章/);
  assert.match(
    String(calls[1].messages[1].content),
    /不合格/,
    '第二次要把上一次的错误告诉模型'
  );
});

test('规划：两次都不合格时返回 invalid 而不是抛错', async () => {
  const provider = {
    async chat() {
      return { content: '{"beats":[]}', finishReason: 'stop' };
    },
  };

  const out = await generateBeatPlan({
    provider,
    systemPrompt: '上下文',
    instruction: '写第一章',
  });

  assert.strictEqual(out.plan, null);
  assert.strictEqual(out.reason, 'invalid');
  assert.ok(out.errors.length > 0);
});

test('规划：超时/取消返回 timeout，上游报错返回 error', async () => {
  const timeoutProvider = {
    async chat() {
      const err = new Error('超时');
      err.code = 'AI_TIMEOUT';
      throw err;
    },
  };
  const out = await generateBeatPlan({
    provider: timeoutProvider,
    systemPrompt: '上下文',
    instruction: '写第一章',
  });
  assert.strictEqual(out.plan, null);
  assert.strictEqual(out.reason, 'timeout');

  const brokenProvider = {
    async chat() {
      throw new Error('上游挂了');
    },
  };
  const out2 = await generateBeatPlan({
    provider: brokenProvider,
    systemPrompt: '上下文',
    instruction: '写第一章',
  });
  assert.strictEqual(out2.plan, null);
  assert.strictEqual(out2.reason, 'error');
});

test('规划：信号已取消时不再发起请求', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const provider = {
    async chat() {
      called = true;
      return { content: '{}' };
    },
  };

  const out = await generateBeatPlan({
    provider,
    systemPrompt: '上下文',
    instruction: '写第一章',
    options: { signal: controller.signal },
  });

  assert.strictEqual(called, false);
  assert.strictEqual(out.reason, 'timeout');
});

test('自检：超时返回 null 与 timeout，正文留空不发起请求', async () => {
  const plan = validateBeatPlan(makePlan()).plan;

  const timeoutProvider = {
    async chat() {
      const err = new Error('超时');
      err.code = 'AI_TIMEOUT';
      throw err;
    },
  };
  const out = await checkBeatCoverage({
    provider: timeoutProvider,
    plan,
    body: '一段正文',
  });
  assert.strictEqual(out.coverage, null);
  assert.strictEqual(out.reason, 'timeout');

  let called = false;
  const provider = {
    async chat() {
      called = true;
      return { content: '{}' };
    },
  };
  const empty = await checkBeatCoverage({ provider, plan, body: '   ' });
  assert.strictEqual(empty.coverage, null);
  assert.strictEqual(empty.reason, 'no_body');
  assert.strictEqual(called, false);
});
