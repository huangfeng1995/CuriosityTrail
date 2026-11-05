'use strict';

/**
 * 章节节拍规划与覆盖自检。
 *
 * 纯逻辑 + 一次 provider 调用：不碰数据库、不认识 Express。
 * 规划与写作共用同一份上下文快照，这里只负责两件事：
 *   1. 把一部长篇的「这一章要发生什么」拆成 4–8 拍，并校验模型给的 JSON；
 *   2. 正文写完后，逐拍判断它有没有真的落到正文里。
 *
 * 之所以要单独拆成模块：规划、自检、重写这三个环节都需要同一套
 * 字段定义与校验规则。规则散在路由里，改一处漏一处就会静默放行
 * 一份缺拍的节拍表。
 */

const { parseModelJson } = require('./parse');

/** 节拍类型：六选一。与规划提示词、校验规则保持一致 */
const BEAT_TYPES = ['行动', '转折', '冲突', '揭示', '决定', '过渡'];

/**
 * 功能拍枚举：这一拍在章节结构里承担什么。
 *
 * 与 type 是两件事：type 说「事件性质」（冲突/揭示），function 说
 * 「在全章曲线上负责哪一段」（开场/身世/告别）。篇幅配比只看 function，
 * 不再按 goal 文案里的关键词猜——「回城/猎鹿」这类地点词会把开场拍
 * 误判成启程拍，正文份额就会全盘错位。
 */
const BEAT_FUNCTIONS = ['opening', 'discussion', 'identity', 'father', 'farewell', 'departure'];
const FUNCTION_LABELS = {
  opening: '开场',
  discussion: '议论',
  identity: '身世',
  father: '长辈到',
  farewell: '告别托付',
  departure: '启程',
};

/** 变量：每拍至少改变一个 */
const DELTA_VARIABLES = ['处境', '关系', '信息', '决心'];

/** 节拍数范围 */
const MIN_BEATS = 4;
const MAX_BEATS = 8;
/** 六类功能全覆盖的起算拍数：少于 6 拍不可能排进六类，不据此判降级。 */
const MIN_BEATS_WITH_FUNCTIONS = 6;

/**
 * 单拍段数与全章段数。
 *
 * 基线范文（5000 字量级）实测 45 个自然段、6 拍。旧的「每拍 1–4 段、
 * 全章 8–14 段」是按两千字短章推的，会把长篇写成提纲，已经作废。
 */
const MIN_PARAGRAPHS = 3;
/**
 * 单拍段数上限。
 *
 * 30% 的身世拍在 40 段的长章里要约 12 段；上限卡在 10 会逼出
 * 每段 150 字以上的超长段，正好撞上 P3 的 80–140 字硬约束。
 * 12 段 × 125 字 ≈ 1500 字，才装得下范文的 30% 份额。
 */
const MAX_PARAGRAPHS = 12;
// 段落数只做安全下限（防止把长章规划成几段），不作为文章结构的验收门槛。
const MIN_TOTAL_PARAGRAPHS = 20;
const MAX_TOTAL_PARAGRAPHS = 80;

/** 范文口径的全章目标字数（仅用于把份额换算成每拍目标字数）。 */
const CHAPTER_TARGET_CHARS = 5000;

/** 空钩子话术，出现即判不合格 */
const EMPTY_HOOKS = ['且听下回分解', '欲知后事', '下回分解'];

/** 回城/身世是本章的承重拍：并进「过渡」拍且份额过低，等于把身世交代糊过去。 */
const ARC_BEAT_RE = /回城|到家|进城|身世|寄养|旧事|年龄|籍贯/;
/**
 * 判「身世被并进过渡拍」只认身世语义，不认「回城」这个地点词。
 *
 * 范文里「下山议论」这一拍本来就发生在回城路上（14%），如果拿「回城」
 * 当判据，会把合法的途中议论拍全部打成「身世合并」，整章计划被拒后
 * 降级直写，后面的自检连跑都跑不到。
 */
const IDENTITY_MERGE_RE = /身世|寄养|旧事|年龄|籍贯|小时候|自幼|童年/;
const ARC_MIN_SHARE = 20;

/**
 * 范文实测的六段功能配比（百分点）。
 *
 * 只看显式 function，不按文案关键词猜。模型可以写 6–8 拍，但每一类
 * 功能的目标份额是固定的；同类功能有多拍时按计划段数分摊。
 * 容差 ±5pp 由 checkWordShares 统一处理，这里只给中心值。
 */
const SHARE_ROLES = [
  { role: 'opening', label: FUNCTION_LABELS.opening, target: 9 },
  { role: 'discussion', label: FUNCTION_LABELS.discussion, target: 14 },
  { role: 'identity', label: FUNCTION_LABELS.identity, target: 30 },
  { role: 'father', label: FUNCTION_LABELS.father, target: 15.5 },
  { role: 'farewell', label: FUNCTION_LABELS.farewell, target: 25 },
  { role: 'departure', label: FUNCTION_LABELS.departure, target: 6.5 },
];
const SHARE_TOLERANCE = 5;

/** 功能拍覆盖：六类各至少一拍。 */
function functionCoverage(beats) {
  const covered = BEAT_FUNCTIONS.filter((fn) => beats.some((beat) => beat.function === fn));
  return {
    covered,
    missing: BEAT_FUNCTIONS.filter((fn) => !covered.includes(fn)),
  };
}

function classifyShareRole(beat) {
  return BEAT_FUNCTIONS.includes(beat.function) ? beat.function : '';
}

