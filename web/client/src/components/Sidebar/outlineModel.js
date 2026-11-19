/**
 * 灵感里的脑图：缩进大纲 ↔ 树。
 *
 * 库里 inspirations 只有 text 一个正文字段，所以脑图存成缩进大纲——
 * 它同时是「能直接读的文字」和「能还原成树的唯一来源」。
 * 不新增字段、不改服务端；AI 侧读到的也还是那段可读的文字。
 */

let seq = 0;
function uid() {
  seq += 1;
  return `n${Date.now().toString(36)}${seq}`;
}

export function makeNode(text = '', children = []) {
  return { id: uid(), text, children };
}

/** 是否像一份脑图：至少两行，且有缩进。 */
export function isOutline(text) {
  const lines = String(text || '').split('\n');
  return lines.length > 1 && lines.some((line) => /^[\t ]+\S/.test(line));
}

/** 缩进大纲 → 树（可能有多个顶层节点）。 */
export function parseOutline(text) {
  const roots = [];
  const stack = []; // { depth, node }

  String(text || '')
    .split('\n')
    .forEach((raw) => {
      if (!raw.trim()) return;
      const lead = raw.match(/^[\t ]*/)[0];
      const depth = lead.includes('\t')
        ? lead.split('\t').length - 1
        : Math.floor(lead.length / 2);
      const node = makeNode(raw.trim());
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      if (stack.length) stack[stack.length - 1].node.children.push(node);
      else roots.push(node);
      stack.push({ depth, node });
    });

  return roots;
}

/** 树 → 缩进大纲。一层两个空格。 */
export function serializeOutline(root) {
  const lines = [];
  const walk = (node, depth) => {
    const text = String(node.text || '').trim();
    if (text) lines.push(`${'  '.repeat(depth)}${text}`);
    (node.children || []).forEach((child) => walk(child, text ? depth + 1 : depth));
  };
  if (root) walk(root, 0);
  return lines.join('\n');
}

/**
 * 一段普通的多行文字 → 一层脑图。
 *
 * 第一行当中心，其余行挂成它的分支；顺手去掉行首的圆点/短横，
 * 免得节点名字里带着「- 」。只做这一层，细分交给作者在脑图里拖。
 */
export function linesToOutline(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/^\s*[-*·•]\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) return '';
  const [head, ...rest] = lines;
  return [head, ...rest.map((line) => `  ${line}`)].join('\n');
}

/** 多顶层节点收成一个中心节点，避免编辑时出现两棵树。 */
export function toRoot(roots, fallbackText = '新想法') {
  if (!roots || !roots.length) return makeNode(fallbackText);
  if (roots.length === 1) return roots[0];
  return makeNode(fallbackText, roots);
}

export function countNodes(node) {
  if (!node) return 0;
  return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
}

export function maxDepth(node) {
  if (!node) return 0;
  const children = node.children || [];
  if (!children.length) return 1;
  return 1 + Math.max(...children.map(maxDepth));
}

/**
 * 树 → 一张表：一级分支做行，二级分支做列名，三级及更深做单元格。
 *
 * 只有确实分出「列」时才返回表；否则让作者选「每个分支一条设定」。
 */
export function treeToTable(root) {
  const rows = (root?.children || []).filter((b) => String(b.text || '').trim());
  if (!rows.length) return null;

  const columns = [];
  rows.forEach((row) => {
    (row.children || []).forEach((col) => {
      const name = String(col.text || '').trim();
      if (name && !columns.includes(name)) columns.push(name);
    });
  });
  if (!columns.length) return null;

  const tableRows = rows.map((row) => {
    const cells = [String(row.text || '').trim()];
    columns.forEach((name) => {
      const col = (row.children || []).find((c) => String(c.text || '').trim() === name);
      cells.push(
        col
          ? (col.children || [])
              .map((v) => String(v.text || '').trim())
              .filter(Boolean)
              .join('；')
          : ''
      );
    });
    return cells;
  });

  return { header: [String(root.text || '').trim() || '分支', ...columns], rows: tableRows };
}

/** 一个分支 → 一条设定的正文（保留层级）。 */
export function branchContent(branch) {
  const lines = [];
  const walk = (node, depth) => {
    const text = String(node.text || '').trim();
    if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
    (node.children || []).forEach((child) => walk(child, depth + 1));
  };
  (branch.children || []).forEach((child) => walk(child, 0));
  return lines.join('\n');
}
