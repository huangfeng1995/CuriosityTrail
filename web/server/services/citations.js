'use strict';

/**
 * 引用定位。
 *
 * AI 引用素材时会带一段片段（snippet），作者点"查看素材"跳回素材库，
 * 但现在只能跳到素材开头——一本三十万字的参考资料，作者还得自己
 * 翻到那一段才能核对。
 *
 * 这里做两件事：
 *   1. 片段在原文里的精确位置（字符下标 + 前后文）
 *   2. 片段所在页码（PDF 素材正文里埋了 [[PAGE n]] 标记）
 *
 * 定位用的是"正文原文"，不是索引里的 bigram 文本——bigram 化之后
 * 字符位置全变了，算出来的页码必然是错的。
 */

const { get } = require('../database');
const { pageAt } = require('./documentText');

/** 页码标记 */
const PAGE_MARK = /\[\[PAGE (\d+)\]\]/g;

/** 命中位置的上下文窗口长度 */
const CONTEXT_LEN = 400;

/**
 * 片段短于这个长度就不定位。
 *
 * 一个字的片段（"我"、"雨"）在长文里几乎必然能找到，但找到的多半是
 * 第一个出现的位置——把作者送到一个无关的地方，比明确说"定位不到"更糟。
 */
const MIN_SNIPPET_LEN = 4;

/**
 * 把文本归一化，用于跨空白比较。
 *
 * 片段来自检索结果（空白被压成单空格），原文可能有换行和缩进，
 * 直接 indexOf 常常找不到。这里把两边都压平再比。
 */
function normalize(text) {
  return String(text || '')
    .replace(PAGE_MARK, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 建立"归一化文本 → 原文下标"的映射。
 *
 * 逐字符走原文：页码标记与多余空白压成单个空格，
 * 同时记录每个归一化字符对应原文里的下标。
 *
 * map 与 normalized 必须逐位对齐——早先的实现只给非空白字符记下标，
 * 命中片段前面若有空白，下标就会整体偏移，算出来的页码也跟着错。
 * 现在每个归一化字符都占一个 map 槽位，下标一一对应。
 */
function buildIndexMap(body) {
  const chars = [];
  const map = [];

  // 连续空白压成单个空格：上一个字符已经是空格就不再来一个
  const push = (ch, rawIndex) => {
    if (ch === ' ' && chars.length && chars[chars.length - 1] === ' ') return;
    chars.push(ch);
    map.push(rawIndex);
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];

    // 页码标记整体跳过，但留一个空格占位：
    // 与 normalize() 的处理保持一致，跨页的片段才不会被粘在一起
    if (body.startsWith('[[PAGE ', i)) {
      const end = body.indexOf(']]', i);
      if (end > 0) {
        push(' ', i);
        i = end + 1;
        continue;
      }
    }

    if (/\s/.test(ch)) {
      push(' ', i);
      continue;
    }

    push(ch, i);
  }

  return { normalized: chars.join(''), map };
}

/**
 * 在素材正文里定位片段。
 *
 * @param {Object} params
 * @param {string} params.body 素材原文
 * @param {string} params.snippet 要定位的片段
 * @returns {{found: boolean, index: number, page: number, context: string, excerpt: string,
 *            before: string, match: string, after: string}}
 */
function locateInBody(body, snippet) {
  const text = String(body || '');
  const needle = normalize(snippet);

  const empty = {
    found: false,
    index: -1,
    page: 0,
    context: '',
    excerpt: '',
    before: '',
    match: '',
    after: '',
  };
  if (!text || !needle) return empty;
  if (needle.length < MIN_SNIPPET_LEN) return empty;

  const { normalized, map } = buildIndexMap(text);

  let at = normalized.indexOf(needle);
  let matchLen = needle.length;
  if (at < 0) {
    // 片段可能被截断过（检索只给 160 字），退一步用开头一段找
    const head = needle.slice(0, Math.min(24, needle.length));
    if (head.length < MIN_SNIPPET_LEN) return empty;
    at = normalized.indexOf(head);
    if (at < 0) return empty;
    matchLen = head.length;
  }

  // 归一化下标 → 原文下标
  const rawIndex = map[at] ?? 0;

  // 上下文在归一化文本上切，命中段与前后文天然对齐，
  // 前端可以直接把 match 标黄，不必在字符串里二次查找。
  const half = Math.floor(CONTEXT_LEN / 2);
  const before = normalized.slice(Math.max(0, at - half), at);
  const match = normalized.slice(at, at + matchLen);
  const after = normalized.slice(at + matchLen, at + matchLen + half);

  const context =
    (before ? '…' : '') + before + match + after + (after.length < half ? '…' : '');

  const excerpt = match.length > 300 ? match.slice(0, 300) + '…' : match;

  return {
    found: true,
    index: rawIndex,
    page: pageAt(text, rawIndex),
    context,
    excerpt,
    before,
    match,
    after,
  };
}

/**
 * 定位一条引用。
 *
 * @param {Object} params
 * @param {string} params.materialId
 * @param {string} params.snippet
 * @returns {Promise<Object|null>} 定位结果；素材不存在返回 null
 */
async function locateCitation({ materialId, snippet }) {
  if (!materialId) return null;

  const material = await get('SELECT * FROM materials WHERE id = ?', [materialId]);
  if (!material) return null;

  const located = locateInBody(material.body, snippet || '');

  return {
    materialId: material.id,
    title: material.title,
    source: material.source,
    sourceUrl: material.source_url,
    pageCount: material.page_count || 0,
    ...located,
  };
}

module.exports = { locateInBody, locateCitation, normalize, buildIndexMap };
