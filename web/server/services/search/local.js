'use strict';

/**
 * 站内素材检索（FTS5 + bigram）。
 *
 * 为什么不用 LIKE：素材库是作者几十年的积累，LIKE '%关键词%' 无法排序、
 * 无法定位命中片段，而且素材一多就全表扫。
 *
 * 为什么不用 unicode61 分词器直接切中文：unicode61 不切分中文，
 * 整段中文被当成一个 token，`MATCH '断剑'` 命中不了。
 *
 * 方案（设计文档 §3.3 方案 B）：写入索引前把中文串切成重叠 2-gram，
 * 非中文保留原词；查询时同样切 bigram，多个 bigram 用 AND 连接。
 * 索引是普通 FTS5 表（不是 external content 表）——因为存进去的是
 * bigram 化后的文本，与 materials 原文不一致，external content 模式会失效。
 * 删除的清理交给 materials_ad 触发器。
 *
 * 索引里除 bigram 外还存了**单字**（unigram）。原因：查询"剑"时，
 * 滑窗 bigram 只能产出"点剑""剑相"这种带上下文的词元，
 * 而素材里"剑"往往独立出现（标签、标题里一个字）。
 * 缺了单字，这类查询就完全召不回。单字噪声大，所以打分时权重低于 bigram。
 */

const { all, get, run } = require('../../database');

/** 单次精确查询最多用多少个 bigram 参与 AND */
const MAX_TERMS = 8;
/** 每条素材取多少字作为片段 */
const SNIPPET_LEN = 160;

/**
 * 把文本切成检索词元。
 * 中文 → 重叠 2-gram；英文/数字 → 整词小写。
 *
 *   "少年握着那把断剑" → ["少年","年握","握着","着那","那把","把断","断剑"]
 */
function bigrams(text) {
  if (!text) return [];
  const out = [];
  const re = /[一-龥]+|[a-zA-Z0-9]+/g;
  let m;
  while ((m = re.exec(text))) {
    const token = m[0];
    if (/[一-龥]/.test(token)) {
      if (token.length === 1) {
        out.push(token);
        continue;
      }
      for (let i = 0; i < token.length - 1; i++) out.push(token.slice(i, i + 2));
    } else {
      out.push(token.toLowerCase());
    }
  }
  return out;
}

/**
 * 索引与宽松检索用的词元：bigram + 中文单字。
 * 单字用于召回"剑""雨"这类独立成词的检索目标。
 */
function indexTerms(text) {
  const bigramList = bigrams(text);
  const out = [...bigramList];
  const seen = new Set(bigramList);
  for (const term of bigramList) {
    if (term.length !== 2) continue;
    for (const ch of term) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      out.push(ch);
    }
  }
  return out;
}

/**
 * 构造 FTS5 MATCH 表达式。
 * 词元里的双引号要转义，否则会被当成语法符号。
 */
function buildMatchExpr(terms, connector = ' AND ') {
  return terms
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(connector);
}

// ---------------------------------------------------------------------------
// 宽松检索的词元抽取
// ---------------------------------------------------------------------------

/**
 * 停用单字。出现在词元里就整条丢掉。
 *
 * 只收纯功能字——像"环""境""描""写""剑""雨"这类实字不能停用，
 * 删了就把作者的真实意图一起抹掉。
 */
const STOP_CHARS = new Set(
  ('的了和是在我你他她它们有个不都很就也会着没看好这那什么给把被对跟与从向为以之者又再并等中下里外时' +
    '啊吧呢吗哦嗯请帮可要说过但而且如若只并且因所更最很么该们些呗咯哈嘛哇哎唔要是能应该曾经' +
    '个些种样点些么样儿们地得着过吧啊呢吗嘛哈')
    .split('')
);

/**
 * 停用词组。多字虚词组合，单独列出来。
 */
const STOP_TERMS = new Set([
  '帮我', '帮忙', '一下', '什么', '可以', '没有', '这个', '那个', '我们',
  '他们', '有没有', '找找', '查找', '一下的', '的话', '的话', '什么用',
  '有吗', '好吗', '行吗', '的话', '怎么', '怎样', '如何', '为什么',
  '的话', '的话', '的话',
]);

/**
 * 通用问法的框架词。检索前先剥掉。
 *
 * 作者说"素材库里有什么能用的"时，真正想找的是内容，不是"素材"这两个字。
 * 不剥掉的话，"素材"会被当成检索目标，命中一堆提到"素材"的条目。
 */
const GENERIC_PHRASES = [
  '素材库', '资料库', '文库', '素材', '资料',
  '有什么', '有哪些', '有什么能用的', '有什么可以用', '可以用', '可用的',
  '能用的', '好用的', '合适的', '用得上的', '能用',
  '帮我', '给我', '找找', '查找', '找一下', '查一下', '查查', '看一下', '看看',
  '搜一下', '搜索', '有没有', '关于', '有关', '相关的',
  '一点', '一些', '要点',
];

