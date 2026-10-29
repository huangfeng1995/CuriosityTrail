'use strict';

/**
 * 对话记忆三层的集成测试。
 *
 * 盯住四件事：
 *  1. **原始层自动入库**：每轮 AI 回复结束，提问 + 回答原文进记忆库。
 *  2. **事实层异步抽取**：AI 挑出来的结构化事实也进库。
 *  3. **手动层同步写入**：作者点「记入记忆」，立刻知道成没成功。
 *  4. **隔离与清理**：别人的消息记不进来；重生成时旧回答的记忆要清掉。
 *
 * 事实抽取要用模型，所以这个文件自带一个假模型端点。
 * 抽取是异步的，测试里要等它跑完（extractor.whenIdle）。
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeSidecar } = require('./fakeSidecar');

const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const { ready, all, get, run } = db;
const config = require('../config');
const aiConfig = require('../services/aiConfig');
const indexer = require('../services/memory/indexer');
const extractor = require('../services/memory/extractor');
const memoryConv = require('../services/memory/conversation');

let server;
let fakeModel;
let fakeSidecar;
let originalConfig;
let originalBaseUrl;
let originalExtractEnabled;

/** 登录测试服务用的那个用户的 id。 */
let testUserId = '';

/** 当前这轮伪造的模型回复。 */
let behavior = null;

/** 抽取请求的内容（用于识别"这是抽取调用"）。 */
let lastExtractInput = '';

/** 当前使用的会话 id。 */
let conversationId = '';

/**
 * 假的 OpenAI 兼容端点。
 *
 * 抽取走非流式请求，正文走流式请求——这里按 body.stream 分开处理。
 * 抽取的请求里 system 提示词是"设定管理员"，据此把它认出来。
 */
