'use strict';

/**
 * 历史锚点的校验、归一化与导入草稿。
 *
 * 这一层不碰数据库：输入候选 → 输出可直接落库的值，
 * 让路由可以在**整批校验通过后再写入**，实现 PV2 的「422 且零入库」。
 *
 * 规则投影（rule_type）只校验类型是否合法。参数的具体语义由 HP4 的
 * anchorCheck 负责；这里不做二次解释，避免两处各写一套判定。
 */

const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');
const { parseModelJson } = require('../agent/parse');

/** 与 work_anchors.kind 的 CHECK 保持一致 */
const KINDS = new Set(['event', 'person', 'time', 'place', 'office', 'custom']);

/** 与 work_anchors.confidence 的 CHECK 保持一致 */
const CONFIDENCES = new Set(['sourced', 'inferable', 'blank']);

/** 模型偶尔会写 inferred，统一归一到库里认的 inferable */
const CONFIDENCE_ALIASES = { inferred: 'inferable' };

/** P.5.4 允许的六种断言类型 */
const RULE_TYPES = new Set([
  'presence_forbidden',
  'event_forbidden',
  'term_forbidden',
  'chronology',
  'blank_guard',
  'manual_only',
]);

const MAX_CANDIDATES = 20;
const MAX_QUOTE_LENGTH = 200;
const DRAFT_TIMEOUT_MS = 60000;

/**
 * 校验失败。路由据此返回 4xx 而不是 500。
 */
class ValidationError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

/** 全角 ASCII → 半角 ASCII */
function toHalfWidth(value) {
  return String(value).replace(/[\uFF01-\uFF5E]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/**
 * 书名 / 卷次 / 条目的归一化：去所有空白 + 全角转半角。
 * 中文引证里这些字段不该带空格；「三 国 志」和「三国志」是同一本书。
 */
function normalizeSource(value) {
  if (value == null) return '';
  return toHalfWidth(value).replace(/\s+/g, '').trim();
}

/** 正文类字段：去首尾空白、内部连续空白压成一个空格 */
function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * 归一化 rules。
 *
 * 未知 rule_type 不拒绝整条锚点，只丢弃该条规则：
 * P.5.7 的既定策略是「规则坏了就降级为仅人工核对」，
 * 锚点正文本身仍然有价值，不能因为模型多写了一个类型就整条丢掉。
 *
 * @param {*} value
 * @returns {{rules: Array<{rule_type: string, params: Object}>, dropped: string[], degraded: boolean}}
 */
function normalizeRules(value) {
  let rules = value;
  if (typeof rules === 'string') {
    try {
      rules = JSON.parse(rules);
    } catch (e) {
      rules = [];
    }
  }
  if (!Array.isArray(rules)) rules = [];

  const out = [];
  const dropped = [];
  for (const item of rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = normalizeToken(item.rule_type);
    if (!RULE_TYPES.has(type)) {
      if (type) dropped.push(type);
      continue;
    }
    const params =
      item.params && typeof item.params === 'object' && !Array.isArray(item.params)
        ? item.params
        : {};
    out.push({ rule_type: type, params });
  }

  const degraded = out.length === 0;
  if (degraded) out.push({ rule_type: 'manual_only', params: {} });
  return { rules: out, dropped, degraded };
}

/**
 * 校验并归一化一条候选锚点。
 *
 * 即使有错也返回尽量完整的 value，供草稿页逐条置灰展示；
 * 真正导入时会因为 ok=false 整批 422。
 *
 * @param {*} raw
 * @returns {{ok: boolean, errors: string[], warnings: string[], value: Object}}
 */
function validateCandidate(raw) {
  const errors = [];
  const warnings = [];
  const value = {
    kind: '',
    subject: '',
    claim: '',
    confidence: '',
    source_title: '',
    source_locator: '',
    source_quote: '',
    rules: [{ rule_type: 'manual_only', params: {} }],
    immutable: 1,
    why_blank: '',
    usable_for: '',
  };

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['候选必须是对象'], warnings, value };
  }

  value.kind = normalizeToken(raw.kind);
  if (!KINDS.has(value.kind)) {
    errors.push(`kind 必须是 ${Array.from(KINDS).join('/')} 之一`);
  }

  value.subject = normalizeText(raw.subject);
  if (!value.subject) errors.push('subject 不能为空');

  value.claim = normalizeText(raw.claim);
  if (!value.claim) errors.push('claim 不能为空');

  const confidenceRaw = normalizeToken(raw.confidence);
  value.confidence = CONFIDENCE_ALIASES[confidenceRaw] || confidenceRaw;
  if (!CONFIDENCES.has(value.confidence)) {
    errors.push('confidence 必须是 sourced/inferable/blank 之一');
  }

  value.source_title = normalizeSource(raw.source_title);
  value.source_locator = normalizeSource(raw.source_locator);
  value.source_quote = normalizeText(raw.source_quote).slice(0, MAX_QUOTE_LENGTH);

  if (value.confidence === 'sourced') {
    if (!value.source_title || !value.source_locator) {
      errors.push('有出处的锚点必须同时提供 source_title 与 source_locator');
    }
  } else if (value.confidence === 'inferable') {
    // P.5.1：可推定至少要能给到书名
    if (!value.source_title) {
      errors.push('可推定锚点至少需要 source_title（可只到书名）');
    }
  }

  // immutable：blank 天然不能作为不可变校验器。
  // 显式传 1 视为作者/模型误用，必须报可读错误而不是让 CHECK 抛 500。
  const rawImmutable = raw.immutable;
  if (value.confidence === 'blank') {
    value.immutable = 0;
    if (
      rawImmutable !== undefined &&
      rawImmutable !== null &&
      (rawImmutable === true || rawImmutable === 1 || rawImmutable === '1')
    ) {
      errors.push('空白锚点不能设为不可变（immutable 必须为 0）');
    }
  } else if (rawImmutable !== undefined && rawImmutable !== null) {
    if (rawImmutable === false || rawImmutable === 0 || rawImmutable === '0') {
      value.immutable = 0;
    } else if (rawImmutable === true || rawImmutable === 1 || rawImmutable === '1') {
      value.immutable = 1;
    } else {
      errors.push('immutable 只能取 true/false');
    }
  }

  const ruleResult = normalizeRules(raw.rules);
  value.rules = ruleResult.rules;
  if (ruleResult.dropped.length) {
    warnings.push(
      `未知规则类型 ${ruleResult.dropped.join('、')} 已忽略${
        ruleResult.degraded ? '，该锚点降级为仅人工核对' : ''
      }`
    );
  }

  if (value.confidence === 'blank') {
    value.why_blank = normalizeText(raw.why_blank);
    value.usable_for = normalizeText(raw.usable_for);
  }

  return { ok: errors.length === 0, errors, warnings, value };
}

