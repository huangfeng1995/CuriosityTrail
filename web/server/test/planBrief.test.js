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
  mergeHandoverIntoBrief,
  placeHandoverInPlan,
  handoverBeatId,
  findHandoverDuplicates,
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

// ---------------------------------------------------------------------------
// 任务六：对手与托付
// ---------------------------------------------------------------------------

/**
 * 四拍小表：B1 开场，B4 是告别拍（goal/cost 可按用例改）。
 *
 * @param {{openingObstacle?: string, openingGoal?: string, farewellGoal?: string,
 *          farewellCost?: string}} [options]
 */
function planWithOpeningAndFarewell(options = {}) {
  const {
    openingObstacle = '门禁森严，符传核验迟迟不放行',
    openingGoal = '把杨平带到堂上',
    farewellGoal = '接过长匣并辞行',
    farewellCost = '把父亲给的犀角弓交出去',
    farewellObstacle = '管家坚持要他亲手拿走',
  } = options;

  return validateBeatPlan({
    chapterGoal: '杨平离开司马府',
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
        goal: openingGoal,
        obstacle: openingObstacle,
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
        goal: farewellGoal,
        obstacle: farewellObstacle,
        cost: farewellCost,
        delta: { variable: '决心', from: '想留下', to: '决定离城' },
        infoGain: '犀角弓的弓弭上刻着司马氏的族记',
        paragraphs: 10,
        endHook: '车队在城门外停下',
      },
    ],
  }).plan;
}

function opponentBrief(extraItems = []) {
  return validatePlanBrief({
    items: [
      {
        kind: 'opponent',
        text: '张杨征粮的使者堵在城门口',
        keywords: ['张杨', '使者'],
        source: '本章大纲',
      },
      ...extraItems,
    ],
  }).brief;
}

test('对手：内部状态被丢弃，具体主体与 none 都能进 brief', () => {
  const out = validatePlanBrief({
    items: [
      { kind: 'opponent', text: '心软不忍逼问', keywords: ['心软'], source: '本章大纲' },
      {
        kind: 'opponent',
        text: '张杨征粮的使者堵在城门口',
        keywords: ['张杨', '使者'],
        source: '本章大纲',
      },
      { kind: 'opponent', none: true, reason: '本章是内廷对话，没有外部势力出场', source: '本章大纲' },
    ],
  });

  assert.strictEqual(out.ok, true);
  assert.ok(
    !out.brief.items.some((x) => x.kind === 'opponent' && x.text.includes('心软')),
    '内部状态不能当对手'
  );
  assert.ok(out.brief.dropped.some((x) => x.includes('内部状态')));

  const concrete = out.brief.items.find((x) => x.kind === 'opponent' && !x.none);
  assert.strictEqual(concrete.id, 'OP1');
  assert.deepStrictEqual(concrete.keywords, ['张杨', '使者']);

  const noneItem = out.brief.items.find((x) => x.kind === 'opponent' && x.none);
  assert.strictEqual(noneItem.reason, '本章是内廷对话，没有外部势力出场');

  // 只有 none、没有具体对手时：这是「没有对手」的结论，不报缺。
  const noneOnly = validatePlanBrief({
    items: [{ kind: 'opponent', none: true, reason: '本章没有外部势力出场', source: '本章大纲' }],
  }).brief;
  const coverage = briefCoverage(noneOnly, planWithOpeningAndFarewell());
  assert.strictEqual(coverage.opponent, 'none');
  assert.ok(!coverage.missing.some((x) => x.slot === 'opening'));
});

test('对手缺失：brief 既没给对手也没说明为什么没有 → 开场硬校验报缺', () => {
  const brief = validatePlanBrief({
    items: [
      { kind: 'loss', text: '交出犀角弓', keywords: ['犀角弓'], source: '设定' },
    ],
  }).brief;

  const coverage = briefCoverage(brief, planWithOpeningAndFarewell());
  assert.strictEqual(coverage.opponent, 'missing');
  const missing = coverage.missing.find((x) => x.slot === 'opening');
  assert.ok(missing, '没有对手也没有 none 说明时必须报缺');
  assert.strictEqual(missing.id, 'OP0');
  assert.match(missing.text, /未给出对手/);
});

