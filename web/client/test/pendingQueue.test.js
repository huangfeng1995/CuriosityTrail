import assert from 'node:assert/strict';
import test from 'node:test';

import {
  enqueue,
  dequeue,
  peek,
  size,
  clearQueue,
  headBelongsTo,
  summarize,
} from '../src/components/Assistant/pendingQueue.js';

const item = (text, chapterId = 'ch1', chapterTitle = '第一章') => ({
  text,
  roleKey: 'writer',
  chapterId,
  chapterTitle,
});

test('入队保持先进先出，空内容不入队', () => {
  let q = [];
  q = enqueue(q, item('一'));
  q = enqueue(q, item('二'));
  q = enqueue(q, item('   '));
  q = enqueue(q, null);
  assert.equal(size(q), 2);
  assert.equal(peek(q).text, '一');
});

test('出队取队首并返回剩余队列', () => {
  let q = [item('一'), item('二')];
  const first = dequeue(q);
  assert.equal(first.head.text, '一');
  assert.equal(size(first.rest), 1);
  const second = dequeue(first.rest);
  assert.equal(second.head.text, '二');
  assert.equal(size(second.rest), 0);
  const empty = dequeue(second.rest);
  assert.equal(empty.head, null);
});

test('入队不修改原数组', () => {
  const q = [item('一')];
  const next = enqueue(q, item('二'));
  assert.equal(size(q), 1);
  assert.equal(size(next), 2);
});

test('清空返回空队列', () => {
  assert.deepEqual(clearQueue(), []);
});

test('队首章节与当前章一致才允许自动发送', () => {
  const q = [item('一', 'ch1'), item('二', 'ch1')];
  assert.equal(headBelongsTo(q, 'ch1'), true);
  assert.equal(headBelongsTo(q, 'ch2'), false);
  assert.equal(headBelongsTo([], 'ch1'), false);
});

test('摘要统计当前章与跨章条数', () => {
  const q = [item('一', 'ch1', '第一章'), item('二', 'ch2', '第二章')];
  const same = summarize(q, 'ch1');
  assert.equal(same.count, 2);
  assert.equal(same.inCurrent, true);
  assert.equal(same.headTitle, '第一章');
  assert.equal(same.otherCount, 1);

  const cross = summarize(q, 'ch2');
  assert.equal(cross.inCurrent, false);
  assert.equal(cross.otherCount, 1);

  assert.equal(summarize([], 'ch1'), null);
});
