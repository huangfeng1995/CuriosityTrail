import React from 'react';

/**
 * 「出现位置」的两个展示件。
 *
 * 徽章挂在卡片标题旁边（一眼看到这名字在正文里有多少存在感），
 * 列表挂在卡片下方（点某一章直接跳过去）。
 */

/**
 * @param {{stat?: {total: number, chapters: Array}}} props
 */
export function CardHitBadge({ stat }) {
  if (!stat) return null;
  if (!stat.total) return <span className="ct-hit-badge is-empty">正文里还没有</span>;
  return (
    <span className="ct-hit-badge">
      {stat.chapters.length} 章 · {stat.total} 处
    </span>
  );
}

/**
 * @param {{
 *   stat?: {total: number, chapters: Array},
 *   label: string,
 *   onGoto: (chapterEntry: Object) => void,
 * }} props
 */
export function CardHitList({ stat, label, onGoto }) {
  if (!stat) return null;
  if (!stat.total) {
    return (
      <p className="ct-hit-empty">
        正文里还没有出现过「{label}」。写进去之后，这里会列出章节和原句。
      </p>
    );
  }

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
