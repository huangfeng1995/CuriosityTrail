'use strict';

/**
 * 全书一致性检查（规则层）。
 *
 * 规则层（本地、免费、立刻出结果）—— 靠数据库里的结构化数据交叉比对
 *   · 人物卡里的角色，正文里从没出现过（写废了的人物）
 *   · 正文里出现了但没有人物卡的角色（漏建卡）
 *   · 设定卡写了但正文从没提到（没落地的设定）
 *   · 章节标题重复、章节状态异常
 *   · 人物别名与其它人物重名（一个人两个名字，AI 会当成两个人）
 *   · 史实锚点与正文冲突（模板启用时的第 6 类规则）
 *
 * 更深的跨章问题交给审稿人，不在这里重复。
 */

const { all, get } = require('../database');
const { isPipelineEnabled } = require('./pipeline/gate');
const { checkAnchors } = require('./pipeline/anchorCheck');

/**
 * 取人物的所有可识别名称。
 *
 * 这里延迟 require：context.js 装配上下文时会加载技能注册表，
 * 技能注册表又加载本模块（checkConsistency 技能）——形成循环依赖。
 * 在顶层解构 nameVariants 会拿到尚未填充的 exports，运行时就是 undefined。
 *
 * @param {Object} character
 * @returns {Array<string>}
 */
function nameVariants(character) {
  return require('./context').nameVariants(character);
}

/**
 * 章节状态白名单
 */
const VALID_STATUS = new Set(['draft', 'revising', 'done']);

/**
 * 把人物名归一化，用于跨人物查重。
 */
function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * 规则层检查。
 *
 * @param {string} workId
 * @returns {Promise<Array<Object>>} 问题列表
 */
async function runRuleChecks(workId) {
  const issues = [];

  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return issues;

  const chapters = await all(
    'SELECT id, title, seq, status, content, blocks FROM chapters WHERE work_id = ? ORDER BY seq',
    [workId]
  );
  const characters = await all(
    'SELECT * FROM characters WHERE work_id = ?',
    [workId]
  );
  const settings = await all(
    'SELECT * FROM settings WHERE work_id = ?',
    [workId]
  );

  const fullText = chapters.map((c) => c.content || '').join('\n');

  // ---- 人物：卡里有、正文里没出现 ----
  for (const character of characters) {
    const variants = nameVariants(character);
    const appeared = variants.some((v) => v && fullText.includes(v));
    if (!appeared && fullText.length > 0) {
      issues.push({
        type: 'unused_character',
        severity: 'low',
        title: `人物「${character.name}」从未在正文中出现`,
        detail:
          '人物卡已建好，但全书正文里找不到这个名字。要么是没写进去，要么是这个角色已经不需要了。',
        target: character.name,
      });
    }
  }

  // ---- 人物：别名与他人重名 ----
  const nameOwner = new Map();
  for (const character of characters) {
    for (const variant of nameVariants(character)) {
      const key = normalizeName(variant);
      if (!key) continue;
      if (nameOwner.has(key) && nameOwner.get(key) !== character.id) {
        issues.push({
          type: 'duplicate_name',
          severity: 'medium',
          title: `「${variant}」同时属于两个不同的人物`,
          detail: `「${character.name}」和「${
            characters.find((c) => c.id === nameOwner.get(key))?.name || '另一人物'
          }」共用同一个名字。AI 会把两个人当成同一个，检索和一致性判断都会出错。`,
          target: variant,
        });
      } else {
        nameOwner.set(key, character.id);
      }
    }
  }

  // ---- 设定：卡里写了、正文没提 ----
  for (const setting of settings) {
    if (!setting.name) continue;
    if (!fullText.includes(setting.name)) {
      issues.push({
        type: 'unused_setting',
        severity: 'low',
        title: `设定「${setting.name}」尚未在正文中落地`,
        detail: '设定卡存在但正文没提到。要么还没写到，要么这个设定用不上了。',
        target: setting.name,
      });
    }
  }

  // ---- 章节：状态异常 ----
  for (const chapter of chapters) {
    if (chapter.status && !VALID_STATUS.has(chapter.status)) {
      issues.push({
        type: 'invalid_status',
        severity: 'low',
        title: `章节「${chapter.title}」的状态值异常`,
        detail: `状态是「${chapter.status}」，不在草稿/修订中/已完成之内。`,
        target: chapter.title,
      });
    }
  }

  // ---- 章节：标题重复 ----
  const titleCount = new Map();
  for (const chapter of chapters) {
    const key = normalizeName(chapter.title);
    titleCount.set(key, (titleCount.get(key) || 0) + 1);
  }
  for (const [title, count] of titleCount) {
    if (count > 1) {
      issues.push({
        type: 'duplicate_chapter_title',
        severity: 'low',
        title: `有 ${count} 章都叫「${title}」`,
        detail: '章节重名会让目录和导出时难以分辨，建议改掉。',
        target: title,
      });
    }
  }

  // ---- 锚点：史实断言与正文冲突（模板启用时的第 6 类规则） ----
  // 走既有报告出口，不另造接口：作者在「一致性检查」页看到的
  // 违锚点和人物未登场、设定未落地是同一份清单。
  if (isPipelineEnabled(work)) {
    try {
      const anchors = await all(
        `SELECT * FROM work_anchors
         WHERE work_id = ? AND status = 'active'
         ORDER BY created_at ASC, id ASC`,
        [workId]
      );
      if (anchors.length) {
        const anchorById = new Map(anchors.map((a) => [a.id, a]));
        for (const chapter of chapters) {
          const body = chapterText(chapter);
          if (!body) continue;
          const hits = checkAnchors(anchors, chapter.seq, [
            { id: chapter.id, content: body },
          ]);
          for (const hit of hits) {
            const anchor = anchorById.get(hit.anchorId) || {};
            issues.push({
              type: 'anchor_violation',
              severity: 'high',
              title: `锚点冲突：第 ${chapter.seq} 章「${hit.quote.slice(0, 30)}」`,
              detail: `${
                anchor.subject ? `「${anchor.subject}」：` : ''
              }${anchor.claim || '锚点断言'}。正文命中「${hit.quote}」（${hit.ruleType}）。`,
              target: anchor.subject || '',
            });
          }
        }
      }
    } catch (err) {
      // 一条新规则坏掉，不能让整份一致性报告失败
      console.error('[consistency] 锚点检查失败（已跳过）:', err.message);
    }
  }

  return issues;
}

/**
 * 章节块：blocks 坏掉时返回空数组，由调用方退回 content。
 */
function blocksOf(chapter) {
  if (!chapter.blocks) return [];
  try {
    const parsed = JSON.parse(chapter.blocks);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 章节正文：blocks 优先，content 兜底。
 *
 * 编辑器以 blocks 为准，纯文本 content 可能还没同步；
 * 只看 content 会漏掉实际写进块里的句子。
 */
function chapterText(chapter) {
  const body = blocksOf(chapter)
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
  return body || String(chapter.content || '');
}

module.exports = {
  runRuleChecks,
};
