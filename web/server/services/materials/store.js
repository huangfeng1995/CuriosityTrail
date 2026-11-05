'use strict';

/**
 * 素材入库与状态流转。
 *
 * 这里是 agent 整理素材的**机械约束层**：模型爱怎么发挥都行，
 * 但落库前必须过这几道闸——
 *   - 单批上限（默认 12 条），超出就让它分批，不许一次灌库；
 *   - sourced 必须有出处；missing 必须没有出处且正文首行写明待补什么；
 *   - origin=web 的条目必须能在本次检索台账里找到对应 URL，找不到就降级；
 *   - 同标题+同出处、同标题、正文前 40 字相同，一律合并而不是再存一条。
 *
 * 校验失败抛 MaterialError，由路由转 400、由技能转工具错误交回模型。
 */

const crypto = require('crypto');
const { all, get, run } = require('../../database');
const localSearch = require('../search/local');
const { ownedMaterial } = require('../scope');

/** 单次 agent 产出的硬上限。可用环境变量调，但不能无限。 */
const MAX_BATCH = Math.max(1, Number(process.env.MATERIAL_BATCH_LIMIT) || 12);

/** 允许的取值 */
const CONFIDENCE_VALUES = ['sourced', 'inferable', 'missing'];
const ORIGIN_VALUES = ['web', 'model', 'internal', 'user'];
const STATUS_VALUES = ['active', 'pending', 'retracted'];

/** 近重复判定：正文前多少字（归一化后）相同视为重复 */
const BODY_KEY_LEN = 40;

class MaterialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MaterialError';
    this.status = 400;
  }
}

const now = () => new Date().toISOString();

/**
 * 去空白与标点后比对。中英文标点、全角半角、空格换行都抹平，
 * 避免「《三国志》」与「三国志」被当成两条。
 */
function normalizeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function normalizeBody(body) {
  return String(body || '')
    .replace(/\[\[PAGE \d+\]\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 正文首行是否写明「待补：…」 */
function hasTodoLine(body) {
  const first = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return Boolean(first && /^待补[：:]/.test(first));
}

/**
 * 置信强度排序：sourced > inferable > missing。
 * 合并时取更强的一档，避免近重复把有出处的条目降级。
 */
const RANK = { missing: 0, inferable: 1, sourced: 2 };

/** 从本次检索台账里挑出与条目相关的记录 */
function pickLogs(item, ledger) {
  const own = Array.isArray(item.searchLog)
    ? item.searchLog
    : item.searchLog
      ? [item.searchLog]
      : [];
  const pool = ledger && ledger.length ? ledger : [];
  const urls = [];
  if (item.sourceUrl) urls.push(String(item.sourceUrl));
  for (const log of own) {
    for (const u of log.urls || []) urls.push(String(u));
  }
  const matched = pool.filter((log) =>
    (log.urls || []).some((u) => urls.includes(String(u)))
  );
  if (!matched.length) return null;
  // 只保留与这条素材相关的记录，台账里的其他查询不写进条目
  return matched;
}

/**
 * 校验并归一化单条输入。
 *
 * @param {Object} input
 * @param {string} userId
 * @param {Object} options { workId, origin, createdBy, ledger }
 * @returns {Object}
 */
function normalizeItem(input, userId, options) {
  if (!input || typeof input !== 'object') {
    throw new MaterialError('素材条目必须是对象');
  }

  const title = String(input.title || '').trim();
  if (!title) throw new MaterialError('素材条目缺少标题');

  let confidence = String(input.confidence || 'inferable').trim();
  if (!CONFIDENCE_VALUES.includes(confidence)) {
    throw new MaterialError(`confidence 只能取 ${CONFIDENCE_VALUES.join(' / ')}`);
  }

  let origin = String(input.origin || options.origin || 'model').trim();
  if (!ORIGIN_VALUES.includes(origin)) {
    throw new MaterialError(`origin 只能取 ${ORIGIN_VALUES.join(' / ')}`);
  }

  let provenance = String(input.provenance || '').trim();
  const body = String(input.body || '');
  const source = String(input.source || '素材库').trim() || '素材库';
  const sourceUrl = String(input.sourceUrl || input.source_url || '').trim();
  const tags = String(input.tags || '').trim();

  // 机械约束一：missing 不许有出处，且正文首行必须写明缺什么
  if (confidence === 'missing') {
    if (provenance) {
      throw new MaterialError('confidence=missing 的条目 provenance 必须为空，不能伪装成有出处');
    }
    if (!hasTodoLine(body)) {
      throw new MaterialError('confidence=missing 的条目正文首行必须写成「待补：<缺什么>」');
    }
  }

  // 机械约束二：sourced 必须有出处
  if (confidence === 'sourced' && !provenance) {
    throw new MaterialError('confidence=sourced 的条目必须有 provenance（书名/篇目/条目）');
  }

  // 机械约束三：origin=web 必须有本次检索台账里的对应记录，否则降级
  let searchLog = '';
  if (origin === 'web') {
    const logs = pickLogs({ searchLog: input.searchLog, sourceUrl }, options.ledger);
    if (!logs) {
      origin = 'model';
      if (confidence === 'sourced') confidence = 'inferable';
    } else {
      searchLog = JSON.stringify(logs);
    }
  }

  // 没标 web 但模型自己给了检索记录：保留，便于作者核对
  if (!searchLog && input.searchLog) {
    const own = Array.isArray(input.searchLog) ? input.searchLog : [input.searchLog];
    searchLog = JSON.stringify(own);
  }

  // 待确认分级：有出处且来自检索/模型整理的条目进 pending，
  // 可推定与待补的纯背景自动入库，但随时可撤。
  const status = confidence === 'sourced' ? 'pending' : 'active';

  return {
    title,
    body,
    provenance,
    confidence,
    origin,
    status,
    source,
    source_url: sourceUrl,
    tags,
    work_id: String(input.workId || options.workId || ''),
    created_by: options.createdBy || 'agent',
    search_log: searchLog,
    user_id: userId,
  };
}

/**
 * 找已有条目（近重复合并）。
 *
 * 判定顺序：同标题+同出处 → 同标题 → 正文前 40 字相同。
 * 已撤回的条目不参与去重，避免撤回后重写永远存不进去。
 */
async function findDuplicate(userId, item) {
  const rows = await all(
    `SELECT * FROM materials
     WHERE user_id = ? AND status != 'retracted'
     ORDER BY modified_at DESC LIMIT 500`,
    [userId]
  );
  const titleKey = normalizeKey(item.title);
  const provKey = normalizeKey(item.provenance);
  const bodyKey = normalizeKey(normalizeBody(item.body)).slice(0, BODY_KEY_LEN);

  for (const row of rows) {
    const rowTitle = normalizeKey(row.title);
    const rowProv = normalizeKey(row.provenance);
    if (titleKey && rowTitle && titleKey === rowTitle && provKey && rowProv === provKey) {
      return row;
    }
    if (titleKey && rowTitle && titleKey === rowTitle) return row;
    if (bodyKey) {
      const rowBody = normalizeKey(normalizeBody(row.body)).slice(0, BODY_KEY_LEN);
      if (rowBody && rowBody === bodyKey) return row;
    }
  }
  return null;
}

/** 合并两条素材：更强的置信、非空出处、正文不重复拼接。 */
function mergeInto(existing, item) {
  const keepConfidence =
    RANK[item.confidence] > RANK[existing.confidence] ? item.confidence : existing.confidence;
  const provenance = existing.provenance || item.provenance;
  let body = existing.body || '';
  const nextBody = item.body || '';
  if (!body) body = nextBody;
  else if (nextBody && normalizeBody(nextBody) !== normalizeBody(body) && !body.includes(nextBody)) {
    body = `${body}\n\n${nextBody}`;
  }
  return {
    confidence: keepConfidence,
    provenance,
    body,
    source: existing.source || item.source,
    source_url: existing.source_url || item.source_url,
    origin: existing.origin === 'web' || item.origin === 'web' ? 'web' : existing.origin,
    search_log: existing.search_log || item.search_log,
  };
}

/**
 * 批量入库。
 *
 * @param {string} userId
 * @param {Array} items
 * @param {Object} options { workId, origin, createdBy, ledger }
 * @returns {Promise<{created: Array, merged: Array, summary: string}>}
 */
async function saveBatch(userId, items, options = {}) {
  if (!userId) throw new MaterialError('缺少用户身份');
  if (!Array.isArray(items) || !items.length) throw new MaterialError('没有可入库的素材');
  if (items.length > MAX_BATCH) {
    throw new MaterialError(
      `单批最多 ${MAX_BATCH} 条，本次给了 ${items.length} 条。请拆成多批再入库。`
    );
  }

  const normalized = items.map((item) => normalizeItem(item, userId, options));

  // 批内去重：同标题或同正文前 40 字只留一条，先按更强置信保留
  const kept = [];
  for (const item of normalized) {
    const dupIndex = kept.findIndex((other) => {
      const t = normalizeKey(other.title);
      const b = normalizeKey(normalizeBody(other.body)).slice(0, BODY_KEY_LEN);
      return (
        (t && t === normalizeKey(item.title)) ||
        (b && b === normalizeKey(normalizeBody(item.body)).slice(0, BODY_KEY_LEN))
      );
    });
    if (dupIndex >= 0) {
      const other = kept[dupIndex];
      if (RANK[item.confidence] > RANK[other.confidence]) kept[dupIndex] = item;
      continue;
    }
    kept.push(item);
  }

  const created = [];
  const merged = [];

  for (const item of kept) {
    const existing = await findDuplicate(userId, item);
    if (existing) {
      const next = mergeInto(existing, item);
      // 合并后升到 sourced 的条目同样要过确认：不能因为合并绕开高风险闸门
      const nextStatus =
        next.confidence === 'sourced' && existing.status === 'active' ? 'pending' : existing.status;
      await run(
        `UPDATE materials
           SET body = ?, provenance = ?, confidence = ?, origin = ?, status = ?, search_log = ?,
               modified_at = ?
         WHERE id = ? AND user_id = ?`,
        [
          next.body,
          next.provenance,
          next.confidence,
          next.origin,
          nextStatus,
          next.search_log,
          now(),
          existing.id,
          userId,
        ]
      );
      const row = await ownedMaterial(existing.id, userId);
      if (row) await localSearch.indexMaterial(row);
      merged.push({ id: existing.id, title: existing.title, confidence: next.confidence });
      continue;
    }

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO materials
         (id, user_id, work_id, title, body, source, source_url, tags, provenance,
          confidence, origin, status, created_by, search_log, char_count, page_count,
          created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        userId,
        item.work_id,
        item.title,
        item.body,
        item.source,
        item.source_url,
        item.tags,
        item.provenance,
        item.confidence,
        item.origin,
        item.status,
        item.created_by,
        item.search_log,
        item.body.length,
        ts,
        ts,
      ]
    );
    const row = await ownedMaterial(id, userId);
    if (row) await localSearch.indexMaterial(row);
    created.push({
      id,
      title: item.title,
      confidence: item.confidence,
      status: item.status,
      origin: item.origin,
    });
  }

  const pending = created.filter((x) => x.status === 'pending').length;
  const missing = created.filter((x) => x.confidence === 'missing').length;
  const summary =
    `入库 ${created.length} 条、合并 ${merged.length} 条` +
    (pending ? `；其中 ${pending} 条有出处，待你批量确认后才进写作检索` : '') +
    (missing ? `；${missing} 条待补` : '');

  return { created, merged, summary };
}

/**
 * 撤回一条素材。撤回后检索、列表默认视图、上下文注入都会立刻过滤掉。
 */
async function retract(userId, id) {
  const row = await ownedMaterial(id, userId);
  if (!row) throw new MaterialError('素材不存在');
  await run(
    "UPDATE materials SET status = 'retracted', modified_at = ? WHERE id = ? AND user_id = ?",
    [now(), id, userId]
  );
  return ownedMaterial(id, userId);
}

/**
 * 批量确认：只把 pending 转 active，一步一批。
 * @returns {Promise<number>} 实际确认条数
 */
async function confirmBatch(userId, ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) throw new MaterialError('没有待确认的条目');
  let count = 0;
  for (const id of list) {
    const result = await run(
      "UPDATE materials SET status = 'active', modified_at = ? WHERE id = ? AND user_id = ? AND status = 'pending'",
      [now(), id, userId]
    );
    if (result && result.changes) count += result.changes;
    const row = await get('SELECT * FROM materials WHERE id = ? AND user_id = ?', [id, userId]);
    if (row) await localSearch.indexMaterial(row);
  }
  return count;
}

/** 能被写作检索命中的条件：active 且不是待补。 */
function isInjectable(row) {
  return Boolean(row) && row.status === 'active' && row.confidence !== 'missing';
}

module.exports = {
  MAX_BATCH,
  CONFIDENCE_VALUES,
  ORIGIN_VALUES,
  STATUS_VALUES,
  MaterialError,
  normalizeKey,
  normalizeBody,
  hasTodoLine,
  normalizeItem,
  saveBatch,
  retract,
  confirmBatch,
  isInjectable,
};
