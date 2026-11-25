'use strict';

/**
 * 规划前的实体接地（grounding）。
 *
 * 节拍规划器要在「本章大纲 + 作品信息 + 上一章结尾 + 人物/设定/素材/情节卡」
 * 这些给定材料里排拍，并且判断是按大纲排、还是退回范文六类功能兜底。
 * 这一层只负责把材料读齐、算出规划模式与可用拍型，不发 SSE、不落库、
 * 也不碰调用方的上下文与消息——行为与原先内联在 /chat 里的那段完全一致。
 */

const { get, all } = require('../../database');
const { findPreviousChapterWithBody, chapterBody } = require('../context');
const { isPipelineEnabled } = require('../pipeline/gate');
const { BEAT_TYPES, DANGER_TYPE } = require('./beatPlan');

/**
 * 多短的大纲不算大纲：一行故事前提（例如「主角进庙查旧案」）提供不了
 * 场景与因果，硬按大纲模式反而会退化成直写；真实分场大纲通常远超 40 字。
 */
const MIN_OUTLINE_CHARS_FOR_PLAN = 40;

/**
 * 上一章拍表的主类型（mainType）。
 *
 * 险露拍只能与上一章形成相邻关系，所以规划器需要知道上一章主类型。
 * 这里吞掉错误按「没有上一章计划」处理，不阻断本轮规划。
 *
 * @returns {Promise<string>} 空串表示取不到
 */
async function loadPreviousMainType(workId, chapterId) {
  if (!workId || !chapterId) return '';
  try {
    const current = await get('SELECT seq FROM chapters WHERE id = ? AND work_id = ?', [
      chapterId,
      workId,
    ]);
    if (!current) return '';
    const prev = await get(
      'SELECT id FROM chapters WHERE work_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1',
      [workId, current.seq]
    );
    if (!prev) return '';
    const row = await get(
      'SELECT plan FROM chapter_plans WHERE chapter_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
      [prev.id]
    );
    if (!row || !row.plan) return '';
    const parsed = JSON.parse(row.plan);
    return parsed && typeof parsed.mainType === 'string' ? parsed.mainType : '';
  } catch (e) {
    return '';
  }
}

/**
 * 读取规划所需的全部实体材料，并算出规划模式与可用拍型。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} [params.chapterId]
 * @param {string} params.userId
 * @param {string} params.message 作者这一轮的指令，进接地语料
 * @param {Array}  [params.plotCards] 本章 + 全书情节卡（已在调用方查好）
 * @returns {Promise<{
 *   planGround: Object,
 *   planCharacterNames: string[],
 *   planMode: 'outline'|'reference',
 *   pipelineEnabled: boolean,
 *   allowedBeatTypes: string[],
 *   previousMainType: string
 * }>}
 */
async function buildPlanGrounding({
  workId,
  chapterId,
  userId,
  message,
  plotCards = [],
} = {}) {
  const [planChapterRow, planWorkRow, groundCharacters, groundSettings, groundMaterials] =
    await Promise.all([
      chapterId
        ? get('SELECT title, outline, seq FROM chapters WHERE id = ? AND work_id = ?', [
            chapterId,
            workId,
          ]).catch(() => null)
        : null,
      get('SELECT title, synopsis, outline, template FROM works WHERE id = ?', [workId]).catch(() => null),
      all(
        `SELECT name, aliases, role, identity, personality, speech, goal, arc, relations, notes, weakness
         FROM characters WHERE work_id = ?`,
        [workId]
      ).catch(() => []),
      all('SELECT name, category, content FROM settings WHERE work_id = ?', [workId]).catch(() => []),
      all(
        `SELECT title, body FROM materials
         WHERE user_id = ? AND (work_id = ? OR work_id IS NULL OR work_id = '')
           AND status != 'retracted'
         ORDER BY created_at DESC, id DESC LIMIT 20`,
        [userId, workId]
      ).catch(() => []),
    ]);

  // 上一章结尾原文也是规划器的给定输入（「如何衔接上一章」），
  // 必须进接地语料：否则上一章末句里的器物（如「弓」）会被判成新道具。
  const previousChapterRow = planChapterRow && planChapterRow.seq
    ? await findPreviousChapterWithBody(workId, planChapterRow.seq).catch(() => null)
    : null;
  const previousChapterText = previousChapterRow
    ? chapterBody(previousChapterRow).slice(-800)
    : '';

  const planGround = {
    outline: String((planChapterRow && planChapterRow.outline) || '').trim(),
    instruction: String(message),
    workTitle: (planWorkRow && planWorkRow.title) || '',
    workOutline: (planWorkRow && planWorkRow.outline) || '',
    synopsis: (planWorkRow && planWorkRow.synopsis) || '',
    previousChapter: previousChapterText,
    characters: groundCharacters || [],
    settings: groundSettings || [],
    materials: groundMaterials || [],
    // 情节卡里的标题/备注也进实体接地语料：卡里的节点是合法出处，
    // 卡外的新人名/新道具仍然找不到出处。
    plotCards,
  };

  // 姓名 + 别名（aliases 可能是逗号/顿号分隔的字符串），只做前情账本的人物识别用。
  const planCharacterNames = [...new Set(
    (groundCharacters || [])
      .flatMap((row) => [row.name, ...String(row.aliases || '').split(/[，,、|/;；]/)])
      .map((name) => String(name || '').trim())
      .filter((name) => name.length >= 2)
  )];

  const planMode = planGround.outline.length >= MIN_OUTLINE_CHARS_FOR_PLAN
    ? 'outline'
    : 'reference';

  // 险露 只在历史悬疑模板启用时可用；相邻章规则需要上一章 mainType。
  // 模板判定只用这一行作品数据，与注入侧共用同一个 gate。
  const pipelineEnabled = isPipelineEnabled(planWorkRow);
  const allowedBeatTypes = pipelineEnabled
    ? BEAT_TYPES
    : BEAT_TYPES.filter((type) => type !== DANGER_TYPE);
  const previousMainType = pipelineEnabled
    ? await loadPreviousMainType(workId, chapterId)
    : '';

  return {
    planGround,
    planCharacterNames,
    planMode,
    pipelineEnabled,
    allowedBeatTypes,
    previousMainType,
  };
}

module.exports = {
  buildPlanGrounding,
  loadPreviousMainType,
  MIN_OUTLINE_CHARS_FOR_PLAN,
};