test('开场对手：只在 B1 的 goal/cost 出现不算覆盖，必须写进 obstacle', () => {
  const brief = opponentBrief();

  const inGoal = planWithOpeningAndFarewell({ openingGoal: '张杨的使者来催粮，杨平想绕道出城' });
  const missingCoverage = briefCoverage(brief, inGoal);
  assert.strictEqual(missingCoverage.opponent, 'missing');
  const missing = missingCoverage.missing.find((x) => x.slot === 'opening');
  assert.ok(missing);
  assert.strictEqual(missing.kind, 'opponent');
  assert.match(missing.text, /张杨/);

  const inObstacle = planWithOpeningAndFarewell({ openingObstacle: '张杨征粮的使者守住城门，不交粮就不放行' });
  const coveredCoverage = briefCoverage(brief, inObstacle);
  assert.strictEqual(coveredCoverage.opponent, 'covered');
  assert.ok(coveredCoverage.covered.includes('OP1'));
  assert.ok(!coveredCoverage.missing.some((x) => x.slot === 'opening'));
});

test('告别托付：托付人不在告别拍或没有交付动作都报缺', () => {
  const brief = validatePlanBrief({
    items: [
      {
        kind: 'mustPresent',
        text: '司马防在告别时把杨平交给杨俊',
        keywords: ['司马防', '托付'],
        source: '人物卡',
        handover: true,
        to: '杨俊',
        handoverKind: '话',
      },
    ],
  }).brief;

  // 告别拍只有抽象的「辞行」，没有人物也没有交付动作。
  const thin = briefCoverage(brief, planWithOpeningAndFarewell({
    farewellGoal: '独自辞行，没有见着人',
    farewellCost: '把一个空匣带出城',
    farewellObstacle: '管家坚持要他亲手拿走',
  }));
  assert.strictEqual(thin.handover, 'missing');
  const missing = thin.missing.find((x) => x.slot === 'handover');
  assert.ok(missing);
  assert.strictEqual(missing.kind, 'mustPresent');
  assert.match(missing.text, /司马防/);
  assert.ok(missing.missingParts.includes('托付人不在场'));
  assert.ok(missing.missingParts.includes('没有可引用的托付话或物'));
  assert.ok(missing.missingParts.includes('交付对象杨俊不在场'));

  // 告别拍里托付人在场，当场把杨平交给杨俊，并留一句可引用的话。
  const full = briefCoverage(brief, planWithOpeningAndFarewell({
    farewellGoal: '司马防在门口拦下他，把杨平交给杨俊',
    farewellCost: '司马防对杨俊说：保他平安',
  }));
  assert.strictEqual(full.handover, 'covered');
  assert.ok(full.covered.includes('MP1'));
  assert.ok(!full.missing.some((x) => x.slot === 'handover'));

  // 托付人到了、话也说了，但交付对象不在场：第三条仍要报缺。
  const noTarget = briefCoverage(brief, planWithOpeningAndFarewell({
    farewellGoal: '司马防在门口拦下他',
    farewellCost: '司马防塞给他一只旧弓，说：保他平安',
  }));
  assert.strictEqual(noTarget.handover, 'missing');
  assert.ok(noTarget.missing.find((x) => x.slot === 'handover').missingParts.includes('交付对象杨俊不在场'));
});

