'use strict';

/**
 * 本章知情边界的只读视图（作者侧）。
 *
 * 注入块给模型看，这里给作者看：同一份 knowledge_at 语义，
 * 只把「谁已知/谁未知」摊平成可核对的结构，不做任何写入。
 *
 * chapter_seq = N 表示「第 N 章写完后生效」，所以编辑第 N 章时
 * 能看到的是 chapter_seq <= N - 1 的状态——与 AI 注入完全一致。
 */

const { all, get } = require('../../database');
const { knowledgeAt } = require('./knowledge');
const { factShortTitle } = require('../context');

/** 已知/公开对本人都是「已知」；其余按原状态分桶。 */
function bucketOf(state) {
  if (state === 'knows' || state === 'exposed') return 'known';
  if (state === 'partial') return 'partial';
  if (state === 'suspects') return 'suspects';
  return 'unknown';
}

/**
 * @param {string} workId
 * @param {string} chapterId
 * @returns {Promise<Object|null>} 章节不存在时返回 null
 */
async function boundaryForChapter(workId, chapterId) {
  const chapter = await get('SELECT * FROM chapters WHERE id = ? AND work_id = ?', [
    chapterId,
    workId,
  ]);
  if (!chapter) return null;

  const [characters, facts, visible] = await Promise.all([
    all('SELECT * FROM characters WHERE work_id = ? ORDER BY name', [workId]),
    all(
      'SELECT * FROM story_facts WHERE work_id = ? ORDER BY created_at ASC, id ASC',
      [workId]
    ),
    knowledgeAt(workId, chapter.seq),
  ]);

  const labels = new Map(facts.map((fact, index) => [fact.id, `F${index + 1}`]));
  const stateByCharacter = new Map();
  for (const row of visible) {
    if (!row || !row.character_id || !row.fact_id) continue;
    if (!stateByCharacter.has(row.character_id)) {
      stateByCharacter.set(row.character_id, new Map());
    }
    stateByCharacter.get(row.character_id).set(row.fact_id, row.state);
  }

  const characterViews = characters.map((character) => {
    const states = stateByCharacter.get(character.id) || new Map();
    const groups = { known: [], partial: [], suspects: [], unknown: [] };
    for (const fact of facts) {
      const state = states.get(fact.id);
      groups[bucketOf(state)].push({
        id: fact.id,
        label: labels.get(fact.id) || '',
        title: factShortTitle(fact),
        state: state || 'unknown',
      });
    }
    return {
      id: character.id,
      name: character.name,
      known: groups.known,
      partial: groups.partial,
      suspects: groups.suspects,
      unknown: groups.unknown,
    };
  });

  return {
    chapterId: chapter.id,
    chapterSeq: chapter.seq,
    chapterTitle: chapter.title,
    // 语义说明给前端直接展示：第 N 章编辑时看到的是开写前边界
    effectiveBeforeSeq: chapter.seq,
    factCount: facts.length,
    characters: characterViews,
  };
}

module.exports = { boundaryForChapter };