/**
 * 把每拍的份额换回「目标字数」，并在份额偏差较大时就地调整段落数。
 *
 * R3 的约束只允许调这一拍的 paragraphs 与目标字数，不许为配比重排整章。
 * 目标段数按 120 字/段估算：1500 字的身世拍 → 12 段，正好落在
 * 80–140 字的形态硬约束里，而不是写成 10 段 150 字的超长段。
 */
function applyTargetChars(beats) {
  for (const beat of beats) {
    const share = Number(beat.wordShare);
    if (!Number.isFinite(share)) continue;
    beat.targetChars = Math.round((share / 100) * CHAPTER_TARGET_CHARS);
    if (!beat.shareRole) continue;
    const desired = Math.min(
      MAX_PARAGRAPHS,
      Math.max(MIN_PARAGRAPHS, Math.round(beat.targetChars / 120))
    );
    beat.targetParagraphs = desired;
    if (Math.abs(desired - (Number(beat.paragraphs) || 0)) >= 2) {
      beat.paragraphs = desired;
    }
  }
}

/**
 * 按功能给每拍套用范文配比。
 *
 * 同类功能有多拍时按 paragraphs 权重分摊该功能的总份额；
 * 功能未分类的拍保留模型/段落折算出来的原始份额，并记进 functionMissing，
 * 交给路由重排——这里绝不按文案关键词替它猜一个功能。
 */
function applyReferenceShares(beats) {
  const byRole = new Map();
  for (const beat of beats) {
    beat.shareRole = classifyShareRole(beat);
    if (!beat.shareRole) continue;
    const rows = byRole.get(beat.shareRole) || [];
    rows.push(beat);
    byRole.set(beat.shareRole, rows);
  }

  for (const rule of SHARE_ROLES) {
    const rows = byRole.get(rule.role);
    if (!rows || !rows.length) continue;
    const totalParagraphs = rows.reduce((sum, beat) => sum + Math.max(1, beat.paragraphs || 1), 0);
    for (const beat of rows) {
      const weight = Math.max(1, beat.paragraphs || 1);
      beat.wordShare = Math.round(rule.target * (weight / totalParagraphs) * 10) / 10;
    }
  }

  // 未分类的拍也要有可比的区间：沿用原来折算出来的份额作为中心值。
  for (const beat of beats) {
    if (!beat.shareRole) beat.shareRole = '';
  }

  const coverage = functionCoverage(beats);
  return coverage.missing;
}

/** 完整交付的机械识别：把某人交给某人。预备动作（递、接、握住手）不算。 */
const DELIVERY_FULL_RE = /把[\u4e00-\u9fa5]{2,4}交给[\u4e00-\u9fa5]{2,4}/;

function beatNarrative(beat) {
  return [beat.goal, beat.obstacle, beat.cost, beat.infoGain, beat.endHook].join('\n');
}

/** 覆盖证据的长度上限：够定位原句，又不至于把正文抄一遍 */
const MAX_EVIDENCE_CHARS = 30;

/**
 * 规划提示词。独立于 writer.js 的正文提示词——规划器只描述节拍表，
 * 不写正文，避免模型顺手开始写小说。
 */
const PLAN_PROMPT = `你是章节节拍规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
字段：chapterGoal, protagonistIntent, obstacle, cost, hook, avoidRepeat（数组，可为空）, mainType, beats[]。
beats 6–8 个；每拍含 id（B1…Bn）、function、functionReason、type（行动|转折|冲突|揭示|决定|过渡）、
goal、obstacle、cost、delta{variable:处境|关系|信息|决心, from, to}、infoGain、paragraphs（3–12）、
targetChars、wordShare、endHook（这一拍结束时的悬念或钩子）。
function 只能取以下六类，且全章六类必须各出现至少一次（可以有同类多拍）：
- opening：开场。有外部对手施加压力、主角被叫走/被传唤，外部压力先一步打断当前场景。
  这一拍的 obstacle 必须写清对手是谁、用什么方式阻碍，正文会据此校验对手是否落进开场。
- discussion：同行议论且发生信息交换（谁告诉谁什么新信息）。
- identity：交代身世与旧日（年龄、籍贯、寄养、旧事）。
- father：长辈到场并带符传/传诏等制度性信物。
- farewell：交割与托付（交物、交人、留下可引用的话）。
- departure：上车出城/启程离场。
function 按事件语义判，不许按关键词猜：判断依据写进 functionReason，一句话说明「谁在场、发生什么、改变了什么」。
错误示例：把雪地猎鹿的开场拍写成 departure、把门前告别写成 departure、把回城身世并进过渡拍。
单章是 5000 字量级的长章：按内容需要给每拍估段数，长章大致 35–65 段即可，不必凑固定段数。
paragraphs 是这一拍的段落数，硬上限 12；targetChars 是这一拍的目标纯汉字数（不含标点），
wordShare 是这一拍占全章正文的百分比。范文实测配比：
opening 8–10%、discussion 14%、identity ≈30%、father 15–16%、farewell 25%、departure 6–7%，允许 ±5pp。
targetChars 与 wordShare 要能对上：targetChars ≈ wordShare × 5000 / 100。
回城/身世这一拍不能并进过渡拍，目标份额低于 20 会被判不合格。
每个节拍必须让至少一个变量发生改变，必须写出代价，禁止空转抒情段。
mainType 必须与某一个 beats[].type 相同。只依据给定上下文，不新增未提供的人物或设定。`;