test('重排指令：开场对手与告别托付带 slot 落点', () => {
  const brief = validatePlanBrief({
    items: [
      { kind: 'opponent', text: '张杨征粮的使者堵在城门口', keywords: ['张杨', '使者'], source: '本章大纲' },
      {
        kind: 'mustPresent',
        text: '司马防在告别时把杨平交给杨俊',
        keywords: ['司马防', '托付'],
        source: '人物卡',
        handover: true,
        to: '杨俊',
        handoverKind: '话',
      },
    ],
  }).brief;

  const plan = planWithOpeningAndFarewell({
    openingObstacle: '天色已晚，城门将闭',
    farewellGoal: '独自辞行，没有见着人',
    farewellCost: '把一个空匣带出城',
  });
  const coverage = briefCoverage(brief, plan);
  const partitioned = partitionCoverage(plan, coverage);

  const opening = partitioned.find((x) => x.slot === 'opening');
  assert.deepStrictEqual(opening.targetBeats, ['B1']);
  assert.match(opening.hint, /外部对手/);

  const handover = partitioned.find((x) => x.slot === 'handover');
  assert.deepStrictEqual(handover.targetBeats, ['B4']);
  assert.match(handover.hint, /交给杨俊/);
  assert.match(handover.hint, /不能只塞进 endHook/);
  assert.match(handover.hint, /当前缺：/);

  const instruction = buildReplanInstruction(partitioned);
  assert.match(instruction, /张杨/);
  assert.match(instruction, /司马防/);
  assert.match(instruction, /杨俊/);
});

test('托付关系注册：人物卡「养父」确定性加一条 handover，并带上交付对象与形式', () => {
  const brief = validatePlanBrief({ items: [] }).brief;
  const merged = mergeHandoverIntoBrief(brief, {
    characters: [
      {
        name: '杨平',
        role: '主角',
        relations: JSON.stringify([{ characterName: '司马防', relation: '养父' }]),
      },
      {
        name: '司马防',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '养父子' }]),
      },
      {
        name: '杨俊',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]),
      },
    ],
    settings: [],
  });

  const item = merged.items.find((x) => x.kind === 'mustPresent' && x.handover === true);
  assert.ok(item, '养父关系必须补一条托付项');
  assert.strictEqual(item.source, '人物卡');
  assert.strictEqual(item.inferred, false);
  assert.deepStrictEqual(item.keywords, ['司马防']);
  assert.strictEqual(item.to, '杨俊', '交付对象取人物卡里的生父，不取托付人本人');
  assert.strictEqual(item.handoverKind, '话', '没有登记交付物时按范文取话');
  assert.match(item.text, /司马防/);
  assert.match(item.text, /交给杨俊/);
  assert.match(item.text, /保他平安/);
});

test('托付关系注册：设定里的「寄养」也能确定性加项', () => {
  const brief = validatePlanBrief({ items: [] }).brief;
  const merged = mergeHandoverIntoBrief(brief, {
    characters: [
      { name: '杨平', role: '主角', relations: '' },
      { name: '司马防', role: '养父', relations: '' },
      {
        name: '杨俊',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]),
      },
    ],
    settings: [
      { name: '寄养', category: '背景', content: '杨平自幼寄养在司马家，司马防待他如子。' },
    ],
  });

  const item = merged.items.find((x) => x.kind === 'mustPresent' && x.handover === true);
  assert.ok(item);
  assert.strictEqual(item.source, '设定');
  assert.deepStrictEqual(item.keywords, ['司马防']);
  assert.strictEqual(item.to, '杨俊');
});

test('托付关系注册：人物卡关系是主来源，设定不把来源改写成「设定」', () => {
  const brief = validatePlanBrief({ items: [] }).brief;
  const merged = mergeHandoverIntoBrief(brief, {
    characters: [
      {
        name: '杨平',
        role: '主角',
        relations: JSON.stringify([
          { characterName: '杨俊', relation: '父子' },
          { characterName: '司马防', relation: '养父' },
        ]),
      },
      { name: '司马防', role: '长辈', relations: '' },
      {
        name: '杨俊',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]),
      },
    ],
    settings: [
      { name: '寄养', category: '背景', content: '杨平自幼寄养在司马防家。' },
    ],
  });

  const item = merged.items.find((x) => x.kind === 'mustPresent' && x.handover === true);
  assert.ok(item);
  assert.strictEqual(item.source, '人物卡', '已有更具体的来源时不能被设定覆盖');
  assert.strictEqual(item.to, '杨俊');
});

