/**
 * 设定里的 Markdown 表格：解析、序列化、与正文合并。
 *
 * 设定内容在库里仍然是一段文本（content），表格只是它的可视化写法。
 * 不新增字段、不改服务端，作者换设备、换客户端看到的还是同一份内容。
 *
 * 一条设定最多认一张表：取正文里的第一个表格块，前后文字原样保留。
 */

/** 表格的初始形状：两列两行，表头留空由作者填。 */
export const EMPTY_TABLE = {
  header: ['', ''],
  rows: [
    ['', ''],
    ['', ''],
  ],
};

/** 一行 Markdown 表格 → 单元格数组；不是表格行返回 null。 */
export function parseTableRow(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return null;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

/** 把正文拆成「表前文字 / 第一张表 / 表后文字」。 */
export function splitContent(content) {
  const text = String(content || '');
  const lines = text.split('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (parseTableRow(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return { before: text.trimEnd(), table: null, after: '' };

  let end = start;
  while (end + 1 < lines.length && parseTableRow(lines[end + 1])) end += 1;

  const block = lines.slice(start, end + 1).map(parseTableRow);
  const header = block[0] || [];
  const rows = block.slice(1).filter((cells) => !isSeparator(cells));

  return {
    before: lines.slice(0, start).join('\n').trimEnd(),
    table: { header, rows },
    after: lines.slice(end + 1).join('\n').trimStart(),
  };
}

function pad(arr, cols) {
  return Array.from({ length: cols }, (_, i) =>
    String(arr[i] ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ')
      .trim()
  );
}

/** 表格 → Markdown。列数以最宽的一行为准，缺的补空。 */
export function serializeTable(table) {
  const header = Array.isArray(table?.header) ? table.header : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const cols = Math.max(1, header.length, ...rows.map((r) => r.length));

  const lines = [
    `| ${pad(header, cols).join(' | ')} |`,
    `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`,
  ];
  rows.forEach((row) => lines.push(`| ${pad(row, cols).join(' | ')} |`));
  return lines.join('\n');
}

/** 把一张表写回正文：替换原有第一张表，没有就接在末尾。 */
export function mergeTable(content, table) {
  const { before, after } = splitContent(content);
  return [before, serializeTable(table), after]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 表格是否没有任何内容（切换页签时用它决定要不要动正文）。 */
export function isEmptyTable(table) {
  if (!table) return true;
  const all = [...(table.header || []), ...(table.rows || []).flat()];
  return all.every((cell) => !String(cell || '').trim());
}

/**
 * 从 Excel / 飞书表格复制来的 TSV → 二维数组。
 * 末尾的空行不要，否则粘一次会多出一整行空格子。
 */
export function parseTsv(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((cell) => cell.trim()));
}

/**
 * 把一块 TSV 铺进表格的指定位置（锚点是左上角）。
 *
 * 行号 -1 表示从表头开始；列或行不够就自动扩。
 */
export function fillFromGrid(table, grid, rowIndex, colIndex) {
  if (!Array.isArray(grid) || !grid.length) return table;

  const width = Math.max(...grid.map((r) => r.length));
  const needCols = colIndex + width;
  const needRows = Math.max(0, rowIndex) + grid.length;

  const header = [...(table.header || [])];
  const rows = (table.rows || []).map((r) => [...r]);

  while (header.length < needCols) header.push('');
  while (rows.length < needRows) rows.push(Array(header.length).fill(''));
  rows.forEach((row) => {
    while (row.length < header.length) row.push('');
  });

  grid.forEach((line, r) => {
    const target = rowIndex + r;
    line.forEach((cell, c) => {
      const at = colIndex + c;
      if (target < 0) header[at] = cell;
      else rows[target][at] = cell;
    });
  });

  return { header, rows };
}