/**
 * 自检提示词。
 *
 * 每拍必须带证据：只说「覆盖了」不给原句，等于让模型自己给自己打分。
 * 证据限 30 字，够定位到正文里的那一句，又不会把正文再抄一遍。
 * 同时明确：段数多少不是判缺拍的标准——拍是否落地看事件与变化，不看篇幅。
 */
const COVERAGE_PROMPT = `你是节拍覆盖检查器。只输出一个 JSON 对象，不要解释、不要 markdown。
输入是《节拍表》和一段正文。逐个节拍判断它是否真正落到正文里：
- covered：该拍的 goal 或 obstacle 能在正文里找到对应的事件句，并且 delta.from→to 或 infoGain 至少有一项能找到对应句。
  每项写成 {"id":"B1","evidence":"正文里的原句或片段"}；evidence 不超过 30 个字，必须能在正文中逐字找到。
  没有 evidence 的拍不算 covered。
- weak：写了事件，但没有写出变量变化（元素为 {id, reason}）。
- missing：完全不满足 covered 的条件，或整拍被「总之/后来/从此」类总结句替代。
段数多少不是判断标准：某拍只写了两段，只要事件和变化都在，也照常算 covered。
另需判断 hookPresent（章末最后一段是否留下未解问题或作出后果未定的决定）与
chapterGoalMet（正文是否回答了 chapterGoal 的人物+动作+结果）。
输出字段：covered（数组）、missing（数组）、weak（数组）、hookPresent（布尔）、chapterGoalMet（布尔）。
只使用节拍表里出现过的 id，不要编造。`;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unique(list) {
  return Array.from(new Set(list));
}

/**
 * 校验并归一化一份节拍表。
 *
 * 校验放在服务端，不交给模型自觉：一份缺代价、缺信息增量或段落数
 * 注水的表，会让写手写成流水账，而作者只会怪「AI 写得不好」。
 *
 * @param {Object|string} candidate 模型输出（对象或 JSON 原文）
 * @returns {{ok: boolean, plan: Object|null, errors: string[]}}
 */
