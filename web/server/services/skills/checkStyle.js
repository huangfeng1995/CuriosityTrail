'use strict';

/**
 * 文风自查技能。
 *
 * 对着作者设定的文风规则核对正文，列出**确定**的违规项。
 *
 * 只做规则层：句长、对白占比、比喻密度、禁用词——这四项都能本地算准。
 * 定性要求（notes）不在这里判：它们已经随规则进了提示词，
 * 由模型自己在写的时候遵守。技能再花钱让模型判一遍意义不大，
 * 而且模型说「符合风格」是最没用的一种回答。
 *
 * 这个技能只读，不修改任何正文：结果回灌给模型，模型自己决定要不要重写。
 * 与另外两个技能（一致性核对、伏笔盘点）同构。
 */

const { get } = require('../../database');
const style = require('../style');
const { measureAll } = require('../style/metrics');
const { METRIC_LABELS, METRIC_UNITS, hasContent } = require('../style/rules');

/** 明细里最多列多少条 */
const DETAIL_LIMIT = 20;

/** 单条违规最多举几个例子 */
const EXAMPLE_LIMIT = 3;

/**
 * 核对一项数值维度。
 *
 * good 卡：期望落在 [min, max] 区间里。
 * bad 卡：超过 max 即违规。
 *
 * @param {Object} params
 * @param {string} params.kind 'good' | 'bad'
 * @param {Object} params.entry 该维度的 {min,max}
 * @param {number} params.actual 实际值
 * @param {string} params.label 维度名
 * @param {string} params.unit 单位
 * @returns {Object|null} 违规项，无违规返回 null
 */
function checkMetric({ kind, entry, actual, label, unit }) {
  if (!entry) return null;

  if (kind === 'bad') {
    if (entry.max === undefined) return null;
    if (actual <= entry.max) return null;
    return {
      label,
      detail: `实际 ${actual}${unit}，超过上限 ${entry.max}${unit}`,
      actual,
      limit: entry.max,
    };
  }

  const min = entry.min;
  const max = entry.max;

  if (min !== undefined && actual < min) {
    return {
      label,
      detail: `实际 ${actual}${unit}，低于期望下限 ${min}${unit}`,
      actual,
      limit: min,
    };
  }
  if (max !== undefined && actual > max) {
    return {
      label,
      detail: `实际 ${actual}${unit}，超过期望上限 ${max}${unit}`,
      actual,
      limit: max,
    };
  }
  return null;
}

/**
 * 查禁用词命中。
 *
 * @param {string} text
 * @param {Array<string>} words
 * @returns {{word: string, count: number, samples: Array<string>}}
 */
function checkBannedWords(text, words) {
  const hits = [];
  const sentences = text.split(/[。！？；!?;\n]+/).map((s) => s.trim()).filter(Boolean);

  for (const word of words) {
    if (!word) continue;
    let count = 0;
    let index = text.indexOf(word);
    while (index >= 0) {
      count += 1;
      index = text.indexOf(word, index + word.length);
    }
    if (!count) continue;

    const samples = [];
    for (const sentence of sentences) {
      if (sentence.includes(word)) {
        samples.push(sentence.length > 40 ? `${sentence.slice(0, 40)}…` : sentence);
        if (samples.length >= EXAMPLE_LIMIT) break;
      }
    }

    hits.push({ word, count, samples });
  }

  return hits;
}

/**
 * 技能主体。
 *
 * @param {Object} params
 * @param {string} [params.target] 要检查的正文片段。不填则检查当前章节全文。
 * @param {Object} ctx
 * @returns {Promise<Object>} { label, summary, detail, findings }
 */
