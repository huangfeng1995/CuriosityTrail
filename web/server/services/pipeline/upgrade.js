'use strict';

/**
 * 素材 → 锚点的显式升格。
 *
 * 素材库和锚点库是两套数据：这里只做**一次显式调用**的转换，
 * 不建外键、不做双向同步，素材之后改了也不会自动改锚点。
 *
 * 三条机械约束：
 *   - `missing` 素材禁止升格为 sourced 锚点；最多 inferable，且 claim 必须以
 *     「证据不足：」开头，保留缺口标记。
 *   - 只有 provenance 能拆出「书名 + 卷次/条目」时才允许 sourced；拆不出
 *     卷次就降为 inferable，不编造 locator。
 *   - 规则只能由调用方显式给出（且必须通过 anchors.normalizeRules）；
 *     推不出来的规则一律退 manual_only，不硬编可能误报的规则。
 *
 * 落库状态一律 pending：升格不等于生效，确认后才会被注入。
 */

const crypto = require('crypto');
const { get, run } = require('../../database');
const { ownedMaterial } = require('../scope');
const anchors = require('./anchors');

/** 一次最多升格多少条素材，避免界面一次勾选整库 */
const MAX_UPGRADE = 20;

class UpgradeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UpgradeError';
    this.status = status;
  }
}

const now = () => new Date().toISOString();

