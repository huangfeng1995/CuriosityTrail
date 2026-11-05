'use strict';

/**
 * 主角背景事实（mustReveal）。
 *
 * 库里原本没有年龄/籍贯/寄养原因，写手自然不会写。这里补两条入库路径：
 *   1. 素材显式升格（agent 或用户选中素材，一次动作）；
 *   2. agent 抽取（直接提交 {content, keywords}）。
 *
 * 背景事实与秘密事实共用 story_facts，用 fact_type 区分：
 *   secret     → 默认，参与知情矩阵/withhold；
 *   background → 首次出场章必须交代，不进知情矩阵的越界粗筛。
 *
 * 不建素材外键、不做双向同步：素材改了不会自动改事实。
 */

const crypto = require('crypto');
const { all, get, transaction } = require('../../database');
const { briefWriterBlock } = require('../agent/planBrief');

const FACT_TYPE_BACKGROUND = 'background';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function splitKeywords(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,，、;；|]/);
  const out = [];
  for (const item of raw) {
    const word = normalizeText(item).replace(/\s+/g, '');
    if (Array.from(word).length < 2) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/** 背景事实的可命中词：显式 keywords 优先；否则按标点切段 + 2-gram。 */
function deriveKeywords(content, extra = []) {
  const explicit = splitKeywords(extra);
  if (explicit.length) return explicit.slice(0, 8);

  const text = normalizeText(content).replace(/\s+/g, '');
  const parts = text.split(/[，。、；：！？,.;:!?\s]+/).filter(Boolean);
  const terms = [];
  const push = (term) => {
    if (Array.from(term).length < 2) return;
    if (!terms.includes(term)) terms.push(term);
  };
  for (const part of parts) {
    if (Array.from(part).length <= 12) push(part);
    const chars = Array.from(part);
    for (let i = 0; i + 1 < chars.length; i++) push(chars[i] + chars[i + 1]);
  }
  return terms.slice(0, 12);
}

function factTerms(fact) {
  return deriveKeywords(fact.content, normalizeText(fact.keywords));
}

/**
 * 素材 → 背景事实的内容。
 *
 * missing 置信度不做 sourced 门禁：背景事实不是史实断言，而是人物设定；
 * 但要在 keywords 里留下「证据不足」标记，提醒写手别写成有出处的事实。
 */
function materialToFact(material) {
  const title = normalizeText(material.title);
  const body = normalizeText(material.body).replace(/\s+/g, ' ');
  const excerpt = Array.from(body).slice(0, 120).join('');
  const content = excerpt && excerpt !== title ? `${title}：${excerpt}` : title;
  const keywords = splitKeywords(material.tags);
  if (title) keywords.unshift(title);
  if (normalizeText(material.confidence) === 'missing') keywords.push('证据不足');
  return {
    content,
    keywords: splitKeywords(keywords).slice(0, 8),
    source: normalizeText(material.provenance) || '素材',
    sourceMaterialId: material.id,
  };
}

function normalizeInputFact(fact) {
  if (!fact || typeof fact !== 'object') return null;
  const content = normalizeText(fact.content);
  if (!content) return null;
  return {
    content,
    keywords: splitKeywords(fact.keywords),
    source: normalizeText(fact.source) || 'agent',
    sourceMaterialId: normalizeText(fact.sourceMaterialId || fact.source_material_id),
  };
}

/**
 * 显式把素材/抽取结果升格为背景事实。
 *
 * 幂等键：work_id + fact_type='background' + content。
 * 重复升格不产生重复行，返回 skipped。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string[]} [params.materialIds]
 * @param {Array} [params.facts]
 * @returns {Promise<{created: Array, skipped: Array}>}
 */
async function upgradeBackgroundFacts({ userId, workId, materialIds = [], facts = [] }) {
  const inputs = [];

  const ids = Array.from(new Set((materialIds || []).map(normalizeText).filter(Boolean)));
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    const rows = await all(
      `SELECT * FROM materials
       WHERE id IN (${placeholders})
         AND user_id = ?
         AND (work_id = ? OR work_id IS NULL OR work_id = '')
         AND status != 'retracted'`,
      [...ids, userId, workId]
    );
    for (const row of rows) inputs.push(materialToFact(row));
  }

  for (const fact of facts || []) {
    const normalized = normalizeInputFact(fact);
    if (normalized) inputs.push(normalized);
  }

  const existing = await all(
    "SELECT id, content FROM story_facts WHERE work_id = ? AND fact_type = 'background'",
    [workId]
  );
  const existingByContent = new Map(existing.map((row) => [normalizeText(row.content), row]));

  const created = [];
  const skipped = [];
  const statements = [];
  const now = new Date().toISOString();

  for (const input of inputs) {
    const key = normalizeText(input.content);
    if (!key) continue;
    if (existingByContent.has(key)) {
      skipped.push({ id: existingByContent.get(key).id, content: key });
      continue;
    }

    const id = crypto.randomUUID();
    const row = {
      id,
      content: key,
      keywords: (input.keywords || []).join(','),
      sourceMaterialId: input.sourceMaterialId || '',
    };
    statements.push({
      sql: `INSERT INTO story_facts
              (id, work_id, secret_id, part_no, content, keywords, fact_type, created_at, modified_at)
            VALUES (?, ?, NULL, 1, ?, ?, ?, ?, ?)`,
      params: [id, workId, key, row.keywords, FACT_TYPE_BACKGROUND, now, now],
    });
    existingByContent.set(key, { id, content: key });
    created.push(row);
  }

  if (statements.length) await transaction(statements);
  return { created, skipped };
}

