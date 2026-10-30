'use strict';

/**
 * AI 对话链路的回归测试。
 *
 * 重点盯住一件事：**AI 的回复绝不能是一个空白气泡**。
 *
 * 曾经的缺陷：模型被 max_tokens 截断、只吐了思考没吐正文时，
 * 后端会静默下发 action='none' + content=''，
 * 前端把它渲染成一个有边框、里面什么都没有的圆角框。
 * 作者既看不到内容，也看不到任何提示，只能对着一片空白反复重试。
 *
 * 这里起一个假的 OpenAI 兼容服务，把它当成真正的 DeepSeek 端点用——
 * 好处是 finish_reason 的捕获、SSE 的解析、路由的兜底逻辑全都在测试射程内。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const app = require('../app');
const { ready, all } = require('../database');
const aiConfig = require('../services/aiConfig');

let server;
let fakeModel;
let originalConfig;

/**
 * 发一条消息，收集整条 SSE 流里的事件。
 */
async function chat(message, extra = {}) {
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message, roleKey: 'writer', ...extra },
  });
  assert.strictEqual(res.status, 200);

  const text = await res.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().startsWith('data:'))
    .map((chunk) => {
      const payload = chunk.slice(5).trim();
      return payload === '[DONE]' ? { type: 'done' } : JSON.parse(payload);
    });
}

test.before(async () => {
  await ready;
  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();

  // 先存下原配置，测试结束后原样还原：
  // aiConfig 是单例，改过之后不复原，后面的测试会拿到一个指向
  // 本测试假服务的 baseUrl，然后一路报"连不上"。
  originalConfig = JSON.parse(JSON.stringify(aiConfig.getConfig()));

  // 把真的 DeepSeek 端点指向假服务——走的是完整 provider 代码路径
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
// 核心回归：空回复必须变成可见的错误
// ---------------------------------------------------------------------------

test('模型被长度上限截断时，返回可见的错误而不是空回复', async () => {
  fakeModel.setDefault({
    content: '',
    reasoning: '反复斟酌用词，写了一堆',
    finishReason: 'length',
  });

  const events = await chat('按照以上的建议修改第一章的内容');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.match(error.message, /截断/, '错误文案要说明是被长度上限截断');

  // 关键断言：绝不能再出现 content 为空的 action 事件
  const action = events.find((e) => e.type === 'action');
  assert.ok(!action || action.content, '不能下发空内容的 action 事件');
});

test('错误文案不指向设置页里不存在的开关', async () => {
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'length' });

  const events = await chat('随便写点什么');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error);
  // 设置页只暴露了角色提示词，没有输出长度/深度思考开关。
  // 让作者去"设置里调"只会让他白找一圈。
  assert.doesNotMatch(error.message, /设置|最大输出|深度思考/);
});

test('模型只输出思考没有正文时，返回可见的错误', async () => {
  fakeModel.setDefault({
    content: '',
    reasoning: '我在反复斟酌这段怎么开头',
    finishReason: 'stop',
  });

  const events = await chat('这个场景还能怎么设计');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.match(error.message, /思考/, '错误文案要说明模型只做了思考');

  const action = events.find((e) => e.type === 'action');
  assert.ok(!action || action.content, '不能下发空内容的 action 事件');
});

test('模型完全没给内容时，返回可见的错误', async () => {
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'stop' });

  const events = await chat('随便写点什么');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.ok(error.message.length > 0, '错误文案不能为空');

  const action = events.find((e) => e.type === 'action');
  assert.ok(!action || action.content, '不能下发空内容的 action 事件');
});

test('空回复时不会在历史里留下孤立的用户消息', async () => {
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'length' });

  await chat('这条消息不该留在历史里');

  const rows = await all('SELECT role, content FROM messages');
  const orphan = rows.find((r) => r.content === '这条消息不该留在历史里');
  assert.ok(!orphan, '失败的用户消息应当被清理掉');
});

test('供应商报错时同样会给出可见的错误并清掉孤立消息', async () => {
  // 4xx 不重试，测试不会被退避拖慢
  fakeModel.setDefault({ httpStatus: 401, errorMessage: '鉴权失败' });

  const events = await chat('这条消息也不该留在历史里');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.ok(error.message.length > 0, '错误文案不能为空');

  const rows = await all('SELECT role, content FROM messages');
  const orphan = rows.find((r) => r.content === '这条消息也不该留在历史里');
  assert.ok(!orphan, '失败的用户消息应当被清理掉');
});

// ---------------------------------------------------------------------------
// 正常回复不受影响
// ---------------------------------------------------------------------------

test('正常回复照常下发 action 事件', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '巷口的雨下得不大，陈默站在灯下等了三分钟。',
      reason: '补了一段环境',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const events = await chat('接着上一段往下写');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.strictEqual(action.action, 'comment');
  assert.match(action.content, /巷口的雨/);

  assert.ok(events.find((e) => e.type === 'done'), '应当下发 done 事件');
});