/** 首行非空文本 */
function firstLine(body) {
  return (
    String(body || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ''
  );
}

/**
 * 保守的类型推断。只看标题与标签，不读正文里的模糊描述。
 * 推断不出来就 custom——类型错了比不标更糟。
 */
function inferKind(material) {
  const text = `${material.title || ''} ${material.tags || ''}`;
  if (/(生卒|生于|卒于|享年)/.test(text)) return 'person';
  if (/(职官|官职|太守|刺史|司空|司徒|太尉|尚书|将军|丞相|校尉|都尉|长史)/.test(text)) {
    return 'office';
  }
  if (/(之战|之变|之乱|之役|起兵|即位|被杀|称帝|伐)/.test(text)) return 'event';
  if (/(地点|城|关|郡|县|州|渡|山|河)/.test(text)) return 'place';
  if (/(年号|纪元|年代|[〇零一二三四五六七八九十百]+年)/.test(text)) return 'time';
  return 'custom';
}

/**
 * 把 provenance 拆成 source_title + source_locator。
 * `《三国志·魏书·武帝纪》` → { title:'三国志', locator:'魏书·武帝纪' }；
 * 拆不出卷次时 locator 为空，调用方据此把 sourced 降为 inferable。
 */
function splitProvenance(provenance) {
  const text = String(provenance || '').trim();
  if (!text) return { title: '', locator: '' };

  const book = /《([^》]+)》/.exec(text);
  if (book) {
    const inside = book[1].trim();
    const rest = text
      .slice(book.index + book[0].length)
      .replace(/^[·．.,，:：/\-\s]+/, '')
      .trim();
    const sep = inside.search(/[·．.／/]/);
    let title = inside;
    let locator = '';
    if (sep > 0) {
      title = inside.slice(0, sep).trim();
      locator = inside.slice(sep + 1).trim();
    }
    if (rest) locator = locator ? `${locator}·${rest}` : rest;
    return { title, locator };
  }

  const parts = text
    .split(/[·．.／/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    return { title: parts[0], locator: parts.slice(1).join('·') };
  }
  return { title: text, locator: '' };
}

/**
 * 计算一条素材对应的锚点字段。
 *
 * @param {Object} material
 * @param {Array} [explicitRules] 调用方显式给出的规则（agent 可给）
 * @returns {{value: Object, degraded: string[]}}
 */
function buildAnchorValue(material, explicitRules) {
  const degraded = [];
  const missing = material.confidence === 'missing';
  const title = String(material.title || '').trim();
  const todo = firstLine(material.body);
  // 「素材库」是默认占位来源，不是出处；missing / 无出处的条目不能拿它充数
  const fallbackSource =
    material.source && material.source !== '素材库' ? String(material.source).trim() : '';

  let confidence = 'inferable';
  const provenance = splitProvenance(material.provenance);

  if (!missing && material.confidence === 'sourced') {
    if (provenance.title && provenance.locator) {
      confidence = 'sourced';
    } else {
      degraded.push('出处拆不出卷次/条目，降为可推定');
    }
  }

  let claim = '';
  if (missing) {
    // 缺口标记必须留在 claim 里，作者/模型都能看到这是证据不足的一条
    claim = `证据不足：${/^待补[：:]/.test(todo) ? todo : `${title}（待补：缺少可核出处）`}`;
  } else {
    claim = todo && todo !== title ? todo : title;
  }

  // 规则只接受调用方显式给出的；推不出来的统一 manual_only
  let rules = [{ rule_type: 'manual_only', params: {} }];
  if (!missing && Array.isArray(explicitRules) && explicitRules.length) {
    const normalized = anchors.normalizeRules(explicitRules);
    rules = normalized.rules;
    if (normalized.degraded) degraded.push('规则无法校验，退为 manual_only');
  } else {
    degraded.push('规则无法从素材可靠推断，退为 manual_only');
  }

  return {
    value: {
      kind: inferKind(material),
      subject: title,
      claim,
      confidence,
      source_title: provenance.title || fallbackSource,
      source_locator: confidence === 'sourced' ? provenance.locator : '',
      source_quote: String(material.body || '').slice(0, anchors.MAX_QUOTE_LENGTH),
      rules,
      // 可推定锚点不做不可变硬约束，避免误报直接卡住正文
      immutable: confidence === 'sourced' ? 1 : 0,
      source_material_id: material.id,
    },
    degraded,
  };
}

/**
 * 把一批素材显式升格为锚点草稿。
 *
 * @param {string} userId
 * @param {string} workId
 * @param {string[]} materialIds
 * @param {{explicitRulesByMaterial?: Object<string, Array>}} [options]
 * @returns {Promise<{created: Array, skipped: Array}>}
 */
async function upgradeMaterials(userId, workId, materialIds, options = {}) {
  const ids = Array.isArray(materialIds) ? materialIds.filter(Boolean) : [];
  if (!ids.length) throw new UpgradeError('没有选择要升格的素材');
  if (ids.length > MAX_UPGRADE) {
    throw new UpgradeError(`一次最多升格 ${MAX_UPGRADE} 条素材`);
  }

  const rulesByMaterial = options.explicitRulesByMaterial || {};
  const created = [];
  const skipped = [];

  for (const id of ids) {
    const material = await ownedMaterial(id, userId);
    if (!material) {
      skipped.push({ id, reason: '素材不存在' });
      continue;
    }
    if (material.status === 'retracted') {
      skipped.push({ id, reason: '素材已撤回，不能升格' });
      continue;
    }
    if (material.status === 'pending') {
      skipped.push({ id, reason: '素材还没确认入库，先在素材库确认' });
      continue;
    }
    if (material.work_id && material.work_id !== workId) {
      skipped.push({ id, reason: '素材属于其他作品' });
      continue;
    }

    // 幂等：同一素材只允许生成一条锚点，重复调用返回已存在的
    const existing = await get(
      'SELECT * FROM work_anchors WHERE work_id = ? AND source_material_id = ? LIMIT 1',
      [workId, material.id]
    );
    if (existing) {
      skipped.push({ id, reason: '这条素材已经升格过', anchorId: existing.id });
      continue;
    }

    const built = buildAnchorValue(material, rulesByMaterial[material.id]);
    const anchorId = crypto.randomUUID();
    const ts = now();

    await run(
      `INSERT INTO work_anchors
         (id, work_id, kind, subject, claim, confidence,
          source_title, source_locator, source_quote, rules, immutable,
          source_material_id, status, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        anchorId,
        workId,
        built.value.kind,
        built.value.subject,
        built.value.claim,
        built.value.confidence,
        built.value.source_title || null,
        built.value.source_locator || null,
        built.value.source_quote || null,
        JSON.stringify(built.value.rules),
        built.value.immutable,
        material.id,
        ts,
        ts,
      ]
    );

    const row = await get('SELECT * FROM work_anchors WHERE id = ?', [anchorId]);
    created.push({
      anchor: row,
      materialId: material.id,
      materialTitle: material.title,
      confidence: built.value.confidence,
      rules: built.value.rules,
      degraded: built.degraded,
    });
  }

  return { created, skipped };
}

module.exports = {
  MAX_UPGRADE,
  UpgradeError,
  inferKind,
  splitProvenance,
  buildAnchorValue,
  upgradeMaterials,
};
