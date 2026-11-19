import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_TABLE,
  parseTableRow,
  splitContent,
  serializeTable,
  mergeTable,
  isEmptyTable,
  parseTsv,
  fillFromGrid,
} from '../src/components/Sidebar/tableModel.js';

/**
 * 设定表格：Markdown 与网格之间的往返。
 *
 * 这套函数的唯一职责是「作者在格子里填的东西，落库后还是能读的表格」，
 * 所以覆盖三点：拆分不吞正文、序列化列宽对齐、外部表格粘贴按锚点铺开。
 */

test('parseTableRow: 拆单元格，保留转义竖线', () => {
  assert.deepEqual(parseTableRow('| 名称 | 材等 |'), ['名称', '材等']);
  assert.deepEqual(parseTableRow('| a \\| b | c |'), ['a | b', 'c']);
  assert.equal(parseTableRow('普通一行'), null);
});

test('splitContent: 前后文字原样保留，只认第一张表', () => {
  const content = '木料分三等。\n\n| 名称 | 材等 |\n| --- | --- |\n| 橡木 | A |\n\n以上按旧制。';
  const { before, table, after } = splitContent(content);
  assert.equal(before, '木料分三等。');
  assert.deepEqual(table.header, ['名称', '材等']);
  assert.deepEqual(table.rows, [['橡木', 'A']]);
  assert.equal(after, '以上按旧制。');
});

test('splitContent: 没有表格时表为空，正文不动', () => {
  const { before, table, after } = splitContent('只有一段说明');
  assert.equal(before, '只有一段说明');
  assert.equal(table, null);
  assert.equal(after, '');
});

test('serializeTable: 列数按最宽的行补齐', () => {
  const md = serializeTable({ header: ['名称'], rows: [['橡木', 'A']] });
  assert.equal(md, '| 名称 |  |\n| --- | --- |\n| 橡木 | A |');
});

test('mergeTable: 已有表时整张替换，不叠第二张', () => {
  const once = mergeTable('说明在前。', { header: ['A'], rows: [['1']] });
  const twice = mergeTable(once, { header: ['B'], rows: [['2']] });
  assert.ok(twice.startsWith('说明在前。'));
  assert.equal((twice.match(/\| B \|/g) || []).length, 1);
  assert.ok(!twice.includes('| A |'));
});

test('isEmptyTable: 全空格子算空', () => {
  assert.equal(isEmptyTable(EMPTY_TABLE), true);
  assert.equal(isEmptyTable({ header: ['名称'], rows: [['']] }), false);
});

test('parseTsv: 去掉末尾空行', () => {
  assert.deepEqual(parseTsv('a\tb\nc\td\n\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('fillFromGrid: 从锚点铺开，行列不够自动扩', () => {
  const table = { header: ['甲', '乙'], rows: [['1', '2']] };
  const next = fillFromGrid(table, [['3', '4'], ['5', '6']], 0, 0);
  assert.deepEqual(next.header, ['甲', '乙']);
  assert.deepEqual(next.rows[0], ['3', '4']);
  assert.deepEqual(next.rows[1], ['5', '6']);
});

test('fillFromGrid: 粘贴比表宽时补列，表头补空', () => {
  const next = fillFromGrid({ header: ['甲'], rows: [['1']] }, [['乙', '丙']], 0, 0);
  assert.deepEqual(next.header, ['甲', '']);
  assert.deepEqual(next.rows[0], ['乙', '丙']);
});

test('fillFromGrid: 行号 -1 表示从表头开始写', () => {
  const next = fillFromGrid(EMPTY_TABLE, [['名称', '材等']], -1, 0);
  assert.deepEqual(next.header, ['名称', '材等']);
});
