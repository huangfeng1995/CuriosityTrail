'use strict';

/**
 * 一致性检查结论的生命周期。
 *
 * 检查会被反复触发（打开面板、每次保存后都会再查一次规则层）。如果结论
 * 只放在内存里，作者忽略过的问题每次重跑都会再报一遍，等于逼他对同一件事
 * 反复做决定。
 *
 * 这里把结论落库，用 fingerprint 认「同一个问题」：
 *   · 首次出现 → open，记 first_seen_at；
 *   · 再次出现且仍是 open → 刷新快照与 last_seen_at；
 *   · 已经是 adopted / dismissed → 保持原状态，不再以 open 报出来。
 *
 * 指纹不追求「措辞无关」，只保证同一来源、同一锚点的结论稳定：
 *   · 规则层：type + target（标题里带计数之类的内容不进指纹）。
 * 这样忽略过的问题重跑时不会复活。
 */

const crypto = require('crypto');
const { all, get, transaction } = require('../database');

const VALID_SOURCE = new Set(['rule', 'cross_chapter']);

const now = () => new Date().toISOString();

function normalize(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 结论指纹。
 *
 * @param {Object} finding
 * @returns {string}
 */
function fingerprintOf(finding) {
  const source = finding.source === 'cross_chapter' ? 'cross_chapter' : 'rule';

  if (source === 'cross_chapter') {
    // 同章 + 同标题视为同一结论；标题是模型给的概括，已做空白/大小写归一。
    return [
      'cross_chapter',
      normalize(finding.type || 'ai'),
      normalize(finding.title),
      Number(finding.chapterSeq) || 0,
    ].join('|');
  }

  // 规则层的 target 是问题锚点（人物名/设定名/章节标题）。
  // 标题里可能带数量（「有 2 章都叫…」），拿标题当指纹会因为数量变化
  // 把作者已经忽略的问题重新当成新问题，所以优先用 target。
  const anchor = finding.target || finding.title;
  return ['rule', normalize(finding.type || 'rule'), normalize(anchor)].join('|');
}

/** 行 → 前端可用的结论形状。 */
function toFinding(row) {
  return {
    id: row.id,
    source: row.source,
    type: row.type || '',
    severity: row.severity || 'medium',
    title: row.title,
    detail: row.detail || '',
    target: row.target || '',
    chapterId: row.chapter_id || '',
    chapterSeq: Number(row.chapter_seq) || 0,
    chapterTitle: row.chapter_title || '',
    blockId: row.block_id || '',
    quote: row.quote || '',
    status: row.status,
    // 能否直接跳到正文：章和块都定位到了才算。跨章问题常常只说得出章，
    // 前端据此决定是「打开正文」还是只标注章节。
    locatable: Boolean(row.chapter_id && row.block_id),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * 记录一次检查的结论。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.source rule | cross_chapter
 * @param {Array<Object>} params.findings 本次检查产出的结论
 * @returns {Promise<Array<Object>>} 仍需要展示的结论（已忽略的不在其中，已采纳的保留并带状态）
 */
async function recordFindings({ userId, workId, source, findings }) {
  if (!userId || !workId || !VALID_SOURCE.has(source)) return [];

  const ts = now();
  const rows = [];
  const seen = new Set();

  for (const finding of findings || []) {
    if (!finding || (!finding.title && !finding.detail)) continue;
    const fingerprint = fingerprintOf({ ...finding, source });
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    rows.push({ fingerprint, finding });
  }

  if (!rows.length) return [];

  // 一次检查的结论在同一个事务里写入：只写一半会出现
  // 「部分问题有 id、部分没有」，前端点忽略就会失败。
  await transaction(
    rows.map(({ fingerprint, finding }) => ({
      sql: `INSERT INTO consistency_findings
              (id, user_id, work_id, fingerprint, source, type, severity,
               title, detail, target, chapter_id, chapter_seq, chapter_title,
               block_id, quote, status, first_seen_at, last_seen_at,
               created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
            ON CONFLICT(user_id, work_id, fingerprint) DO UPDATE SET
              severity      = excluded.severity,
              title         = excluded.title,
              detail        = excluded.detail,
              target        = excluded.target,
              chapter_id    = excluded.chapter_id,
              chapter_seq   = excluded.chapter_seq,
              chapter_title = excluded.chapter_title,
              block_id      = excluded.block_id,
              quote         = excluded.quote,
              last_seen_at  = excluded.last_seen_at,
              updated_at    = excluded.updated_at`,
      params: [
        crypto.randomUUID(),
        userId,
        workId,
        fingerprint,
        source,
        String(finding.type || (source === 'cross_chapter' ? 'ai' : 'rule')),
        String(finding.severity || 'medium'),
        String(finding.title || finding.detail).slice(0, 200),
        String(finding.detail || ''),
        String(finding.target || ''),
        finding.chapterId || null,
        Number(finding.chapterSeq) || 0,
        String(finding.chapterTitle || ''),
        String(finding.blockId || ''),
        String(finding.quote || ''),
        ts,
        ts,
        ts,
        ts,
      ],
    }))
  );

  const placeholders = rows.map(() => '?').join(', ');
  const stored = await all(
    `SELECT * FROM consistency_findings
      WHERE user_id = ? AND work_id = ? AND fingerprint IN (${placeholders})`,
    [userId, workId, ...rows.map((r) => r.fingerprint)]
  );

  // 已忽略的不再展示；已采纳的保留，让作者看到「这条处理过了」
  return stored
    .filter((row) => row.status !== 'dismissed')
    .map(toFinding);
}

module.exports = {
  recordFindings,
  fingerprintOf,
  toFinding,
};
