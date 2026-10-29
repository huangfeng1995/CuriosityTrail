'use strict';

/**
 * 记忆索引与召回的集成测试。
 *
 * 用假 sidecar（内存 Map）跑，覆盖设计文档 §10 的三条关键契约：
 *  1. **一致性**：改章节 → 旧块被删、新块入库；删章节 → 台账与向量都清理
 *  2. **隔离**：用户 A 索引的内容，用户 B 召不回来
 *  3. **降级**：sidecar 挂了，索引标失败、召回返回空但对话不受影响
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');
const { startFakeSidecar } = require('./fakeSidecar');

const env = setupTempEnv();

const config = require('../config');
const db = require('../database');
const { all, get, run } = db;
const client = require('../services/memory/client');
const indexer = require('../services/memory/indexer');
const retriever = require('../services/memory/retriever');
const uris = require('../services/memory/uris');

let fake = null;

/**
 * 每个用例前起假 sidecar，并把 baseUrl 指过去。
 */
async function withSidecar(fn) {
  // 建表是异步的迁移，先等它跑完
  await db.ready;
  fake = await startFakeSidecar();
  const original = config.vikingBaseUrl;
  config.vikingBaseUrl = fake.url;
  try {
    await fn();
  } finally {
    config.vikingBaseUrl = original;
    await fake.close();
    fake = null;
  }
}

/**
 * 造一个用户 + 一部作品 + 一章正文。
 */
async function seedWork(userId, chapterBody) {
  const workId = require('crypto').randomUUID();
  const chapterId = require('crypto').randomUUID();
  const now = new Date().toISOString();

  // memory_chunks 有指向 users 的外键，用户得先存在
  const existing = await get('SELECT id FROM users WHERE id = ?', [userId]);
  if (!existing) {
    await run(
      'INSERT INTO users (id, phone, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)',
      [userId, `1${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`, 'user', now, now]
    );
  }

  await run(
    'INSERT INTO works (id, user_id, title, created_at, modified_at) VALUES (?, ?, ?, ?, ?)',
    [workId, userId, '测试作品', now, now]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, content, blocks, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chapterId,
      workId,
      '第一章',
      1,
      chapterBody,
      JSON.stringify([{ id: 'b1', type: 'paragraph', content: chapterBody }]),
      now,
      now,
    ]
  );

  return { workId, chapterId };
}

/**
 * 立刻跑一次索引（跳过防抖）。
 */
async function indexNow(params) {
  await indexer.indexSource({ ...params, immediate: true });
}

test('索引：章节入库后台账与向量都有', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌，站在雨夜的巷口。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const rows = await all(
      'SELECT * FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'indexed');
    assert.ok(rows[0].viking_uri.startsWith('viking://resources/u/'));

    // 向量侧也确实写进去了
    assert.strictEqual(fake.store.size, 1);
    const [uri] = [...fake.store.keys()];
    assert.strictEqual(uri, rows[0].viking_uri);
  });
});

test('一致性：改章节后旧块被替换，新内容在向量里', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    // 改写正文。blocks 是权威数据，content 只是它的快照，两个都要改。
    await run('UPDATE chapters SET content = ?, blocks = ? WHERE id = ?', [
      '林昭把那枚青铜令牌丢进了河里，转身走进雨里。',
      JSON.stringify([
        { id: 'b1', type: 'paragraph', content: '林昭把那枚青铜令牌丢进了河里，转身走进雨里。' },
      ]),
      chapterId,
    ]);

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const rows = await all(
      'SELECT * FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    assert.strictEqual(rows.length, 1, '块数不该变');
    assert.ok(rows[0].content.includes('丢进了河里'), '台账里应该是新正文');

    const texts = [...fake.store.values()];
    assert.strictEqual(texts.length, 1);
    assert.ok(texts[0].includes('丢进了河里'), '向量里应该是新正文');
    assert.ok(!texts[0].includes('握着一枚'), '旧正文不该残留');
  });
});

test('一致性：删章节后台账与向量都清理', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });
    assert.strictEqual(fake.store.size, 1);

    await indexer.removeSource({ userId, sourceType: 'chapter', sourceId: chapterId });

    const rows = await all(
      'SELECT * FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    assert.strictEqual(rows.length, 0, '台账应该清空');
    assert.strictEqual(fake.store.size, 0, '向量应该清空');
  });
});

