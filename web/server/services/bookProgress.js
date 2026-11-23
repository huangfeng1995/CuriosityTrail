'use strict';

/**
 * 全书进度。
 *
 * 模型写单章时最容易失去位置感：这一章是铺垫还是收束、离主线高潮还有多远，
 * 只看本章正文是判断不出来的。这里用作者**已经填过的信息**给出位置：
 *
 *   1. 作品大纲里如果有「第 X 幕 / 第 X 卷」标题，按标题数和章号区间推断；
 *   2. 没有幕/卷标题时，用章节自己的 volume 字段数卷；
 *   3. 两边都没有，就只给确定事实：第 N 章、全书现有 M 章、前面已有 N-1 章。
 *
 * 关键原则：**不猜**。推断不出来就不写「接近高潮」这种判断，
 * 免得模型拿一句编造的进度去安排节奏。
 */

/** 幕/卷/部/篇 标题：允许 markdown 前缀与数字/中文数字。 */
const HEADING_RE = /^\s*(?:#{1,6}\s*)?(第\s*[一二三四五六七八九十百零两0-9]+\s*([幕卷部篇]))/;
/** 标题块里的章号区间：第 1-10 章 / 1–10 章 / 第1至10章。 */
const RANGE_RE = /第?\s*(\d+)\s*[-–—~～至到]\s*(\d+)\s*章/;

const KIND_NAMES = { 幕: '幕', 卷: '卷', 部: '部', 篇: '篇' };

/**
 * 解析大纲里的幕/卷结构与章号区间。
 *
 * 只认「标题行 + 标题块内出现的区间」，解析不到区间就只保留标题（用于数总数）。
 *
 * @param {string} outline
 * @returns {{acts: Array, volumes: Array}}
 */
function parseOutlinePlan(outline) {
  const lines = String(outline || '').split(/\r?\n/);
  const headings = [];

  lines.forEach((line, index) => {
    const match = line.match(HEADING_RE);
    if (!match) return;
    headings.push({
      index,
      label: match[1].replace(/\s+/g, ''),
      kind: match[2],
      line: line.trim(),
    });
  });

  const withRange = headings.map((heading, i) => {
    const nextIndex = i + 1 < headings.length ? headings[i + 1].index : lines.length;
    // 区间通常写在标题同一行，也可能在标题下面几行（幕简介里）。
    const block = lines.slice(heading.index, nextIndex).join('\n');
    const range = block.match(RANGE_RE);
    return {
      label: heading.label,
      kind: heading.kind,
      text: heading.line,
      start: range ? Number(range[1]) : 0,
      end: range ? Number(range[2]) : 0,
    };
  });

  const dedupe = (kind) => {
    const seen = new Set();
    const list = [];
    for (const item of withRange) {
      if (item.kind !== kind) continue;
      const key = `${item.label}|${item.start}-${item.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(item);
    }
    return list;
  };

  return { acts: dedupe('幕'), volumes: dedupe('卷') };
}

/** 在区间列表里找包含某一章的那一段。 */
function findRange(list, seq) {
  const n = Number(seq) || 0;
  if (!n) return -1;
  return list.findIndex((item) => item.start > 0 && item.end >= item.start && n >= item.start && n <= item.end);
}

/** 卷名匹配：章节 volume 与大纲标题互相包含即认为是同一卷。 */
function findVolumeByName(volumes, volumeName) {
  const name = String(volumeName || '').replace(/\s+/g, '');
  if (!name) return -1;
  return volumes.findIndex((item) => {
    const text = String(item.text || '').replace(/\s+/g, '');
    return text.includes(name) || name.includes(item.label);
  });
}

/**
 * 生成给模型看的全书进度。
 *
 * @param {{work: Object, chapter: Object, chapters: Array}} params
 * @returns {{text: string, level: string, act: Object|null, volume: Object|null}|null}
 */
function describeBookProgress({ work, chapter, chapters = [] }) {
  if (!work || !chapter) return null;

  const ordered = [...chapters].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const position = ordered.findIndex((c) => c.id === chapter.id);
  const chapterIndex = position >= 0 ? position + 1 : Number(chapter.seq) || 1;
  const chapterTotal = Math.max(ordered.length, chapterIndex);
  const beforeCount = Math.max(0, chapterIndex - 1);

  const lines = [
    '## 全书进度',
    `当前：第 ${chapterIndex} 章（全书现有 ${chapterTotal} 章，前面已有 ${beforeCount} 章）`,
  ];

  const plan = parseOutlinePlan(work.outline);
  let level = 'chapter';
  let actInfo = null;
  let volumeInfo = null;

  // ---- 幕 ----
  if (plan.acts.length) {
    const hit = findRange(plan.acts, chapter.seq);
    if (hit >= 0) {
      level = 'act';
      const index = hit + 1;
      const remaining = Math.max(0, plan.acts.length - index);
      actInfo = { index, total: plan.acts.length, remaining };
      lines.push(
        `幕：第 ${index} ${KIND_NAMES.幕}（大纲共 ${plan.acts.length} 幕）` +
          `，距最后一幕还有 ${remaining} 幕`
      );
    } else {
      lines.push(`幕：大纲共 ${plan.acts.length} 幕；本章未标出所属幕，不要自行推断位置`);
    }
  }

  // ---- 卷 ----
  const volumeNames = [];
  for (const item of ordered) {
    const name = String(item.volume || '').trim();
    if (name && !volumeNames.includes(name)) volumeNames.push(name);
  }

  let volumeIndex = 0;
  const volumeTotal = Math.max(plan.volumes.length, volumeNames.length);

  if (volumeTotal) {
    if (chapter.volume) {
      const byName = findVolumeByName(plan.volumes, chapter.volume);
      if (byName >= 0) volumeIndex = byName + 1;
      else volumeIndex = volumeNames.indexOf(String(chapter.volume).trim()) + 1;
    }
    if (!volumeIndex) {
      const bySeq = findRange(plan.volumes, chapter.seq);
      if (bySeq >= 0) volumeIndex = bySeq + 1;
    }

    if (volumeIndex) {
      level = level === 'act' ? level : 'volume';
      const remaining = Math.max(0, volumeTotal - volumeIndex);
      volumeInfo = { index: volumeIndex, total: volumeTotal, remaining };
      lines.push(
        `卷：第 ${volumeIndex} 卷（全书共 ${volumeTotal} 卷）` +
          (remaining ? `，距最后一卷还有 ${remaining} 卷` : '，已是最后一卷')
      );
    } else {
      lines.push(`卷：全书共 ${volumeTotal} 卷；本章未标出所属卷`);
    }
  }

  // ---- 篇幅（作者填了目标字数才给比较，不拿正文长度猜剧情位置） ----
  const targetWords = Number(work.target_words) || 0;
  if (targetWords > 0) {
    const written = ordered.reduce((sum, c) => sum + (Number(c.word_count) || 0), 0);
    lines.push(`篇幅：已写 ${written} 字 / 目标 ${targetWords} 字`);
  }

  return {
    text: lines.join('\n'),
    level,
    chapterIndex,
    chapterTotal,
    beforeCount,
    act: actInfo,
    volume: volumeInfo,
  };
}

module.exports = {
  parseOutlinePlan,
  describeBookProgress,
};
