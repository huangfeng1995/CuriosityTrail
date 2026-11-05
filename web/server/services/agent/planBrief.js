'use strict';

/**
 * 分场 brief：把「这一章必须发生什么」提前到节拍规划之前。
 *
 * 现状的断点不在写手：提纲只写了「父亲来接他，全家告别」，
 * 规划器就排不出「交犀角弓」「司马防托付」这些拍，写手自然写不出。
 * 这一步只做一件事：把必须发生的动作列成可追溯的清单，供规划器硬覆盖，
 * 供写手当具体到物的约束。
 *
 * 纯逻辑 + 一次 provider 调用：不碰数据库、不认识 Express。
 */

const { parseModelJson } = require('./parse');

const KINDS = ['loss', 'mustPresent', 'mustWithhold', 'mustReveal', 'evidence'];

/**
 * 硬约束类别：规划器必须把它们落到某一拍。
 * mustReveal 不在这里——它由首次出场章另行校验，不参与节拍硬覆盖。
 */
const HARD_KINDS = ['loss', 'mustPresent', 'mustWithhold'];

const MAX_ITEMS_PER_KIND = 6;
const MAX_KEYWORDS = 6;

const BRIEF_PROMPT = `你是章节分场 brief 规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
任务：根据本章大纲、作品大纲、人物卡、设定、素材与上一章结尾，回答「这一章必须发生哪些动作」。
输出格式：{"items":[{"kind":"loss|mustPresent|mustWithhold|mustReveal|evidence","text":"具体动作，写到物、写到人","keywords":["能在正文或节拍表里被逐字命中的词"],"source":"本章大纲|作品大纲|人物卡|设定|素材|上一章","inferred":false}]}
五类含义：
- loss：不可逆损失/交出物/说出口的话/做出的决定。必须具体到物，如「交出犀角弓」。
- mustPresent：关键人物必须到场，尤其长辈、托付人、见证人。写清是谁、来做什么。
- mustWithhold：本章必须隐瞒、不得解释的信息，防止人物把悬念解释掉。写清「不得解释什么」。
- mustReveal：必须交代的背景信息，如年龄、籍贯、寄养原因。每项要能一句话说清。
- evidence：物证或制度异常，如符传形制、逾制信号。
每条必须能追溯到给定输入：source 填来源，或 inferred 填 true。inferred=true 只表示你的推断，
只能作为建议，不能当成硬约束；不要为了凑数编造人物、器物或事件。
每条 keywords 给 1–4 个能在文本中逐字命中的词，优先用器物名、人名、地名、制度名。`;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unique(list) {
  return Array.from(new Set(list));
}

function normalizeKeywords(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string') {
    raw = value.split(/[,，、;；|]/);
  }
  const keywords = [];
  for (const item of raw) {
    const word = text(item).replace(/\s+/g, '');
    if (word.length < 2) continue;
    if (!keywords.includes(word)) keywords.push(word);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

function normalizeItem(raw, index, dropped) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push(`第 ${index + 1} 条不是对象`);
    return null;
  }
  const kind = text(raw.kind);
  if (!KINDS.includes(kind)) {
    dropped.push(`第 ${index + 1} 条 kind 不合法：${kind || '空'}`);
    return null;
  }
  const itemText = text(raw.text);
  if (!itemText) {
    dropped.push(`第 ${index + 1} 条 text 为空`);
    return null;
  }
  const inferred = raw.inferred === true;
  const source = text(raw.source);
  if (!source && !inferred) {
    // 追溯不到输入的条目不能进 brief：否则规划器会把模型臆造当硬约束。
    dropped.push(`第 ${index + 1} 条没有来源且未标 inferred：「${itemText}」`);
    return null;
  }
  return {
    id: `${kind[0].toUpperCase()}${index + 1}`,
    kind,
    text: itemText,
    keywords: normalizeKeywords(raw.keywords),
    source: inferred && !source ? 'inferred' : source,
    inferred,
  };
}

/**
 * 校验并归一化一份分场 brief。
 *
 * @param {Object|string} candidate 模型输出（对象或 JSON 原文）
 * @returns {{ok: boolean, brief: {items: Array, dropped: string[]}|null, errors: string[]}}
 */