test('托付关系注册：已有同人物的 mustPresent 只升级为 handover，不重复堆', () => {
  const brief = validatePlanBrief({
    items: [
      {
        kind: 'mustPresent',
        text: '司马防到场',
        keywords: ['司马防'],
        source: '人物卡',
      },
    ],
  }).brief;
  const before = brief.items.length;
  const merged = mergeHandoverIntoBrief(brief, {
    characters: [
      { name: '杨平', role: '主角', relations: JSON.stringify([{ characterName: '司马防', relation: '养父' }]) },
      { name: '司马防', role: '长辈', relations: '' },
      {
        name: '杨俊',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]),
      },
    ],
  });

  assert.strictEqual(merged.items.length, before, '不重复新增条目');
  const item = merged.items.find((x) => x.kind === 'mustPresent' && x.text === '司马防到场');
  assert.strictEqual(item.handover, true);
  assert.strictEqual(item.to, '杨俊');
});

test('托付关系注册：没有登记关系或 brief 为空时保持原样', () => {
  const brief = validatePlanBrief({ items: [] }).brief;
  const untouched = mergeHandoverIntoBrief(brief, {
    characters: [{ name: '杨平', role: '主角', relations: '' }],
    settings: [],
  });
  assert.deepStrictEqual(untouched.items, []);

  assert.strictEqual(mergeHandoverIntoBrief(null, { characters: [], settings: [] }), null);
});

/**
 * 五拍小表：B2 是「门前告别」，B4 是「出城」，B5 是章末收束。
 * 用来证明托付落点按语义选，而不是按拍序选。
 */
function fiveBeatPlan() {
  return validateBeatPlan({
    chapterGoal: '杨平随父离城',
    protagonistIntent: '跟父亲去许都',
    obstacle: '司马防不肯放人',
    cost: '交出犀角弓',
    hook: '司马防只说了半句',
    avoidRepeat: [],
    mainType: '决定',
    beats: [
      {
        id: 'B1', type: '行动', goal: '进司马府见父亲', obstacle: '门禁核对符传',
        cost: '在门外等了一个时辰', delta: { variable: '处境', from: '门外', to: '堂上' },
        infoGain: '符传的形制与寻常不同', paragraphs: 8, endHook: '堂内有人咳了一声',
      },
      {
        id: 'B2', type: '决定', goal: '在司马府门前与司马朗告别', obstacle: '司马朗把照看的话推回来',
        cost: '没把托付说出口', delta: { variable: '关系', from: '还能托付', to: '只能自己扛' },
        infoGain: '司马朗只说路上当心', paragraphs: 8, endHook: '司马懿把野兔挂在门环上',
      },
      {
        id: 'B3', type: '冲突', goal: '回院收拾行装', obstacle: '箱笼里只剩一只旧弓',
        cost: '把旧物一件件丢下', delta: { variable: '处境', from: '还像住着', to: '成了过客' },
        infoGain: '旧弓上刻着司马氏族记', paragraphs: 8, endHook: '管家把长匣放到案上',
      },
      {
        id: 'B4', type: '行动', goal: '随传车出城', obstacle: '城门核验逾制的符传',
        cost: '被多扣了一刻', delta: { variable: '处境', from: '城里', to: '城外' },
        infoGain: '传车上封着司空府印', paragraphs: 8, endHook: '车帘外有人追来',
      },
      {
        id: 'B5', type: '揭示', goal: '在驿馆落脚', obstacle: '杨俊不肯说许都的事',
        cost: '一夜没睡', delta: { variable: '信息', from: '以为只是随行', to: '知道有人在等' },
        infoGain: '杨俊提到获嘉旧案', paragraphs: 8, endHook: '司马防只说了半句',
      },
    ],
  }).plan;
}

