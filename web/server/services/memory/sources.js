'use strict';

/**
 * 记忆来源的正文装配。
 *
 * 一个"记忆来源"就是一类可以被召回的东西：章节正文、人物卡、设定卡、
 * 对话消息。它们的原始存储格式各不相同（JSON 块结构 / 散字段 / 纯文本），
 * 这里统一转成"一段可以直接切块的纯文本"。
 *
 * 人物卡与设定卡沿用 [context.js](../context.js) 的渲染函数——
 * 同一份档案在提示词里和在记忆库里必须是同一副样子，
 * 否则 AI 召回的"林昭"和它看到的"林昭"会对不上。
 */

const { get } = require('../../database');
const { formatCharacter, formatSetting, parseBlocks } = require('../context');

/**
 * 章节正文：优先用 blocks 拼（它是权威数据），缺失时退回 content。
 *
 * @param {object} chapter
 * @returns {string}
 */
function chapterText(chapter) {
  if (!chapter) return '';
  const blocks = parseBlocks(chapter.blocks);
  const full = blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
  return full || chapter.content || '';
}

/**
 * 章节的块结构（切块时要认 scene_break 与 dialogue）。
 *
 * @param {object} chapter
 * @returns {Array}
 */
function chapterBlocks(chapter) {
  if (!chapter) return [];
  const blocks = parseBlocks(chapter.blocks);
  return blocks.length ? blocks : [];
}

/**
 * 人物卡文本。
 *
 * @param {object} character
 * @returns {string}
 */
function characterText(character) {
  if (!character) return '';
  return formatCharacter(character);
}

/**
 * 设定卡文本。
 *
 * @param {object} setting
 * @returns {string}
 */
function settingText(setting) {
  if (!setting) return '';
  return formatSetting(setting);
}

/**
 * 对话消息文本（原始层）。
 *
 * 用户消息与 AI 回复拼在一起——AI 回复常常是在回应用户，
 * 拆开存会让语义断掉。
 *
 * @param {object} message
 * @returns {string}
 */
function messageText(message) {
  if (!message) return '';
  return message.content || '';
}

/**
 * 按来源类型取正文。
 *
 * @param {object} params
 * @param {string} params.sourceType
 * @param {object} params.row 对应的数据库行
 * @returns {string}
 */
function sourceText({ sourceType, row }) {
  switch (sourceType) {
    case 'chapter':
      return chapterText(row);
    case 'character':
      return characterText(row);
    case 'setting':
      return settingText(row);
    case 'conv_raw':
    case 'conv_fact':
    case 'conv_manual':
      return messageText(row);
    default:
      return '';
  }
}

/**
 * 取一条章节（含归属校验）。
 *
 * @param {string} chapterId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
function findChapter(chapterId, userId) {
  return get(
    `SELECT c.* FROM chapters c
     JOIN works w ON w.id = c.work_id
     WHERE c.id = ? AND w.user_id = ?`,
    [chapterId, userId]
  );
}

/**
 * 取一条人物卡（含归属校验）。
 */
function findCharacter(characterId, userId) {
  return get(
    `SELECT ch.* FROM characters ch
     JOIN works w ON w.id = ch.work_id
     WHERE ch.id = ? AND w.user_id = ?`,
    [characterId, userId]
  );
}

/**
 * 取一条设定卡（含归属校验）。
 */
function findSetting(settingId, userId) {
  return get(
    `SELECT s.* FROM settings s
     JOIN works w ON w.id = s.work_id
     WHERE s.id = ? AND w.user_id = ?`,
    [settingId, userId]
  );
}

/**
 * 取一条消息（含归属校验）。
 */
function findMessage(messageId, userId) {
  return get(
    `SELECT m.*, c.work_id AS work_id, c.user_id AS user_id
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.user_id = ?`,
    [messageId, userId]
  );
}

module.exports = {
  chapterText,
  chapterBlocks,
  characterText,
  settingText,
  messageText,
  sourceText,
  findChapter,
  findCharacter,
  findSetting,
  findMessage,
};
