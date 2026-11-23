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
/**
 * 年龄事实：只认「十八/十四 + 岁」这一形态。
 *
 * 正文里的「十八年的日子」不是在交代年龄，「十八」单独出现在别处也不能算。
 */
const AGE_FACT_RE = /([一二三四五六七八九十百]{1,4}|[0-9]{1,3})\s*(?:岁|周岁)/;

function ageTokenOf(content) {
  const normalized = normalizeText(content);
  const match = normalized.match(AGE_FACT_RE);
  return match ? match[1] : '';
}

/** 年龄表述：十八岁 / 十八了 / 今年十八 / 年满十八；不认「十八年」。 */
function ageExpressionHit(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `${escaped}\\s*(?:岁|周岁|了|整)|(?:今年|年满|已满|刚满|才)\\s*${escaped}`
  ).test(text);
}


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

/** 单段正文是否命中了某条背景事实（与 checkMustReveal 同一套判定）。 */
function factHitInText(fact, text) {
  const terms = factTerms(fact);
  const prefix = Array.from(normalizeText(fact.content)).slice(0, 12).join('');
  const ageToken = ageTokenOf(fact.content);
  if (ageToken) return ageExpressionHit(text, ageToken);
  return terms.some((term) => text.includes(term)) || Boolean(prefix && text.includes(prefix));
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean);
}