test('handover 落位：按告别语义选 B2，而不是最后或出城那拍', () => {
  const brief = mergeHandoverIntoBrief(validatePlanBrief({ items: [] }).brief, {
    characters: [
      {
        name: '杨平',
        role: '主角',
        relations: JSON.stringify([{ characterName: '司马防', relation: '养父' }]),
      },
      {
        name: '司马防',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '养父子' }]),
      },
      {
        name: '杨俊',
        role: '长辈',
        relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]),
      },
    ],
  });

  const plan = fiveBeatPlan();
  const before = briefCoverage(brief, plan);
  assert.strictEqual(before.handover, 'missing');
  assert.ok(before.missing.find((x) => x.slot === 'handover').missingParts.includes('托付人不在场'));

  const placed = placeHandoverInPlan(plan, before);
  assert.deepStrictEqual(placed.placed, ['B2'], '托付必须落到门前的告别拍');
  assert.deepStrictEqual(placed.unplaced, []);
  const b2 = placed.plan.beats.find((x) => x.id === 'B2');
  const b4 = placed.plan.beats.find((x) => x.id === 'B4');
  assert.match(b2.goal, /司马防/);
  assert.match(b2.goal, /杨俊/);
  assert.ok(!/司马防/.test(b4.goal), '不能推到出城拍');

  const after = briefCoverage(brief, placed.plan);
  assert.strictEqual(after.handover, 'covered');
  assert.ok(!after.missing.some((x) => x.slot === 'handover'));
});

test('handover 不硬编：人物卡里没有托付关系时 brief 不动、不报假缺', () => {
  const brief = validatePlanBrief({
    items: [
      { kind: 'mustPresent', text: '司马朗到场', keywords: ['司马朗'], source: '人物卡' },
    ],
  }).brief;
  const merged = mergeHandoverIntoBrief(brief, {
    characters: [
      { name: '杨平', role: '主角', relations: '' },
      { name: '司马朗', role: '兄弟', relations: '' },
    ],
    settings: [],
  });

  assert.deepStrictEqual(merged.items, brief.items, '没有托付关系就不新增 handover');
  const coverage = briefCoverage(merged, planWithOpeningAndFarewell());
  assert.strictEqual(coverage.handover, 'absent');
  assert.ok(!coverage.missing.some((x) => x.slot === 'handover'), '不能报假缺');
});

test('handover 排不进：没有告别/离场拍时如实报缺，节拍表仍可用', () => {
  const brief = mergeHandoverIntoBrief(validatePlanBrief({ items: [] }).brief, {
    characters: [
      { name: '杨平', role: '主角', relations: JSON.stringify([{ characterName: '司马防', relation: '养父' }]) },
      { name: '司马防', role: '长辈', relations: '' },
      { name: '杨俊', role: '长辈', relations: JSON.stringify([{ characterName: '杨平', relation: '父子' }]) },
    ],
  });

  // 全在堂内议事，没有任何告别/门前/登车/出城语义。
  const indoor = validateBeatPlan({
    chapterGoal: '在堂上把旧事说清',
    protagonistIntent: '追问寄养旧事',
    obstacle: '司马防不肯正面回答',
    cost: '顶撞长辈',
    hook: '管家把长匣放到案上',
    avoidRepeat: [],
    mainType: '冲突',
    beats: [
      { id: 'B1', type: '行动', goal: '进堂问话', obstacle: '门禁核对符传', cost: '等了一个时辰', delta: { variable: '处境', from: '门外', to: '堂上' }, infoGain: '符传的形制与寻常不同', paragraphs: 10, endHook: '堂内有人咳了一声' },
      { id: 'B2', type: '冲突', goal: '问寄养旧事', obstacle: '司马防避而不答', cost: '话说重了', delta: { variable: '关系', from: '客气', to: '顶撞' }, infoGain: '司马防提到寄养旧约', paragraphs: 10, endHook: '司马防沉默' },
      { id: 'B3', type: '转折', goal: '听完安排', obstacle: '外头车马已到', cost: '没来得及追问', delta: { variable: '信息', from: '以为暂住', to: '知道不再回来' }, infoGain: '箱笼只剩一只旧弓', paragraphs: 10, endHook: '管家放下一只长匣' },
      { id: 'B4', type: '决定', goal: '把旧弓留在案上', obstacle: '司马防坚持要他带走', cost: '亲手拿走旧弓', delta: { variable: '决心', from: '想留下', to: '决定收下' }, infoGain: '弓弭上刻着司马族记', paragraphs: 10, endHook: '长匣扣上了' },
    ],
  }).plan;

  const coverage = briefCoverage(brief, indoor);
  const missing = coverage.missing.find((x) => x.slot === 'handover');
  assert.strictEqual(coverage.handover, 'missing');
  assert.deepStrictEqual(missing.missingParts, ['没有告别/离场拍']);

  const placed = placeHandoverInPlan(indoor, coverage);
  assert.deepStrictEqual(placed.placed, []);
  assert.strictEqual(placed.unplaced.length, 1, '排不进就如实留给 planDegraded');
  assert.strictEqual(placed.plan.beats.length, indoor.beats.length, '节拍表结构仍可用');

  const partitioned = partitionCoverage(indoor, coverage);
  const handover = partitioned.find((x) => x.slot === 'handover');
  assert.deepStrictEqual(handover.targetBeats, []);
  assert.match(handover.hint, /没有告别\/离场拍/);
});

