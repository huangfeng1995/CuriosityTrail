'use strict';

/**
 * 断言投影：把锚点上的 `rules` 投影成对正文的本地检查。
 *
 * 纯函数、无数据库、无 provider、无网络。`claim` 是自然语言，代码读不懂；
 * 能跑的是每条锚点挂的 `rule_type + params`（P.5.4 六种）。
 *
 * 输出 `[{anchorId, ruleType, quote, offset, blockId}]`：
 *   - `quote` 是包含触发词的整句（「命中即报出原句」）；
 *   - `offset` 是相对 `block.content` 的起点，`block.content.slice(offset)`
 *     能逐字回到该句；
 *   - 同一句命中多条规则时全部保留，由调用方按句聚合。
 *
 * 规则写坏或类型未知一律跳过该条，不抛错——一条坏规则不能拖垮整章断言。
 */

const { splitSentences } = require('../style/metrics');

/** 与 P.5.4 / anchors.js 一致的六种规则类型 */
const RULE_TYPES = new Set([
  'presence_forbidden',
  'event_forbidden',
  'term_forbidden',
  'chronology',
  'blank_guard',
  'manual_only',
]);

const CN_DIGITS = {
  〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/**
 * 解析规则 JSON。坏数据返回空数组（等价于 manual_only）。
 * @param {string|Array} raw
 * @returns {Array<Object>}
 */
function parseRules(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/** 章序：只接受整数（数字或纯数字字符串），其余视为无效 */
function toSeq(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** 非空字符串数组；其他形状一律丢弃 */
function strList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
}

/**
 * 中文数字 → 阿拉伯数字，支持 1–99（「二十五」「二十」「十」）。
 * 解析不了返回 null。
 */
function cnNumber(text) {
  const str = String(text || '').trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);

  if (str.includes('十')) {
    const [left, right = ''] = str.split('十');
    const tens = left ? CN_DIGITS[left] : 1;
    const ones = right ? CN_DIGITS[right] : 0;
    if (tens === undefined || ones === undefined) return null;
    return tens * 10 + ones;
  }

  if (str.length === 1 && CN_DIGITS[str] !== undefined) return CN_DIGITS[str];
  return null;
}

/**
 * 把「建安四年」这样的年号+年份拆成 {era:'建安', year:4}。
 * 解析不了返回 null（调用方跳过该条 chronology）。
 */
function parseEraYear(value) {
  const str = String(value || '').trim();
  const match = /^(\D+?)([〇零一二三四五六七八九十\d]+)年$/.exec(str);
  if (!match) return null;
  const year = cnNumber(match[2]);
  if (year === null) return null;
  return { era: match[1], year };
}

/**
 * 切句并给出相对 block.content 的 offset。
 *
 * 复用 metrics.splitSentences（P.5.4 要求），用游标推进 indexOf，
 * 重复句子也能拿到各自的位置。
 *
 * @param {string} text
 * @returns {Array<{text: string, offset: number}>}
 */
function sentencesWithOffset(text) {
  const out = [];
  let cursor = 0;
  for (const sentence of splitSentences(text)) {
    const offset = text.indexOf(sentence.text, cursor);
    if (offset < 0) continue;
    out.push({ text: sentence.text, offset });
    cursor = offset + sentence.text.length;
  }
  return out;
}

/**
 * 句子里是否出现任意一个词。
 * 内联循环而不是 words.some()：这是最热的路径，避免每条规则／每句话都创建闭包。
 */
function hasAnyWord(sentence, words) {
  for (let i = 0; i < words.length; i += 1) {
    if (words[i] && sentence.includes(words[i])) return true;
  }
  return false;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一条规则编译成 `(sentence) => boolean`，只编译一次。
 *
 * 返回 null 表示这条规则在当前章序下不适用（或参数不成立）——
 * 与「规则写错就跳过」同一种处理，不报错。
 *
 * @param {Object} rule
 * @param {number|null} chapterSeq
 * @returns {((sentence: string) => boolean)|null}
 */
function compileRule(rule, chapterSeq) {
  const params = rule.params && typeof rule.params === 'object' ? rule.params : {};

  switch (rule.rule_type) {
    case 'presence_forbidden': {
      // 时间线没给就不投影：代码不替作者判断「这一章该不该活着」
      const fromSeq = toSeq(params.from_seq);
      if (chapterSeq === null || fromSeq === null || chapterSeq < fromSeq) return null;
      const persons = strList(params.persons);
      if (!persons.length) return null;
      return (sentence) => hasAnyWord(sentence, persons);
    }

    case 'event_forbidden': {
      const beforeSeq = toSeq(params.before_seq);
      if (chapterSeq === null || beforeSeq === null || chapterSeq >= beforeSeq) return null;
      const triggers = strList(params.triggers);
      if (!triggers.length) return null;
      return (sentence) => hasAnyWord(sentence, triggers);
    }

    case 'term_forbidden': {
      const terms = strList(params.terms);
      if (!terms.length) return null;
      const allowNear = strList(params.allow_near);
      return (sentence) => {
        if (hasAnyWord(sentence, allowNear)) return false;
        return hasAnyWord(sentence, terms);
      };
    }

    case 'chronology': {
      const lower = parseEraYear(params.not_before);
      const upper = parseEraYear(params.not_after);
      if (!lower && !upper) return null;
      if (lower && upper && lower.era !== upper.era) return null;

      // 只认同一纪年字样的越界（「建安九年」）；跨年号留给人工核对。
      const era = (lower || upper).era;
      const pattern = new RegExp(
        `${escapeRegExp(era)}([〇零一二三四五六七八九十\\d]+)年`,
        'g'
      );

      return (sentence) => {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(sentence)) !== null) {
          const year = cnNumber(match[1]);
          if (year === null) continue;
          if (lower && year < lower.year) return true;
          if (upper && year > upper.year) return true;
        }
        return false;
      };
    }

    case 'blank_guard': {
      const phrases = strList(params.phrases);
      if (!phrases.length) return null;
      return (sentence) => hasAnyWord(sentence, phrases);
    }

    default:
      return null;
  }
}

