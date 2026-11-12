'use strict';

/**
 * 出现位置扫描 / 全文改名的纯函数测试。
 *
 * 盯两件事：
 * 1) 最长优先、不重叠——「王二」和「王二狗」同时存在时不能互相串；
 * 2) 改名的替换次数必须与实际改掉的处数一致，否则前端提示会骗人。
 */

const test = require('node:test');
const assert = require('node:assert');

const occurrence = require('../services/occurrence');

const chapter = (id, seq, blocks, title = `第${seq}章`) => ({
  id,
  seq,
  title,
  blocks: JSON.stringify(blocks),
});

test('scan：最长优先，短名不会切掉长名', () => {
  const hits = occurrence.scan('王二狗和王二一起走了', ['王二', '王二狗']);
  assert.deepStrictEqual(
    hits.map((h) => h.term),
    ['王二狗', '王二']
  );
  assert.strictEqual(hits[0].offset, 0);
  assert.strictEqual(hits[1].offset, 4);
});

test('scan：重复出现都能统计到，且位置不重叠', () => {
  const hits = occurrence.scan('王二，王二。', ['王二']);
  assert.strictEqual(hits.length, 2);
  assert.deepStrictEqual(hits.map((h) => h.offset), [0, 3]);
});

test('termsOf：本名与别名合并去重', () => {
  assert.deepStrictEqual(occurrence.termsOf('陈默', '老陈，小默、陈哥'), [
    '陈默',
    '老陈',
    '小默',
    '陈哥',
  ]);
  assert.deepStrictEqual(occurrence.termsOf('陈默', '陈默, 老陈'), ['陈默', '老陈']);
});

test('scanWork：按章聚合，包含对白说话人字段', () => {
  const chapters = [
    chapter('c1', 1, [
      { id: 'b1', type: 'paragraph', content: '王二推门进来。' },
      { id: 'b2', type: 'dialogue', speaker: '王二', content: '谁？' },
    ]),
    chapter('c2', 2, [{ id: 'b3', type: 'paragraph', content: '没有人。' }]),
    chapter('c3', 3, [{ id: 'b4', type: 'paragraph', content: '王二笑了，王二没说话。' }]),
  ];

  const result = occurrence.scanWork(chapters, [
    { key: 'char-1', words: ['王二'] },
    { key: 'char-2', words: ['不存在的人'] },
  ]);

  assert.strictEqual(result['char-1'].total, 4);
  assert.strictEqual(result['char-1'].chapters.length, 2);
  assert.strictEqual(result['char-1'].chapters[0].chapterId, 'c1');
  assert.strictEqual(result['char-1'].chapters[1].chapterId, 'c3');
  assert.strictEqual(result['char-1'].chapters[1].count, 2);

  assert.strictEqual(result['char-2'].total, 0);
  assert.deepStrictEqual(result['char-2'].chapters, []);
});

test('scanWork：blocks 坏数据不抛错，只跳过该章', () => {
  const chapters = [
    { id: 'bad', seq: 1, title: '坏章', blocks: '{not json' },
    chapter('c2', 2, [{ id: 'b1', type: 'paragraph', content: '王二在。' }]),
  ];
  const result = occurrence.scanWork(chapters, [{ key: 'k', words: ['王二'] }]);
  assert.strictEqual(result.k.total, 1);
  assert.strictEqual(result.k.chapters.length, 1);
});

test('replaceInBlocks：只替换命中词，其余字段原样保留', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '王二推门进来。', note: 'x' },
    { id: 'b2', type: 'dialogue', speaker: '王二', content: '王二来了' },
    { id: 'b3', type: 'scene_break', content: '' },
  ];

  const result = occurrence.replaceInBlocks(blocks, ['王二'], '李四');
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.blocks[0].content, '李四推门进来。');
  assert.strictEqual(result.blocks[0].note, 'x');
  assert.strictEqual(result.blocks[1].speaker, '李四');
  assert.strictEqual(result.blocks[1].content, '李四来了');
  assert.strictEqual(result.blocks[2].type, 'scene_break');
});

test('replaceInBlocks：guard 保护更长的其他名字', () => {
  const result = occurrence.replaceInBlocks(
    [{ id: 'b1', type: 'paragraph', content: '王二狗和王二' }],
    ['王二'],
    '李四',
    { guard: ['王二狗'] }
  );
  assert.strictEqual(result.blocks[0].content, '王二狗和李四');
  assert.strictEqual(result.count, 1);
});

test('replaceInBlocks：不传 guard 时会按字面替换（调用方责任）', () => {
  const result = occurrence.replaceInBlocks(
    [{ id: 'b1', type: 'paragraph', content: '王二狗' }],
    ['王二'],
    '李四'
  );
  assert.strictEqual(result.blocks[0].content, '李四狗');
});

test('replaceInBlocks：没有命中返回 null', () => {
  const result = occurrence.replaceInBlocks(
    [{ id: 'b1', type: 'paragraph', content: '无关内容' }],
    ['王二'],
    '李四'
  );
  assert.strictEqual(result, null);
});