/** 按每拍段落数把段落分给各拍；与节拍规划的段落权重保持一致。 */
function beatParagraphRanges(beats, paragraphCount) {
  const weights = beats.map((beat) => Math.max(1, Number(beat && beat.paragraphs) || 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const ranges = [];
  let from = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const last = i === beats.length - 1;
    const to = last
      ? paragraphCount
      : Math.min(paragraphCount, Math.max(from, from + Math.round((weights[i] / total) * paragraphCount)));
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}

/** 只保留仍需在本章交代的背景事实；被 mustWithhold 压住的不再计入。 */
function activeBackgroundFacts(facts, brief) {
  const keys = withheldFactKeys(brief);
  return (facts || []).filter((fact) => {
    if (normalizeText(fact.fact_type) !== FACT_TYPE_BACKGROUND) return false;
    if (keys.ids.has(normalizeText(fact.id))) return false;
    if (keys.contents.has(normalizeText(fact.content))) return false;
    return true;
  });
}

/**
 * 信息释放时间表：每条背景事实最早允许在第几拍说。
 *
 * 优先用 brief 里模型给的 revealAt；没给时按「本章后半段起、一事一拍」排出默认节奏，
 * 不再允许「首次出场章每项至少一句」那样在第一拍把底牌全说完。
 */
function revealSchedule({ facts = [], plan = null, brief = null } = {}) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  if (!beats.length) return null;
  const background = activeBackgroundFacts(facts, brief);
  if (!background.length) return null;

  const items = brief && Array.isArray(brief.items)
    ? brief.items.filter((item) => item && item.kind === 'mustReveal')
    : [];
  const beatIds = beats.map((beat) => beat.id);
  const start = Math.max(1, Math.ceil(beats.length / 2));
  const schedule = new Map();

  background.forEach((fact, index) => {
    const content = normalizeText(fact.content);
    const terms = factTerms(fact);
    const item = items.find((candidate) => {
      const itemText = normalizeText(candidate.text);
      if (itemText && (content.includes(itemText) || itemText.includes(content))) return true;
      return (candidate.keywords || []).some((keyword) => content.includes(normalizeText(keyword)))
        || terms.some((term) => itemText.includes(term));
    });
    const explicit = item && beatIds.includes(normalizeText(item.revealAt));
    const beatId = explicit
      ? normalizeText(item.revealAt)
      : beatIds[Math.min(beats.length - 1, start + index)];
    schedule.set(fact.id, beatId);
  });
  return schedule;
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
function checkMustReveal({ facts = [], body = '', plan = null, brief = null }) {
  const text = normalizeText(body);
  const background = activeBackgroundFacts(facts, brief);
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const schedule = revealSchedule({ facts: background, plan, brief });
  const paragraphs = splitParagraphs(text);
  const ranges = beats.length ? beatParagraphRanges(beats, paragraphs.length) : [];
  const paragraphBeatIndex = (index) => {
    const hit = ranges.findIndex(([from, to]) => index >= from && index < to);
    return hit >= 0 ? hit : -1;
  };

  const missing = [];
  const premature = [];
  let covered = 0;

  for (const fact of background) {
    const terms = factTerms(fact);
    const revealBeat = schedule ? schedule.get(fact.id) || '' : '';
    const revealIndex = revealBeat ? beats.findIndex((beat) => beat.id === revealBeat) : -1;
    const hitIndexes = [];
    paragraphs.forEach((paragraph, index) => {
      if (factHitInText(fact, paragraph)) hitIndexes.push(index);
    });

    if (!hitIndexes.length) {
      missing.push({
        id: fact.id,
        content: normalizeText(fact.content),
        keywords: terms.slice(0, 4),
        ...(revealBeat ? { revealBeat } : {}),
      });
      continue;
    }

    // 有节拍计划时按拍释放：最早命中的段落若落在 revealAt 之前，就是底牌提前释放。
    const firstBeatIndex = paragraphBeatIndex(hitIndexes[0]);
    if (revealIndex >= 0 && firstBeatIndex >= 0 && firstBeatIndex < revealIndex) {
      premature.push({
        id: fact.id,
        content: normalizeText(fact.content),
        earliestBeat: revealBeat,
        actualBeat: beats[firstBeatIndex].id,
        evidence: paragraphs[hitIndexes[0]].slice(0, 40),
      });
      continue;
    }

    covered += 1;
  }

  return {
    total: background.length,
    covered,
    missing,
    premature,
    withheld: (brief && Array.isArray(brief.backgroundWithheld) && brief.backgroundWithheld) || [],
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
 * 主角出场章的背景交代检查。
 *
 * 不再限定「主角首次出场章」：第二章起仍按本章 revealAt 检查提前与缺失，
 * 不会因为主角在前文出现过就把整项检查关掉（HP14 修复三）。
 *
 * @param {Object} params
 * @param {Array} params.facts
 * @param {Array} params.characters
 * @param {string} params.chapterText 本章大纲 + 已有正文（用于判断主角是否出场）
 * @param {string} params.body 本章现有正文
 * @returns {{applicable:boolean, protagonist:Object|null, total:number, covered:number, missing:Array}}
 */
function mustRevealForChapter({
  facts = [],
  characters = [],
  chapterText = '',
  body = '',
  plan = null,
  brief = null,
}) {
  const protagonist = pickProtagonist(characters);
  const empty = { applicable: false, protagonist, total: 0, covered: 0, missing: [], premature: [], withheld: [] };
  if (!protagonist) return empty;

  const variants = characterVariants(protagonist);
  if (!variants.length) return empty;

  // 本章大纲/正文里主角根本没出场 → 不适用。
  const current = `${chapterText || ''}\n${body || ''}`;
  if (!variants.some((name) => current.includes(name))) return empty;

  const check = checkMustReveal({ facts, body, plan, brief });

  // 库里一条背景事实都没有时，不能因为「没有可检查项」就静默放过：
  // 主角出场章必须让作者看见「背景事实还没入库」，否则正文会继续缺年龄/籍贯/寄养原因。
  if (check.total === 0) {
    // 有背景事实、但全部被 mustWithhold 压住：这是明确的「本章不交代」，
    // 不能报成「尚未入库」，否则写手会被逼着点破悬念。
    if (check.withheld.length) {
      return {
        applicable: true,
        protagonist,
        total: 0,
        covered: 0,
        missing: [],
        premature: [],
        withheld: check.withheld,
      };
    }
    return {
      applicable: true,
      protagonist,
      total: 0,
      covered: 0,
      missing: [
        {
          id: 'background-not-ingested',
          content: '主角背景事实（年龄/籍贯/寄养原因）尚未入库',
          keywords: [],
          notIngested: true,
        },
      ],
      premature: [],
      withheld: [],
    };
  }

  return { applicable: true, protagonist, ...check };
}

/** 交付徽标：重写后仍缺时挂到 reason 前，作者一眼能看到。 */
function mustRevealBadge(missing = []) {
  if (!missing || !missing.length) return '';
  const names = missing.slice(0, 3).map((item) => item.content);
  const more = missing.length > 3 ? ` 等 ${missing.length} 项` : '';
  return `【背景自检：未交代 ${names.join('、')}${more}】`;
}

/**
 * background 与 mustWithhold 撞同一条信息时，谁优先。
 *
 * 口径：**mustWithhold 优先**。
 *
 *   - background 的语义是「读者需要知道」；mustWithhold 的语义是
 *     「本章不能点破」。两者落在同一信息上时，点破会直接毁掉本章的悬念钩子，
 *     代价远大于晚一章交代；所以这条事实不再进本章的 mustReveal，
 *     写手只按 mustWithhold 处理（可以暗示，不得解释）。
 *   - 不是静默丢弃：冲突项写进 brief.backgroundWithheld（事实/withhold 双方 id 与原文），
 *     mustReveal 自检也不再拿它报「未交代」，作者能在数据里看到这条冲突，
 *     要提前交代就去掉/放宽对应的 mustWithhold。
 *
 * 判定只做「同一条信息」而不是「同一个场景/同一批人」：
 *   - 去掉「不得/不要/只写」这类禁止语后，一方正文包含另一方；
 *   - 或双方显式关键词至少共享 2 个；
 *   - 或去掉禁止语后的最长公共子串 ≥10 字（覆盖关键词缺失、模型换写的情况）。
 *
 * 只用「共享一个词」会把「温县/司马防」这种同场人物误判成同一条信息：
 * 例如「杨平寄养在温县司马防家」与「不得解释司马防在温县所忧的势力」
 * 共享两个专名，但不是同一件事，不能因此压下年龄与寄养事实。
 */
function stripWithholdModals(text) {
  return String(text || '').replace(
    /不得(?:解释|点破|写明|交代|让|把|写出)?|不要(?:解释|点破)?|不许(?:解释|点破)?|不能(?:解释|点破)?|禁止|只(?:写|可|能|要)/g,
    ''
  );
}

function longestCommonSubstringLength(a, b) {
  const left = Array.from(String(a || ''));
  const right = Array.from(String(b || ''));
  if (!left.length || !right.length) return 0;
  let best = 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

function withholdConflict(fact, item) {
  const factText = normalizeText(fact.content).replace(/\s+/g, '');
  const itemCore = stripWithholdModals(normalizeText(item.text)).replace(/\s+/g, '');
  if (!factText || !itemCore) return false;
  if (factText.includes(itemCore) || itemCore.includes(factText)) return true;

  const factKeys = splitKeywords(fact.keywords);
  const itemKeys = splitKeywords(item.keywords);
  const shared = itemKeys.filter((key) => factKeys.includes(key));
  if (shared.length >= 2) return true;

  return longestCommonSubstringLength(factText, itemCore) >= 10;
}

/** brief 里被 mustWithhold 压住的背景事实（按 id 与原文两种键）。 */
function withheldFactKeys(brief) {
  const rows = brief && Array.isArray(brief.backgroundWithheld) ? brief.backgroundWithheld : [];
  return {
    ids: new Set(rows.map((row) => normalizeText(row.factId)).filter(Boolean)),
    contents: new Set(rows.map((row) => normalizeText(row.content)).filter(Boolean)),
  };
}

/**
 * 把背景事实并进分场 brief 的 mustReveal。
 *
 * 这是确定性合并：模型没给、漏给，背景事实也不能漏。
 * 没有背景事实时原样返回（null 仍是 null，保证旧链路逐字不变）。
 * 与 mustWithhold 撞同一条信息时不并 mustReveal，改记 backgroundWithheld。
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
  const withholds = items.filter((item) => item && item.kind === 'mustWithhold');
  const existing = new Set(items.map((item) => `${item.kind}|${item.text}`));
  // 与 planBrief 的 id 前缀一致：背景事实一律落在 mustReveal，用 MR 计数。
  let revealCount = items.filter((item) => item.kind === 'mustReveal').length;
  const withheld = brief && Array.isArray(brief.backgroundWithheld)
    ? [...brief.backgroundWithheld]
    : [];

  for (const fact of background) {
    const content = normalizeText(fact.content);
    if (!content) continue;
    const conflict = withholds.find((item) => withholdConflict(fact, item));
    if (conflict) {
      if (!withheld.some((row) => normalizeText(row.factId) === normalizeText(fact.id))) {
        withheld.push({
          factId: fact.id || '',
          content,
          withholdId: conflict.id || '',
          withholdText: normalizeText(conflict.text),
          reason: 'mustWithhold 优先：同一信息本章不得点破',
        });
      }
      continue;
    }
    const key = `mustReveal|${content}`;
    if (existing.has(key)) continue;
    existing.add(key);
    revealCount += 1;
    items.push({
      id: `MR${revealCount}`,
      kind: 'mustReveal',
      text: content,
      keywords: factTerms(fact).slice(0, 4),
      source: 'story_facts',
      inferred: false,
    });
  }

  return {
    ...(brief || {}),
    items,
    dropped: (brief && brief.dropped) || [],
    ...(withheld.length ? { backgroundWithheld: withheld } : {}),
  };
}

module.exports = {
  FACT_TYPE_BACKGROUND,
  deriveKeywords,
  materialToFact,
  upgradeBackgroundFacts,
  checkMustReveal,
  revealSchedule,
  pickProtagonist,
  mustRevealForChapter,
  mustRevealBadge,
  mergeIntoBrief,
  briefWriterBlock,
};