/**
 * 对一章正文跑断言投影。
 *
 * @param {Array<Object>} anchors status='active' 的 work_anchors 行
 * @param {number} chapterSeq 当前章序
 * @param {Array<{id?: string, content?: string}>} blocks 正文块
 * @returns {Array<{anchorId: string, ruleType: string, quote: string, offset: number, blockId: string}>}
 */
function checkAnchors(anchors, chapterSeq, blocks) {
  const seq = toSeq(chapterSeq);
  const anchorList = Array.isArray(anchors) ? anchors : [];
  const blockList = Array.isArray(blocks) ? blocks : [];

  // 规则只编译一次：50 条锚点 × 上百句，不能在句子循环里反复解析 params。
  const projected = [];
  for (const anchor of anchorList) {
    if (!anchor || anchor.status !== 'active') continue;
    const anchorId = String(anchor.id || '');
    for (const rule of parseRules(anchor.rules)) {
      if (!rule || typeof rule !== 'object') continue;
      if (!RULE_TYPES.has(rule.rule_type)) continue;
      if (rule.rule_type === 'manual_only') continue;
      const test = compileRule(rule, seq);
      if (!test) continue;
      projected.push({ anchorId, ruleType: rule.rule_type, test });
    }
  }

  if (!projected.length) return [];

  const violations = [];
  for (const block of blockList) {
    if (!block || typeof block.content !== 'string' || !block.content) continue;
    const blockId = String(block.id || '');
    for (const sentence of sentencesWithOffset(block.content)) {
      for (const item of projected) {
        if (!item.test(sentence.text)) continue;
        violations.push({
          anchorId: item.anchorId,
          ruleType: item.ruleType,
          quote: sentence.text,
          offset: sentence.offset,
          blockId,
        });
      }
    }
  }

  return violations;
}

module.exports = {
  checkAnchors,
  parseRules,
  RULE_TYPES,
};
