'use strict';

/**
 * 文风维度度量。
 *
 * 纯函数，不碰数据库、不碰 provider。所有口径与平台的字数统计一致
 * （见 wordCount.js），否则作者在编辑器里看到的字数和规则里的数字对不上。
 *
 * 这些度量是「规则层」的：免费、确定、立刻出结果。
 * 模型可以补充定性判断，但能不能说「这句 32 字、超过上限」这种事，
 * 必须是本地算的——模型自己数不准，作者也不会信。
 */

const { countWords } = require('../wordCount');

/** 句末标点。顿号、逗号不断句。 */
const SENTENCE_END = /[。！？；!?;…]+|\n+/;

/**
 * 比喻标记词。
 *
 * 已知不精确：「像」有动词义（"他像是在等"），会被算进比喻密度。
 * 这是有意接受的近似——意象密度本来就是个粗指标，
 * 拿它当「超过就提醒」的触发线足够，精确到个位数没有意义。
 */
const IMAGERY_MARKERS = ['像', '如同', '仿佛', '宛如', '好似', '犹如'];

/** 中文引号。用于从纯文本里估算对白占比。 */
const QUOTE_PAIRS = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
];

/**
 * 切句。
 *
 * @param {string} text
 * @returns {Array<{index: number, text: string}>}
 */
function splitSentences(text) {
  if (!text) return [];
  const out = [];
  let buffer = '';

  for (const ch of String(text)) {
    buffer += ch;
    if (SENTENCE_END.test(ch) && ch !== '\n') {
      const trimmed = buffer.trim();
      if (trimmed) out.push({ index: out.length, text: trimmed });
      buffer = '';
    }
  }

  const tail = buffer.trim();
  if (tail) out.push({ index: out.length, text: tail });

  return out;
}

/**
 * 量句长。
 *
 * @param {string} text
 * @returns {{avg: number, max: number, count: number, sentences: Array}}
 */
function measureSentenceLength(text) {
  const sentences = splitSentences(text)
    .map((s) => ({ index: s.index, text: s.text, words: countWords(s.text) }))
    .filter((s) => s.words > 0);

  if (!sentences.length) {
    return { avg: 0, max: 0, count: 0, sentences: [] };
  }

  const total = sentences.reduce((sum, s) => sum + s.words, 0);
  const maxSentence = sentences.reduce((m, s) => (s.words > m.words ? s : m), sentences[0]);

  return {
    avg: Math.round((total / sentences.length) * 10) / 10,
    max: maxSentence.words,
    count: sentences.length,
    sentences,
  };
}

/**
 * 量对白占比（百分比）。
 *
 * 有块结构时用块类型（`dialogue`）——这是准确的。
 * 只有纯文本时退化为引号内字符数估算：作者粘贴的样例通常带引号，
 * 估得准不准不重要，重要的是能给出**相对**的量级。
 *
 * @param {string} text
 * @param {Array} [blocks] 章节块
 * @returns {number} 0–100
 */
function measureDialogueRatio(text, blocks) {
  if (Array.isArray(blocks) && blocks.length) {
    const proseBlocks = blocks.filter((b) => b && b.type !== 'scene_break');
    const total = proseBlocks.reduce((sum, b) => sum + countWords(b.content || ''), 0);
    if (!total) return 0;
    const dialogue = proseBlocks
      .filter((b) => b.type === 'dialogue')
      .reduce((sum, b) => sum + countWords(b.content || ''), 0);
    return Math.round((dialogue / total) * 1000) / 10;
  }

  if (!text) return 0;

  let quoted = 0;
  let rest = '';
  for (const [open, close] of QUOTE_PAIRS) {
    let remaining = text;
    for (;;) {
      const start = remaining.indexOf(open);
      if (start < 0) break;
      const end = remaining.indexOf(close, start + open.length);
      if (end < 0) break;
      quoted += countWords(remaining.slice(start + open.length, end));
      remaining = remaining.slice(0, start) + remaining.slice(end + close.length);
    }
    rest = remaining;
  }

  const total = countWords(text);
  if (!total) return 0;
  return Math.round((quoted / total) * 1000) / 10;
}

/**
 * 量意象密度（每千字的比喻数）。
 *
 * @param {string} text
 * @returns {number}
 */
function measureImageryDensity(text) {
  if (!text) return 0;
  const chars = countWords(text);
  if (!chars) return 0;

  let hits = 0;
  for (const marker of IMAGERY_MARKERS) {
    let index = text.indexOf(marker);
    while (index >= 0) {
      hits += 1;
      index = text.indexOf(marker, index + marker.length);
    }
  }

  return Math.round((hits / chars) * 1000 * 100) / 100;
}

/**
 * 汇总所有维度。
 *
 * @param {string} text
 * @param {Array} [blocks]
 * @returns {{sentenceLength: Object, dialogueRatio: number, imageryDensity: number, words: number}}
 */
function measureAll(text, blocks) {
  const sentenceLength = measureSentenceLength(text);
  return {
    sentenceLength,
    dialogueRatio: measureDialogueRatio(text, blocks),
    imageryDensity: measureImageryDensity(text),
    words: countWords(text),
  };
}

module.exports = {
  splitSentences,
  measureSentenceLength,
  measureDialogueRatio,
  measureImageryDensity,
  measureAll,
  IMAGERY_MARKERS,
};
