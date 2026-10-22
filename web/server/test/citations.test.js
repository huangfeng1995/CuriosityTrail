'use strict';

/**
 * 引用定位测试。
 *
 * 定位必须在**原文**上算，不能在索引的 bigram 文本上算——
 * bigram 化之后字符位置全变了，算出来的页码必然是错的。
 */

const test = require('node:test');
const assert = require('node:assert');

const { locateInBody, normalize } = require('../services/citations');

test('normalize: 压平空白并去掉页码标记', () => {
  assert.strictEqual(normalize('[[PAGE 3]]雨夜   巷子'), '雨夜 巷子');
});

test('locateInBody: 命中纯文本', () => {
  const body = '第一段内容。第二段有一句关于雨夜巷子的描写。第三段收尾。';
  const result = locateInBody(body, '关于雨夜巷子的描写');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.index, body.indexOf('关于雨夜巷子的描写'));
});

test('locateInBody: 片段空白与原文不一致也能命中', () => {
  // 原文有换行和缩进，检索给出的片段是压平的
  const body = '第一行\n  第二行包含关键信息\n第三行';
  const result = locateInBody(body, '第一行 第二行包含关键信息');
  assert.strictEqual(result.found, true);
  assert.ok(result.index >= 0);
});

test('locateInBody: 定位到正确的页码', () => {
  const body = [
    '[[PAGE 1]]第一页内容。',
    '[[PAGE 2]]第二页有一段关于断剑的描写。',
    '[[PAGE 3]]第三页。',
  ].join('\n');

  const result = locateInBody(body, '关于断剑的描写');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.page, 2);
});

test('locateInBody: 第一页的内容页码是 1 而不是 0', () => {
  const body = '[[PAGE 1]]开头的句子。\n[[PAGE 2]]后面。';
  const result = locateInBody(body, '开头的句子');
  assert.strictEqual(result.page, 1);
});

test('locateInBody: 没有页码标记时页码为 0', () => {
  const result = locateInBody('这是一段纯文本内容', '这是一段纯文本');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.page, 0);
});

test('locateInBody: 找不到时返回 found=false', () => {
  const result = locateInBody('完全无关的正文', '根本不在这里的东西');
  assert.strictEqual(result.found, false);
  assert.strictEqual(result.index, -1);
});

test('locateInBody: 空输入不炸', () => {
  assert.strictEqual(locateInBody('', '片段').found, false);
  assert.strictEqual(locateInBody('正文', '').found, false);
});

test('locateInBody: 太短的片段不硬凑', () => {
  // 少于 4 个字符的片段在长正文里几乎必然误命中，宁可报找不到
  const body = '一'.repeat(500);
  const result = locateInBody(body, '一');
  assert.strictEqual(result.found, false);
});

test('locateInBody: 返回的上下文包含命中内容', () => {
  const body = '前面很长的一段内容。'.repeat(20) + '关键句在这里。' + '后面内容。'.repeat(20);
  const result = locateInBody(body, '关键句在这里');
  assert.strictEqual(result.found, true);
  assert.ok(result.context.includes('关键句在这里'));
});

test('locateInBody: before/match/after 三段能拼回上下文', () => {
  // 前端靠这三段把命中片段标黄，三段必须首尾相接
  const body = '前面的内容。'.repeat(30) + '关键句在这里。' + '后面的内容。'.repeat(30);
  const result = locateInBody(body, '关键句在这里');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.match, '关键句在这里');
  assert.ok(result.before.endsWith('内容。'));
  // match 只含片段本身，句末标点落在 after 里
  assert.ok(result.after.includes('后面的内容。'));
});

test('locateInBody: 命中段前面有空白时，原文下标不偏移', () => {
  // 早先的实现不给空白字符记下标，命中位置会整体偏掉——
  // 页码跟着错，作者就翻到了错误的那一页
  const body = '第一段。\n\n第二段里有断剑的描写。\n\n第三段。';
  const result = locateInBody(body, '断剑的描写');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.index, body.indexOf('断剑的描写'));
});

test('locateInBody: 跨页片段也能定位', () => {
  // 检索给的片段是把页码标记换成空格后的样子，句号还在
  const body = '[[PAGE 3]]这一页写满了雨。[[PAGE 4]]下一段继续。';
  const result = locateInBody(body, '写满了雨。 下一段继续');
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.page, 3);
});