function validateBeatPlan(candidate) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, plan: null, errors: ['没有解析出 JSON 对象'] };
  }

  const chapterGoal = text(data.chapterGoal);
  const protagonistIntent = text(data.protagonistIntent);
  const obstacle = text(data.obstacle);
  const cost = text(data.cost);
  const hook = text(data.hook);
  const mainType = text(data.mainType);
  const avoidRepeat = Array.isArray(data.avoidRepeat)
    ? data.avoidRepeat.map((x) => text(x)).filter(Boolean)
    : [];

  for (const [key, value] of Object.entries({
    chapterGoal,
    protagonistIntent,
    obstacle,
    cost,
    hook,
  })) {
    if (!value) errors.push(`顶层字段 ${key} 不能为空`);
  }
  if (EMPTY_HOOKS.some((word) => hook.includes(word))) {
    errors.push('hook 不能是「且听下回分解」式空钩');
  }
  if (mainType && !BEAT_TYPES.includes(mainType)) {
    errors.push(`mainType 必须是六种节拍类型之一，收到「${mainType}」`);
  }

  const rawBeats = Array.isArray(data.beats) ? data.beats : [];
  if (rawBeats.length < MIN_BEATS || rawBeats.length > MAX_BEATS) {
    errors.push(`节拍数必须在 ${MIN_BEATS}–${MAX_BEATS} 之间，收到 ${rawBeats.length}`);
  }

  const beats = [];
  const functionReasonMissing = [];
  let totalParagraphs = 0;

  rawBeats.forEach((beat, index) => {
    const where = `第 ${index + 1} 拍`;
    if (!beat || typeof beat !== 'object') {
      errors.push(`${where}不是对象`);
      return;
    }

    const id = text(beat.id) || `B${index + 1}`;
    const type = text(beat.type);
    const rawFunction = text(beat.function);
    const beatFunction = BEAT_FUNCTIONS.includes(rawFunction) ? rawFunction : '';
    const functionReason = text(beat.functionReason);
    const goal = text(beat.goal);
    const beatObstacle = text(beat.obstacle);
    const beatCost = text(beat.cost);
    const infoGain = text(beat.infoGain);
    const endHook = text(beat.endHook);
    const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
    const variable = text(delta.variable);
    const from = text(delta.from);
    const to = text(delta.to);
    const paragraphs = Number(beat.paragraphs);

    if (id !== `B${index + 1}`) errors.push(`${where}的 id 必须是 B${index + 1}，收到「${id}」`);
    if (!BEAT_TYPES.includes(type)) errors.push(`${where}的 type 不合法：${type || '空'}`);
    // function 缺失/非法不直接判计划作废：作废会掉进整章直写，比缺分类更糟。
    // 这里只记为「未分类」，由路由重排一次；重排后仍缺才写进 plan_degraded。
    if (!beatFunction) functionReasonMissing.push(`${id}:未分类${rawFunction ? `(${rawFunction})` : ''}`);
    else if (functionReason.length < 8) functionReasonMissing.push(`${id}:缺判定依据`);
    for (const [key, value] of Object.entries({ goal, obstacle: beatObstacle, cost: beatCost })) {
      if (!value) errors.push(`${where}的 ${key} 不能为空`);
    }
    if (!DELTA_VARIABLES.includes(variable)) {
      errors.push(`${where}的 delta.variable 必须是处境/关系/信息/决心之一`);
    }
    if (!from || !to) errors.push(`${where}的 delta.from / delta.to 不能为空`);
    if (from && to && from === to) errors.push(`${where}的 delta.from 与 to 不能相同`);
    if (infoGain.length < 8) errors.push(`${where}的 infoGain 至少 8 个字`);
    if (!endHook) errors.push(`${where}的 endHook 不能为空`);
    if (!Number.isInteger(paragraphs) || paragraphs < MIN_PARAGRAPHS || paragraphs > MAX_PARAGRAPHS) {
      errors.push(`${where}的 paragraphs 必须是 ${MIN_PARAGRAPHS}–${MAX_PARAGRAPHS} 的整数`);
    } else {
      totalParagraphs += paragraphs;
    }

    const rawShare = Number(beat.wordShare);
    beats.push({
      id,
      function: beatFunction,
      functionReason,
      type,
      goal,
      obstacle: beatObstacle,
      cost: beatCost,
      delta: { variable, from, to },
      infoGain,
      paragraphs: Number.isInteger(paragraphs) ? paragraphs : 0,
      wordShare: Number.isFinite(rawShare) && rawShare > 0 && rawShare <= 100 ? rawShare : null,
      endHook,
    });
  });

  // wordShare：模型给齐了就按它的配比；缺项或合计明显不对，就按段落权重折算，
  // 保证每拍都有目标份额，而不是让某一拍静默缺失。
  const totalParagraphsForShare = beats.reduce((sum, b) => sum + (b.paragraphs || 0), 0);
  const rawShareTotal = beats.reduce((sum, b) => sum + (b.wordShare || 0), 0);
  const usableRawShare =
    beats.every((b) => b.wordShare !== null) && rawShareTotal >= 90 && rawShareTotal <= 110;
  for (const beat of beats) {
    if (usableRawShare) {
      beat.wordShare = Math.round(beat.wordShare * 10) / 10;
    } else if (totalParagraphsForShare > 0) {
      beat.wordShare = Math.round(((beat.paragraphs || 0) / totalParagraphsForShare) * 1000) / 10;
    } else {
      beat.wordShare = Math.round((100 / Math.max(1, beats.length)) * 10) / 10;
    }
    beat.plannedShare = beat.wordShare;
  }

  // 范文配比优先：有合法 function 的拍改用实测目标；未分类的拍保留原份额，
  // 但绝不按文案关键词补猜一个功能（猜错会让整章份额错位）。
  const shareMissing = applyReferenceShares(beats);
  const fnCoverage = functionCoverage(beats);
  // 六类功能是「5000 字长章 6–8 拍」的结构要求。短章（<6 拍）本来就排不下
  // 六类，不拿它判降级；功能字段仍按拍使用，只是不做全覆盖硬校验。
  const requireFunctions = beats.length >= MIN_BEATS_WITH_FUNCTIONS;
  applyTargetChars(beats);
  const adjustedParagraphs = beats.reduce((sum, beat) => sum + (beat.paragraphs || 0), 0);
  totalParagraphs = adjustedParagraphs;

  if (beats.length && (totalParagraphs < MIN_TOTAL_PARAGRAPHS || totalParagraphs > MAX_TOTAL_PARAGRAPHS)) {
    errors.push(`全章段落数必须在 ${MIN_TOTAL_PARAGRAPHS}–${MAX_TOTAL_PARAGRAPHS} 之间，收到 ${totalParagraphs}`);
  }
  if (mainType && beats.length && !beats.some((b) => b.type === mainType)) {
    errors.push('mainType 必须与某一个节拍的 type 相同');
  }

  // 身世不能并进过渡拍：计划份额低于 20% 说明这一拍只是顺带提一句。
  // 只认身世语义，不认「回城」地点词——途中议论拍本来就发生在回城路上。
  for (const beat of beats) {
    const planned = Number.isFinite(beat.plannedShare) ? beat.plannedShare : beat.wordShare;
    const identitySemantic = beat.function === 'identity' || IDENTITY_MERGE_RE.test(beatNarrative(beat));
    if (beat.type === '过渡' && identitySemantic && planned < ARC_MIN_SHARE) {
      errors.push(
        `${beat.id}把身世（寄养/年龄/籍贯/旧事）并进了过渡拍（计划份额仅 ${planned}%，应 ≥${ARC_MIN_SHARE}%），` +
          '身世必须单独成拍'
      );
    }
  }

  // 完整交付只能有一拍；两拍都写「把某人交给某人」就是重复交付。
  const deliveryBeats = beats.filter((beat) => DELIVERY_FULL_RE.test(beatNarrative(beat)));
  if (deliveryBeats.length > 1) {
    errors.push(
      `${deliveryBeats.map((b) => b.id).join('、')} 两拍都写了完整交付；交付全章只写一次`
    );
  }

  if (errors.length) return { ok: false, plan: null, errors };

  return {
    ok: true,
    plan: {
      chapterGoal,
      protagonistIntent,
      obstacle,
      cost,
      hook,
      avoidRepeat,
      mainType,
      beats,
      totalParagraphs,
      shareMissing,
      functionCovered: fnCoverage.covered,
      functionMissing: requireFunctions ? fnCoverage.missing : [],
      functionReasonMissing: requireFunctions ? functionReasonMissing : [],
    },
    errors: [],
  };
}

/**
 * 「最接近合法」兜底：校验失败时不把整章丢给写手直写。
 *
 * 把可解析的节拍表按硬边界修复：段数夹到 3–12、缺失必填字段补占位、
 * 非法文不加猜测。修复后的表仍可能缺功能拍/缺对手，但至少保留
 * 事件链与篇幅结构，比「整章 85 段直写」更接近合格产物。
 *
 * @param {Object|string} candidate 模型最后一次输出
 * @returns {Object|null}
 */
