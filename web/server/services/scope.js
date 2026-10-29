'use strict';

/**
 * 数据归属校验。
 *
 * 只有 works / materials / inspirations / conversations / prompt_overrides
 * 直接带 user_id；章节、人物、设定、情节卡、版本、写作事件都靠 work_id 间接归属。
 * 所以这里统一收口：任何按 id 取子资源的入口，都必须先过一遍归属校验，
 * 不能直接 `SELECT * FROM chapters WHERE id = ?`——否则换个 id 就能读别人的稿子。
 */

const { get } = require('../database');

/**
 * 取当前用户名下的作品。
 * @param {string} workId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
function ownedWork(workId, userId) {
  if (!workId || !userId) return Promise.resolve(null);
  return get('SELECT * FROM works WHERE id = ? AND user_id = ?', [workId, userId]);
}

/**
 * 取当前用户名下的章节（经 works 关联）。
 * @param {string} chapterId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
function ownedChapter(chapterId, userId) {
  if (!chapterId || !userId) return Promise.resolve(null);
  return get(
    `SELECT c.* FROM chapters c
     JOIN works w ON w.id = c.work_id
     WHERE c.id = ? AND w.user_id = ?`,
    [chapterId, userId]
  );
}

/**
 * 取当前用户名下的人物卡。
 */
function ownedCharacter(id, userId) {
  if (!id || !userId) return Promise.resolve(null);
  return get(
    `SELECT ch.* FROM characters ch
     JOIN works w ON w.id = ch.work_id
     WHERE ch.id = ? AND w.user_id = ?`,
    [id, userId]
  );
}

/**
 * 取当前用户名下的世界观设定。
 */
function ownedSetting(id, userId) {
  if (!id || !userId) return Promise.resolve(null);
  return get(
    `SELECT s.* FROM settings s
     JOIN works w ON w.id = s.work_id
     WHERE s.id = ? AND w.user_id = ?`,
    [id, userId]
  );
}

/**
 * 取当前用户名下的情节卡。
 */
function ownedPlotCard(id, userId) {
  if (!id || !userId) return Promise.resolve(null);
  return get(
    `SELECT p.* FROM plot_cards p
     JOIN works w ON w.id = p.work_id
     WHERE p.id = ? AND w.user_id = ?`,
    [id, userId]
  );
}

/**
 * 取当前用户名下的素材。
 */
function ownedMaterial(id, userId) {
  if (!id || !userId) return Promise.resolve(null);
  return get('SELECT * FROM materials WHERE id = ? AND user_id = ?', [id, userId]);
}

/**
 * 取当前用户名下的会话。
 */
function ownedConversation(id, userId) {
  if (!id || !userId) return Promise.resolve(null);
  return get('SELECT * FROM conversations WHERE id = ? AND user_id = ?', [id, userId]);
}

/**
 * 判断某个用户是不是管理员（只有管理员能整库备份/恢复）。
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isAdmin(userId) {
  if (!userId) return false;
  const user = await get('SELECT role FROM users WHERE id = ?', [userId]);
  return user?.role === 'admin';
}

module.exports = {
  ownedWork,
  ownedChapter,
  ownedCharacter,
  ownedSetting,
  ownedPlotCard,
  ownedMaterial,
  ownedConversation,
  isAdmin,
};