/**
 * 校验整批待导入候选。任何一条不合法 → 整批 422，调用方零写入。
 *
 * @param {*} candidates
 * @returns {Array<Object>} 归一化后的可落库值
 */
function validateImportBatch(candidates) {
  if (!Array.isArray(candidates)) {
    throw new ValidationError('candidates 必须是数组');
  }
  if (!candidates.length) {
    throw new ValidationError('没有可导入的候选锚点');
  }
  if (candidates.length > MAX_CANDIDATES) {
    throw new ValidationError(`一次最多导入 ${MAX_CANDIDATES} 条锚点`);
  }

  const values = [];
  candidates.forEach((raw, index) => {
    const result = validateCandidate(raw);
    if (!result.ok) {
      throw new ValidationError(`第 ${index + 1} 条候选：${result.errors.join('；')}`);
    }
    values.push(result.value);
  });
  return values;
}

// ---------------------------------------------------------------------------
// 导入草稿（AI 整理）
// ---------------------------------------------------------------------------

const DRAFT_SYSTEM_PROMPT = `你是历史悬疑小说的史实资料员。任务是整理指定时代与主题的史实锚点，供作者逐条确认后入库。

只输出 JSON，不要任何解释：
{
  "anchors": [
    {
      "kind": "event|person|time|place|office|custom",
      "subject": "主实体：曹操 / 建安四年 / 司空",
      "claim": "供人读、供模型读的一句断言",
      "confidence": "sourced|inferable|blank",
      "source_title": "书名或篇名",
      "source_locator": "卷次或条目",
      "source_quote": "原文摘录，不超过 200 字",
      "rules": [
        { "rule_type": "presence_forbidden", "params": { "persons": ["曹操"], "from_seq": 40 } }
      ]
    }
  ],
  "blankAreas": [
    { "topic": "哪一段史料空白", "why_blank": "为什么无载（亡佚/未记/争议）", "usable_for": "作者可在此虚构什么" }
  ]
}

硬要求：
1. 每条锚点必须给 confidence。sourced 必须同时给 source_title 与 source_locator；给不出卷次/条目就不要标 sourced。
2. 常见说法、学界通行说法不得写成 sourced；拿不准就写 inferable，并在 claim 里写「一般认为」。
3. rules 的 rule_type 只能是：presence_forbidden、event_forbidden、term_forbidden、chronology、blank_guard、manual_only。没有可执行规则就写 manual_only。
4. 史料无载的区间单独放进 blankAreas，不要混进 anchors。
5. 最多 20 条锚点。不确定的事实宁可少写，不要编造出处。`;