function salvageBeatPlan(candidate) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const rawBeats = Array.isArray(data.beats) ? data.beats : [];
  if (!rawBeats.length) return null;

  const beats = rawBeats.slice(0, MAX_BEATS).map((raw, index) => {
    const beat = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
    const rawParagraphs = Number(beat.paragraphs);
    const paragraphs = Number.isInteger(rawParagraphs)
      ? Math.min(MAX_PARAGRAPHS, Math.max(MIN_PARAGRAPHS, rawParagraphs))
      : MIN_PARAGRAPHS;
    const rawShare = Number(beat.wordShare);
    return {
      id: `B${index + 1}`,
      function: BEAT_FUNCTIONS.includes(text(beat.function)) ? text(beat.function) : '',
      functionReason: text(beat.functionReason),
      type: BEAT_TYPES.includes(text(beat.type)) ? text(beat.type) : '过渡',
      goal: text(beat.goal) || '（原计划缺目标，按章目标推进）',
      obstacle: text(beat.obstacle) || '（原计划缺阻碍，按现有情境补写）',
      cost: text(beat.cost) || '（原计划缺代价，按事件结果补写）',
      delta: {
        variable: DELTA_VARIABLES.includes(text(delta.variable)) ? text(delta.variable) : '处境',
        from: text(delta.from) || '原状',
        to: text(delta.to) || '新的处境',
      },
      infoGain: text(beat.infoGain) || '（原计划缺少信息增量，按现有事件补写）',
      paragraphs,
      wordShare: Number.isFinite(rawShare) && rawShare > 0 && rawShare <= 100 ? rawShare : null,
      endHook: text(beat.endHook) || '（原计划缺钩子，按下一拍推进）',
    };
  });

  const totalParagraphsForShare = beats.reduce((sum, b) => sum + (b.paragraphs || 0), 0);
  const rawShareTotal = beats.reduce((sum, b) => sum + (b.wordShare || 0), 0);
  const usableRawShare =
    beats.every((b) => b.wordShare !== null) && rawShareTotal >= 90 && rawShareTotal <= 110;
  for (const beat of beats) {
    if (usableRawShare) {
      beat.wordShare = Math.round(beat.wordShare * 10) / 10;
    } else if (totalParagraphsForShare > 0) {
      beat.wordShare = Math.round(((beat.paragraphs || 0) / totalParagraphsForShare) * 1000) / 10;
    } else {
      beat.wordShare = Math.round((100 / Math.max(1, beats.length)) * 10) / 10;
    }
    beat.plannedShare = beat.wordShare;
  }
  const shareMissing = applyReferenceShares(beats);
  applyTargetChars(beats);
  const fnCoverage = functionCoverage(beats);
  const requireFunctions = beats.length >= MIN_BEATS_WITH_FUNCTIONS;
  const functionReasonMissing = [];
  if (requireFunctions) {
    for (const beat of beats) {
      if (!beat.function) functionReasonMissing.push(`${beat.id}:未分类`);
      else if (!beat.functionReason || beat.functionReason.length < 8) {
        functionReasonMissing.push(`${beat.id}:缺判定依据`);
      }
    }
  }

  return {
    chapterGoal: text(data.chapterGoal) || '（原计划缺章目标，按写作指令推进）',
    protagonistIntent: text(data.protagonistIntent) || '（原计划缺主角意图，按章目标推断）',
    obstacle: text(data.obstacle) || '（原计划缺主要阻碍）',
    cost: text(data.cost) || '（原计划缺代价）',
    hook: text(data.hook) || '（原计划缺钩子）',
    avoidRepeat: Array.isArray(data.avoidRepeat)
      ? data.avoidRepeat.map((x) => text(x)).filter(Boolean)
      : [],
    mainType: BEAT_TYPES.includes(text(data.mainType)) ? text(data.mainType) : beats[0].type,
    beats,
    totalParagraphs: beats.reduce((sum, beat) => sum + (beat.paragraphs || 0), 0),
    shareMissing,
    functionCovered: fnCoverage.covered,
    functionMissing: requireFunctions ? fnCoverage.missing : [],
    functionReasonMissing,
    salvaged: true,
  };
}

/**
 * 功能拍重排指令：只补缺的功能分类，不重写已经合格的事件。
 */