test('模型没给 JSON 时，原始文本当回复内容', async () => {
  fakeModel.setDefault({ content: '这里直接是自然语言回复，没有 JSON。', finishReason: 'stop' });

  const events = await chat('随便聊聊');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.strictEqual(action.action, 'comment');
  assert.match(action.content, /自然语言回复/);
});

test('模型给了 JSON 但正文为空时，用 reason 顶上', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'none',
      content: '',
      reason: '这一段已经比较完整，暂时没什么可改的。',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const events = await chat('帮我看看这一段');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.ok(action.content, '正文不能为空');
  assert.match(action.content, /暂时没什么可改的/);
});

test('模型的正文不是字符串时（数组/对象），照样能显示出来', async () => {
  // 模型有时会把正文写成数组或对象。
  // 以前这些会被当成空串丢掉，作者看到的就是一个空白框。
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: ['方向一：雨夜里有人敲门。', '方向二：门缝里塞进来一封信。'],
      reason: '给了两个走向',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const events = await chat('这个场景还能怎么设计');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.ok(action.content, '正文不能为空');
  assert.match(action.content, /雨夜里有人敲门/);
  assert.match(action.content, /塞进来一封信/);
});

// ---------------------------------------------------------------------------
// 历史对话：作者要能翻回之前聊过什么
// ---------------------------------------------------------------------------

test('历史对话：聊完能在列表里看到，标题取第一句话', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '可以让陈默先发现线索，再让对手主动出手。',
      reason: '给了冲突升级的方向',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const events = await chat('帮我想想第三章的冲突怎么升级');
  const done = events.find((e) => e.type === 'done' && e.conversationId);
  assert.ok(done, '正常对话应当带回 conversationId');

  const res = await server.request('/api/ai/conversations');
  assert.strictEqual(res.status, 200);

  const list = await res.json();
  const item = list.find((c) => c.id === done.conversationId);
  assert.ok(item, '刚聊完的会话必须出现在历史列表里');
  assert.match(item.title, /第三章的冲突/, '标题应当取自作者的第一句话');
  assert.ok(item.messageCount >= 2, '一问一答至少两条消息');
  assert.ok(item.preview.length > 0, '列表要给出一段预览');
});

test('历史对话：能取回完整的问答，保留动作与角色信息', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      action: 'comment',
      content: '先把雨声写足，再让敲门声进来。',
      reason: '重写了开头',
      citations: [],
    }),
    finishReason: 'stop',
  });

  const events = await chat('这段开头还能怎么改');
  const done = events.find((e) => e.type === 'done' && e.conversationId);

  const res = await server.request(
    `/api/ai/conversations/${done.conversationId}/messages`
  );
  assert.strictEqual(res.status, 200);

  const data = await res.json();
  assert.strictEqual(data.id, done.conversationId);

  const user = data.messages.find((m) => m.role === 'user');
  assert.ok(user, '要能取回作者的提问');
  assert.match(user.content, /这段开头还能怎么改/);

  const assistant = data.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, '要能取回 AI 的回答');
  assert.strictEqual(assistant.action, 'comment');
  assert.match(assistant.content, /敲门声/);
  assert.ok(assistant.roleLabel, '回答要带上角色名，否则历史里分不清是谁说的');
});

test('历史对话：别人的会话既看不到列表也打不开', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({ action: 'comment', content: '好。', reason: '', citations: [] }),
    finishReason: 'stop',
  });

  const events = await chat('这条只属于我自己');
  const done = events.find((e) => e.type === 'done' && e.conversationId);

  const otherCookie = await server.loginAs('13900000099');

  const listRes = await server.requestAs(otherCookie, '/api/ai/conversations');
  const list = await listRes.json();
  assert.ok(
    !list.find((c) => c.id === done.conversationId),
    '别人的历史列表里不能出现我的会话'
  );

  const detailRes = await server.requestAs(
    otherCookie,
    `/api/ai/conversations/${done.conversationId}/messages`
  );
  assert.strictEqual(detailRes.status, 404, '别人的会话 id 应当当作不存在');
});

// ---------------------------------------------------------------------------
// 行内操作：空回复不能把正文改成空白
// ---------------------------------------------------------------------------

test('行内操作遇到空回复时报错，而不是返回空正文', async () => {
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'length' });

  const res = await server.request('/api/ai/inline', {
    method: 'POST',
    body: { action: 'rewrite', selection: '雨夜的巷子里只剩下脚步声。' },
  });

  assert.notStrictEqual(res.status, 200, '空回复不应当被当成一次成功的改写');
  const body = await res.json();
  assert.ok(body.error && body.error.length > 0, '要给出可读的错误文案');
});