/**
 * 剥掉通用框架词，只留可能有检索价值的内容。
 */
function stripGeneric(query) {
  let text = String(query || '');
  for (const phrase of GENERIC_PHRASES) {
    if (!text.includes(phrase)) continue;
    text = text.split(phrase).join('');
  }
  return text;
}

/**
 * 判断问句是不是"浏览整个素材库"型（没有具体检索目标）。
 *
 * 剥掉框架词后如果只剩停用字，说明作者问的是"库里有什么"而不是
 * "库里有 X 吗"——关键词检索必然零命中，应该改用最近素材兜底。
 */
function isGenericQuery(query) {
  const residual = stripGeneric(query);
  if (!residual.trim()) return true;
  return ![...residual].some((ch) => !STOP_CHARS.has(ch));
}

/**
 * 从自然语言问句里抽出检索词元。
 *
 * 作者问的是"帮我找找有没有适合写这场雨夜追逐的环境描写"，
 * 直接拿去 AND 匹配必然零命中——因为每个 bigram 都得同时出现。
 * 这里剔除含功能字的词元，保留有信息量的部分。
 *
 * @returns {Array<{term: string, weight: number}>} weight: 2=bigram 1=单字
 */
function extractQueryTerms(query) {
  const raw = bigrams(stripGeneric(query));
  const seen = new Set();
  const terms = [];

  for (const term of raw) {
    if (seen.has(term)) continue;
    if (STOP_TERMS.has(term)) continue;
    // 单字同样要过停用字这道关：剥掉框架词后常只剩"里""个"这种残字
    if ([...term].some((ch) => STOP_CHARS.has(ch))) continue;
    seen.add(term);
    terms.push({ term, weight: term.length >= 2 ? 2 : 1 });
  }

  // 再补中文单字，覆盖"剑""雨"这类独立成词的检索目标
  for (const term of raw) {
    if (term.length !== 2) continue;
    for (const ch of term) {
      if (seen.has(ch)) continue;
      if (STOP_CHARS.has(ch)) continue;
      seen.add(ch);
      terms.push({ term: ch, weight: 1 });
    }
  }

  return terms;
}

/**
 * 从正文里截出命中位置附近的片段。
 * 索引存的是 bigram，原文要从 materials 取回。
 */
function extractSnippet(body, terms) {
  if (!body) return '';
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return '';

  // 优先用长度 ≥2 的词元定位，单字词元太容易误命中
  const probes = (terms || [])
    .map((t) => (typeof t === 'string' ? t : t.term))
    .filter((t) => t.length >= 2);
  let at = -1;
  for (const probe of probes) {
    const idx = flat.indexOf(probe);
    if (idx >= 0 && (at < 0 || idx < at)) at = idx;
  }
  if (at < 0) return flat.slice(0, SNIPPET_LEN);

  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, start + SNIPPET_LEN);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

/**
 * 检索素材库（精确）。
 *
 * 用于用户明确知道关键词的场景：多个词元之间是 AND 关系。
 *
 * @param {string} query 查询词
 * @param {Object} [options]
 * @param {number} [options.limit] 返回条数，默认 5
 * @returns {Promise<Array<{id,title,snippet,source,sourceUrl,tags,charCount}>>}
 */
async function search(query, options = {}) {
  const limit = options.limit ?? 5;
  const terms = bigrams(query);
  if (!terms.length) return [];

  // 单字查询只能靠索引里的单字命中，多字查询走 bigram AND
  const expr = buildMatchExpr(terms.slice(0, MAX_TERMS));

  let rows = [];
  try {
    rows = await all(
      `SELECT material_id FROM materials_fts
       WHERE materials_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      [expr, limit]
    );
  } catch (e) {
    // MATCH 表达式语法出错（罕见，多为素材正文里含特殊符号）时退化为 OR
    try {
      const orExpr = buildMatchExpr(terms.slice(0, MAX_TERMS), ' OR ');
      rows = await all(
        `SELECT material_id FROM materials_fts
         WHERE materials_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
        [orExpr, limit]
      );
    } catch (e2) {
      return [];
    }
  }

  if (!rows.length) return [];

  const results = [];
  for (const row of rows) {
    const material = await get('SELECT * FROM materials WHERE id = ?', [row.material_id]);
    if (!material) continue;
    results.push({
      id: material.id,
      title: material.title,
      snippet: extractSnippet(material.body, terms),
      source: material.source || '素材库',
      sourceUrl: material.source_url || '',
      tags: material.tags || '',
      charCount: material.char_count || 0,
    });
  }
  return results;
}

