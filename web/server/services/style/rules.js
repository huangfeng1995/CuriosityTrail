'use strict';

/**
 * 文风规则的合并与格式化。
 *
 * 纯函数，不碰数据库、不碰 provider。
 *
 * 规则卡的结构固定（见设计文档 §3.2），因为固定槽位才能被
 * check_style 确定地核对。自由散文形式的规则模型只能「大致理解」，
 * 作者也无法一眼看出自己的要求是什么。
 *
 * good 卡与 bad 卡的 metrics 语义不同：
 *   good —— min/max 是期望落在这个区间里
 *   bad  —— max 是警戒上限，超过即违规；min 忽略
 */

const METRIC_KEYS = ['sentenceLength', 'dialogueRatio', 'imageryDensity'];

const METRIC_LABELS = {
  sentenceLength: '句长',
  dialogueRatio: '对白占比',
  imageryDensity: '比喻密度',
};

const METRIC_UNITS = {
  sentenceLength: '字/句',
  dialogueRatio: '%',
  imageryDensity: '处/千字',
};

/** 空规则。合并的起点。 */
const EMPTY_RULES = Object.freeze({
  summary: '',
  metrics: {},
  bannedWords: [],
  notes: [],
});

/**
 * 归一化一张卡的规则：补齐缺省字段、丢掉非法值。
 *
 * 模型输出的 JSON 不一定干净（数字写成字符串、数组里混进对象），
 * 脏数据必须在这里被挡掉，不能流到后面的比较运算里。
 *
 * @param {Object} raw
 * @returns {{summary: string, metrics: Object, bannedWords: Array<string>, notes: Array<string>}}
 */
function normalizeRules(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const metrics = {};
  const rawMetrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
  for (const key of METRIC_KEYS) {
    const entry = rawMetrics[key];
    if (!entry || typeof entry !== 'object') continue;
    const min = toNumber(entry.min);
    const max = toNumber(entry.max);
    if (min === null && max === null) continue;
    metrics[key] = {};
    if (min !== null) metrics[key].min = min;
    if (max !== null) metrics[key].max = max;
  }

  return {
    summary: typeof source.summary === 'string' ? source.summary.trim() : '',
    metrics,
    bannedWords: toStringList(source.bannedWords),
    notes: toStringList(source.notes),
  };
}

/**
 * 转数字。空串、null、非数一律当作「没给」。
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

/**
 * 转字符串数组。去掉空串、去重、限长。
 */
function toStringList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * 合并同一 kind 的多张卡。
 *
 * 数值取交集：多张好样例的共性就是交集。
 * 若交集为空（两张卡的要求互相矛盾），退回并集并在 conflicts 里记一笔——
 *   矛盾的要求不能丢掉，作者得知道有这回事。
 * 词表取并集。
 *
 * @param {Array<{kind: string, rules: Object}>} cards
 * @returns {{rules: Object, conflicts: Array<string>}}
 */
function mergeRules(cards) {
  const list = (cards || []).filter((c) => c && c.rules);
  if (!list.length) {
    return { rules: normalizeRules(null), conflicts: [] };
  }

  const conflicts = [];
  const merged = normalizeRules(null);

  // summary：多条拼接
  const summaries = list
    .map((c) => normalizeRules(c.rules).summary)
    .filter(Boolean);
  merged.summary = Array.from(new Set(summaries)).join('；');

  // 词表：并集
  const banned = new Set();
  const notes = new Set();
  for (const card of list) {
    const r = normalizeRules(card.rules);
    for (const w of r.bannedWords) banned.add(w);
    for (const n of r.notes) notes.add(n);
  }
  merged.bannedWords = Array.from(banned);
  merged.notes = Array.from(notes);

  // 数值：交集
  for (const key of METRIC_KEYS) {
    const mins = [];
    const maxs = [];
    for (const card of list) {
      const r = normalizeRules(card.rules);
      const entry = r.metrics[key];
      if (!entry) continue;
      if (entry.min !== undefined) mins.push(entry.min);
      if (entry.max !== undefined) maxs.push(entry.max);
    }
    if (!mins.length && !maxs.length) continue;

    const mergedMin = mins.length ? Math.max(...mins) : undefined;
    const mergedMax = maxs.length ? Math.min(...maxs) : undefined;

    if (mergedMin !== undefined && mergedMax !== undefined && mergedMin > mergedMax) {
      conflicts.push(`${METRIC_LABELS[key]}：各张卡的要求互相矛盾（${mergedMin} 与 ${mergedMax}），已放宽为并集`);
      merged.metrics[key] = {
        min: mins.length ? Math.min(...mins) : undefined,
        max: maxs.length ? Math.max(...maxs) : undefined,
      };
      continue;
    }

    merged.metrics[key] = {};
    if (mergedMin !== undefined) merged.metrics[key].min = mergedMin;
    if (mergedMax !== undefined) merged.metrics[key].max = mergedMax;
  }

  return { rules: merged, conflicts };
}

