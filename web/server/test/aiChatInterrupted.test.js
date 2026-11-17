'use strict';

/**
 * 客户端中断后的服务端行为。
 *
 * 背景：作者关页面 / 点取消 / 网络断开时，请求会被 abort。
 * 旧实现把本轮用户消息 DELETE 掉，助手消息又从没入库——
 * 作者看着写了一半的正文，刷新后连自己发的那句话都没了。
 *
 * 现在改成：
 *   · 用户消息保留，并标成 interrupted；
 *   · 已经流出去的半截正文另存一条助手消息，同样标 interrupted；
 *   · 真失败（模型报错 / 上游非法 / 写库失败）才回滚；
 *   · interrupted 的那一轮整轮不进下一轮的写作上下文。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const app = require('../app');
const { ready, all, get } = require('../database');
const aiConfig = require('../services/aiConfig');

let server;
let fakeModel;
let originalConfig;

/**
 * 发一条会被中途掐断的请求：等请求真的打到假模型再断开。
 *
 * @param {string} message 作者这一轮说的话
 */
async function chatThenDisconnect(message) {
  const controller = new AbortController();
  const pending = server
    .request('/api/ai/chat', {
      method: 'POST',
      body: { message, roleKey: 'writer' },
      signal: controller.signal,
    })
    .catch(() => null);

  // 等请求真正打到假模型、进入流式等待，再断开。
  await new Promise((resolve) => setTimeout(resolve, 400));
  controller.abort();
  await pending;
  // 等服务端的 close 事件与落库完成
  await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * 某一轮所在的会话 id。
 *
 * 所有用例共用同一个库，按内容查会把别的用例的消息也算进来，
 * 所以先按这一轮的用户消息定位到会话，再在会话范围内查。
 *
 * @param {string} message 作者这一轮说的话
 * @returns {Promise<string>}
 */
async function conversationOf(message) {
  const row = await get(
    'SELECT conversation_id AS cid FROM messages WHERE content = ? ORDER BY rowid DESC LIMIT 1',
    [message]
  );
  assert.ok(row && row.cid, `应当能定位到「${message}」这一轮的会话`);
  return row.cid;
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

  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) aiConfig.updateConfig(originalConfig);
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 中断：保留什么
// ---------------------------------------------------------------------------

test('客户端断开：用户消息保留下来，并标成 interrupted', async () => {
  fakeModel.setDefault({ holdStream: true });

  await chatThenDisconnect('这一轮会被中途掐断');

  const rows = await all(
    "SELECT role, content, status FROM messages WHERE content = '这一轮会被中途掐断'"
  );
  assert.strictEqual(rows.length, 1, '作者发的那句话必须留在库里');
  assert.strictEqual(rows[0].role, 'user');
  assert.strictEqual(rows[0].status, 'interrupted', '中断的这一轮要标出来');
});

test('客户端断开：已输出的半截正文存成一条 interrupted 的助手消息', async () => {
  fakeModel.setDefault({ holdStream: true });

  await chatThenDisconnect('写一半就断');

  const cid = await conversationOf('写一半就断');
  const rows = await all(
    "SELECT role, content, status, payload FROM messages WHERE conversation_id = ? AND role = 'assistant'",
    [cid]
  );
  assert.strictEqual(rows.length, 1, '半截正文要单独存一条助手消息');

  const row = rows[0];
  assert.strictEqual(row.status, 'interrupted', '半截稿要和正常完成区分开');
  assert.match(row.content, /输出到一半就断了/, '半截正文就是已经推给作者的那部分');
  assert.doesNotMatch(row.content, /"action"/, '存的是正文，不是模型的协议外壳');

  const payload = JSON.parse(row.payload);
  assert.strictEqual(payload.interrupted, true, 'payload 里也要带 interrupted 标记');
});

test('客户端断开：一个 token 都没产出时，只留提问，不造半截助手消息', async () => {
  // hangStream：200 已回，但一个字都不吐就挂住
  fakeModel.setDefault({ hangStream: true });

  await chatThenDisconnect('一个字都没写出来');

  const cid = await conversationOf('一个字都没写出来');

  const userRows = await all(
    "SELECT role, content, status FROM messages WHERE conversation_id = ? AND role = 'user'",
    [cid]
  );
  assert.strictEqual(userRows.length, 1, '提问仍然保留');
  assert.strictEqual(userRows[0].status, 'interrupted');

  const assistantRows = await all(
    "SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant'",
    [cid]
  );
  assert.strictEqual(assistantRows.length, 0, '没有输出就不能凭空造一条半截消息');
});

// ---------------------------------------------------------------------------
// 中断：不进下一轮上下文
// ---------------------------------------------------------------------------

test('中断的那一轮整轮不进下一轮上下文（半截正文不会被当完整前文）', async () => {
  fakeModel.setDefault({ holdStream: true });
  await chatThenDisconnect('上一轮的问题');

  // 下一轮：模型正常回复
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '这一轮正常答完了。',
      reason: '',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message: '下一轮的问题', roleKey: 'writer' },
  });
  const text = await res.text();

  assert.match(text, /这一轮正常答完了/, '下一轮要正常拿到回复');

  // 看发出去的 messages：不能有被中断那一轮的任何一条
  const sent = fakeModel.calls[fakeModel.calls.length - 1];
  const dumped = JSON.stringify(sent.messages);
  assert.doesNotMatch(dumped, /上一轮的问题/, '被中断的提问不能进上下文');
  assert.doesNotMatch(dumped, /输出到一半就断了/, '半截正文不能进上下文');
});

