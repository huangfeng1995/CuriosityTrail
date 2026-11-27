'use strict';

/**
 * 章节拍表落库与复用（HP11 / P.8.2）。
 *
 * 目标只有一件事：重进同一章或重开写时不要再跑一遍规划。
 *
 * 复用不是无条件读旧行：规划时记下本章大纲与正文的指纹，只有两者都没变
 * 才算「计划仍有效」。正文改过、大纲改过都必须重排，否则写手会拿一份
 * 描述旧稿的节拍表去写新稿。
 *
 * 本模块不调用模型，也不认识 Express，方便单测。
 */

const crypto = require('crypto');
const { get, run } = require('../../database');

/** 只保留最近一次规划；被放弃（abandoned）的行不参与复用。 */
const REUSABLE_STATUSES = new Set(['draft', 'awaiting_choice', 'confirmed']);

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex');
}

/**
 * 本章正文指纹。
 *
 * blocks 是正文的权威结构；空数组时退回 content。只做原文哈希，
 * 不做 trim/归一化：作者改了一个标点也应该视为正文变过。
 */
function bodyOf(chapter) {
  if (!chapter) return '';
  const blocks = String(chapter.blocks || '');
  if (blocks && blocks !== '[]') return blocks;
  return String(chapter.content || '');
}

function fingerprintOf(chapter) {
  return {
    outlineHash: sha1(String((chapter && chapter.outline) || '')),
    bodyHash: sha1(bodyOf(chapter)),
  };
}

async function readChapter(workId, chapterId) {
  return get(
    'SELECT outline, content, blocks FROM chapters WHERE id = ? AND work_id = ?',
    [chapterId, workId]
  );
}

/**
 * 读取可复用的拍表。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} params.chapterId
 * @returns {Promise<{plan: Object, brief: Object|null, row: Object, stale: false}
 *                   | {plan: null, brief: null, row: Object|null, stale: boolean, reason: string}>}
 */