function buildFunctionReplanInstruction(plan, missing, reasonMissing = []) {
  const labels = missing.map((fn) => `${fn}（${FUNCTION_LABELS[fn]}）`).join('、');
  const current = (plan && plan.beats ? plan.beats : [])
    .map((beat) => `${beat.id}=${beat.function || '未分类'}`)
    .join('、');
  return [
    '（功能拍自检：节拍表的功能分类不完整，只做一次重排。）',
    `当前功能：${current || '无'}；缺少：${labels || '无'}。`,
    reasonMissing.length ? `判定依据缺失：${reasonMissing.join('、')}。` : '',
    '给每拍补 function（opening|discussion|identity|father|farewell|departure）与 functionReason（谁在场、发生什么、改变了什么）。',
    '按事件语义判，不许按关键词猜：opening=外部对手施压/被叫走；discussion=同行议论且信息交换；',
    'identity=交代身世旧日；father=长辈到场并带符传；farewell=交割托付；departure=上车出城。',
    '六类必须各至少一拍，全章 6–8 拍；其余已经合格的拍保留原目标与事件，不要重写成新剧情。',
    '只输出完整节拍表 JSON，不要解释。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 把节拍表格式化成给写手看的硬约束块。
 *
 * 放在 system 末尾、技能清单之前（由 assembleContext 插入）。
 * 正文里不插任何节拍标记——对账交给自检，不让作者看到 B1/B2 的噪音。
 *
 * @param {Object} plan validateBeatPlan 归一化后的 plan
 * @returns {string}
 */
function formatBeatPlan(plan) {
  if (!plan) return '';
  return [
    '## 本章节拍表（硬约束，必须覆盖）',
    '按 B1→Bn 顺序推进；每拍至少改变一个变量；不得把两拍合并成一段总结；正文里不要写节拍编号。',
    JSON.stringify(plan),
  ].join('\n');
}

/**
 * 校验自检结果。
 *
 * 以节拍表为准重新计算 missing：模型有时会给出自相矛盾的
 * covered / missing 列表，照抄会把已覆盖的拍报成缺拍，触发无意义重写。
 *
 * @param {Object|string} candidate 自检输出
 * @param {Object} plan 已校验的节拍表
 * @returns {Object|null} 合法返回覆盖报告，否则 null
 */
function validateCoverage(candidate, plan) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!plan || !Array.isArray(plan.beats)) return null;

  const ids = plan.beats.map((b) => b.id);
  const toIds = (value, keyed) =>
    Array.isArray(value)
      ? value
          .map((x) => (keyed && x && typeof x === 'object' ? x.id : x))
          .map((x) => text(x))
          .filter((id) => ids.includes(id))
      : [];

  const weakIds = unique(toIds(data.weak, true));

  // covered 每项必须带 evidence：只有「覆盖了」三个字、没有原句，
  // 等于模型自己给自己打分，missing 会永远算不准。
  // 没有证据的条目按未覆盖处理，交给 missing 重算。
  const evidenceById = new Map();
  const claimed = [];
  for (const item of Array.isArray(data.covered) ? data.covered : []) {
    const id = text(item && typeof item === 'object' ? item.id : item);
    const evidence = text(item && typeof item === 'object' ? item.evidence : '');
    if (!ids.includes(id) || !evidence) continue;
    claimed.push(id);
    if (!evidenceById.has(id)) {
      evidenceById.set(id, Array.from(evidence).slice(0, MAX_EVIDENCE_CHARS).join(''));
    }
  }

  const covered = unique(claimed).filter((id) => !weakIds.includes(id));
  const evidence = covered.map((id) => ({ id, evidence: evidenceById.get(id) }));

  const modelMissing = unique(toIds(data.missing, false)).filter(
    (id) => !covered.includes(id) && !weakIds.includes(id)
  );
  const missing = unique([
    ...ids.filter((id) => !covered.includes(id) && !weakIds.includes(id)),
    ...modelMissing,
  ]);

  const weak = Array.isArray(data.weak)
    ? data.weak
        .filter((w) => w && ids.includes(text(w.id)))
        .map((w) => ({ id: text(w.id), reason: text(w.reason) }))
    : [];

  return {
    covered,
    missing,
    weak,
    evidence,
    hookPresent: data.hookPresent === true,
    chapterGoalMet: data.chapterGoalMet === true,
  };
}

/**
 * 生成缺拍重写指令。
 *
 * 明确列出缺哪几拍、每拍该写出什么变化，并要求重写全文——
 * 不让模型局部拼接，否则补丁段落和原稿的语气、人称一定对不上。
 *
 * @param {Object} plan
 * @param {{missing: string[], weak: Array}} coverage
 * @param {string[]} [mustReveal] 首次出场章仍缺的背景事实
 * @returns {string}
 */
function buildRewriteInstruction(plan, coverage, mustReveal = [], handover = {}) {
  const byId = new Map((plan && plan.beats ? plan.beats : []).map((b) => [b.id, b]));
  const lines = [
    `（覆盖自检结果：正文没有完整覆盖节拍表。缺失：${(coverage.missing || []).join('、') || '无'}。）`,
    '请重写全文，按 B1→Bn 顺序补足下面这些节拍，不要局部插入，不要解释：',
  ];

  const handoverBeat = handover && handover.handoverBeat ? `第 ${handover.handoverBeat} 拍` : '';
  const dupIds = (coverage && coverage.handoverDuplicated) || [];
  if (handoverBeat) {
    lines.push(
      `本章交付只发生一次，${handoverBeat} 完成；其余拍不要重复托付话或重复交割，` +
        '最多保留递、接、握住手这类预备动作。'
    );
  }
  if (dupIds.length) {
    lines.push(
      `以下拍已经重复交付，必须删掉完整形态，只保留预备动作：${dupIds.join('、')}。`
    );
  }
  const withholdIds = (handover && handover.mustWithholdIds) || [];
  for (const id of withholdIds) {
    lines.push(
      `- ${id}：本拍只写形制细节与人物反应，不写制度结论，不替读者解释；` +
        '删掉所有关于私辟/传诏/符传/逾制/该不该的判断句。'
    );
  }
  for (const conflict of (handover && handover.invariantConflicts) || []) {
    if (!conflict || !conflict.beatId) continue;
    lines.push(
      `- ${conflict.beatId}：${conflict.label}应写「${conflict.expected}」，正文写成了「${conflict.actual}」；` +
        '同一事实只保留一个数，改成 brief 不变项里的值。'
    );
  }

  for (const id of coverage.missing) {
    const beat = byId.get(id);
    if (!beat) continue;
    lines.push(
      `- ${id}：目标「${beat.goal}」，阻碍「${beat.obstacle}」，代价「${beat.cost}」，` +
        `变量「${beat.delta.variable}」从「${beat.delta.from}」变为「${beat.delta.to}」，` +
        `结束时留下「${beat.endHook}」。`
    );
  }

  const weak = coverage.weak || [];
  for (const item of weak) {
    const beat = byId.get(item.id);
    if (!beat) continue;
    lines.push(
      `- ${item.id}（写了事件但没写出变化）：必须写出「${beat.delta.from}」到「${beat.delta.to}」的变化。`
    );
  }

  if (mustReveal.length) {
    lines.push(
      '同时必须交代以下背景事实（主角首次出场章，每项至少一句，写进对话或叙述，不得一句话带过）：'
    );
    for (const content of mustReveal) lines.push(`- ${content}`);
  }

  lines.push('保持已经合格的节拍，不要删掉它们。章末要留下 hook。');
  return lines.join('\n');
}