function validatePlanBrief(candidate) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  const errors = [];
  const dropped = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, brief: null, errors: ['没有解析出 JSON 对象'] };
  }

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const seen = new Set();
  const items = [];

  for (let index = 0; index < rawItems.length; index++) {
    const item = normalizeItem(rawItems[index], index, dropped);
    if (!item) continue;
    const key = `${item.kind}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  const byKind = new Map();
  const limited = [];
  for (const item of items) {
    const count = byKind.get(item.kind) || 0;
    if (count >= MAX_ITEMS_PER_KIND) {
      dropped.push(`超出 ${item.kind} 数量上限：「${item.text}」`);
      continue;
    }
    byKind.set(item.kind, count + 1);
    limited.push({ ...item, id: `${item.kind[0].toUpperCase()}${count + 1}` });
  }

  return {
    ok: true,
    brief: { items: limited, dropped },
    errors,
  };
}

function groupByKind(brief, kinds) {
  const items = (brief && Array.isArray(brief.items) ? brief.items : []).filter(
    (item) => kinds.includes(item.kind) && item.inferred !== true
  );
  return items;
}

function itemLine(item) {
  const source = item.source ? `（来源：${item.source}）` : '';
  const keywords = item.keywords && item.keywords.length
    ? `（关键词：${item.keywords.join('、')}）`
    : '';
  return `- [${item.kind}] ${item.text}${source}${keywords}`;
}

/**
 * 把 brief 格式化成规划/写作共用的硬约束块。没有条目时返回空串，
 * 由调用方按「无 brief」回落旧行为。
 *
 * @param {{items: Array}|null} brief
 * @returns {string}
 */
function formatPlanBrief(brief) {
  if (!brief || !Array.isArray(brief.items) || !brief.items.length) return '';

  const hard = groupByKind(brief, ['loss']);
  const present = groupByKind(brief, ['mustPresent']);
  const withhold = groupByKind(brief, ['mustWithhold']);
  const reveal = groupByKind(brief, ['mustReveal']);
  const evidence = groupByKind(brief, ['evidence']);
  const inferred = brief.items.filter((item) => item.inferred === true);

  const lines = [
    '## 本章分场 brief（来自前一步，必须落实到节拍表与正文）',
    '下列硬约束必须分别落到某一拍的 goal/obstacle/cost 或正文的具体动作里；不得用抽象概括代替。',
  ];

  const sections = [
    ['不可逆损失/交出物/决定', hard],
    ['必须到场的人物', present],
    ['必须 withhold、不得解释的信息', withhold],
    ['必须交代的背景信息', reveal],
    ['物证/制度异常', evidence],
  ];
  for (const [label, items] of sections) {
    if (!items.length) continue;
    lines.push(`${label}：`);
    for (const item of items) lines.push(itemLine(item));
  }

  if (inferred.length) {
    lines.push('仅供参考（inferred，不得当成硬约束、不得为了它新增事实）：');
    for (const item of inferred) lines.push(itemLine(item));
  }

  return lines.join('\n');
}

function beatHaystack(beat) {
  if (!beat || typeof beat !== 'object') return '';
  const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
  return [
    beat.goal,
    beat.obstacle,
    beat.cost,
    beat.infoGain,
    beat.endHook,
    delta.variable,
    delta.from,
    delta.to,
  ]
    .map((x) => text(x))
    .filter(Boolean)
    .join('\n');
}

function itemHit(item, haystack) {
  if (haystack.includes(item.text)) return true;
  const terms = item.keywords && item.keywords.length ? item.keywords : [item.text];
  const hits = terms.filter((term) => term.length >= 2 && haystack.includes(term)).length;
  // 单关键词命中即可；多关键词至少要命中两个锚点，
  // 否则「司马防」单独出现就会被判成「司马防到场并当面托付」已覆盖。
  return hits >= Math.min(2, terms.length);
}

/**
 * 校验节拍表是否覆盖 brief 的硬约束。
 *
 * @param {{items: Array}|null} brief
 * @param {Object|null} plan validateBeatPlan 归一化后的节拍表
 * @returns {{covered: string[], missing: Array<{id,kind,text}>, hardTotal: number}}
 */
function briefCoverage(brief, plan) {
  const hard = groupByKind(brief, HARD_KINDS);
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const haystacks = beats.map(beatHaystack);

  const covered = [];
  const missing = [];
  for (const item of hard) {
    const hit = haystacks.some((haystack) => itemHit(item, haystack));
    if (hit) covered.push(item.id);
    else missing.push({ id: item.id, kind: item.kind, text: item.text });
  }

  return { covered, missing, hardTotal: hard.length };
}

/**
 * 给写手组指令的具体约束块。
 *
 * 只写非 inferred 的项；每行都具体到物、到人、到不得解释的内容。
 *
 * @param {{items: Array}|null} brief
 * @returns {string}
 */
function briefWriterBlock(brief) {
  if (!brief || !Array.isArray(brief.items) || !brief.items.length) return '';

  const lines = [];
  const loss = groupByKind(brief, ['loss']);
  const present = groupByKind(brief, ['mustPresent']);
  const withhold = groupByKind(brief, ['mustWithhold']);
  const reveal = groupByKind(brief, ['mustReveal']);
  const evidence = groupByKind(brief, ['evidence']);

  if (loss.length) lines.push(`- 本章不可逆损失/交出物：${loss.map((x) => x.text).join('；')}`);
  if (present.length) lines.push(`- 必须到场：${present.map((x) => x.text).join('；')}`);
  if (withhold.length) lines.push(`- 不得解释（必须 withhold）：${withhold.map((x) => x.text).join('；')}`);
  if (reveal.length) lines.push(`- 必须交代（每项至少一句）：${reveal.map((x) => x.text).join('；')}`);
  if (evidence.length) lines.push(`- 必须落地的物证/制度异常：${evidence.map((x) => x.text).join('；')}`);

  const inferred = brief.items.filter((item) => item.inferred === true);
  if (inferred.length) {
    lines.push(`- 建议（inferred，可不用，不得为它新增事实）：${inferred.map((x) => x.text).join('；')}`);
  }

  if (!lines.length) return '';
  return ['## 本章不可逆约束（具体到物，不能抽象化）', ...lines].join('\n');
}

/**
 * 把硬缺项分配到「最近可落点」，仅用于重排指令的文案。
 *
 * 不修改模型返回的节拍表：规划器有它自己的结构校验，
 * 这里只告诉它「这一项应该落在哪一拍附近」。
 *
 * @param {Object|null} plan
 * @param {{missing: Array}} coverage
 * @returns {Array<{id,kind,text,targetBeats: string[], hint: string}>}
 */
function partitionCoverage(plan, coverage) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const missing = coverage && Array.isArray(coverage.missing) ? coverage.missing : [];

  return missing.map((item) => {
    const target = beats.find((beat) => {
      const haystack = beatHaystack(beat);
      if (item.kind === 'loss') return /代价|交|失去|决定|放弃/.test(haystack);
      if (item.kind === 'mustPresent') return /见|到|来|托付|告别/.test(haystack);
      return false;
    });
    const fallback = beats.length ? beats[Math.max(0, beats.length - 2)] : null;
    const beat = target || fallback;
    return {
      ...item,
      targetBeats: beat ? [beat.id] : [],
      hint: beat
        ? `建议落到 ${beat.id}（该拍已有「${text(beat.goal).slice(0, 30)}」）`
        : '建议新增一拍承接这一项，或在现有拍里改写 goal/cost',
    };
  });
}

/**
 * 生成重排指令。把缺项和可落点一起给规划器，避免它原样再输出一遍。
 *
 * @param {Array} partitioned partitionCoverage 的结果
 * @returns {string}
 */
function buildReplanInstruction(partitioned) {
  if (!Array.isArray(partitioned) || !partitioned.length) return '';
  const lines = [
    '上一版节拍表没有覆盖分场 brief 的以下硬性动作，请重排节拍表（可以改 goal/obstacle/cost，必要时新增一拍）：',
  ];
  for (const item of partitioned) {
    lines.push(`- [${item.kind}] ${item.text}；${item.hint}`);
  }
  lines.push('每一项都必须能在某一拍的字段里被逐字命中；不要为了覆盖新增输入里没有的人物或事件。');
  return lines.join('\n');
}

/**
 * 分场 brief 调用。失败返回 brief=null，由路由回落到「无 brief」的旧链路。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} params.systemPrompt 与节拍规划共用的上下文快照
 * @param {string} params.instruction 作者本次的写作指令
 * @param {Object} [params.options] temperature/model/thinking/signal
 * @returns {Promise<{brief: Object|null, raw: string, errors: string[], reason: string, usage: Object|null}>}
 */
async function generatePlanBrief({ provider, systemPrompt, instruction, options = {} }) {
  const signal = options.signal || null;
  let lastRaw = '';
  let lastErrors = [];
  let lastUsage = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) {
      return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'timeout', usage: lastUsage };
    }

    const userContent = attempt === 0
      ? `请为这一章生成分场 brief。选题：${instruction}`
      : `上一次输出不合格：${lastErrors.join('；')}。只输出一个合格的 JSON 对象，不要解释。`;

    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n---\n\n${BRIEF_PROMPT}` },
          { role: 'user', content: userContent },
        ],
        ...options,
        jsonOutput: true,
        maxTokens: 1200,
      });

      lastRaw = String(result.content || '');
      lastUsage = result.usage || null;
      const check = validatePlanBrief(lastRaw);
      if (check.ok) {
        return {
          brief: check.brief,
          raw: lastRaw,
          errors: [],
          reason: '',
          usage: lastUsage,
        };
      }
      lastErrors = check.errors;
    } catch (err) {
      if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
        return {
          brief: null,
          raw: lastRaw,
          errors: lastErrors,
          reason: err.code === 'AI_ABORTED' ? 'aborted' : 'timeout',
          usage: lastUsage,
        };
      }
      return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'error', usage: lastUsage };
    }
  }

  return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'invalid', usage: lastUsage };
}

module.exports = {
  KINDS,
  HARD_KINDS,
  BRIEF_PROMPT,
  validatePlanBrief,
  formatPlanBrief,
  briefCoverage,
  briefWriterBlock,
  partitionCoverage,
  buildReplanInstruction,
  generatePlanBrief,
};