test('格式与写手块：对手和托付都有独立段落', () => {
  const brief = validatePlanBrief({
    items: [
      { kind: 'opponent', text: '张杨征粮的使者堵在城门口', keywords: ['张杨', '使者'], source: '本章大纲' },
      {
        kind: 'mustPresent',
        text: '司马防在告别时把杨平交给杨俊',
        keywords: ['司马防', '托付'],
        source: '人物卡',
        handover: true,
        to: '杨俊',
        handoverKind: '话',
      },
    ],
  }).brief;

  const formatted = formatPlanBrief(brief);
  assert.match(formatted, /外部对手（开场拍必须由它施加阻碍/);
  assert.match(formatted, /托付（全章只允许一次完整交付，告别\/离场拍由托付人本人/);
  assert.match(formatted, /交付给：杨俊；形式：话；全章只交付一次/);

  const writerBlock = briefWriterBlock(brief);
  assert.match(writerBlock, /开场的外部对手/);
  assert.match(writerBlock, /托付（全章只允许一次完整交付/);
  assert.match(writerBlock, /交给：杨俊；形式：话/);
  // 托付项不再重复出现在「必须到场」行。
  assert.strictEqual((writerBlock.match(/司马防在告别时把杨平交给杨俊/g) || []).length, 1);
});

test('格式：opponent 标了 none 时写明原因，不硬编', () => {
  const brief = validatePlanBrief({
    items: [{ kind: 'opponent', none: true, reason: '本章没有外部势力出场', source: '本章大纲' }],
  }).brief;
  const formatted = formatPlanBrief(brief);
  assert.match(formatted, /本章没有明确的外部对手（本章没有外部势力出场）/);
  assert.ok(!formatted.includes('外部对手（开场拍必须由它施加阻碍）'));
});

/** 六拍：B3 门前交接，B6 正式告别交付。 */
function sixBeatHandoverPlan() {
  return validateBeatPlan({
    chapterGoal: '杨平随父离城',
    protagonistIntent: '跟父亲走',
    obstacle: '司马防不肯放人',
    cost: '交出犀角弓',
    hook: '车队出城',
    avoidRepeat: [],
    mainType: '决定',
    beats: [
      { id: 'B1', type: '行动', goal: '进司马府见父亲', obstacle: '门禁核对符传', cost: '在门外等了一个时辰', delta: { variable: '处境', from: '门外', to: '堂上' }, infoGain: '符传的形制与寻常不同', paragraphs:  4, endHook: '堂内有人咳了一声' },
      { id: 'B2', type: '冲突', goal: '问寄养旧事', obstacle: '司马防避而不答', cost: '话说重了', delta: { variable: '关系', from: '客气', to: '顶撞' }, infoGain: '司马防提到寄养旧约', paragraphs: 4, endHook: '司马防沉默' },
      { id: 'B3', type: '转折', goal: '回到司马府门前', obstacle: '管家催着上车', cost: '没来得及追问', delta: { variable: '处境', from: '院里', to: '门口' }, infoGain: '箱笼只剩一只旧弓', paragraphs: 4, endHook: '长匣扣上了' },
      { id: 'B4', type: '行动', goal: '随传车出城', obstacle: '城门核验符传', cost: '被多扣了一刻', delta: { variable: '处境', from: '城里', to: '城外' }, infoGain: '传车上封着司空府印', paragraphs: 4, endHook: '车帘外有人追来' },
      { id: 'B5', type: '揭示', goal: '在驿馆落脚', obstacle: '杨俊不肯说许都', cost: '一夜没睡', delta: { variable: '信息', from: '以为只是随行', to: '知道有人在等' }, infoGain: '杨俊提到获嘉旧案', paragraphs: 4, endHook: '司马防只说了半句' },
      { id: 'B6', type: '决定', goal: '在门前与司马家众人告别', obstacle: '司马防不肯松手', cost: '把杨平的手交给杨俊', delta: { variable: '关系', from: '还能托付', to: '交出去了' }, infoGain: '司马防说「保他平安」', paragraphs: 4, endHook: '车队动了' },
    ],
  }).plan;
}

