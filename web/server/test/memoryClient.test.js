'use strict';

/**
 * 记忆服务客户端（Node ↔ Python sidecar）的契约与降级测试。
 *
 * 用假 sidecar（内存 Map）跑，不依赖 Python 环境。
 * 重点验证三件事：
 *   1. 契约：四个接口的请求体与响应解析对得上
 *   2. 降级：sidecar 挂了/超时/500 时召回不抛异常，索引要抛
 *   3. 隔离：查询只能命中 targetUri 前缀下的条目
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');
const { startFakeSidecar } = require('./fakeSidecar');

// 必须在 require 业务模块之前设好环境变量：
// config.js 在加载时就把 DATA_DIR 等读成常量，之后再改 process.env 已经太晚。
const env = setupTempEnv();

const config = require('../config');
const client = require('../services/memory/client');

/** 每个用例前起一个假 sidecar，用例后关掉。 */
async function withSidecar(fn) {
  const fake = await startFakeSidecar();
  const originalBaseUrl = config.vikingBaseUrl;
  config.vikingBaseUrl = fake.url;
  try {
    await fn(client, fake);
  } finally {
    config.vikingBaseUrl = originalBaseUrl;
    await fake.close();
  }
}

test('health: sidecar 可用时返回模型与维度', async () => {
  await withSidecar(async (c, fake) => {
    const result = await c.health();
    assert.ok(result);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.model, 'fake-embedding-model');
    assert.strictEqual(result.dim, 2048);
  });
});

test('health: sidecar 不可用时返回 null 而不是抛异常', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('unavailable');
    const result = await c.health();
    assert.strictEqual(result, null);
  });
});

test('index: 写入后 query 能召回同一 URI', async () => {
  await withSidecar(async (c) => {
    const uri = 'viking://resources/u/u1/w/w1/chapter/c1/0';
    const written = await c.index(uri, '林昭握着一枚青铜令牌站在雨夜巷口');
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.rootUri, uri);

    const recalled = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
      limit: 5,
      minScore: 0.2,
    });
    assert.strictEqual(recalled.degraded, false);
    assert.strictEqual(recalled.results.length, 1);
    assert.strictEqual(recalled.results[0].uri, uri);
    assert.ok(recalled.results[0].score >= 0.2);
  });
});

test('query: 跨用户前缀不泄漏', async () => {
  await withSidecar(async (c) => {
    await c.index('viking://resources/u/userA/w/w1/chapter/c1/0', '林昭的青铜令牌');
    await c.index('viking://resources/u/userB/w/w1/chapter/c1/0', '苏晚的青铜令牌');

    const forA = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/userA/',
    });
    assert.strictEqual(forA.results.length, 1);
    assert.ok(forA.results[0].uri.includes('/u/userA/'));

    const forB = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/userB/',
    });
    assert.strictEqual(forB.results.length, 1);
    assert.ok(forB.results[0].uri.includes('/u/userB/'));
  });
});

test('query: minScore 过滤掉低分结果', async () => {
  await withSidecar(async (c) => {
    await c.index('viking://resources/u/u1/w/w1/chapter/c1/0', '完全无关的内容');
    const result = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
      minScore: 0.9,
    });
    assert.strictEqual(result.results.length, 0);
  });
});

test('remove: 删除后召不回来', async () => {
  await withSidecar(async (c) => {
    const uri = 'viking://resources/u/u1/w/w1/chapter/c1/0';
    await c.index(uri, '青铜令牌');
    await c.remove(uri);

    const result = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
    });
    assert.strictEqual(result.results.length, 0);
  });
});

test('降级：sidecar 500 时 query 不抛异常，返回 degraded', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('error');
    const result = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
    });
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.results.length, 0);
    assert.ok(result.reason);
  });
});

test('降级：sidecar 超时时 query 不抛异常', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('timeout');
    const result = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
    });
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.results.length, 0);
  });
});

test('降级：sidecar 未启动时 query 不抛异常', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('unavailable');
    const result = await c.query({
      query: '青铜令牌',
      targetUri: 'viking://resources/u/u1/',
    });
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.results.length, 0);
  });
});

test('降级：sidecar 未启动时 index 抛异常（索引失败要能被感知）', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('unavailable');
    await assert.rejects(
      () => c.index('viking://resources/u/u1/w/w1/chapter/c1/0', '内容'),
      (e) => e.name === 'MemoryServiceError'
    );
  });
});

test('降级：sidecar 500 时 index 抛异常且标记为可重试', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('error');
    await assert.rejects(
      () => c.index('viking://resources/u/u1/w/w1/chapter/c1/0', '内容'),
      (e) => e.name === 'MemoryServiceError' && e.retryable === true
    );
  });
});

test('降级：sidecar 400 时 index 抛异常且标记为不可重试', async () => {
  await withSidecar(async (c, fake) => {
    fake.setFault('badrequest');
    await assert.rejects(
      () => c.index('viking://resources/u/u1/w/w1/chapter/c1/0', '内容'),
      (e) => e.name === 'MemoryServiceError' && e.retryable === false && e.status === 400
    );
  });
});

test('降级：记忆功能关闭时 recall 直接返回 degraded', async () => {
  const original = config.memoryEnabled;
  config.memoryEnabled = false;
  try {
    assert.strictEqual(client.isEnabled(), false);
    const result = await client.query({
      query: 'x',
      targetUri: 'viking://resources/u/u1/',
    });
    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.results.length, 0);
  } finally {
    config.memoryEnabled = original;
  }
});

test('清理临时目录', () => {
  env.cleanup();
});
