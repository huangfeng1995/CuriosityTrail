import React from 'react';

/**
 * 行内改写/形态修订共用的逐字对照。
 *
 * 节点编辑器（ChapterEditor）与侧栏动作卡片（ActionCard）都要画「原文 / 新版」，
 * 差异算法只留这一份：两边各写一遍，标色规则迟早会走样。
 */

// 对照里的差异一次最多算多少格。超了就只并排显示原文与新版，不做逐字标色：
// 两千字的长段再逐字对齐会明显卡顿，而这么大的改动本来也看不清细差。
const DIFF_CELL_LIMIT = 240000;

/** 逐字对照：返回原文/新版各自的片段，供上下两行分别标删改与新增。 */
export function diffInline(before, after) {
  if (before === after) return null;
  const n = before.length;
  const m = after.length;
  if (n * m > DIFF_CELL_LIMIT) return null;

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        before[i] === after[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const beforeSegs = [];
  const afterSegs = [];
  const push = (arr, type, ch) => {
    const last = arr[arr.length - 1];
    if (last && last.type === type) last.text += ch;
    else arr.push({ type, text: ch });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push(beforeSegs, 'same', before[i]);
      push(afterSegs, 'same', after[j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      push(beforeSegs, 'del', before[i]);
      i += 1;
    } else {
      push(afterSegs, 'add', after[j]);
      j += 1;
    }
  }
  while (i < n) {
    push(beforeSegs, 'del', before[i]);
    i += 1;
  }
  while (j < m) {
    push(afterSegs, 'add', after[j]);
    j += 1;
  }
  return { beforeSegs, afterSegs };
}

/** 把对照片段渲染出来：变化的那一侧用删/增标记，未变的保持普通文字。 */
export function renderDiff(segs, changed) {
  return segs.map((seg, i) => {
    if (seg.type !== changed) return <React.Fragment key={i}>{seg.text}</React.Fragment>;
    return changed === 'del' ? <del key={i}>{seg.text}</del> : <ins key={i}>{seg.text}</ins>;
  });
}