function handoverBrief() {
  return validatePlanBrief({
    items: [
      {
        kind: 'mustPresent',
        text: '司马防在告别拍把杨平交给杨俊',
        keywords: ['司马防'],
        source: '人物卡',
        handover: true,
        to: '杨俊',
        handoverKind: '话',
      },
    ],
  }).brief;
}

test('交付重复：B3 与 B6 都完整交付 → 标出 B3，重写后只剩 B6', () => {
  const brief = handoverBrief();
  brief.handoverBeat = 'B6';
  const plan = sixBeatHandoverPlan();

  const before = [
    '杨平进了司马府，堂上有人咳了一声。',
    '符传核验比寻常更慢。',
    '司马防问起杨平这些年的日子。',
    '杨平答得越来越轻。',
    '司马防当着杨俊的面把杨平的手交到杨俊手里。',
    '司马防说：「保他平安。」',
    '传车出了城门。',
    '车帘外有人追了两步。',
    '驿馆的灯点到半夜。',
    '杨俊没有提许都。',
    '司马防把杨平的手递到杨俊手里。',
    '司马防说：「这孩子在我家养了十年，今日完璧归赵。」',
  ].join('\n');

  const dup = findHandoverDuplicates(brief, before, plan);
  assert.strictEqual(dup.handoverBeat, 'B6');
  assert.deepStrictEqual(dup.beatIds, ['B3'], 'B3 是重复的完整交付，必须标出');

  const after = [
    '杨平进了司马府，堂上有人咳了一声。',
    '符传核验比寻常更慢。',
    '司马防问起杨平这些年的日子。',
    '杨平答得越来越轻。',
    '司马防把杨平的手往杨俊那边送了送。',
    '杨俊伸手接住，没有多话。',
    '传车出了城门。',
    '车帘外有人追了两步。',
    '驿馆的灯点到半夜。',
    '杨俊没有提许都。',
    '司马防把杨平的手递到杨俊手里。',
    '司马防说：「这孩子在我家养了十年，今日完璧归赵。」',
  ].join('\n');

  const fixed = findHandoverDuplicates(brief, after, plan);
  assert.deepStrictEqual(fixed.beatIds, [], '重写后只剩 B6 一次完整交付');
  assert.strictEqual(fixed.handoverBeat, 'B6');
});

test('交付不重复：只有 B6 完整交付 → 不标', () => {
  const brief = handoverBrief();
  brief.handoverBeat = 'B6';
  const plan = sixBeatHandoverPlan();
  const body = [
    '杨平进了司马府，堂上有人咳了一声。',
    '符传核验比寻常更慢。',
    '司马防问起杨平这些年的日子。',
    '杨平答得越来越轻。',
    '司马防把杨平的手往杨俊那边送了送。',
    '杨俊伸手接住，没有多话。',
    '传车出了城门。',
    '车帘外有人追了两步。',
    '驿馆的灯点到半夜。',
    '杨俊没有提许都。',
    '司马防把杨平的手递到杨俊手里。',
    '司马防说：「这孩子在我家养了十年，今日完璧归赵。」',
  ].join('\n');

  const dup = findHandoverDuplicates(brief, body, plan);
  assert.strictEqual(dup.handoverBeat, 'B6');
  assert.deepStrictEqual(dup.beatIds, [], '只有一次交付就不标');
});

