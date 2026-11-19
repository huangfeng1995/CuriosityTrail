import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeNode,
  isOutline,
  linesToOutline,
  parseOutline,
  serializeOutline,
  toRoot,
  countNodes,
  treeToTable,
  branchContent,
} from '../src/components/Sidebar/outlineModel.js';

/**
 * 灵感脑图：缩进大纲 ↔ 树 ↔ 设定。
 *
 * 这里不测渲染，只测「作者写下的层级不会在往返里丢」。
 */

test('isOutline: 只有缩进行才算脑图', () => {
  assert.equal(isOutline('一句话'), false);
  assert.equal(isOutline('两句\n但不是层级'), false);
  assert.equal(isOutline('中心\n  分支'), true);
});

test('parseOutline: 空格与 Tab 都能读出层级', () => {
  const roots = parseOutline('中心\n  一级\n    二级\n  再一级');
  assert.equal(roots.length, 1);
  assert.equal(roots[0].text, '中心');
  assert.deepEqual(
    roots[0].children.map((c) => c.text),
    ['一级', '再一级']
  );
  assert.equal(roots[0].children[0].children[0].text, '二级');

  const tabs = parseOutline('中心\n\t一级');
  assert.equal(tabs[0].children.length, 1);
});

test('serializeOutline: 树回写成两层缩进', () => {
  const root = makeNode('中心', [makeNode('一级', [makeNode('二级')])]);
  assert.equal(serializeOutline(root), '中心\n  一级\n    二级');
});

test('parseOutline / serializeOutline: 往返不丢节点', () => {
  const text = '木料\n  橡木\n    材等\n      A\n  胡桃木';
  const root = toRoot(parseOutline(text));
  assert.equal(serializeOutline(root), text);
  assert.equal(countNodes(root), 5);
});

test('toRoot: 多顶层节点收进一个中心', () => {
  const root = toRoot(parseOutline('甲\n乙'), '脑图');
  assert.equal(root.text, '脑图');
  assert.deepEqual(
    root.children.map((c) => c.text),
    ['甲', '乙']
  );
});

test('treeToTable: 一级做行、二级做列、三级做单元格', () => {
  const root = makeNode('木料', [
    makeNode('橡木', [
      makeNode('材等', [makeNode('A')]),
      makeNode('产区', [makeNode('北美')]),
    ]),
    makeNode('胡桃木', [makeNode('材等', [makeNode('A+')])]),
  ]);

  const table = treeToTable(root);
  assert.deepEqual(table.header, ['木料', '材等', '产区']);
  assert.deepEqual(table.rows, [
    ['橡木', 'A', '北美'],
    ['胡桃木', 'A+', ''],
  ]);
});

test('treeToTable: 同一格多个值用分号连接', () => {
  const root = makeNode('木料', [
    makeNode('橡木', [makeNode('产区', [makeNode('北美'), makeNode('欧洲')])]),
  ]);
  assert.equal(treeToTable(root).rows[0][1], '北美；欧洲');
});

test('treeToTable: 只有一层时不给表，交给「每个分支一条」', () => {
  const root = makeNode('木料', [makeNode('橡木'), makeNode('胡桃木')]);
  assert.equal(treeToTable(root), null);
});

test('linesToOutline: 多行文字摊成一层，第一行当中心', () => {
  assert.equal(
    linesToOutline('雨夜追人\n- 巷子太窄\n· 灯笼灭了'),
    '雨夜追人\n  巷子太窄\n  灯笼灭了'
  );
  assert.equal(linesToOutline('只有一行'), '只有一行');
  assert.equal(linesToOutline('  \n '), '');
});

test('branchContent: 分支的孩子写成层级列表', () => {
  const branch = makeNode('橡木', [makeNode('材等', [makeNode('A')])]);
  assert.equal(branchContent(branch), '- 材等\n  - A');
});
