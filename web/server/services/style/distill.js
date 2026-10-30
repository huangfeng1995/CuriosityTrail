'use strict';

/**
 * 风格蒸馏。
 *
 * 把一段样例原文变成可执行的文风规则。
 *
 * **原文只在这一刻存在**：调完模型就丢，绝不落库。
 * 理由见设计文档 §2.1——负样例进 prompt 会反向污染，
 * 原文也抢 24000 字的上下文预算。
 *
 * 模型只输出「可执行的风格特征」，不输出对原文的评价、不复述原文。
 * 句长、对话占比这类数字由本地先算好（metrics.js），
 * 作为事实依据喂给模型——模型自己数不准，作者也不会信它数出来的数。
 */

const { parseModelJson } = require('../agent/parse');
const { normalizeRules } = require('./rules');
const { measureAll } = require('./metrics');

/** 喂给模型的原文上限。超了截断，模型看全篇也没必要。 */
const SAMPLE_LIMIT = 4000;

/** 输出 token 上限。规则卡很小，给多了是浪费。 */
const MAX_TOKENS = 1200;

/**
 * 构造提示词。
 *
 * @param {'good'|'bad'} kind
 * @param {string} text 样例原文
 * @param {string} notes 作者的补充说明
 * @param {Object} metrics 本地算出的客观指标
 * @returns {string}
 */
function buildPrompt(kind, text, notes, metrics) {
  const isGood = kind === 'good';

  const facts = [
    `平均句长 ${metrics.sentenceLength.avg} 字（最长 ${metrics.sentenceLength.max} 字，共 ${metrics.sentenceLength.count} 句）`,
    `对白占比 ${metrics.dialogueRatio}%`,
    `比喻密度 ${metrics.imageryDensity} 处/千字`,
    `总字数 ${metrics.words}`,
  ];

  const lines = [
    isGood
      ? '你是文风分析助手。下面这段文字是作者欣赏的范本。'
      : '你是文风分析助手。下面这段文字是作者不喜欢的范本（可能是机器味太重的稿子）。',
    '',
    isGood
      ? '请提炼这段文字**可执行的风格特征**，让另一个写手能照着写。'
      : '请提炼这段文字**必须避免的风格特征**，让另一个写手知道要躲开什么。',
    '',
    '硬性要求：',
    '1. 只输出风格规则，不要评价内容，不要复述原文，不要模仿原文的措辞。',
    '2. 不要输出原文里的具体词句（作者不希望这些词被当成范例照抄）。',
    '3. 下面的客观数字是程序统计出来的，直接采用，不要自己估。',
    '',
    '客观数据：',
    ...facts.map((f) => `- ${f}`),
  ];

  if (notes && notes.trim()) {
    lines.push('', `作者的补充说明：${notes.trim()}`);
  }

  lines.push(
    '',
    '输出格式（严格 JSON，不要 markdown 代码块）：',
    '{',
    '  "summary": "一句话概括这段文字的整体文风特征（30 字以内）",',
    '  "metrics": {',
    isGood
      ? '    "sentenceLength": { "min": 数字, "max": 数字 },   // 每句字数的期望区间，依据上面的平均句长'
      : '    "sentenceLength": { "max": 数字 },                // 每句字数不要超过多少，依据上面的平均句长',
    isGood
      ? '    "dialogueRatio": { "min": 数字, "max": 数字 },     // 对白占比的期望区间（百分比）'
      : '    "dialogueRatio": { "max": 数字 },                 // 对白占比不要超过多少（百分比）',
    isGood
      ? '    "imageryDensity": { "max": 数字 }                 // 比喻密度上限（处/千字）'
      : '    "imageryDensity": { "max": 数字 }                 // 比喻密度不要超过多少（处/千字）',
    '  },',
    '  "bannedWords": ["这行文字里作者在意的负面词或模板词"],',
    '  "notes": ["定性要求，一句话一条，最多 4 条"]',
    '}',
    '',
    isGood
      ? '注意：bannedWords 填这段好文字里刻意回避的词（没有就给空数组）。'
      : '注意：bannedWords 填这段坏文字里的典型毛病词（8 个以内），这些词以后一律不准出现。'
  );

  return lines.join('\n');
}

/**
 * 蒸馏一段样例。
 *
 * @param {Object} params
 * @param {Object} params.provider 已解析的 provider
 * @param {'good'|'bad'} params.kind
 * @param {string} params.text 样例原文
 * @param {string} [params.notes]
 * @param {Array} [params.blocks] 样例来源是章节时的块结构（对话占比算得准）
 * @returns {Promise<Object>} 归一化后的规则
 * @throws 模型没给出可用规则时抛错（调用方据此不写卡）
 */
async function distill(params) {
  const { provider, kind, text, notes = '', blocks } = params;

  if (!provider) throw new Error('没有可用的 AI provider');
  if (!text || !String(text).trim()) throw new Error('样例内容不能为空');

  const sample = String(text).slice(0, SAMPLE_LIMIT);
  const metrics = measureAll(sample, blocks);

  const result = await provider.chat({
    messages: [
      { role: 'system', content: buildPrompt(kind, sample, notes, metrics) },
      { role: 'user', content: sample },
    ],
    temperature: 0.2,
    // 内部小判定：不需要长链推理，开思考只会更慢更贵。
    // 项目里已有先例：memory/extractor.js 的 extractFacts。
    thinking: 'disabled',
    jsonOutput: true,
    maxTokens: MAX_TOKENS,
  });

  const parsed = parseModelJson(result && result.content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('模型没有给出可解析的文风规则，请再试一次');
  }

  const rules = normalizeRules(parsed);

  // 一条规则都没有 = 这次蒸馏等于没做。
  // 写进库会让作者以为「我已经设好了」，实际什么都没生效——比报错更糟。
  if (
    !rules.summary &&
    !Object.keys(rules.metrics).length &&
    !rules.bannedWords.length &&
    !rules.notes.length
  ) {
    throw new Error('模型没有提炼出任何文风规则，请再试一次');
  }

  return rules;
}

/**
 * 从原文取一段摘要，供作者辨认样例是哪一段。
 *
 * 最多 100 字。样例原文可能来自别人的作品，留太长的片段不合适；
 * 但完全不留的话作者看到一排卡片分不清谁是谁。
 *
 * @param {string} text
 * @returns {string}
 */
function makeExcerpt(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
}

module.exports = {
  SAMPLE_LIMIT,
  MAX_TOKENS,
  distill,
  buildPrompt,
  makeExcerpt,
};