/**
 * 给作者看的编排徽标。没有问题时返回空串。
 *
 * @param {Object} params
 * @param {Object|null} params.coverage
 * @param {string} params.checkError
 * @param {boolean} params.rewrote
 * @param {boolean} params.rewriteFailed
 * @param {boolean} params.truncated
 * @returns {string}
 */
function beatBadge({ coverage, checkError, rewrote, rewriteFailed, truncated } = {}) {
  if (truncated) return '【编排自检：未自检（截断）】';
  if (checkError === 'time_budget') return '【编排自检：未自检（时间不足）】';
  // 重写本身成功了，但复核没跑成。此时手上的 missing 是重写前的旧报告，
  // 不能拿它冒充当前稿的结论，只能说复核未完成。
  if (checkError === 'recheck') return '【编排自检：已重写，复核未完成】';
  if (checkError || !coverage) return '【编排自检：未自检】';
  if (!coverage.missing.length) return '';
  if (rewriteFailed) {
    return `【编排自检：重写失败，保留第一版；缺 ${coverage.missing.join('、')}】`;
  }
  return rewrote
    ? `【编排自检：重写后仍缺 ${coverage.missing.join('、')}】`
    : `【编排自检：缺 ${coverage.missing.join('、')}】`;
}

/**
 * 规划调用。
 *
 * 失败一律返回 plan=null，由路由降级直写——规划只是增强，
 * 不能因为它挂掉就让整轮起稿失败。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} params.systemPrompt 与写作共用的上下文快照
 * @param {string} params.instruction 作者本次的写作指令
 * @param {Object} [params.options] temperature/model/thinking/signal
 * @returns {Promise<{plan: Object|null, raw: string, errors: string[], reason: string}>}
 */