function draftNotice(reason) {
  return reason || '锚点整理失败，请稍后重试或手动录入';
}

/**
 * 带超时的模型调用。与卡片识别同一策略：超时即放弃，不重试。
 */
async function callWithTimeout(provider, messages, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([
      provider
        .chat({
          messages,
          temperature: 0.2,
          maxTokens: 2400,
          jsonOutput: true,
          thinking: 'disabled',
          signal:
            typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(timeoutMs)
              : undefined,
        })
        .catch((err) => ({ __error: err })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 空白区草稿归一化：没有 topic 的直接丢弃。 */
function normalizeBlankAreas(rawAreas) {
  if (!Array.isArray(rawAreas)) return [];
  return rawAreas
    .filter((area) => area && typeof area === 'object')
    .map((area) => ({
      topic: normalizeText(area.topic),
      why_blank: normalizeText(area.why_blank),
      usable_for: normalizeText(area.usable_for),
    }))
    .filter((area) => area.topic)
    .slice(0, MAX_CANDIDATES);
}

/**
 * 生成锚点草稿。**只返回候选，不落库**。
 *
 * 失败/超时/无 provider 一律返回空数组 + notice，不抛错：
 * 手工录入表单是兜底路径，整理失败不能阻塞作者。
 *
 * @param {Object} params
 * @param {string} params.topic 主题
 * @param {string} [params.era] 时代
 * @param {string} [params.hint] 补充提示
 * @param {Object} [params.provider] 仅供测试注入
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{anchors: Array, blankAreas: Array, notice: string}>}
 */
async function draftAnchors(params = {}) {
  const { topic, era, hint, provider, timeoutMs = DRAFT_TIMEOUT_MS } = params;

  let active = provider;
  if (!active) {
    try {
      active = resolveProvider(aiConfig.getConfig()).provider;
    } catch (e) {
      return { anchors: [], blankAreas: [], notice: draftNotice('没有可用的 AI provider') };
    }
  }

  const userLines = [`主题：${normalizeText(topic)}`];
  if (normalizeText(era)) userLines.push(`时代：${normalizeText(era)}`);
  if (normalizeText(hint)) userLines.push(`补充提示：${normalizeText(hint)}`);

  const messages = [
    { role: 'system', content: DRAFT_SYSTEM_PROMPT },
    { role: 'user', content: userLines.join('\n') },
  ];

  try {
    const result = await callWithTimeout(active, messages, timeoutMs);
    if (!result || result.__timedOut || result.__error) {
      return {
        anchors: [],
        blankAreas: [],
        notice: draftNotice(result && result.__timedOut ? '整理超时' : '模型调用失败'),
      };
    }

    const parsed = parseModelJson(result.content || '');
    const rawAnchors = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.anchors)
        ? parsed.anchors
        : [];
    const rawAreas = parsed && typeof parsed === 'object' ? parsed.blankAreas : [];

    const anchors = rawAnchors.slice(0, MAX_CANDIDATES).map((raw) => {
      const checked = validateCandidate(raw);
      return {
        ...checked.value,
        valid: checked.ok,
        errors: checked.errors,
        warnings: checked.warnings,
      };
    });

    return { anchors, blankAreas: normalizeBlankAreas(rawAreas), notice: '' };
  } catch (e) {
    return { anchors: [], blankAreas: [], notice: draftNotice('整理异常') };
  }
}

module.exports = {
  KINDS,
  CONFIDENCES,
  RULE_TYPES,
  MAX_CANDIDATES,
  MAX_QUOTE_LENGTH,
  ValidationError,
  toHalfWidth,
  normalizeSource,
  normalizeRules,
  validateCandidate,
  validateImportBatch,
  normalizeBlankAreas,
  draftAnchors,
};
