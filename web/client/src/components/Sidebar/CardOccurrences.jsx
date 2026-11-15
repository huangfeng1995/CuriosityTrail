import React from 'react';

/**
 * 「出现位置」的两个展示件。
 *
 * 徽章挂在卡片标题旁边（一眼看到这名字在正文里有多少存在感），
 * 列表挂在卡片下方（点某一章直接跳过去）。
 * 没有命中时两者都不占位：一句「正文里还没有」既没有动作，
 * 也会把卡片撑高一截，不如干脆不出现。
 */

/**
 * @param {{stat?: {total: number, chapters: Array}}} props
 */
export function CardHitBadge({ stat }) {
  if (!stat || !stat.total) return null;
  return (
    <span className="ct-hit-badge">
      {stat.chapters.length} 章 · {stat.total} 处
    </span>
  );
}

/**
 * @param {{
 *   stat?: {total: number, chapters: Array},
 *   onGoto: (chapterEntry: Object) => void,
 * }} props
 */
export function CardHitList({ stat, onGoto }) {
  if (!stat || !stat.total) return null;

  return (
    <div className="ct-hit-list">
      {stat.chapters.map((chapter) => (
        <button
          key={chapter.chapterId}
          type="button"
          className="ct-hit-row"
          onClick={() => onGoto(chapter)}
          title={`跳到「${chapter.chapterTitle}」`}
        >
          <span className="ct-hit-row-head">
            <span className="ct-hit-chapter">{chapter.chapterTitle || '未命名章节'}</span>
            <span className="ct-hit-count">{chapter.count} 处</span>
          </span>
          <span className="ct-hit-snippet">
            {chapter.hits?.slice(0, 2).map((h) => h.snippet).join(' / ')}
          </span>
        </button>
      ))}
    </div>
  );
}
