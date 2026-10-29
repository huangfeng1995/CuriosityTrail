'use strict';

/**
 * 记忆 URI 构造与解析测试。
 *
 * URI 是记忆层的"主键"，错了会导致台账对不上向量、
 * 或者删除时把别人的东西删掉——所以每个分支都要钉死。
 */

const test = require('node:test');
const assert = require('node:assert');

const uris = require('../services/memory/uris');

test('workRoot: 带上用户与作品前缀', () => {
  assert.strictEqual(uris.workRoot('u1', 'w1'), 'viking://resources/u/u1/w/w1/');
});

test('userRoot: 用户级前缀', () => {
  assert.strictEqual(uris.userRoot('u1'), 'viking://resources/u/u1/');
});

test('chunkUri: 章节块', () => {
  assert.strictEqual(
    uris.chunkUri({
      userId: 'u1',
      workId: 'w1',
      sourceType: 'chapter',
      sourceId: 'c1',
      chunkNo: 3,
    }),
    'viking://resources/u/u1/w/w1/chapter/c1/3'
  );
});

test('chunkUri: 人物与设定块', () => {
  assert.strictEqual(
    uris.chunkUri({ userId: 'u1', workId: 'w1', sourceType: 'character', sourceId: 'ch1' }),
    'viking://resources/u/u1/w/w1/character/ch1/0'
  );
  assert.strictEqual(
    uris.chunkUri({ userId: 'u1', workId: 'w1', sourceType: 'setting', sourceId: 's1' }),
    'viking://resources/u/u1/w/w1/setting/s1/0'
  );
});

test('chunkUri: 对话三层各有独立路径，互不覆盖', () => {
  const base = { userId: 'u1', workId: 'w1', sourceId: 'm1', conversationId: 'cv1' };
  assert.strictEqual(
    uris.chunkUri({ ...base, sourceType: 'conv_raw' }),
    'viking://resources/u/u1/w/w1/conv_raw/cv1/m1/0'
  );
  assert.strictEqual(
    uris.chunkUri({ ...base, sourceType: 'conv_fact' }),
    'viking://resources/u/u1/w/w1/conv_fact/cv1/m1/0'
  );
  assert.strictEqual(
    uris.chunkUri({ ...base, sourceType: 'conv_manual' }),
    'viking://resources/u/u1/w/w1/conv_manual/cv1/m1/0'
  );
});

test('chunkUri: 对话块缺 conversationId 直接报错', () => {
  assert.throws(
    () => uris.chunkUri({ userId: 'u1', workId: 'w1', sourceType: 'conv_fact', sourceId: 'm1' }),
    /conversationId/
  );
});

test('chunkUri: 拒绝非法路径段', () => {
  assert.throws(
    () =>
      uris.chunkUri({
        userId: 'u1',
        workId: 'w1',
        sourceType: 'chapter',
        sourceId: 'c1/../../etc',
      }),
    /不合法/
  );
});

test('chunkUri: 未知来源类型直接报错', () => {
  assert.throws(
    () => uris.chunkUri({ userId: 'u1', workId: 'w1', sourceType: 'material', sourceId: 'm1' }),
    /未知记忆来源类型/
  );
});

test('parseUri: 章节块往返一致', () => {
  const uri = uris.chunkUri({
    userId: 'u1',
    workId: 'w1',
    sourceType: 'chapter',
    sourceId: 'c1',
    chunkNo: 5,
  });
  assert.deepStrictEqual(uris.parseUri(uri), {
    userId: 'u1',
    workId: 'w1',
    sourceType: 'chapter',
    sourceId: 'c1',
    conversationId: null,
    // 非对话来源没有消息 id
    messageId: null,
    chunkNo: 5,
  });
});

test('parseUri: 对话块能取出 conversationId 与 sourceId', () => {
  const uri = uris.chunkUri({
    userId: 'u1',
    workId: 'w1',
    sourceType: 'conv_fact',
    sourceId: 'm1',
    conversationId: 'cv1',
  });
  const parsed = uris.parseUri(uri);
  assert.strictEqual(parsed.sourceType, 'conv_fact');
  assert.strictEqual(parsed.conversationId, 'cv1');
  assert.strictEqual(parsed.sourceId, 'm1');
  assert.strictEqual(parsed.chunkNo, 0);
});

test('parseUri: 非本系统的 URI 返回 null', () => {
  assert.strictEqual(uris.parseUri('https://example.com/x'), null);
  assert.strictEqual(uris.parseUri('viking://resources/u/u1/w/w1/unknown/x/0'), null);
  assert.strictEqual(uris.parseUri(null), null);
});

test('sidecar 侧 URI 层级下限：每条 URI 至少 7 段', () => {
  // sidecar 的 split_uri 要求 split('/') 后不少于 7 段，否则判定层级不足。
  const uri = uris.chunkUri({
    userId: 'u1',
    workId: 'w1',
    sourceType: 'chapter',
    sourceId: 'c1',
  });
  assert.ok(uri.split('/').length >= 7);
});