test('正常的上一轮仍然进上下文（别把好内容一起剔了）', async () => {
  // 先正常聊一轮
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '这是上一轮完好的回答。',
      reason: '',
      citations: [],
    }),
    finishReason: 'stop',
  });
  const first = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message: '上一轮完好的问题', roleKey: 'writer' },
  });
  const firstText = await first.text();
  const firstDone = firstText
    .split('\n\n')
    .filter((c) => c.trim().startsWith('data:'))
    .map((c) => c.slice(5).trim())
    .filter((c) => c !== '[DONE]')
    .map((c) => JSON.parse(c))
    .find((e) => e.type === 'done' && e.conversationId);

  // 再来一轮：模型正常回复（同一个会话）
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: {
      message: '这一轮的问题',
      roleKey: 'writer',
      conversationId: firstDone.conversationId,
    },
  });
  await res.text();

  const sent = fakeModel.calls[fakeModel.calls.length - 1];
  const dumped = JSON.stringify(sent.messages);
  assert.match(dumped, /上一轮完好的问题/, '完好的上一轮提问要留在上下文里');
  assert.match(dumped, /这是上一轮完好的回答/, '完好的上一轮回答要留在上下文里');
});

test('中断之后作者还能在历史里看到这一轮（刷新后不是空的）', async () => {
  fakeModel.setDefault({ holdStream: true });
  await chatThenDisconnect('刷新之后我还想看到这句话');

  const listRes = await server.request('/api/ai/conversations');
  const list = await listRes.json();
  assert.ok(list.length >= 1, '会话要出现在历史列表里');

  const detailRes = await server.request(`/api/ai/conversations/${list[0].id}/messages`);
  const data = await detailRes.json();

  const user = data.messages.find((m) => m.role === 'user');
  assert.ok(user, '提问要能读回来');
  assert.strictEqual(user.status, 'interrupted', '接口要带出状态字段，前端据此标记');

  const assistant = data.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, '半截助手消息要能读回来');
  assert.strictEqual(assistant.status, 'interrupted');
  assert.match(assistant.content, /输出到一半就断了/);
});

test('重新生成时中断：上一版答案原样放回，半截稿单独标出来', async () => {
  // 先正常聊一轮，拿到一条完好的回答
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '这是上一版完好的回答。',
      reason: '',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message: '重新生成这一轮', roleKey: 'writer' },
  });
  const text = await res.text();
  const done = text
    .split('\n\n')
    .filter((c) => c.trim().startsWith('data:'))
    .map((c) => c.slice(5).trim())
    .filter((c) => c !== '[DONE]')
    .map((c) => JSON.parse(c))
    .find((e) => e.type === 'done' && e.messageId);
  assert.ok(done && done.messageId, '第一轮要拿到助手消息 id');

  // 重新生成：中途断开
  fakeModel.setDefault({ holdStream: true });

  const controller = new AbortController();
  const pending = server
    .request('/api/ai/chat', {
      method: 'POST',
      body: {
        message: '重新生成这一轮',
        roleKey: 'writer',
        conversationId: done.conversationId,
        replaceMessageId: done.messageId,
      },
      signal: controller.signal,
    })
    .catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 400));
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 400));

  const cid = await conversationOf('重新生成这一轮');
  const rows = await all(
    'SELECT role, content, status FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid',
    [cid]
  );

  const assistants = rows.filter((r) => r.role === 'assistant');
  assert.strictEqual(assistants.length, 2, '上一版答案和半截稿都要在');

  const restored = assistants.find((a) => a.content.includes('这是上一版完好的回答'));
  assert.ok(restored, '上一版完好的回答要原样放回去');
  assert.strictEqual(restored.status, 'complete', '放回去的上一版是完好的');

  const partial = assistants.find((a) => a.content.includes('输出到一半就断了'));
  assert.ok(partial, '半截稿要留下来');
  assert.strictEqual(partial.status, 'interrupted', '半截稿标中断');
});

test('真失败（供应商报错）仍然回滚：提问不留下来', async () => {
  fakeModel.setDefault({ httpStatus: 500, errorMessage: '上游炸了' });

  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message: '这条会失败', roleKey: 'writer' },
  });
  const text = await res.text();

  assert.match(text, /"type":"error"/, '要下发错误事件');

  const rows = await all("SELECT id FROM messages WHERE content = '这条会失败'");
  assert.strictEqual(rows.length, 0, '真失败仍然回滚提问');
});