async function loadReusablePlan({ workId, chapterId } = {}) {
  if (!workId || !chapterId) {
    return { plan: null, brief: null, row: null, stale: false, reason: 'no_chapter' };
  }

  const chapter = await readChapter(workId, chapterId);
  if (!chapter) {
    return { plan: null, brief: null, row: null, stale: false, reason: 'no_chapter' };
  }

  const row = await get(
    `SELECT * FROM chapter_plans
     WHERE work_id = ? AND chapter_id = ?
     ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    [workId, chapterId]
  );
  if (!row || !REUSABLE_STATUSES.has(row.status)) {
    return { plan: null, brief: null, row: row || null, stale: false, reason: 'no_plan' };
  }

  const { outlineHash, bodyHash } = fingerprintOf(chapter);
  const outlineChanged = row.outline_hash !== outlineHash;
  const bodyChanged = row.body_hash !== bodyHash;
  if (outlineChanged || bodyChanged) {
    return {
      plan: null,
      brief: null,
      row,
      stale: true,
      reason: outlineChanged && bodyChanged ? 'outline+body_changed'
        : outlineChanged ? 'outline_changed' : 'body_changed',
    };
  }

  let plan = null;
  let brief = null;
  try {
    plan = JSON.parse(row.plan);
  } catch (e) {
    return { plan: null, brief: null, row, stale: true, reason: 'bad_plan_json' };
  }
  if (!plan || !Array.isArray(plan.beats) || !plan.beats.length) {
    return { plan: null, brief: null, row, stale: true, reason: 'empty_plan' };
  }
  if (row.brief) {
    try {
      brief = JSON.parse(row.brief);
    } catch (e) {
      brief = null;
    }
  }

  return { plan, brief, row, stale: false, reason: 'reused' };
}

/**
 * 保存本章最终采用的拍表（同一章只更新最近一行）。
 *
 * 写入时重新取一次指纹：规划期间作者可能改过大纲/正文，存最新的指纹
 * 才能让「下次是否复用」判断的是这一次真正看到的输入。
 */
async function saveChapterPlan({
  workId,
  chapterId,
  plan,
  brief = null,
  status = 'confirmed',
  options = [],
  chosen = null,
} = {}) {
  if (!workId || !chapterId || !plan) return null;

  const chapter = await readChapter(workId, chapterId);
  const { outlineHash, bodyHash } = fingerprintOf(chapter);
  const ts = new Date().toISOString();
  const planJson = JSON.stringify(plan);
  const briefJson = brief ? JSON.stringify(brief) : null;
  const optionsJson = JSON.stringify(Array.isArray(options) ? options : []);

  const existing = await get(
    `SELECT id FROM chapter_plans
     WHERE work_id = ? AND chapter_id = ?
     ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
    [workId, chapterId]
  );

  if (existing) {
    await run(
      `UPDATE chapter_plans
       SET plan = ?, brief = ?, status = ?, options = ?, chosen = ?,
           outline_hash = ?, body_hash = ?, updated_at = ?
       WHERE id = ?`,
      [planJson, briefJson, status, optionsJson, chosen, outlineHash, bodyHash, ts, existing.id]
    );
    return existing.id;
  }

  const id = crypto.randomUUID();
  await run(
    `INSERT INTO chapter_plans
       (id, work_id, chapter_id, plan, brief, status, options, chosen,
        outline_hash, body_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workId,
      chapterId,
      planJson,
      briefJson,
      status,
      optionsJson,
      chosen,
      outlineHash,
      bodyHash,
      ts,
      ts,
    ]
  );
  return id;
}

/**
 * 从拍表里找暂停点（HP12）。
 *
 * 只有「决定」拍、标了 critical、且带 2–3 个选项时才停。
 * 这不是「所有章节都停下来」：没有关键抉择的章照旧一路写完。
 *
 * @param {Object} plan validateBeatPlan 归一化后的拍表
 * @returns {{beatId: string, goal: string, options: Array}|null}
 */
function pausePointOf(plan) {
  if (!plan || !Array.isArray(plan.beats)) return null;
  const beat = plan.beats.find(
    (item) =>
      item &&
      item.type === '决定' &&
      item.critical === true &&
      Array.isArray(item.options) &&
      item.options.length >= 2
  );
  if (!beat) return null;
  return {
    beatId: beat.id,
    goal: beat.goal || '',
    options: beat.options.slice(0, 3).map((option) => ({
      id: String(option.id),
      label: String(option.label),
      consequence: String(option.consequence),
    })),
  };
}

/** 解析库里的 options 列；坏数据按空清单处理，不让暂停面板渲染出半条选项。 */
function parseOptions(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter((item) => item && item.id && item.label && item.consequence)
      .slice(0, 3)
      .map((item) => ({
        id: String(item.id),
        label: String(item.label),
        consequence: String(item.consequence),
      }));
  } catch (e) {
    return [];
  }
}

function parsePlan(raw) {
  try {
    return JSON.parse(raw || 'null');
  } catch (e) {
    return null;
  }
}

/**
 * 作者选定一个选项，或直接按原计划放行。
 *
 * 不传 optionId（null/''）＝ 放行：状态同样转 confirmed，但不额外追加
 * 「本节拍已定」约束，写手按节拍表原样写。这样作者既能改方向，
 * 也能看一眼就让它往下走。
 *
 * @returns {{planId, status, option}|{error: string, options?: Array}}
 */
async function choosePlanOption({ workId, chapterId, planId, optionId } = {}) {
  if (!workId || !chapterId || !planId) return { error: 'not_found' };
  const row = await get(
    'SELECT * FROM chapter_plans WHERE id = ? AND work_id = ? AND chapter_id = ?',
    [planId, workId, chapterId]
  );
  if (!row) return { error: 'not_found' };
  if (row.status === 'abandoned') return { error: 'abandoned' };

  const options = parseOptions(row.options);
  const wanted = optionId === null || optionId === undefined ? '' : String(optionId);
  let option = null;
  if (wanted) {
    option = options.find((item) => item.id === wanted) || null;
    if (!option) return { error: 'bad_option', options };
  }

  const ts = new Date().toISOString();
  await run(
    "UPDATE chapter_plans SET status = 'confirmed', chosen = ?, updated_at = ? WHERE id = ?",
    [option ? option.id : null, ts, row.id]
  );
  return { planId: row.id, status: 'confirmed', option, options };
}

/** 作者放弃这次规划：不写正文，计划行留档但不再参与复用。 */
async function abandonChapterPlan({ workId, chapterId, planId } = {}) {
  if (!workId || !chapterId || !planId) return { error: 'not_found' };
  const row = await get(
    'SELECT id FROM chapter_plans WHERE id = ? AND work_id = ? AND chapter_id = ?',
    [planId, workId, chapterId]
  );
  if (!row) return { error: 'not_found' };
  await run(
    "UPDATE chapter_plans SET status = 'abandoned', updated_at = ? WHERE id = ?",
    [new Date().toISOString(), row.id]
  );
  return { planId: row.id, status: 'abandoned' };
}

module.exports = {
  fingerprintOf,
  loadReusablePlan,
  saveChapterPlan,
  pausePointOf,
  parseOptions,
  choosePlanOption,
  abandonChapterPlan,
};