test('交付重复：同段各提一次名字，不算完整交付', () => {
  const brief = handoverBrief();
  brief.handoverBeat = 'B6';
  const plan = sixBeatHandoverPlan();
  // B3 那一段里司马防与杨俊都出现了，但只是「话是说给杨俊听的」，
  // 没有任何人真的把杨平交出去——这不能算第二次完整交付。
  const body = [
    '杨平进了司马府，堂上有人咳了一声。',
    '符传核验比寻常更慢。',
    '司马防问起杨平这些年的日子。',
    '杨平答得越来越轻。',
    '司马朗说这话时眼睛看着杨平，可每个字都是给杨俊的。司马防前天还在院里操练，腰都没弯一下。',
    '“父亲说，车马已经备好。”司马朗说完，把手往袖子里一拢。',
    '传车出了城门。',
    '车帘外有人追了两步。',
    '驿馆的灯点到半夜。',
    '杨俊没有提许都。',
    '司马防把杨平的手递到杨俊手里。',
    '司马防说：「这孩子在我家养了十年，今日完璧归赵。」',
  ].join('\n');

  const dup = findHandoverDuplicates(brief, body, plan);
  assert.strictEqual(dup.handoverBeat, 'B6');
  assert.deepStrictEqual(dup.beatIds, [], '只是同段提到名字，不能当成第二次交付');
});

test('handover 拍号：告别/送行拍优先于门口交接拍', () => {
  const brief = handoverBrief();
  const plan = sixBeatHandoverPlan();
  assert.strictEqual(handoverBeatId(brief, plan), 'B6');
});

/** 七拍：B6 只是门前交接，B7 才上车离开。 */
function departurePlan() {
  const beat = (id, goal, obstacle, cost, infoGain, endHook, type = '行动') => ({
    id,
    type,
    goal,
    obstacle,
    cost,
    delta: { variable: '处境', from: `${id}起点`, to: `${id}终点` },
    infoGain,
    paragraphs: 3,
    endHook,
  });
  return validateBeatPlan({
    chapterGoal: '杨平随父离城',
    protagonistIntent: '跟父亲走',
    obstacle: '司马防不肯放人',
    cost: '交出犀角弓',
    hook: '车队出城',
    avoidRepeat: [],
    mainType: '决定',
    beats: [
      beat('B1', '进司马府见父亲', '门禁核对符传', '在门外等了一个时辰', '符传形制与寻常不同，尾部多出一颗星', '堂内有人咳了一声'),
      beat('B2', '问寄养旧事', '司马防避而不答', '话说重了', '司马防提到寄养旧约，话只说了半句', '司马防沉默'),
      beat('B3', '回到司马府门前', '管家催着上车', '没来得及追问', '箱笼只剩一只旧弓，弓弭上还有族记', '长匣扣上了'),
      beat('B4', '随传车出城', '城门核验符传', '被多扣了一刻', '传车上封着司空府印，印泥尚未干透', '车帘外有人追来'),
      beat('B5', '在驿馆落脚', '杨俊不肯说许都', '一夜没睡', '杨俊提到获嘉旧案，随即闭口不再说', '司马防只说了半句'),
      beat('B6', '在司马府门前把杨平交给杨俊', '家兵核对符传迟迟不放', '在阶下多站了一刻', '符传尾部的星纹被看清，多出一颗', '门里有人喊住手'),
      beat('B7', '杨平上车，跟父亲离开温县', '司马防隔帘交代，杨俊在阶下应声', '被父亲交给传车', '司马防说保他平安，只说了这一句', '车轮压过石槛', '决定'),
    ],
  }).plan;
}

test('handover 拍号：门口交接拍不抢离场拍，交付落在 B7', () => {
  const brief = handoverBrief();
  const plan = departurePlan();
  assert.strictEqual(handoverBeatId(brief, plan), 'B7');
});
