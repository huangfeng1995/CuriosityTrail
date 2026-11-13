'use strict';

/**
 * 卡片名在正文里的出现位置。
 *
 * 纯函数、不碰数据库：路由把章节读出来交给这里。前端靠它回答
 * 「这条设定/这个人物在哪几章出现过」，也靠同一套匹配规则做全文改名。
 *
 * 匹配规则只有一条，但必须两边共用：**最长优先、不重叠**。
 * 「王二」和「王二狗」同时存在时，正文里的「王二狗」只能算给「王二狗」，
 * 否则统计会重复、改名也会把「王二狗」改成「王三狗」。
 */

/**
 * 解析章节的 blocks。坏数据返回空数组——统计少一章，不能整页报错。
 * @param {string|Array} raw
 * @returns {Array<Object>}
 */
function parseBlocks(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 拆分人物卡的别名串。
 *
 * 作者习惯混用中英文标点，这里一次性认全：逗号、顿号、分号、
 * 竖线、斜杠和空白。
 * @param {string} raw
 * @returns {string[]}
 */
function parseAliases(raw) {
  return String(raw || '')
    .split(/[,，、;；|/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 一条卡片对应的全部检索词：本名 + 别名，去重、去空。
 * @param {string} name
 * @param {string} aliases
 * @returns {string[]}
 */
function termsOf(name, aliases) {
  const words = [String(name || '').trim(), ...parseAliases(aliases)];
  return Array.from(new Set(words.filter(Boolean)));
}

/**
 * 在文本里找出所有命中。
 *
 * 逐字符推进 + 每次尝试最长词：这样天然不重叠，也不依赖正则转义。
 * 正文里一两个字符的分支最多几十个，比建 AC 自动机更划算。
 *
 * @param {string} text
 * @param {string[]} words 按长度降序更好，这里内部保证
 * @returns {Array<{term: string, offset: number, length: number}>}
 */
function scan(text, words) {
  const source = String(text || '');
  if (!source || !words.length) return [];

  const sorted = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  const hits = [];
  let i = 0;
  while (i < source.length) {
    let matched = '';
    for (const word of sorted) {
      if (source.startsWith(word, i)) {
        matched = word;
        break;
      }
    }
    if (matched) {
      hits.push({ term: matched, offset: i, length: matched.length });
      i += matched.length;
    } else {
      i += 1;
    }
  }
  return hits;
}

/**
 * 命中处前后各取一小段，供侧栏展示「这句里提到了」。
 * @param {string} text
 * @param {number} offset
 * @param {number} length
 * @param {number} radius
 * @returns {string}
 */
function snippet(text, offset, length, radius = 14) {
  const from = Math.max(0, offset - radius);
  const to = Math.min(text.length, offset + length + radius);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return `${prefix}${text.slice(from, to)}${suffix}`.replace(/\s+/g, ' ');
}

/**
 * 扫描整部作品。
 *
 * @param {Array<Object>} chapters 章节行（含 id/title/seq/blocks/content）
 * @param {Array<{key: string, words: string[]}>} items 每个 key 是一张卡片
 * @returns {Object<string, {total: number, chapters: Array}>}
 */
function scanWork(chapters, items) {
  const list = Array.isArray(chapters) ? chapters : [];
  const cards = (Array.isArray(items) ? items : [])
    .map((item) => ({
      key: String(item?.key || ''),
      words: [...new Set((item?.words || []).map((w) => String(w || '').trim()).filter(Boolean))],
    }))
    .filter((item) => item.key && item.words.length);

  const result = {};
  for (const card of cards) result[card.key] = { total: 0, chapters: [] };
  if (!cards.length) return result;

  for (const chapter of list) {
    const blocks = parseBlocks(chapter.blocks);
    if (!blocks.length) continue;

    for (const card of cards) {
      const hits = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        // 对白块的说话人单独存在 speaker 字段里，漏掉的话「陈默」这个名字
        // 在那句对白里就永远统计不到。
        for (const field of ['content', 'speaker']) {
          const text = typeof block[field] === 'string' ? block[field] : '';
          if (!text) continue;
          for (const hit of scan(text, card.words)) {
            hits.push({
              blockId: String(block.id || ''),
              field,
              term: hit.term,
              offset: hit.offset,
              length: hit.length,
              snippet: snippet(text, hit.offset, hit.length),
            });
          }
        }
      }
      if (!hits.length) continue;

      result[card.key].total += hits.length;
      result[card.key].chapters.push({
        chapterId: String(chapter.id || ''),
        chapterTitle: chapter.title || '',
        seq: chapter.seq,
        count: hits.length,
        firstBlockId: hits[0].blockId,
        hits,
      });
    }
  }

  // 按章序排，作者看到的是"第 1 章、第 2 章"而不是入库顺序
  for (const key of Object.keys(result)) {
    result[key].chapters.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return result;
}

/**
 * 把块里的词替换掉，返回新块与替换处数。
 *
 * 只改 content 与 speaker；块 id、类型、图片等字段原样保留，
 * 否则正文结构会散。没有命中时返回 null，调用方据此跳过落库。
 *
 * guard 是「不能误伤的其他名字」：改名「王二→李四」时，作品里若还有
 * 「王二狗」，这里必须能把整段「王二狗」吃掉而不是把前两个字改掉。
 * 只传旧词本身做不到——扫描器无从知道它只是更长名字的一部分。
 *
 * @param {Array<Object>} blocks
 * @param {string[]} words 旧词
 * @param {string} replacement 新词
 * @param {{guard?: string[]}} [options]
 * @returns {{blocks: Array<Object>, count: number}|null}
 */
function replaceInBlocks(blocks, words, replacement, { guard = [] } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const target = String(replacement || '').trim();
  if (!target) return null;

  const olds = new Set(words.map((w) => String(w || '').trim()).filter(Boolean));
  const dictionary = [...olds, ...(guard || []).map((w) => String(w || '').trim())].filter(
    Boolean
  );
  if (!olds.size || !dictionary.length) return null;

  let count = 0;
  const next = list.map((block) => {
    if (!block || typeof block !== 'object') return block;
    let changed = false;
    const out = { ...block };

    for (const field of ['content', 'speaker']) {
      const text = block[field];
      if (typeof text !== 'string' || !text) continue;
      const hits = scan(text, dictionary);
      if (!hits.length) continue;

      let cursor = 0;
      let rebuilt = '';
      for (const hit of hits) {
        // 命中别家长名：原样搬过去，也不让旧词在它内部再匹配一次
        rebuilt += text.slice(cursor, hit.offset);
        rebuilt += olds.has(hit.term) ? target : hit.term;
        cursor = hit.offset + hit.length;
        if (olds.has(hit.term)) {
          count += 1;
          changed = true;
        }
      }
      rebuilt += text.slice(cursor);
      if (changed) out[field] = rebuilt;
    }

    return changed ? out : block;
  });

  return count ? { blocks: next, count } : null;
}

module.exports = {
  parseBlocks,
  parseAliases,
  termsOf,
  scan,
  snippet,
  scanWork,
  replaceInBlocks,
};
