'use strict';

/**
 * 情节卡。
 *
 * 作者在动笔前把关键节点列成卡片：一段情节、一个人物出场、一条伏笔。
 * 写长篇最怕的不是写不动，是写着写着忘了自己埋过什么。
 * 卡片挂在作品或章节下，随时能看到进度。
 */

const crypto = require('crypto');
const { all, get, run } = require('../database');

/** 卡片类型 */
const KINDS = ['plot', 'character', 'setting', 'conflict', 'foreshadow'];

/** 卡片状态 */
const STATUSES = ['todo', 'doing', 'done'];

/** 类型对应的中文名 */
const KIND_LABELS = {
  plot: '情节',
  character: '人物',
  setting: '设定',
  conflict: '冲突',
  foreshadow: '伏笔',
};

/** 状态对应的中文名 */
const STATUS_LABELS = {
  todo: '待写',
  doing: '进行中',
  done: '已完成',
};

/**
 * 列出某作品的全部情节卡。
 *
 * @param {string} workId
 * @returns {Promise<Array>}
 */
async function listCards(workId) {
  return all(
    `SELECT c.*, ch.title AS chapter_title, ch.seq AS chapter_seq
     FROM plot_cards c
     LEFT JOIN chapters ch ON ch.id = c.chapter_id
     WHERE c.work_id = ?
     ORDER BY c.seq, c.created_at`,
    [workId]
  );
}

/**
 * 列出某章的情节卡。
 */
async function listCardsByChapter(chapterId) {
  return all(
    `SELECT c.*, ch.title AS chapter_title, ch.seq AS chapter_seq
     FROM plot_cards c
     LEFT JOIN chapters ch ON ch.id = c.chapter_id
     WHERE c.chapter_id = ?
     ORDER BY c.seq, c.created_at`,
    [chapterId]
  );
}

/**
 * 取一张卡片（含所属章节的标题与序号）。
 *
 * 带章节信息是为了让前端列表直接显示"挂在第几章"，
 * 不用再发一轮请求去查章节。
 */
async function getCard(id) {
  return get(
    `SELECT c.*, ch.title AS chapter_title, ch.seq AS chapter_seq
     FROM plot_cards c
     LEFT JOIN chapters ch ON ch.id = c.chapter_id
     WHERE c.id = ?`,
    [id]
  );
}

/**
 * 新建卡片。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} [params.chapterId]
 * @param {string} params.title
 * @param {string} [params.kind]
 * @param {string} [params.content]
 * @param {string} [params.status]
 * @returns {Promise<Object>}
 */
async function createCard(params) {
  const { workId, chapterId, title, kind = 'plot', content = '', status = 'todo' } = params;

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();

  // seq 追加到末尾，作者可以在前端再拖拽排序
  const maxRow = await get(
    'SELECT MAX(seq) AS maxSeq FROM plot_cards WHERE work_id = ?',
    [workId]
  );
  const seq = (maxRow?.maxSeq ?? -1) + 1;

  await run(
    `INSERT INTO plot_cards
       (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workId,
      chapterId || null,
      String(title).trim(),
      KINDS.includes(kind) ? kind : 'plot',
      content,
      seq,
      STATUSES.includes(status) ? status : 'todo',
      ts,
      ts,
    ]
  );

  return getCard(id);
}

/**
 * 更新卡片。
 *
 * @param {string} id
 * @param {Object} patch
 * @returns {Promise<Object|null>}
 */
async function updateCard(id, patch) {
  const existing = await getCard(id);
  if (!existing) return null;

  const title = patch.title !== undefined
    ? String(patch.title).trim()
    : existing.title;
  const kind = patch.kind !== undefined
    ? (KINDS.includes(patch.kind) ? patch.kind : existing.kind)
    : existing.kind;
  const content = patch.content !== undefined ? patch.content : existing.content;
  const status = patch.status !== undefined
    ? (STATUSES.includes(patch.status) ? patch.status : existing.status)
    : existing.status;
  const chapterId = patch.chapterId !== undefined
    ? (patch.chapterId || null)
    : existing.chapter_id;

  await run(
    `UPDATE plot_cards
     SET title = ?, kind = ?, content = ?, status = ?, chapter_id = ?, modified_at = ?
     WHERE id = ?`,
    [title, kind, content, status, chapterId, new Date().toISOString(), id]
  );

  return getCard(id);
}

/**
 * 删除卡片。
 */
async function deleteCard(id) {
  const result = await run('DELETE FROM plot_cards WHERE id = ?', [id]);
  return result.changes > 0;
}

/**
 * 批量排序。接收 id 数组，按数组顺序重写 seq。
 *
 * @param {string} workId
 * @param {Array<string>} cardIds
 */
async function reorderCards(workId, cardIds) {
  for (let i = 0; i < cardIds.length; i++) {
    await run(
      'UPDATE plot_cards SET seq = ?, modified_at = ? WHERE id = ? AND work_id = ?',
      [i, new Date().toISOString(), cardIds[i], workId]
    );
  }
}

module.exports = {
  listCards,
  listCardsByChapter,
  getCard,
  createCard,
  updateCard,
  deleteCard,
  reorderCards,
  KINDS,
  STATUSES,
  KIND_LABELS,
  STATUS_LABELS,
};