async function generateBeatPlan({ provider, systemPrompt, instruction, options = {} }) {
  const signal = options.signal || null;
  let lastRaw = '';
  let lastErrors = [];
  let lastUsage = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) {
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'timeout', usage: lastUsage };
    }

    const userContent = attempt === 0
      ? `请为这一章生成节拍表。选题：${instruction}`
      : `上一次输出不合格：${lastErrors.join('；')}。` +
        '请在保留可用节拍的前提下按错误清单修正：格式/段数/份额错误的拍就地改，' +
        '缺身世拍或对手拍就补一拍；只输出完整的合格 JSON，不要解释，不要省略任何一拍。' +
        (lastRaw ? `\n上一次输出：\n${lastRaw}` : '');

    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n---\n\n${PLAN_PROMPT}` },
          { role: 'user', content: userContent },
        ],
        ...options,
        jsonOutput: true,
        // 实测：6 拍 / 45 段的完整节拍表约 1558 tokens；加上 functionReason、
        // targetChars 与 8 拍上限，2600 才留得住余量，2000 会在末拍截断。
        maxTokens: 2600,
      });

      lastRaw = String(result.content || '');
      lastUsage = result.usage || null;
      const check = validateBeatPlan(lastRaw);
      if (check.ok) {
        return { plan: check.plan, raw: lastRaw, errors: [], reason: '', usage: lastUsage };
      }
      lastErrors = check.errors;
    } catch (err) {
      if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
        return {
          plan: null,
          raw: lastRaw,
          errors: lastErrors,
          reason: err.code === 'AI_ABORTED' ? 'aborted' : 'timeout',
          usage: lastUsage,
        };
      }
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'error', usage: lastUsage };
    }
  }

  // R4：两次都不合格时按「最接近合法」的版本交付，不丢给写手直写。
  // 修复只夹边界与补占位，不猜剧情；缺功能拍/对手会在 plan_degraded 里写明。
  const salvaged = salvageBeatPlan(lastRaw);
  if (salvaged) {
    return { plan: salvaged, raw: lastRaw, errors: lastErrors, reason: 'salvaged', usage: lastUsage };
  }
  return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'invalid', usage: lastUsage };
}

/**
 * 覆盖自检调用。失败返回 null，由路由按「未自检」交付。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {Object} params.plan
 * @param {string} params.body 正文纯文本
 * @param {Object} [params.options]
 * @returns {Promise<{coverage: Object|null, reason: string}>}
 */
async function checkBeatCoverage({ provider, plan, body, options = {} }) {
  if (!plan || !body || !body.trim()) return { coverage: null, reason: 'no_body' };

  try {
    const result = await provider.chat({
      messages: [
        { role: 'system', content: COVERAGE_PROMPT },
        {
          role: 'user',
          content: `《节拍表》\n${JSON.stringify(plan)}\n\n《正文》\n${body.slice(0, 20000)}`,
        },
      ],
      ...options,
      // 自检只需要判断，不需要发散。
      temperature: 0.2,
      jsonOutput: true,
      maxTokens: 800,
    });

    const coverage = validateCoverage(result.content, plan);
    return {
      coverage,
      reason: coverage ? '' : 'invalid',
      usage: result.usage || null,
    };
  } catch (err) {
    if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
      return { coverage: null, reason: 'timeout', usage: null };
    }
    return { coverage: null, reason: 'error', usage: null };
  }
}

/** 纯汉字计数：篇幅配比只看正文汉字，不含标点与空白。 */
function cjkCount(value) {
  return Array.from(String(value || '')).filter((ch) => /[\u4e00-\u9fff]/.test(ch)).length;
}

function shareParagraphRanges(beats, paragraphCount) {
  const weights = beats.map((beat) => Math.max(1, Number(beat.paragraphs) || 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const ranges = [];
  let from = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const last = i === beats.length - 1;
    const to = last
      ? paragraphCount
      : Math.min(paragraphCount, Math.max(from, from + Math.round((weights[i] / totalWeight) * paragraphCount)));
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}

/**
 * 正文实际篇幅配比：逐拍量纯汉字，和目标 wordShare 比，超过 ±5pp 就记账。
 *
 * 只报告、不改写——配比是规划问题，重写逃不出一份本来就失衡的节拍表。
 *
 * @param {Object} plan 已校验节拍表
 * @param {string} body 正文
 * @param {number} [tolerance=5] 允许偏离的百分点
 * @returns {{applicable: boolean, total: number, beats: Array, outOfRange: string[],
 *           shareMissing: string[], reason?: string}}
 */
function checkWordShares(plan, body, tolerance = SHARE_TOLERANCE) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const paragraphs = String(body || '')
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean);
  const emptyRoleShares = SHARE_ROLES.map((rule) => ({
    function: rule.role,
    label: rule.label,
    target: rule.target,
    range: [rule.target - tolerance, rule.target + tolerance],
    share: null,
    hit: false,
    present: false,
  }));
  if (!beats.length || !paragraphs.length) {
    return {
      applicable: false,
      total: 0,
      beats: [],
      roleShares: emptyRoleShares,
      outOfRange: [],
      shareMissing: [],
    };
  }

  const ranges = shareParagraphRanges(beats, paragraphs.length);
  const rows = [];
  const total = cjkCount(paragraphs.join(''));
  for (let i = 0; i < beats.length; i += 1) {
    const [from, to] = ranges[i];
    const chars = to > from ? cjkCount(paragraphs.slice(from, to).join('')) : 0;
    const share = total > 0 ? Math.round((chars / total) * 1000) / 10 : 0;
    const target = Number(beats[i].wordShare);
    const beatFunction = BEAT_FUNCTIONS.includes(beats[i].function) ? beats[i].function : '';
    const hasTarget = Number.isFinite(target);
    rows.push({
      id: beats[i].id,
      function: beatFunction,
      label: FUNCTION_LABELS[beatFunction] || '',
      target: hasTarget ? target : null,
      range: hasTarget ? [Math.round((target - tolerance) * 10) / 10, Math.round((target + tolerance) * 10) / 10] : null,
      share,
      delta: hasTarget ? Math.round((share - target) * 10) / 10 : null,
      hit: hasTarget ? Math.abs(share - target) <= tolerance : false,
      chars,
    });
  }

  // 按功能汇总：检查表要的是「identity ≥25%、farewell ≥20%」，
  // 不是逐拍数字。同类功能多拍时把实际份额相加再和规则目标比。
  const roleShares = SHARE_ROLES.map((rule) => {
    const sameRole = rows.filter((row) => row.function === rule.role);
    const share = sameRole.length
      ? Math.round(sameRole.reduce((sum, row) => sum + row.share, 0) * 10) / 10
      : null;
    return {
      function: rule.role,
      label: rule.label,
      target: rule.target,
      range: [rule.target - tolerance, rule.target + tolerance],
      share,
      hit: sameRole.length ? Math.abs(share - rule.target) <= tolerance : false,
      present: sameRole.length > 0,
    };
  });

  const shareMissing = Array.isArray(plan?.shareMissing) ? plan.shareMissing : [];
  // 六段功能拍没排齐时，剩余目标份额合计不到 100：再按绝对配比逐个判越界，
  // 等于把「计划缺拍」伪装成「正文每一拍都写错」。这里只报缺哪类功能拍，
  // 不产出逐拍越界清单；结构问题归规划层，不赖在写手身上。
  if (shareMissing.length) {
    return {
      applicable: false,
      reason: 'share_missing',
      shareMissing,
      total,
      beats: rows,
      roleShares,
      outOfRange: [],
    };
  }
  const outOfRange = rows
    .filter((row) => row.target !== null && Math.abs(row.delta) > tolerance)
    .map((row) => row.id);
  return { applicable: true, total, beats: rows, roleShares, outOfRange, shareMissing };
}

module.exports = {
  BEAT_TYPES,
  BEAT_FUNCTIONS,
  FUNCTION_LABELS,
  DELTA_VARIABLES,
  PLAN_PROMPT,
  COVERAGE_PROMPT,
  validateBeatPlan,
  salvageBeatPlan,
  functionCoverage,
  buildFunctionReplanInstruction,
  checkWordShares,
  validateCoverage,
  formatBeatPlan,
  buildRewriteInstruction,
  beatBadge,
  generateBeatPlan,
  checkBeatCoverage,
};
