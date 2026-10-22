/**
 * 字数统计（前端）。
 *
 * 口径必须与服务端 services/wordCount.js 一致：
 * 作者在编辑器里看到的字数和"写作进度"里的字数是同一个数，
 * 不一致的话会直接怀疑工具算错了。
 *
 * 规则：
 *   · 汉字/日文/韩文逐字计 1
 *   · 标点逐个计 1（作者确实写出来了）
 *   · 英文与数字按词计（hello world = 2），不按字母
 *   · 空白不计
 */

/** CJK 统一表意文字 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;

/** 英文单词与数字串 */
const WORD = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

/**
 * 统计一段文本的字数。
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  if (!text) return 0;

  let count = 0;
  const str = String(text);

  for (const ch of str) {
    if (CJK.test(ch)) count += 1;
  }

  for (const ch of str) {
    if (/\s/.test(ch)) continue;
    if (CJK.test(ch)) continue;
    if (/[A-Za-z0-9]/.test(ch)) continue;
    count += 1;
  }

  const matches = str.match(WORD);
  if (matches) count += matches.length;

  return count;
}

/**
 * 统计一组块的字数（正文块才计，分场符不算）。
 *
 * @param {Array} blocks
 * @returns {number}
 */
export function countBlockWords(blocks) {
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
export function formatWords(n) {
  const num = Number(n) || 0;
  if (num < 10000) return String(num);
  return (num / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
}
