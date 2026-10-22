'use strict';

/**
 * 字数统计测试。
 *
 * 口径必须与作者在 Word 里看到的"字数（不计空格）"一致，
 * 否则进度条上的数字和作者心里的数字对不上，工具会被直接弃用。
 */

const test = require('node:test');
const assert = require('node:assert');

const { countWords, countBlockWords, formatWords } = require('../services/wordCount');

test('countWords: 中文逐字计数', () => {
  assert.strictEqual(countWords('雨夜巷子'), 4);
  assert.strictEqual(countWords('他握住了那把断剑'), 8);
});

test('countWords: 空白不计入', () => {
  assert.strictEqual(countWords('雨  夜\t巷子'), 4);
  assert.strictEqual(countWords('  '), 0);
  assert.strictEqual(countWords(''), 0);
  assert.strictEqual(countWords(null), 0);
});

test('countWords: 英文按词计数', () => {
  assert.strictEqual(countWords('hello world'), 2);
  assert.strictEqual(countWords('the rain in'), 3);
});

test('countWords: 中英混排', () => {
  // 5 个汉字（他说了走了）+ 2 个英文词
  assert.strictEqual(countWords('他说了 hello world 走了'), 5 + 2);
});

test('countWords: 标点计入（作者写出来的字符）', () => {
  assert.strictEqual(countWords('好。'), 2);
  assert.strictEqual(countWords('「好。」'), 4);
});

test('countBlockWords: 分场符不算正文', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', content: '雨夜巷子' },
    { id: 'b', type: 'scene_break', content: '分场' },
    { id: 'c', type: 'paragraph', content: '他走了' },
  ];
  // 只算两段正文：4 + 3 = 7，分场符的 2 字不算
  assert.strictEqual(countBlockWords(blocks), 7);
});

test('countBlockWords: 空块与非法输入', () => {
  assert.strictEqual(countBlockWords([]), 0);
  assert.strictEqual(countBlockWords(null), 0);
  assert.strictEqual(countBlockWords([{ id: 'x' }, null, { content: '' }]), 0);
});

test('formatWords: 一万以下原样显示', () => {
  assert.strictEqual(formatWords(0), '0');
  assert.strictEqual(formatWords(9999), '9999');
});

test('formatWords: 一万以上转成"万"', () => {
  assert.strictEqual(formatWords(10000), '1 万');
  assert.strictEqual(formatWords(23500), '2.4 万');
  assert.strictEqual(formatWords(120000), '12 万');
});
