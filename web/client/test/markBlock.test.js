import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MARKABLE_TYPES,
  isMarkableBlock,
  parseSpeaker,
  splitBlockForMark,
} from '../src/components/Editor/blocks.js';

/**
 * 选区标记（正文里把某一句标成对白）的拆块测试。
 *
 * 核心约定：
 *   - 整块选中 → 只换类型，不产生新块
 *   - 部分选中 → 切成 前段 / 选中段 / 后段，第一段沿用原 id
 *   - 无法标记的情况（同类型、空选区、非文本块）返回 null，调用方不记撤销点
 */

const block = (id, type, content, patch = {}) => ({ id, type, content, ...patch });

// ---------------------------------------------------------------------------
// 说话人解析
// ---------------------------------------------------------------------------

test('parseSpeaker: 拆出冒号前的说话人', () => {
  assert.deepEqual(parseSpeaker('陈默：哇哇'), { speaker: '陈默', content: '哇哇' });
  assert.deepEqual(parseSpeaker('陈默:哇哇'), { speaker: '陈默', content: '哇哇' });
});

test('parseSpeaker: 没有冒号就整句留在正文', () => {
  assert.deepEqual(parseSpeaker('“哇哇”'), { speaker: '', content: '“哇哇”' });
});

test('parseSpeaker: 逗号、引号开头不当作说话人', () => {
  assert.deepEqual(parseSpeaker('，他说'), { speaker: '', content: '，他说' });
  assert.deepEqual(parseSpeaker('“别动。”他说'), { speaker: '', content: '“别动。”他说' });
});

// ---------------------------------------------------------------------------
// 可标记类型
// ---------------------------------------------------------------------------

test('isMarkableBlock: 只有正文/对白/独白可标记', () => {
  assert.equal(isMarkableBlock(block('a', 'paragraph', 'x')), true);
  assert.equal(isMarkableBlock(block('a', 'dialogue', 'x')), true);
  assert.equal(isMarkableBlock(block('a', 'inner', 'x')), true);
  assert.equal(isMarkableBlock(block('a', 'image', 'x')), false);
  assert.equal(isMarkableBlock(block('a', 'scene_break', '')), false);
  assert.equal(isMarkableBlock(null), false);
});

// ---------------------------------------------------------------------------
// 整块选中：等价于转类型
// ---------------------------------------------------------------------------

test('整块标为对白：保留正文，说话人留空', () => {
  const blocks = [block('b1', 'paragraph', '哇哇')];
  const out = splitBlockForMark(blocks, 'b1', 0, 2, 'dialogue');

  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'dialogue');
  assert.equal(out[0].content, '哇哇');
  assert.equal(out[0].speaker, '');
  assert.equal(out[0].id, 'b1');
});

test('整块对白标回正文：说话人并回正文，不悬空', () => {
  const blocks = [block('b1', 'dialogue', '哇哇', { speaker: '陈默' })];
  const out = splitBlockForMark(blocks, 'b1', 0, 2, 'paragraph');

  assert.equal(out[0].type, 'paragraph');
  assert.equal(out[0].content, '陈默：哇哇');
  assert.equal(out[0].speaker, undefined);
});

// ---------------------------------------------------------------------------
// 部分选中：切成三段
// ---------------------------------------------------------------------------

test('段中标记：切成 前段/对白/后段，顺序与内容都对', () => {
  const content = '第一句。第二句。第三句。';
  const blocks = [block('b1', 'paragraph', content)];
  const start = content.indexOf('第二句。');

  const out = splitBlockForMark(blocks, 'b1', start, start + '第二句。'.length, 'dialogue');

  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((b) => [b.type, b.content]),
    [
      ['paragraph', '第一句。'],
      ['dialogue', '第二句。'],
      ['paragraph', '第三句。'],
    ]
  );
  // 第一段必须沿用原 id，审稿锚点/撤销快照还指着它
  assert.equal(out[0].id, 'b1');
  assert.notEqual(out[1].id, 'b1');
  assert.notEqual(out[2].id, 'b1');
});

