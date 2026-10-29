'use strict';

/**
 * 记忆召回在对话链路里的集成测试。
 *
 * 盯住三件事：
 *  1. **memory 事件在第一个 token 之前到达** —— 作者要先看到"参考了什么"，
 *     再看到答案。迟了就成了事后补注。
 *  2. **作者能控制**：useMemory=false 就一条都不召回；
 *     excludeRefIds 命中的条目不参与这次生成。
 *  3. **重生成不污染历史**：剔除记忆后重新生成，
 *     旧的问答要真的从历史里消失，而不是叠在上面。
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

let server;
let fakeModel;
let fakeSidecar;
let originalConfig;
let originalBaseUrl;

/**
 * 登录测试服务用的那个用户的 id。
 *
 * 必须用真正登录的那个用户：作品的归属、URI 前缀、召回过滤
 * 全都按 user_id 走。拿一个数据库里有、但没登录的用户造数据，
 * 召回会理所当然地一条都捞不到。
 */
let testUserId = '';

/** 当前这轮伪造的模型回复 */
let behavior = null;

/** 当前使用的会话 id。同一作品内的多次对话共用一个会话。 */
let conversationId = '';

/**
 * 假的 OpenAI 兼容端点。跟 aiChat.test.js 一样，但更简单：
 * 只回一段固定的 JSON 正文。
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

        const b = behavior || { content: '' };

        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: b.content || '' }, finish_reason: 'stop' }],
            })
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (b.content) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: b.content }, finish_reason: null }],
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
 * 会话 id 自动接续：连续几轮对话必须落在同一个 conversation 里，
 * 否则"重新生成时替换旧问答"根本无从谈起——服务端找不到上一版。
 *
 * @param {object} body
 * @returns {Promise<Array>} 事件列表
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
 * 造一部作品 + 两章正文，并立刻建好索引。
 *
 * 作品挂在登录用户名下——归属不对的话召回会按 user_id 过滤掉。
 *
 * **两章是必须的**：召回时会排除「当前章」（正文已经全量注进上下文了，
 * 召回它没有意义）。只种一章的话，那唯一一章就是当前章，
 * 结果一条都召不回来，测的就不是召回而是"排除"了。
 *
 * @param {string} body 旧章正文（这一章才是召回得出来的）
 * @returns {Promise<{workId: string, chapterId: string, memoryChapterId: string}>}
 *   `chapterId` 是当前章，`memoryChapterId` 是可召回的旧章
 */
async function seedIndexedWork(body) {
  const workId = crypto.randomUUID();
  const chapterId = crypto.randomUUID();
  const memoryChapterId = crypto.randomUUID();
  const now = new Date().toISOString();

  // 新作品 = 新会话。不同作品混在一个会话里，历史会串味。
  conversationId = '';

  await run(
    'INSERT INTO works (id, user_id, title, created_at, modified_at) VALUES (?, ?, ?, ?, ?)',
    [workId, testUserId, '雾港', now, now]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, content, blocks, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      memoryChapterId,
      workId,
      '第一章',
      1,
      body,
      JSON.stringify([{ id: 'b1', type: 'paragraph', content: body }]),
      now,
      now,
    ]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, content, blocks, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chapterId,
      workId,
      '第二章',
      2,
      '林昭握着那枚青铜令牌，走向更深的雨夜。',
      JSON.stringify([
        { id: 'b2', type: 'paragraph', content: '林昭握着那枚青铜令牌，走向更深的雨夜。' },
      ]),
      now,
      now,
    ]
  );

  for (const sourceId of [memoryChapterId, chapterId]) {
    await indexer.indexSource({
      userId: testUserId,
      workId,
      sourceType: 'chapter',
      sourceId,
    });
  }

  return { workId, chapterId, memoryChapterId };
}

/**
 * 当前会话里的消息。
 * @returns {Promise<Array>}
 */
function conversationMessages() {
  return all(
    'SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [conversationId]
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

  server = await startServer(app);

  // 拿真正登录的那个用户的 id
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
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 记忆事件
// ---------------------------------------------------------------------------

test('召回：对话时会下发 memory 事件并带上来源标签', async () => {
  behavior = {
    content: JSON.stringify({
      action: 'comment',
      content: '林昭把令牌攥紧了些。',
      reason: '接上文',
      citations: [],
    }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const events = await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
  });

  const memory = events.find((e) => e.type === 'memory');
  assert.ok(memory, '应当下发 memory 事件');
  assert.strictEqual(memory.degraded, false);
  assert.strictEqual(memory.refs.length, 1);
  assert.strictEqual(memory.refs[0].sourceType, 'chapter');
  assert.ok(memory.refs[0].label.includes('第一章'));
  assert.ok(memory.refs[0].preview.includes('青铜令牌'));
});

test('顺序：memory 事件在第一个 token 之前到达', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const events = await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
  });

  const memoryIndex = events.findIndex((e) => e.type === 'memory');
  const tokenIndex = events.findIndex((e) => e.type === 'token');

  assert.ok(memoryIndex >= 0, '应当有 memory 事件');
  assert.ok(tokenIndex >= 0, '应当有 token 事件');
  assert.ok(memoryIndex < tokenIndex, 'memory 事件必须早于第一个 token');
});