async function run(params, ctx = {}) {
  const { userId, workId, chapterId } = ctx;
  const target = String((params && params.target) || '').trim();

  const label = '文风自查';

  // 没有作品就没有作品级规则，但全局规则仍然适用。
  const effective = await style.resolveEffectiveStyle(userId, workId);
  const hasGood = hasContent(effective.good && effective.good.rules);
  const hasBad = hasContent(effective.bad && effective.bad.rules);

  if (!hasGood && !hasBad) {
    return {
      label,
      summary: '还没有设定文风规则，没有可核对的项',
      detail: [],
      findings: [],
    };
  }

  // 取待检查的正文
  let text = target;
  let blocks = null;

  if (!text) {
    if (!chapterId) {
      return {
        label,
        summary: '没有指定要检查的正文，也没有当前章节',
        detail: [],
        findings: [],
      };
    }
    const chapter = await get(
      `SELECT c.blocks, c.content FROM chapters c
       JOIN works w ON w.id = c.work_id
       WHERE c.id = ? AND w.user_id = ?`,
      [chapterId, userId]
    );
    if (!chapter) {
      return { label, summary: '没有找到当前章节', detail: [], findings: [] };
    }
    blocks = parseBlocks(chapter.blocks);
    text = blocks
      .map((b) => (b && b.content ? b.content : ''))
      .filter(Boolean)
      .join('\n\n');
    if (!text) text = chapter.content || '';
  }

  if (!text || !text.trim()) {
    return { label, summary: '没有可检查的正文', detail: [], findings: [] };
  }

  const metrics = measureAll(text, blocks);
  const findings = [];

  // ---- 数值维度 ----
  for (const kind of ['good', 'bad']) {
    const rules = kind === 'good' ? effective.good.rules : effective.bad.rules;
    if (!rules || !rules.metrics) continue;

    for (const [key, entry] of Object.entries(rules.metrics)) {
      let actual;
      if (key === 'sentenceLength') actual = metrics.sentenceLength.avg;
      else if (key === 'dialogueRatio') actual = metrics.dialogueRatio;
      else if (key === 'imageryDensity') actual = metrics.imageryDensity;
      else continue;

      const violation = checkMetric({
        kind,
        entry,
        actual,
        label: METRIC_LABELS[key] || key,
        unit: METRIC_UNITS[key] || '',
      });
      if (!violation) continue;

      findings.push({
        kind,
        dimension: key,
        label: violation.label,
        detail: violation.detail,
        actual: violation.actual,
        limit: violation.limit,
      });
    }
  }

  // 句长违规时附上最长的几句，让作者能直接看到问题在哪
  const lengthFinding = findings.find((f) => f.dimension === 'sentenceLength');
  if (lengthFinding && metrics.sentenceLength.sentences.length) {
    const longest = [...metrics.sentenceLength.sentences]
      .sort((a, b) => b.words - a.words)
      .slice(0, EXAMPLE_LIMIT)
      .map((s) => `${s.words} 字：${s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text}`);
    lengthFinding.samples = longest;
  }

  // ---- 禁用词 ----
  const bannedHits = [];
  for (const kind of ['good', 'bad']) {
    const rules = kind === 'good' ? effective.good.rules : effective.bad.rules;
    if (!rules || !rules.bannedWords.length) continue;
    for (const hit of checkBannedWords(text, rules.bannedWords)) {
      bannedHits.push({ kind, ...hit });
    }
  }
  for (const hit of bannedHits) {
    findings.push({
      kind: hit.kind,
      dimension: 'bannedWords',
      label: `禁用词「${hit.word}」`,
      detail: `出现 ${hit.count} 次`,
      samples: hit.samples,
    });
  }

  const detail = findings.slice(0, DETAIL_LIMIT).map((f) => ({
    label: f.label,
    text: f.detail + (f.samples && f.samples.length ? `｜${f.samples.join('；')}` : ''),
  }));

  let summary;
  if (!findings.length) {
    summary = `按 ${metrics.words} 字核对，未发现违反规则的地方`;
  } else {
    summary = `发现 ${findings.length} 处不符合文风规则`;
    if (findings.length > DETAIL_LIMIT) {
      summary += `（仅列出前 ${DETAIL_LIMIT} 条）`;
    }
  }

  return { label, summary, detail, findings };
}

/**
 * 解析章节块。
 */
function parseBlocks(blocksJson) {
  if (!blocksJson) return [];
  try {
    const parsed = JSON.parse(blocksJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

module.exports = {
  name: 'check_style',
  label: '文风自查',
  description:
    '按作者设定的文风规则检查正文：句长、对白占比、比喻密度、禁用词。当作者问「这段文风有没有问题」「符不符合我的风格」「帮我看看哪里不像我的写法」时使用。只做规则核对，不改正文。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '要检查的正文片段。不填则检查当前章节全文。',
      },
    },
    required: [],
  },
  run,
  _internal: {
    checkMetric,
    checkBannedWords,
  },
};