test('从段首选中：没有前段，首块是新类型且沿用原 id', () => {
  const content = '第一句。第二句。';
  const blocks = [block('b1', 'paragraph', content)];
  const end = '第一句。'.length;

  const out = splitBlockForMark(blocks, 'b1', 0, end, 'inner');

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((b) => [b.type, b.content]),
    [
      ['inner', '第一句。'],
      ['paragraph', '第二句。'],
    ]
  );
  assert.equal(out[0].id, 'b1');
});

test('选到段尾：没有后段', () => {
  const content = '第一句。第二句。';
  const blocks = [block('b1', 'paragraph', content)];
  const start = '第一句。'.length;

  const out = splitBlockForMark(blocks, 'b1', start, content.length, 'dialogue');

  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((b) => [b.type, b.content]),
    [
      ['paragraph', '第一句。'],
      ['dialogue', '第二句。'],
    ]
  );
});

test('选中带说话人的句子：说话人进 speaker 字段，正文不重复', () => {
  const content = '他停了一下。陈默：哇哇';
  const blocks = [block('b1', 'paragraph', content)];
  const start = content.indexOf('陈默');

  const out = splitBlockForMark(blocks, 'b1', start, content.length, 'dialogue');

  assert.equal(out.length, 2);
  assert.equal(out[1].type, 'dialogue');
  assert.equal(out[1].speaker, '陈默');
  assert.equal(out[1].content, '哇哇');
  assert.equal(out[0].content, '他停了一下。');
});

test('拆块不影响前后其他块', () => {
  const blocks = [
    block('b0', 'paragraph', '前一块'),
    block('b1', 'paragraph', '第一句。第二句。'),
    block('b2', 'paragraph', '后一块'),
  ];
  const start = '第一句。'.length;

  const out = splitBlockForMark(blocks, 'b1', start, '第一句。第二句。'.length, 'dialogue');

  assert.deepEqual(
    out.map((b) => b.content),
    ['前一块', '第一句。', '第二句。', '后一块']
  );
  assert.equal(out[0].id, 'b0');
  assert.equal(out[3].id, 'b2');
});

// ---------------------------------------------------------------------------
// 不该动的情况
// ---------------------------------------------------------------------------

test('同类型标记返回 null，不产生撤销点', () => {
  const blocks = [block('b1', 'dialogue', '哇哇', { speaker: '陈默' })];
  assert.equal(splitBlockForMark(blocks, 'b1', 0, 2, 'dialogue'), null);
});

test('空选区返回 null', () => {
  const blocks = [block('b1', 'paragraph', '哇哇')];
  assert.equal(splitBlockForMark(blocks, 'b1', 1, 1, 'dialogue'), null);
});

test('只选中空白返回 null', () => {
  const blocks = [block('b1', 'paragraph', '哇哇   ')];
  assert.equal(splitBlockForMark(blocks, 'b1', 2, 5, 'dialogue'), null);
});

test('不可标记的块（插图）返回 null', () => {
  const blocks = [block('b1', 'image', '图注', { url: '/uploads/a.png' })];
  assert.equal(splitBlockForMark(blocks, 'b1', 0, 2, 'dialogue'), null);
});

test('越界下标被夹回内容范围，不产生空块', () => {
  const blocks = [block('b1', 'paragraph', '哇哇')];
  assert.equal(splitBlockForMark(blocks, 'b1', 99, 120, 'dialogue'), null);
});

test('目标类型不在可标记范围返回 null', () => {
  const blocks = [block('b1', 'paragraph', '哇哇')];
  assert.equal(splitBlockForMark(blocks, 'b1', 0, 2, 'image'), null);
  assert.ok(MARKABLE_TYPES.every((t) => t !== 'image'));
});
