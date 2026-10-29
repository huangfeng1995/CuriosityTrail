'use strict';

/**
 * 多步循环的 HTTP 集成测试。
 *
 * 单测文件（agentSkills.test.js）测纯逻辑，不起 HTTP；
 * 这里要验证三个新 SSE 事件真的从路由里发出来了，就得走完整链路。
 *
 * 另开一个文件而不是往单测文件里塞：一个文件一套环境
 * （setupTempEnv / test.after 各一次），混在一起会互相打架。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好 DATA_DIR：
// app 会加载 skills → 技能模块 → database.js，
// 而 database.js 在模块加载时就打开了 SQLite 连接。
const env = setupTempEnv();

const app = require('../app');
const { ready } = require('../database');
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

test('模型要求调用技能时，技能被调用、结果被喂回、最终下发 action', async () => {
  // 测试请求没带 workId，conversation.work_id 是空，
  // 技能在 run() 开头就返回「没有找到要查的作品」，不会调模型做判定。
  fakeModel.setQueue([
    { content: '{"action":"call_tool","tool":"audit_foreshadowing","params":{"target":"铜钥匙"}}' },
    { content: '{"action":"comment","content":"铜钥匙在第 7 章回收了。"}' },
  ]);

  const events = await chat('第三章那个铜钥匙最后收了吗');

  // 技能轮次不能有 token 下发
  const tokenText = events.filter((e) => e.type === 'token').map((e) => e.content).join('');
  assert.ok(!tokenText.includes('call_tool'), '工具轮次的 JSON 不能出现在 token 里');

  // 三个新事件都要到
  assert.ok(events.find((e) => e.type === 'agent_thinking'), '要有 agent_thinking');
  assert.ok(events.find((e) => e.type === 'tool_start'), '要有 tool_start');
  assert.ok(events.find((e) => e.type === 'tool_done'), '要有 tool_done');

  // 最终要下发 action
  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '最终要下发 action 事件');
  assert.match(action.content, /铜钥匙/);
});

test('技能名不存在时不崩溃，仍然下发 action', async () => {
  fakeModel.setQueue([
    { content: '{"action":"call_tool","tool":"根本没有这个技能"}' },
    { content: '{"action":"comment","content":"这个我查不了。"}' },
  ]);

  const events = await chat('随便问一句');
  assert.ok(events.find((e) => e.type === 'action'), '仍然要下发 action 事件');
});

test('模型没给 JSON 时，原文当回复内容（回归）', async () => {
  fakeModel.setDefault({ content: '这里直接是自然语言回复，没有 JSON。', finishReason: 'stop' });

  const events = await chat('随便聊聊');
  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.strictEqual(action.action, 'comment');
  assert.match(action.content, /自然语言回复/);
});