function startFakeModel() {
  return new Promise((resolve) => {
    const sockets = new Set();

    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch (e) {
          body = {};
        }

        const messages = Array.isArray(body.messages) ? body.messages : [];
        const systemText = messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n');

        const isExtract = systemText.includes('设定管理员');
        if (isExtract) {
          lastExtractInput = messages.map((m) => m.content).join('\n');
        }

        const b = behavior || { content: '' };
        const content = isExtract
          ? (b.facts !== undefined ? b.facts : '{"facts": []}')
          : (b.content || '');

        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content }, finish_reason: 'stop' }],
            })
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (content) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content }, finish_reason: null }],
            })}\n\n`
          );
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    srv.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    srv.listen(0, '127.0.0.1', () =>
      resolve({
        server: srv,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => srv.close(done));
        },
      })
    );
  });
}

/**
 * 发一条消息，收集整条 SSE 流里的事件。
 *
 * @param {object} body
 * @returns {Promise<Array>}
 */
async function chat(body) {
  const payload = { roleKey: 'writer', ...body };
  if (conversationId) payload.conversationId = conversationId;

  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: payload,
  });
  assert.strictEqual(res.status, 200);

  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((chunk) => chunk.trim().startsWith('data:'))
    .map((chunk) => {
      const payloadText = chunk.slice(5).trim();
      return payloadText === '[DONE]' ? { type: 'done' } : JSON.parse(payloadText);
    });

  const done = events.find((e) => e.type === 'done');
  if (done && done.conversationId) {
    conversationId = done.conversationId;
  }
  return events;
}

/**
 * 造一部作品 + 一章正文。
 *
 * @param {string} body 章节正文
 * @returns {Promise<{workId: string, chapterId: string}>}
 */
async function seedWork(body) {
  const workId = crypto.randomUUID();
  const chapterId = crypto.randomUUID();
  const now = new Date().toISOString();

  conversationId = '';

  await run(
    'INSERT INTO works (id, user_id, title, created_at, modified_at) VALUES (?, ?, ?, ?, ?)',
    [workId, testUserId, '雾港', now, now]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, content, blocks, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chapterId,
      workId,
      '第一章',
      1,
      body,
      JSON.stringify([{ id: 'b1', type: 'paragraph', content: body }]),
      now,
      now,
    ]
  );

  return { workId, chapterId };
}

/**
 * 某条来源在台账里的块。
 *
 * @param {string} sourceType
 * @param {string} sourceId
 * @returns {Promise<Array>}
 */
function chunksOf(sourceType, sourceId) {
  return all(
    'SELECT * FROM memory_chunks WHERE source_type = ? AND source_id = ? ORDER BY chunk_no',
    [sourceType, sourceId]
  );
}

test.before(async () => {
  await ready;

  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();

  originalConfig = JSON.parse(JSON.stringify(aiConfig.getConfig()));
  aiConfig.updateConfig({
    provider: 'deepseek',
    deepseek: {
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'deepseek-flash',
      thinking: false,
    },
  });

  fakeSidecar = await startFakeSidecar();
  originalBaseUrl = config.vikingBaseUrl;
  config.vikingBaseUrl = fakeSidecar.url;

  originalExtractEnabled = config.memoryExtractEnabled;
  config.memoryExtractEnabled = true;

  server = await startServer(app);

  const user = await get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  assert.ok(user, '测试服务应当已注册默认用户');
  testUserId = user.id;
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (fakeSidecar) await fakeSidecar.close();
  if (originalConfig) aiConfig.updateConfig(originalConfig);
  if (originalBaseUrl) config.vikingBaseUrl = originalBaseUrl;
  if (originalExtractEnabled !== undefined) {
    config.memoryExtractEnabled = originalExtractEnabled;
  }
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 原始层
// ---------------------------------------------------------------------------

test('原始层：AI 回复结束后，提问与回答原文进记忆库', async () => {
  behavior = {
    content: JSON.stringify({
      action: 'comment',
      content: '林昭把令牌翻过来，背面刻着一行小字。',
      reason: '',
      citations: [],
    }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌，站在雨夜的巷口。');

  const events = await chat({
    message: '令牌背面刻着什么',
    workId,
    chapterId,
  });
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.messageId, 'done 事件要带助手消息 id');

  // 原始层是后台索引的，等它跑完
  await indexer.whenIdle();

  const rows = await chunksOf('conv_raw', done.messageId);
  assert.strictEqual(rows.length, 1, '原始层应当有一块');
  assert.strictEqual(rows[0].status, 'indexed');
  assert.ok(rows[0].content.includes('令牌背面刻着什么'), '要存作者问了什么');
  assert.ok(
    rows[0].content.includes('林昭把令牌翻过来'),
    '要存 AI 答了什么'
  );
  assert.ok(rows[0].viking_uri.includes('/conv_raw/'), 'URI 要走 conv_raw 段');
});

test('原始层：重新生成时旧回答的记忆被清掉，新回答另起一条', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第一次的回答。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const first = await chat({ message: '接下来怎么写', workId, chapterId });
  const firstDone = first.find((e) => e.type === 'done');
  await indexer.whenIdle();

  assert.strictEqual((await chunksOf('conv_raw', firstDone.messageId)).length, 1);

  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第二次的回答。', reason: '', citations: [] }),
  };
  const second = await chat({
    message: '接下来怎么写',
    workId,
    chapterId,
    replaceMessageId: firstDone.messageId,
  });
  const secondDone = second.find((e) => e.type === 'done');
  await indexer.whenIdle();

  assert.strictEqual(
    (await chunksOf('conv_raw', firstDone.messageId)).length,
    0,
    '旧回答的原始层记忆要被清掉'
  );
  const fresh = await chunksOf('conv_raw', secondDone.messageId);
  assert.strictEqual(fresh.length, 1, '新回答另起一条记忆');
  assert.ok(fresh[0].content.includes('第二次的回答'));
});

test('重新生成：作者提问那一行被复用，不会多出一条', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第一次的回答。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const first = await chat({ message: '接下来怎么写', workId, chapterId });
  const firstDone = first.find((e) => e.type === 'done');

  const before = await all(
    'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
  );
  const userRowBefore = before.find((m) => m.role === 'user');
  assert.ok(userRowBefore, '应当有一条用户消息');

  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第二次的回答。', reason: '', citations: [] }),
  };
  await chat({
    message: '接下来怎么写',
    workId,
    chapterId,
    replaceMessageId: firstDone.messageId,
  });

  const after = await all(
    'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
  );
  const userRows = after.filter((m) => m.role === 'user');
  assert.strictEqual(userRows.length, 1, '用户消息不该多出一条');
  assert.strictEqual(
    userRows[0].id,
    userRowBefore.id,
    '重新生成要复用原来那条提问——作者在它上面点过「记入记忆」，换了 id 就指空了'
  );
  assert.strictEqual(after.filter((m) => m.role === 'assistant').length, 1);
});

// ---------------------------------------------------------------------------
// 事实层
// ---------------------------------------------------------------------------

test('事实层：AI 抽出的结构化事实也进记忆库', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '林昭认出了这枚令牌。', reason: '', citations: [] }),
    facts: JSON.stringify({ facts: ['林昭认得青铜令牌上的家徽'] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭和令牌什么关系', workId, chapterId });
  const done = events.find((e) => e.type === 'done');

  // 抽取是异步的
  await extractor.whenIdle();
  await indexer.whenIdle();

  assert.ok(lastExtractInput.includes('林昭和令牌什么关系'), '抽取要拿到原文');

  const rows = await chunksOf('conv_fact', done.messageId);
  assert.strictEqual(rows.length, 1, '事实层应当有一块');
  assert.strictEqual(rows[0].status, 'indexed');
  assert.ok(rows[0].content.includes('林昭认得青铜令牌上的家徽'));
  assert.ok(rows[0].viking_uri.includes('/conv_fact/'));
});

test('事实层：抽取不出东西时不写任何块', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
    facts: JSON.stringify({ facts: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '嗯', workId, chapterId });
  const done = events.find((e) => e.type === 'done');

  await extractor.whenIdle();
  await indexer.whenIdle();

  assert.strictEqual((await chunksOf('conv_fact', done.messageId)).length, 0);
  // 原始层照旧入库
  assert.strictEqual((await chunksOf('conv_raw', done.messageId)).length, 1);
});

// ---------------------------------------------------------------------------
// 手动层
// ---------------------------------------------------------------------------

test('手动层：作者点「记入记忆」同步写入并立即返回成功', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '林昭推开了门。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭接下来去哪', workId, chapterId });
  const done = events.find((e) => e.type === 'done');
  await indexer.whenIdle();

  const res = await server.request(`/api/ai/messages/${done.messageId}/remember`, {
    method: 'POST',
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);

  // 同步写入：接口返回时块已经落库
  const rows = await chunksOf('conv_manual', done.messageId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'indexed');
  assert.ok(rows[0].content.includes('林昭推开了门'));
  assert.ok(rows[0].viking_uri.includes('/conv_manual/'));
});

test('手动层：作者自己的提问也能记', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '记住林昭是左撇子', workId, chapterId });
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.userMessageId, 'done 事件要带回用户消息 id');
  await indexer.whenIdle();

  const res = await server.request(`/api/ai/messages/${done.userMessageId}/remember`, {
    method: 'POST',
  });
  assert.strictEqual(res.status, 200);

  const rows = await chunksOf('conv_manual', done.userMessageId);
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].content.includes('林昭是左撇子'));
});

test('手动层：sidecar 挂了就如实报错，不假装成功', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭是谁', workId, chapterId });
  const done = events.find((e) => e.type === 'done');
  await indexer.whenIdle();

  fakeSidecar.setFault('error');
  const res = await server.request(`/api/ai/messages/${done.messageId}/remember`, {
    method: 'POST',
  });
  fakeSidecar.setFault(null);

  assert.notStrictEqual(res.status, 200, '写不进去就该报错');
  const data = await res.json().catch(() => ({}));
  assert.ok(data.error, '要带上原因');
});

// ---------------------------------------------------------------------------
// 隔离
// ---------------------------------------------------------------------------

test('隔离：别人的消息记不进自己的记忆库', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭是谁', workId, chapterId });
  const done = events.find((e) => e.type === 'done');
  await indexer.whenIdle();

  const otherCookie = await server.loginAs('13900000002');

  const res = await server.requestAs(otherCookie, `/api/ai/messages/${done.messageId}/remember`, {
    method: 'POST',
  });
  assert.strictEqual(res.status, 404, '别人的消息应当 404');
});

test('隔离：手动层的台账只写进当前用户名下', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭是谁', workId, chapterId });
  const done = events.find((e) => e.type === 'done');
  await indexer.whenIdle();

  await server.request(`/api/ai/messages/${done.messageId}/remember`, { method: 'POST' });

  const rows = await chunksOf('conv_manual', done.messageId);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].user_id, testUserId);
});

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

test('清理：消息没了，三层记忆都清掉', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '林昭推开了门。', reason: '', citations: [] }),
    facts: JSON.stringify({ facts: ['林昭推门进入内堂'] }),
  };

  const { workId, chapterId } = await seedWork('林昭握着一枚青铜令牌。');
  const events = await chat({ message: '林昭接下来去哪', workId, chapterId });
  const done = events.find((e) => e.type === 'done');

  await extractor.whenIdle();
  await indexer.whenIdle();

  assert.strictEqual((await chunksOf('conv_raw', done.messageId)).length, 1);
  assert.strictEqual((await chunksOf('conv_fact', done.messageId)).length, 1);

  await server.request(`/api/ai/messages/${done.messageId}/remember`, { method: 'POST' });
  assert.strictEqual((await chunksOf('conv_manual', done.messageId)).length, 1);

  memoryConv.forgetMessage({ userId: testUserId, messageId: done.messageId });
  await indexer.whenIdle();

  assert.strictEqual((await chunksOf('conv_raw', done.messageId)).length, 0);
  assert.strictEqual((await chunksOf('conv_fact', done.messageId)).length, 0);
  assert.strictEqual((await chunksOf('conv_manual', done.messageId)).length, 0);
});

test('清理临时目录', async () => {
  await db.ready;
  env.cleanup();
});