test('控制：useMemory=false 时一条都不召回', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const events = await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
    useMemory: false,
  });

  const memory = events.find((e) => e.type === 'memory');
  assert.ok(memory, '仍然要下发 memory 事件');
  assert.strictEqual(memory.refs.length, 0);
  assert.strictEqual(memory.degraded, false);
});

test('控制：excludeRefIds 命中的条目不参与这次生成', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '好的。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const first = await chat({ message: '林昭接下来会怎么做', workId, chapterId });
  const memory = first.find((e) => e.type === 'memory');
  assert.strictEqual(memory.refs.length, 1);

  const second = await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
    excludeRefIds: [memory.refs[0].id],
  });

  const secondMemory = second.find((e) => e.type === 'memory');
  assert.strictEqual(secondMemory.refs.length, 0, '被剔除的条目不该再出现');
});

test('降级：sidecar 挂了对话照常进行，memory 事件标记 degraded', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '照常回答。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  fakeSidecar.setFault('error');

  const events = await chat({ message: '林昭接下来会怎么做', workId, chapterId });

  fakeSidecar.setFault(null);

  const memory = events.find((e) => e.type === 'memory');
  assert.ok(memory);
  assert.strictEqual(memory.degraded, true);
  assert.strictEqual(memory.refs.length, 0);
  assert.ok(memory.reason);

  // 对话本身必须照常走完
  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '记忆挂了不影响 AI 回答');
  assert.match(action.content, /照常回答/);
});

// ---------------------------------------------------------------------------
// 重生成
// ---------------------------------------------------------------------------

test('重生成：旧问答被替换掉，历史里不会叠两遍', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第一次的回答。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const first = await chat({ message: '林昭接下来会怎么做', workId, chapterId });
  const done = first.find((e) => e.type === 'done');
  assert.ok(done.messageId, 'done 事件要带助手消息 id');

  const before = await conversationMessages();
  assert.strictEqual(before.filter((m) => m.role === 'user').length, 1);
  assert.strictEqual(before.filter((m) => m.role === 'assistant').length, 1);

  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第二次的回答。', reason: '', citations: [] }),
  };

  await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
    replaceMessageId: done.messageId,
  });

  const after = await conversationMessages();
  assert.strictEqual(after.filter((m) => m.role === 'user').length, 1, '用户消息不该多出一条');
  assert.strictEqual(after.filter((m) => m.role === 'assistant').length, 1, '助手消息不该多出一条');
  assert.ok(
    after.some((m) => m.content.includes('第二次的回答')),
    '新回答应当写进历史'
  );
  assert.ok(
    !after.some((m) => m.content.includes('第一次的回答')),
    '旧回答应当从历史里消失'
  );
});

test('重生成失败：旧回答回到历史里，不让作者白白丢掉上一个答案', async () => {
  behavior = {
    content: JSON.stringify({ action: 'comment', content: '第一次的回答。', reason: '', citations: [] }),
  };

  const { workId, chapterId } = await seedIndexedWork(
    '林昭握着一枚青铜令牌，站在雨夜的巷口。'
  );

  const first = await chat({ message: '林昭接下来会怎么做', workId, chapterId });
  const done = first.find((e) => e.type === 'done');

  // 这一次模型什么都不给
  behavior = { content: '' };

  await chat({
    message: '林昭接下来会怎么做',
    workId,
    chapterId,
    replaceMessageId: done.messageId,
  });

  const after = await conversationMessages();
  assert.ok(
    after.some((m) => m.content.includes('第一次的回答')),
    '重生成失败后旧回答应当回到历史'
  );
  assert.strictEqual(
    after.filter((m) => m.role === 'user').length,
    1,
    '重生成失败后不该多出一条提问'
  );
  assert.strictEqual(
    after.filter((m) => m.role === 'assistant').length,
    1,
    '重生成失败后不该多出一条回答'
  );
});

test('清理临时目录', async () => {
  await db.ready;
  env.cleanup();
});