/**
 * 把生效规则格式化成注入提示词的文本。
 *
 * @param {{good: Object, bad: Object}} effective
 * @returns {string} 空串表示没有规则
 */
function formatStylePrompt(effective) {
  const lines = [];

  const good = effective && effective.good ? effective.good.rules : null;
  const bad = effective && effective.bad ? effective.bad.rules : null;

  if (good && hasContent(good)) {
    lines.push('### 要学的（作者欣赏的文风）');
    if (good.summary) lines.push(`整体感觉：${good.summary}`);
    const metrics = formatMetrics(good.metrics, 'good');
    if (metrics) lines.push(metrics);
    if (good.bannedWords.length) {
      lines.push(`这些词不要出现：${good.bannedWords.join('、')}`);
    }
    if (good.notes.length) {
      lines.push(`要点：${good.notes.join('；')}`);
    }
  }

  if (bad && hasContent(bad)) {
    lines.push('### 要避开的（作者不喜欢的文风）');
    if (bad.summary) lines.push(`整体感觉：${bad.summary}`);
    const metrics = formatMetrics(bad.metrics, 'bad');
    if (metrics) lines.push(metrics);
    if (bad.bannedWords.length) {
      lines.push(`这些词绝对不要出现：${bad.bannedWords.join('、')}`);
    }
    if (bad.notes.length) {
      lines.push(`要避免：${bad.notes.join('；')}`);
    }
  }

  if (!lines.length) return '';

  return [
    '## 文风要求',
    '以下是作者明确设定的文风标准，优先于你的默认文风。写正文时必须遵守。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * 格式化数值维度。
 *
 * good 卡给区间，bad 卡给上限——坏样例的「至少多少」没有意义。
 */
function formatMetrics(metrics, kind) {
  if (!metrics || !Object.keys(metrics).length) return '';

  const parts = [];
  for (const key of METRIC_KEYS) {
    const entry = metrics[key];
    if (!entry) continue;
    const label = METRIC_LABELS[key];
    const unit = METRIC_UNITS[key];

    if (kind === 'bad') {
      if (entry.max !== undefined) {
        parts.push(`${label}不超过 ${entry.max}${unit}`);
      }
      continue;
    }

    if (entry.min !== undefined && entry.max !== undefined) {
      parts.push(`${label}在 ${entry.min}–${entry.max}${unit}之间`);
    } else if (entry.min !== undefined) {
      parts.push(`${label}不少于 ${entry.min}${unit}`);
    } else if (entry.max !== undefined) {
      parts.push(`${label}不超过 ${entry.max}${unit}`);
    }
  }

  return parts.length ? parts.join('；') : '';
}

/**
 * 规则有没有实际内容。
 */
function hasContent(rules) {
  if (!rules) return false;
  return Boolean(
    rules.summary ||
      (rules.metrics && Object.keys(rules.metrics).length) ||
      (rules.bannedWords && rules.bannedWords.length) ||
      (rules.notes && rules.notes.length)
  );
}

module.exports = {
  METRIC_KEYS,
  METRIC_LABELS,
  METRIC_UNITS,
  EMPTY_RULES,
  normalizeRules,
  mergeRules,
  formatStylePrompt,
  formatMetrics,
  hasContent,
};