/**
 * 正文是否交代了每条背景事实。
 *
 * 命中判定：任一 keyword 或 content 的前 12 字出现在正文。
 * 顺序即入参顺序，保证同一输入同一结果。
 *
 * @param {Object} params
 * @param {Array} params.facts story_facts 行
 * @param {string} params.body 正文
 * @returns {{total:number, covered:number, missing:Array}}
 */
function checkMustReveal({ facts = [], body = '' }) {
  const text = normalizeText(body);
  const background = (facts || []).filter(
    (fact) => normalizeText(fact.fact_type) === FACT_TYPE_BACKGROUND
  );

  const missing = [];
  for (const fact of background) {
    const terms = factTerms(fact);
    const prefix = Array.from(normalizeText(fact.content)).slice(0, 12).join('');
    const hit = terms.some((term) => text.includes(term)) || (prefix && text.includes(prefix));
    if (!hit) {
      missing.push({
        id: fact.id,
        content: normalizeText(fact.content),
        keywords: terms.slice(0, 4),
      });
    }
  }

  return {
    total: background.length,
    covered: background.length - missing.length,
    missing,
  };
}

function characterVariants(character) {
  const variants = [normalizeText(character.name)];
  for (const alias of String(character.aliases || '').split(/[,，、]/)) {
    const value = alias.trim();
    if (value) variants.push(value);
  }
  return variants.filter(Boolean);
}

/** 主角：role 含「主角」优先，否则第一条人物卡。 */
function pickProtagonist(characters = []) {
  const rows = (characters || []).filter(Boolean);
  return rows.find((character) => normalizeText(character.role).includes('主角')) || rows[0] || null;
}

/**
 * 首次出场章的背景交代检查。
 *
 * @param {Object} params
 * @param {Array} params.facts
 * @param {Array} params.characters
 * @param {string} params.chapterText 本章大纲 + 已有正文（用于判断主角是否出场）
 * @param {Array<string>} params.priorBodies 更早章节的正文
 * @param {string} params.body 本章现有正文
 * @returns {{applicable:boolean, protagonist:Object|null, total:number, covered:number, missing:Array}}
 */
function mustRevealForChapter({
  facts = [],
  characters = [],
  chapterText = '',
  priorBodies = [],
  body = '',
}) {
  const protagonist = pickProtagonist(characters);
  const empty = { applicable: false, protagonist, total: 0, covered: 0, missing: [] };
  if (!protagonist) return empty;

  const variants = characterVariants(protagonist);
  if (!variants.length) return empty;

  // 更早的章节已经出现过 → 本章不是首次出场，不强制交代。
  const prior = (priorBodies || []).join('\n');
  if (variants.some((name) => prior.includes(name))) return empty;

  // 本章大纲/正文里主角根本没出场 → 不适用。
  const current = `${chapterText || ''}\n${body || ''}`;
  if (!variants.some((name) => current.includes(name))) return empty;

  const check = checkMustReveal({ facts, body });
  return { applicable: check.total > 0, protagonist, ...check };
}

/** 交付徽标：重写后仍缺时挂到 reason 前，作者一眼能看到。 */
function mustRevealBadge(missing = []) {
  if (!missing || !missing.length) return '';
  const names = missing.slice(0, 3).map((item) => item.content);
  const more = missing.length > 3 ? ` 等 ${missing.length} 项` : '';
  return `【背景自检：未交代 ${names.join('、')}${more}】`;
}

/**
 * 把背景事实并进分场 brief 的 mustReveal。
 *
 * 这是确定性合并：模型没给、漏给，背景事实也不能漏。
 * 没有背景事实时原样返回（null 仍是 null，保证旧链路逐字不变）。
 *
 * @param {Object|null} brief
 * @param {Array} facts
 * @returns {Object|null}
 */
function mergeIntoBrief(brief, facts = []) {
  const background = (facts || []).filter(
    (fact) => normalizeText(fact.fact_type) === FACT_TYPE_BACKGROUND
  );
  if (!background.length) return brief || null;

  const items = brief && Array.isArray(brief.items) ? [...brief.items] : [];
  const existing = new Set(items.map((item) => `${item.kind}|${item.text}`));

  for (const fact of background) {
    const content = normalizeText(fact.content);
    const key = `mustReveal|${content}`;
    if (!content || existing.has(key)) continue;
    existing.add(key);
    items.push({
      id: `M${items.length + 1}`,
      kind: 'mustReveal',
      text: content,
      keywords: factTerms(fact).slice(0, 4),
      source: 'story_facts',
      inferred: false,
    });
  }

  return { ...(brief || {}), items, dropped: (brief && brief.dropped) || [] };
}

module.exports = {
  FACT_TYPE_BACKGROUND,
  deriveKeywords,
  materialToFact,
  upgradeBackgroundFacts,
  checkMustReveal,
  pickProtagonist,
  mustRevealForChapter,
  mustRevealBadge,
  mergeIntoBrief,
  briefWriterBlock,
};