test('隔离：用户 B 召不到用户 A 的记忆', async () => {
  await withSidecar(async () => {
    const userA = require('crypto').randomUUID();
    const userB = require('crypto').randomUUID();
    const workA = await seedWork(userA, '林昭握着一枚青铜令牌。');

    await indexNow({
      userId: userA,
      workId: workA.workId,
      sourceType: 'chapter',
      sourceId: workA.chapterId,
    });

    const result = await retriever.retrieve({
      userId: userB,
      workId: workA.workId,
      query: '青铜令牌',
    });
    assert.strictEqual(result.refs.length, 0, '用户 B 不该看到用户 A 的记忆');
  });
});

test('隔离：同一作品下另一个用户也召不到', async () => {
  await withSidecar(async () => {
    const userA = require('crypto').randomUUID();
    const userB = require('crypto').randomUUID();
    const workA = await seedWork(userA, '林昭握着一枚青铜令牌。');

    await indexNow({
      userId: userA,
      workId: workA.workId,
      sourceType: 'chapter',
      sourceId: workA.chapterId,
    });

    const result = await retriever.retrieve({
      userId: userB,
      workId: workA.workId,
      query: '青铜令牌',
    });
    assert.strictEqual(result.refs.length, 0);
  });
});

test('召回：同用户同作品能召回并带上来源标签', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌，站在雨夜的巷口。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const result = await retriever.retrieve({
      userId,
      workId,
      query: '青铜令牌',
    });

    assert.strictEqual(result.refs.length, 1);
    const ref = result.refs[0];
    assert.strictEqual(ref.sourceType, 'chapter');
    assert.strictEqual(ref.sourceId, chapterId);
    assert.ok(ref.label.includes('第一章'), `来源标签不对：${ref.label}`);
    assert.ok(ref.preview.includes('青铜令牌'));
  });
});

test('召回：excludeRefIds 命中的条目被剔除', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const first = await retriever.retrieve({ userId, workId, query: '青铜令牌' });
    assert.strictEqual(first.refs.length, 1);

    const excluded = await retriever.retrieve({
      userId,
      workId,
      query: '青铜令牌',
      excludeRefIds: [first.refs[0].id],
    });
    assert.strictEqual(excluded.refs.length, 0);
  });
});

test('降级：sidecar 500 时召回返回空且标记 degraded', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    fake.setFault('error');
    const result = await retriever.retrieve({ userId, workId, query: '青铜令牌' });

    assert.strictEqual(result.degraded, true);
    assert.strictEqual(result.refs.length, 0);
    assert.ok(result.reason);
  });
});

test('召回：当前章被排除——它的正文已经在上下文里了', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    // 不排除时能召回到本章。
    const withChapter = await retriever.retrieve({ userId, workId, query: '青铜令牌' });
    assert.strictEqual(withChapter.refs.length, 1);
    assert.strictEqual(withChapter.refs[0].sourceId, chapterId);

    // 排除后召不到本章。
    const withoutChapter = await retriever.retrieve({
      userId,
      workId,
      query: '青铜令牌',
      excludeChapterId: chapterId,
    });
    assert.strictEqual(withoutChapter.refs.length, 0, '当前章不该被召回');
  });
});

test('降级：sidecar 未启动时索引标 failed，不抛异常', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    fake.setFault('unavailable');
    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const rows = await all(
      'SELECT * FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'failed');
    assert.ok(rows[0].last_error);
  });
});

test('统计：索引状态能被统计出来', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const stats = await indexer.stats(userId);
    assert.strictEqual(stats.indexed, 1);
    assert.strictEqual(stats.failed, 0);
    assert.strictEqual(stats.total, 1);
  });
});

test('重建：重建后条目数与之前一致', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });
    const before = await indexer.stats(userId);

    await indexer.rebuild({ userId, workId });
    await indexer.whenIdle();

    const after = await indexer.stats(userId);
    assert.strictEqual(after.total, before.total);
    assert.strictEqual(after.indexed, before.indexed);
  });
});