/**
 * 宽松检索：先宽召回，再按命中情况打分排序。
 *
 * 精确检索（search）适合用户明确知道关键词的场景；
 * AI 拿到的是自然语言问句，需要这种"召回后排序"的策略。
 *
 * @param {string} query 自然语言查询
 * @param {Object} [options]
 * @param {number} [options.limit] 返回条数，默认 4
 * @param {number} [options.candidates] 召回候选数，默认 40
 * @returns {Promise<Array>}
 */
async function searchLoose(query, options = {}) {
  const limit = options.limit ?? 4;
  const candidates = options.candidates ?? 40;
  const terms = extractQueryTerms(query);
  if (!terms.length) return [];

  // 宽召回：任意一个词元命中即可进候选池
  const orExpr = buildMatchExpr(
    terms.slice(0, 30).map((t) => t.term),
    ' OR '
  );

  let rows = [];
  try {
    rows = await all(
      `SELECT material_id FROM materials_fts
       WHERE materials_fts MATCH ?
       LIMIT ?`,
      [orExpr, candidates]
    );
  } catch (e) {
    return [];
  }
  if (!rows.length) return [];

  // 打分：命中词元越多越相关，标题与标签命中权重更高
  const scored = [];
  for (const row of rows) {
    const material = await get('SELECT * FROM materials WHERE id = ?', [row.material_id]);
    if (!material) continue;

    const title = (material.title || '').toLowerCase();
    const tags = (material.tags || '').toLowerCase();
    const body = (material.body || '').toLowerCase();

    let score = 0;
    let hits = 0;
    for (const { term, weight } of terms) {
      let fieldWeight = 0;
      if (title.includes(term)) fieldWeight = 3;
      else if (tags.includes(term)) fieldWeight = 2;
      else if (body.includes(term)) fieldWeight = 1;
      if (!fieldWeight) continue;
      score += fieldWeight * weight;
      hits++;
    }
    if (!hits) continue;
    // 命中的词元种类越多越相关
    score += hits * 2;

    scored.push({ material, score, hits });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ material, hits }) => ({
    id: material.id,
    title: material.title,
    snippet: extractSnippet(material.body, terms),
    source: material.source || '素材库',
    sourceUrl: material.source_url || '',
    tags: material.tags || '',
    charCount: material.char_count || 0,
    matchedTerms: hits,
  }));
}

/**
 * 把一条素材写进索引。
 * 由应用层显式调用（bigram 化只能在应用层做）。
 */
async function indexMaterial(material) {
  if (!material?.id) return;
  const row = await get('SELECT rid FROM materials WHERE id = ?', [material.id]);
  if (!row) return;

  await run('DELETE FROM materials_fts WHERE rowid = ?', [row.rid]);
  await run(
    `INSERT INTO materials_fts(rowid, title, body, tags, material_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      row.rid,
      indexTerms(material.title).join(' '),
      indexTerms(material.body).join(' '),
      indexTerms(material.tags).join(' '),
      material.id,
    ]
  );
}

/**
 * 从索引里移除一条。
 */
async function removeMaterial(materialId) {
  const row = await get('SELECT rid FROM materials WHERE id = ?', [materialId]);
  if (!row) return;
  await run('DELETE FROM materials_fts WHERE rowid = ?', [row.rid]);
}

/**
 * 全量重建索引。启动时调用一次，保证索引与业务表一致。
 */
async function rebuildIndex() {
  const materials = await all('SELECT * FROM materials');
  await run('DELETE FROM materials_fts');
  for (const material of materials) {
    await run(
      `INSERT INTO materials_fts(rowid, title, body, tags, material_id)
       VALUES (?, ?, ?, ?, ?)`,
      [
        material.rid,
        indexTerms(material.title).join(' '),
        indexTerms(material.body).join(' '),
        indexTerms(material.tags).join(' '),
        material.id,
      ]
    );
  }
  return materials.length;
}

/**
 * 取最近更新的若干条素材。
 * 用来回答"素材库里有什么"这类没有明确关键词的问题。
 */
async function recent(limit = 3) {
  const rows = await all(
    'SELECT * FROM materials ORDER BY modified_at DESC LIMIT ?',
    [limit]
  );
  return rows.map((material) => ({
    id: material.id,
    title: material.title,
    snippet: (material.body || '').replace(/\s+/g, ' ').slice(0, SNIPPET_LEN),
    source: material.source || '素材库',
    sourceUrl: material.source_url || '',
    tags: material.tags || '',
    charCount: material.char_count || 0,
  }));
}

module.exports = {
  search,
  searchLoose,
  recent,
  indexMaterial,
  removeMaterial,
  rebuildIndex,
  bigrams,
  indexTerms,
  extractSnippet,
  extractQueryTerms,
  isGenericQuery,
  stripGeneric,
};
