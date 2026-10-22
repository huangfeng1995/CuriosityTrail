'use strict';

/**
 * 字数统计。
 *
 * 中文小说的"字数"不是空格分词后的词数——作者看到 Word 显示的
 * "字数（不计空格）"是按字符算的，2 万字指 2 万个汉字。
 * 这里按同一口径统计：CJK 字符逐个计数，英文/数字按词计数。
 *
 * 与前端保持同一口径很重要：作者在编辑器里看到的数字和统计图里的数字
 * 不一致，会直接怀疑工具算错了。
 */

/** CJK 统一表意文字（含扩展区），汉字、日文假名、韩文都算"一个字符" */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

/** 英文单词与数字串 */
const WORD = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

/**
 * 统计一段文本的字数。
 *
 * 空白不计入，但标点计入——标点是作者实际写出来的字符。
 * 块编辑器里 scene_break（分场符）不算正文，会被调用方剔除。
 *
 * 英文按"词"计（hello world = 2），不是按字母（= 10）：
 * 中文作者写的是中文，英文多是人名地名，一个专名算一个字更贴近直觉。
 *
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;

  let count = 0;
  const str = String(text);

  // CJK 逐字计数
  for (const ch of str) {
    if (CJK.test(ch)) count += 1;
  }

  // 标点逐个计数（空白已在上面排除）
  for (const ch of str) {
    if (/[\s]/.test(ch)) continue;
    if (CJK.test(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch)) continue;
    if (/[^\s]/.test(ch)) count += 1;
  }

  // 英文与数字按词计数
  const matches = str.match(WORD);
  if (matches) count += matches.length;

  return count;
}

/**
 * 统计一组块的字数（正文块才计）。
 *
 * @param {Array} blocks
 * @returns {number}
 */
function countBlockWords(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let total = 0;
  for (const block of blocks) {
    if (!block || !block.content) continue;
    if (block.type === 'scene_break') continue;
    total += countWords(block.content);
  }
  return total;
}

/**
 * 把数字格式化成"1.2 万字"这种作者一眼能读的样式。
 *
 * @param {number} n
 * @returns {string}
 */
function formatWords(n) {
  const num = Number(n) || 0;
  if (num < 10000) return String(num);
  return (num / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
}

module.exports = { countWords, countBlockWords, formatWords };