test('重建：已索引的内容会被重新向量化', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });
    assert.strictEqual(fake.store.size, 1);
    const callsBefore = fake.indexCalls;

    // 正文一个字没改，台账状态也是 indexed——
    // 增量判定本该全部跳过，但重建必须真的重新推一遍。
    await indexer.rebuild({ userId, workId });
    await indexer.whenIdle();

    assert.ok(
      fake.indexCalls > callsBefore,
      `重建后没有重新向量化（写入次数仍为 ${callsBefore}）`
    );
    const row = await get(
      'SELECT status FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    assert.strictEqual(row.status, 'indexed');
    assert.strictEqual(fake.store.size, 1, '向量仍然只有一条（覆盖写，不是追加）');
  });
});

test('重建：重建成功后刷新索引元信息', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    // 假装索引是用旧模型建的：校验必须失败。
    await indexer.writeMeta(userId, { embedding_model: 'old-model', embedding_dim: 768 });
    assert.strictEqual((await indexer.checkMetaConsistency(userId)).ok, false);

    await indexer.rebuild({ userId, workId });
    await indexer.whenIdle();

    // 重建完成后元信息应该跟着更新，模型不一致的降级解得开。
    const check = await indexer.checkMetaConsistency(userId);
    assert.strictEqual(check.ok, true, `重建后仍降级：${check.reason}`);
  });
});

test('重建：对话记忆也会被重新向量化', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId } = await seedWork(userId, '林昭握着一枚青铜令牌。');
    const messageId = require('crypto').randomUUID();

    // 对话记忆：正文在台账里，不在源表里。
    await indexNow({
      userId,
      workId,
      sourceType: 'conv_raw',
      sourceId: messageId,
      conversationId: messageId,
      content: '作者：林昭到底拿了谁的令牌？\nAI：那枚青铜令牌是沈家的。',
    });

    const rows = await indexer.listRebuildConversationChunks(userId, workId);
    assert.strictEqual(rows.length, 1, '对话记忆应该进重建清单');

    const callsBefore = fake.indexCalls;
    await indexer.rebuild({ userId, workId });
    await indexer.whenIdle();

    assert.ok(fake.indexCalls > callsBefore, '对话记忆没有重新向量化');
    const after = await indexer.listRebuildConversationChunks(userId, workId);
    assert.strictEqual(after[0].status, 'indexed');
    // 内容不变：重推的是同一份正文，不是重新生成的
    assert.strictEqual(after[0].content, rows[0].content);
  });
});

test('元信息：模型不一致时拒绝召回', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();

    await indexer.writeMeta(userId, { embedding_model: 'old-model', embedding_dim: 768 });

    const check = await indexer.checkMetaConsistency(userId);
    assert.strictEqual(check.ok, false);
    assert.ok(check.reason.includes('需要重建索引'));
  });
});

test('元信息：模型一致时通过', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();

    await indexer.writeMeta(userId, {
      embedding_model: 'fake-embedding-model',
      embedding_dim: 2048,
    });

    const check = await indexer.checkMetaConsistency(userId);
    assert.strictEqual(check.ok, true);
  });
});

test('元信息：按用户隔离——A 的模型不影响 B', async () => {
  await withSidecar(async () => {
    const userA = require('crypto').randomUUID();
    const userB = require('crypto').randomUUID();

    await indexer.writeMeta(userA, { embedding_model: 'old-model', embedding_dim: 768 });

    assert.strictEqual((await indexer.checkMetaConsistency(userA)).ok, false);
    assert.strictEqual((await indexer.checkMetaConsistency(userB)).ok, true);
  });
});

test('URI：台账里记的 URI 与构造器一致', async () => {
  await withSidecar(async () => {
    const userId = require('crypto').randomUUID();
    const { workId, chapterId } = await seedWork(userId, '林昭握着一枚青铜令牌。');

    await indexNow({ userId, workId, sourceType: 'chapter', sourceId: chapterId });

    const row = await get(
      'SELECT * FROM memory_chunks WHERE user_id = ? AND source_id = ?',
      [userId, chapterId]
    );
    const expected = uris.chunkUri({
      userId,
      workId,
      sourceType: 'chapter',
      sourceId: chapterId,
      chunkNo: 0,
    });
    assert.strictEqual(row.viking_uri, expected);

    const parsed = uris.parseUri(row.viking_uri);
    assert.strictEqual(parsed.userId, userId);
    assert.strictEqual(parsed.workId, workId);
    assert.strictEqual(parsed.sourceId, chapterId);
  });
});

test('清理临时目录', async () => {
  await db.ready;
  env.cleanup();
});
