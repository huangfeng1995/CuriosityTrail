'use strict';

/**
 * 知情矩阵读取。
 *
 * P.6.3 的硬边界只在这一个函数里实现：
 *   - 生成第 N 章时只能读到 `chapter_seq <= N - 1` 的行；
 *     `chapter_seq = N` 表示「第 N 章写完后才知道」，要到第 N+1 章才可见。
 *   - 同一 (character, fact) 取可见行里 chapter_seq 最大的一条；无行即 unknown。
 *
 * 调用方（HP6 的上下文注入、HP7 的抽取）不要自己拼 `chapter_seq` 条件，
 * 否则边界会在两处漂移。
 */

const { all } = require('../../database');

/**
 * 取第 chapterSeq 章开写前可见的知情状态。
 *
 * @param {string} workId
 * @param {number} chapterSeq 当前正在写的章序（第 N 章传 N）
 * @returns {Promise<Array<Object>>} 每个 (character_id, fact_id) 的最新一行
 */
async function knowledgeAt(workId, chapterSeq) {
  const seq = Number(chapterSeq);
  if (!workId || !Number.isInteger(seq)) return [];

  const rows = await all(
    `SELECT * FROM knowledge_matrix
     WHERE work_id = ? AND chapter_seq <= ?
     ORDER BY chapter_seq ASC, created_at ASC`,
    [workId, seq - 1]
  );

  // 只记变化点，所以可见行里最后一条就是当前状态。
  const latest = new Map();
  for (const row of rows) {
    latest.set(`${row.character_id}\u0000${row.fact_id}`, row);
  }
  return Array.from(latest.values());
}

module.exports = { knowledgeAt };
