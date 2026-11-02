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

/** 变量：每拍至少改变一个 */
const DELTA_VARIABLES = ['处境', '关系', '信息', '决心'];

/** 节拍数范围 */
const MIN_BEATS = 4;
const MAX_BEATS = 8;

/** 单拍段数 */
const MIN_PARAGRAPHS = 1;
const MAX_PARAGRAPHS = 4;

/** 全章段数 */
const MIN_TOTAL_PARAGRAPHS = 8;
const MAX_TOTAL_PARAGRAPHS = 14;

/** 空钩子话术，出现即判不合格 */
const EMPTY_HOOKS = ['且听下回分解', '欲知后事', '下回分解'];

/**
 * 规划提示词。独立于 writer.js 的正文提示词——规划器只描述节拍表，
 * 不写正文，避免模型顺手开始写小说。
 */
const PLAN_PROMPT = `你是章节节拍规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
字段：chapterGoal, protagonistIntent, obstacle, cost, hook, avoidRepeat（数组，可为空）, mainType, beats[]。
beats 4–8 个；每拍含 id（B1…Bn）、type（行动|转折|冲突|揭示|决定|过渡）、goal、obstacle、cost、
delta{variable:处境|关系|信息|决心, from, to}、infoGain、paragraphs（1–4）、endHook（这一拍结束时的悬念或钩子）。
全章 paragraphs 合计 8–14。每个节拍必须让至少一个变量发生改变，必须写出代价，禁止空转抒情段。
mainType 必须与某一个 beats[].type 相同。只依据给定上下文，不新增未提供的人物或设定。`;

/**
 * 自检提示词。
 */
const COVERAGE_PROMPT = `你是节拍覆盖检查器。只输出一个 JSON 对象，不要解释、不要 markdown。
输入是《节拍表》和一段正文。逐个节拍判断它是否真正落到正文里：
- covered：该拍的 goal 或 obstacle 能在正文里找到对应的事件句，并且 delta.from→to 或 infoGain 至少有一项能找到对应句；
- weak：写了事件，但没有写出变量变化（元素为 {id, reason}）；
- missing：完全不满足前一条，或整拍被「总之/后来/从此」类总结句替代。
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
  let totalParagraphs = 0;

  rawBeats.forEach((beat, index) => {
    const where = `第 ${index + 1} 拍`;
    if (!beat || typeof beat !== 'object') {
      errors.push(`${where}不是对象`);
      return;
    }

    const id = text(beat.id) || `B${index + 1}`;
    const type = text(beat.type);
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

    beats.push({
      id,
      type,
      goal,
      obstacle: beatObstacle,
      cost: beatCost,
      delta: { variable, from, to },
      infoGain,
      paragraphs: Number.isInteger(paragraphs) ? paragraphs : 0,
      endHook,
    });
  });

  if (beats.length && (totalParagraphs < MIN_TOTAL_PARAGRAPHS || totalParagraphs > MAX_TOTAL_PARAGRAPHS)) {
    errors.push(`全章段落数必须在 ${MIN_TOTAL_PARAGRAPHS}–${MAX_TOTAL_PARAGRAPHS} 之间，收到 ${totalParagraphs}`);
  }
  if (mainType && beats.length && !beats.some((b) => b.type === mainType)) {
    errors.push('mainType 必须与某一个节拍的 type 相同');
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
    },
    errors: [],
  };
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
  const covered = unique(toIds(data.covered, false)).filter((id) => !weakIds.includes(id));
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
 * @returns {string}
 */
function buildRewriteInstruction(plan, coverage) {
  const byId = new Map((plan && plan.beats ? plan.beats : []).map((b) => [b.id, b]));
  const lines = [
    `（覆盖自检结果：正文没有完整覆盖节拍表。缺失：${coverage.missing.join('、') || '无'}。）`,
    '请重写全文，按 B1→Bn 顺序补足下面这些节拍，不要局部插入，不要解释：',
  ];

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

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) {
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'timeout' };
    }

    const userContent = attempt === 0
      ? `请为这一章生成节拍表。选题：${instruction}`
      : `上一次输出不合格：${lastErrors.join('；')}。只输出一个合格的 JSON 对象，不要解释。`;

    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n---\n\n${PLAN_PROMPT}` },
          { role: 'user', content: userContent },
        ],
        ...options,
        jsonOutput: true,
        maxTokens: 1200,
      });

      lastRaw = String(result.content || '');
      const check = validateBeatPlan(lastRaw);
      if (check.ok) {
        return { plan: check.plan, raw: lastRaw, errors: [], reason: '' };
      }
      lastErrors = check.errors;
    } catch (err) {
      if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
        return {
          plan: null,
          raw: lastRaw,
          errors: lastErrors,
          reason: err.code === 'AI_ABORTED' ? 'aborted' : 'timeout',
        };
      }
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'error' };
    }
  }

  return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'invalid' };
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
    return { coverage, reason: coverage ? '' : 'invalid' };
  } catch (err) {
    if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
      return { coverage: null, reason: 'timeout' };
    }
    return { coverage: null, reason: 'error' };
  }
}

module.exports = {
  BEAT_TYPES,
  DELTA_VARIABLES,
  PLAN_PROMPT,
  COVERAGE_PROMPT,
  validateBeatPlan,
  validateCoverage,
  formatBeatPlan,
  buildRewriteInstruction,
  beatBadge,
  generateBeatPlan,
  checkBeatCoverage,
};
