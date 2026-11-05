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
const { ready, all, get, run } = require('../database');
const aiConfig = require('../services/aiConfig');
const { assembleContext } = require('../services/context');

let server;
let fakeModel;
let originalConfig;
let seedSeq = 0;

/**
 * 造一部属于当前登录用户的作品与章节，用来触发节拍规划。
 *
 * @param {{outline?: string, body?: string, seq?: number}} [options]
 * @returns {Promise<{workId: string, chapterId: string}>}
 */
async function seedChapter(options = {}) {
  const { outline = '', body = '', seq = 1 } = options;
  const user = await get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  assert.ok(user, '默认测试用户应当存在');

  seedSeq += 1;
  const workId = `work-t3-${seedSeq}`;
  const chapterId = `chapter-t3-${seedSeq}`;
  const now = new Date().toISOString();

  await require('../database').run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, user.id, `测试作品${seedSeq}`, now, now]
  );
  await require('../database').run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', ?, ?, ?, 0, ?, ?)`,
    [
      chapterId,
      workId,
      `第${seedSeq}章`,
      seq,
      body,
      JSON.stringify(body ? [{ id: `b${seedSeq}`, type: 'paragraph', content: body }] : []),
      outline,
      now,
      now,
    ]
  );

  return { workId, chapterId };
}

/**
 * 一份合格的节拍表响应（四拍、合计 40 段，落在 40–55 的长章区间）。
 */
function validPlanJson() {
  return JSON.stringify({
    chapterGoal: '主角查清旧案的第一条线索',
    protagonistIntent: '进庙查案',
    obstacle: '庙祝拦门',
    cost: '交出随身信物',
    hook: '照片背面写着主角的名字',
    avoidRepeat: [],
    mainType: '揭示',
    beats: [
      {
        id: 'B1',
        type: '行动',
        goal: '进入城隍庙',
        obstacle: '庙祝拦着不让进',
        cost: '押上唯一的信物',
        delta: { variable: '处境', from: '被挡在庙外', to: '进入内殿' },
        infoGain: '庙里供着的不是城隍像，而是一张旧照片',
        paragraphs: 10,
        endHook: '照片上的人穿着现任知县的官服',
      },
      {
        id: 'B2',
        type: '冲突',
        goal: '问出照片来历',
        obstacle: '庙祝闪烁其词',
        cost: '被赶出庙门',
        delta: { variable: '关系', from: '互相试探', to: '彻底翻脸' },
        infoGain: '旧案发生在二十年前，当时知县尚未到任',
        paragraphs: 10,
        endHook: '庙祝说漏了「那年冬天」四个字',
      },
      {
        id: 'B3',
        type: '转折',
        goal: '从旧档里找出那年冬天的记录',
        obstacle: '档案被抽走了关键几页',
        cost: '惊动管档的主簿',
        delta: { variable: '信息', from: '以为只是一桩旧案', to: '发现有人一直在抹掉它' },
        infoGain: '缺失的几页正好是案发前后三个月',
        paragraphs: 10,
        endHook: '主簿当夜就请了病假',
      },
      {
        id: 'B4',
        type: '揭示',
        goal: '确认照片上的人是谁',
        obstacle: '照片已被人提前取走',
        cost: '失去当面指认的机会',
        delta: { variable: '决心', from: '只想查清线索', to: '决定把这桩旧案翻到底' },
        infoGain: '取走照片的人留下了与知县相同的印泥',
        paragraphs: 10,
        endHook: '县衙后门当晚抬出一口箱子',
      },
    ],
  });
}

/**
 * 写满一组目标篇幅的假正文，避免测试里意外触发续写。
 *
 * 四拍章按 3 拍一组切成 2 组，每组目标 20 段 ≈ 2440 字，
 * 低于 80% 会触发续写，所以这里给到 20 段 × 约 120 字。
 */
function segmentBody(label, extraParagraph = '') {
  const sentence = '风雪压着庙檐，他把手按在门环上，指腹能摸到一层薄冰，门里有人轻轻咳了一声。';
  const rows = Array.from(
    { length: 20 },
    (_, i) => `${label}第${i + 1}段：${sentence}${sentence}${sentence}`
  );
  if (extraParagraph) rows.push(extraParagraph);
  return rows.join('\n\n');
}

/**
 * 一轮「规划 → 两组正文 → 覆盖自检」的假模型响应。
 * 规划测试只需要盯 system 里的边界，正文与自检沿用同一套合格响应。
 */
function planningQueue() {
  return [
    { content: validPlanJson(), finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '庙门半掩，主角在门槛外停了停。\n\n' + segmentBody('第一组'),
        reason: '按节拍表写第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
        reason: '按节拍表写第二组并收束',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '庙门半掩，主角在门槛外停了停' },
          { id: 'B2', evidence: '他问庙祝照片上是谁，庙祝不答' },
          { id: 'B3', evidence: '旧档中间缺了几页，断口很新' },
          { id: 'B4', evidence: '县衙后门抬出一口箱子' },
        ],
        missing: [],
        weak: [],
        hookPresent: true,
        chapterGoalMet: true,
      }),
      finishReason: 'stop',
    },
  ];
}

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
  assert.strictEqual(error.code, 'AI_TRUNCATED', '要能区分"被截断"和"真空响应"');
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
  assert.strictEqual(error.code, 'AI_REASONING_ONLY', '要能区分"只思考没正文"');
  assert.match(error.message, /思考/, '错误文案要说明模型只做了思考');

  const action = events.find((e) => e.type === 'action');
  assert.ok(!action || action.content, '不能下发空内容的 action 事件');
});

test('模型完全没给内容时，返回可见的错误', async () => {
  fakeModel.setDefault({ content: '', reasoning: '', finishReason: 'stop' });

  const events = await chat('随便写点什么');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.strictEqual(error.code, 'AI_EMPTY_RESPONSE', '要能区分"上游真空响应"');
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

test('模型没给 JSON 时，原始文本作为正文下发并标记', async () => {
  fakeModel.setDefault({ content: '这里直接是自然语言回复，没有 JSON。', finishReason: 'stop' });

  const events = await chat('随便聊聊');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.strictEqual(action.action, 'append', '原文要作为正文下发，作者才能应用');
  assert.match(action.content, /自然语言回复/, '原始文本不能被丢掉');
  assert.strictEqual(action.parseFailed, true, '必须标记这是解析失败后的原文回退');
  assert.match(action.reason, /格式/, '要说明为什么按原文处理');
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

test('模型第一次返回空响应时自动重试一次，第二次必须换掉 JSON 模式', async () => {
  // DeepSeek 的 JSON 模式偶发空白完成：用量照算，正文一个字都没有。
  // 作者不该为供应商的抖动买单——服务端自己再要一次。
  //
  // 但"再要一次"不能是原样重发：长历史 + response_format=json_object
  // 是已知会稳定返回几千个空格的组合，第二次必须换条件。
  fakeModel.setQueue([
    { content: '', reasoning: '', finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'comment',
        content: '重试之后拿到的回答。',
        reason: '',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('这段再帮我改改');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '重试成功时应当正常下发回答');
  assert.match(action.content, /重试之后拿到/);
  assert.ok(!events.find((e) => e.type === 'error'), '能重试成功就不该给作者报错');

  const first = fakeModel.calls[before];
  const second = fakeModel.calls[before + 1];
  assert.deepStrictEqual(
    first.response_format,
    { type: 'json_object' },
    '第一次按约定开 JSON 模式'
  );
  assert.ok(
    !second.response_format,
    '第二次必须关掉 JSON 模式，否则等于用同一个致病条件又发了一遍'
  );
  const last = second.messages[second.messages.length - 1];
  assert.match(
    String(last.content || ''),
    /不要输出 JSON/,
    '重试时要明确要求直接写纯文本正文'
  );
});

test('审稿意见会作为历史进入写手的重写请求', async () => {
  // 作者的实际操作：先和审稿人聊，再让写手"按上面的建议重写"。
  // 这条路能不能成立，全看审稿意见有没有真的拼进写手的请求。
  const criticNote = '审稿意见MAGIC：结尾太仓促，需要一个收束句。';
  fakeModel.setQueue([
    {
      content: JSON.stringify({
        action: 'comment',
        content: criticNote,
        reason: '',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        action: 'replace',
        content: '改好的开头。',
        reason: '按审稿意见补了收束句',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);

  const first = await chat('帮我审一下第一章', { roleKey: 'critic' });
  const done = first.find((e) => e.type === 'done' && e.conversationId);
  assert.ok(done, '审稿轮要带回 conversationId，后面的写手才知道接着聊');

  const before = fakeModel.calls.length;
  const second = await chat('按上面的建议重写第一章', {
    roleKey: 'writer',
    conversationId: done.conversationId,
  });
  assert.ok(second.find((e) => e.type === 'action'), '重写应当正常返回');

  const writerCall = fakeModel.calls[before];
  const assistantHistory = writerCall.messages.filter((m) => m.role === 'assistant');
  assert.ok(
    assistantHistory.some((m) => String(m.content || '').includes('审稿意见MAGIC')),
    '审稿意见必须以 assistant 历史出现在写手请求里'
  );
  const joined = writerCall.messages.map((m) => String(m.content || '')).join('\n');
  assert.match(joined, /按上面的建议重写第一章/, '本次提问也要在请求里');
});

test('模型返回 action=none 且没有正文与理由时，标记为 AI_NO_BODY', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({ action: 'none', content: '', reason: '', citations: [] }),
    finishReason: 'stop',
  });

  const events = await chat('帮我看看这一段');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '应当下发 error 事件');
  assert.strictEqual(error.code, 'AI_NO_BODY', '模型有回应但没正文，不能报成上游空白');
});

test('重试后仍为空时，明确告知已自动重试过', async () => {
  fakeModel.setQueue([
    { content: '', reasoning: '', finishReason: 'stop' },
    { content: '', reasoning: '', finishReason: 'stop' },
  ]);

  const events = await chat('还是没反应');

  const error = events.find((e) => e.type === 'error');
  assert.ok(error, '连续两次空响应必须给出可见错误');
  assert.match(error.message, /已自动重试一次/, '要说明已经替作者重试过');
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
  assert.strictEqual(body.code, 'AI_TRUNCATED', '行内路径也要把"被截断"单独分类');
  assert.ok(body.error && body.error.length > 0, '要给出可读的错误文案');
});

test('行内操作遇到非 JSON 原文时，作为正文回退并标记', async () => {
  fakeModel.setDefault({ content: '他抬头看了看天，没有说一句话。', finishReason: 'stop' });

  const res = await server.request('/api/ai/inline', {
    method: 'POST',
    body: { action: 'rewrite', selection: '雨夜的巷子里只剩下脚步声。' },
  });

  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.action, 'append', '原文要作为正文返回');
  assert.match(body.content, /抬头看了看天/, '原始文本不能被丢掉');
  assert.strictEqual(body.parseFailed, true, '必须标记解析失败');
  assert.match(body.reason, /格式/, '要说明为什么按原文处理');
});

// ---------------------------------------------------------------------------
// 超时：必须能和其他空回复分开
// ---------------------------------------------------------------------------

test('provider 超时会被标记成 AI_TIMEOUT', async () => {
  // 路由的 catch 按 err.code === 'AI_TIMEOUT' 分类。这里验证底层确实打了这个标记，
  // 否则超时会被当成普通供应商错误，作者只看到一句"失败"。
  const http = require('node:http');
  const { fetchWithRetry } = require('../services/providers/base');

  const slow = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }, 300);
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const { port } = slow.address();

  try {
    await assert.rejects(
      () => fetchWithRetry(`http://127.0.0.1:${port}/chat/completions`, {}, 0, 50),
      (err) => {
        assert.strictEqual(err.code, 'AI_TIMEOUT', '超时要带 AI_TIMEOUT 标记');
        return true;
      }
    );
  } finally {
    if (slow.closeAllConnections) slow.closeAllConnections();
    await new Promise((resolve) => slow.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// T3 节拍规划：规划 → 写作 → 自检 → （缺拍时）重写一次
// ---------------------------------------------------------------------------

test('起稿前先规划：节拍表以 JSON 进入写手请求，规划不读整章正文', async () => {
  const { workId, chapterId } = await seedChapter({
    outline: 'MAGIC-大纲：主角进庙查旧案，庙祝会拦他。',
    body: 'MAGIC-正文：这一段是已经写好的正文，不应该再塞进规划请求。',
  });

  fakeModel.setQueue([
    // 1. 规划
    { content: validPlanJson(), finishReason: 'stop' },
    // 2. 第一组（B1–B2）
    {
      content: JSON.stringify({
        action: 'append',
        content: '庙门半掩，主角在门槛外停了停。\n\n' + segmentBody('第一组'),
        reason: '按节拍表写第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    // 3. 第二组（B3–B4，最后一组才收束）
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
        reason: '按节拍表写第二组并收束',
        citations: [],
      }),
      finishReason: 'stop',
    },
    // 4. 覆盖自检：四拍全中，每拍带可核对的原句
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '庙门半掩，主角在门槛外停了停' },
          { id: 'B2', evidence: '他问庙祝照片上是谁，庙祝不答' },
          { id: 'B3', evidence: '旧档中间缺了几页，断口很新' },
          { id: 'B4', evidence: '县衙后门抬出一口箱子' },
        ],
        missing: [],
        weak: [],
        hookPresent: true,
        chapterGoalMet: true,
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('按大纲写这一章', { workId, chapterId });

  const planCall = fakeModel.calls[before];
  const writerCall = fakeModel.calls[before + 1];
  const lastSegmentCall = fakeModel.calls[before + 2];
  const checkCall = fakeModel.calls[before + 3];
  assert.ok(checkCall, '规划成功且产出正文后，应当跑一次覆盖自检');

  // 规划请求：JSON 模式、独立预算、上下文含大纲但不含整章正文
  assert.deepStrictEqual(planCall.response_format, { type: 'json_object' });
  assert.strictEqual(planCall.max_tokens, 2000, '规划预算 2000，完整节拍表实测约 1558 tokens');
  const planSystem = String(planCall.messages[0].content || '');
  assert.match(planSystem, /MAGIC-大纲/, '规划要用本章大纲');
  assert.ok(!planSystem.includes('MAGIC-正文'), '规划不塞整章正文');

  // 写手请求：节拍表拼在 system 里，写手仍按原 JSON 契约输出
  const writerSystem = String(writerCall.messages[0].content || '');
  assert.match(writerSystem, /## 本章节拍表（硬约束，必须覆盖）/);
  assert.match(writerSystem, /"B4"/, '节拍表 JSON 要完整交给写手');
  assert.deepStrictEqual(writerCall.response_format, { type: 'json_object' });
  assert.strictEqual(
    writerCall.max_tokens,
    10000,
    '写手预算要能容纳 5000 字正文，思考也不能把正文挤没'
  );
  assert.strictEqual(lastSegmentCall.max_tokens, 10000, '每组调用用的是同一份写手预算');

  // 中间组只写本组、禁止收尾；最后一组才允许收束并埋钩子
  const firstInstruction = String(
    writerCall.messages[writerCall.messages.length - 1].content || ''
  );
  assert.match(firstInstruction, /第 1\/2 组/);
  assert.match(firstInstruction, /本组只写这几拍：B1、B2/);
  assert.match(firstInstruction, /不要提前收尾/);
  assert.match(firstInstruction, /禁止出现「就这样」「从此」/, '中间组要明确禁收尾语气');

  const lastInstruction = String(
    lastSegmentCall.messages[lastSegmentCall.messages.length - 1].content || ''
  );
  assert.match(lastInstruction, /第 2\/2 组/);
  assert.match(lastInstruction, /可以收束本章/, '只有最后一组才允许收束');
  assert.match(lastInstruction, /章末钩子/);

  // 自检请求
  assert.deepStrictEqual(checkCall.response_format, { type: 'json_object' });
  assert.strictEqual(checkCall.max_tokens, 800);
  assert.match(String(checkCall.messages[1].content), /《节拍表》/);
  assert.match(String(checkCall.messages[0].content), /30 个字/, '自检要求每拍给出短证据');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '起稿应当正常下发 action');
  assert.strictEqual(action.action, 'append');
  assert.match(action.content, /庙门半掩/);
  assert.match(action.content, /县衙后门当晚抬出一口箱子/, '最后一组的章末钩子要接在整章末尾');
  assert.deepStrictEqual(action.beatCheck.missing, []);
  assert.strictEqual(action.segmentInfo.groups, 2, '四拍章按 3 拍一组切成 2 组');
  assert.strictEqual(action.segmentInfo.calls, 2, '每组一次调用，这一轮不该有续写');
  assert.strictEqual(action.segmentInfo.degraded, '');
  assert.strictEqual(action.beatCheck.evidence.length, 4, '每拍都要带证据');
  for (const item of action.beatCheck.evidence) {
    assert.ok(Array.from(item.evidence).length <= 30, '证据不能超过 30 字');
  }
  assert.strictEqual(action.planDegraded, '', '规划成功时不应打降级标记');
  assert.doesNotMatch(action.reason, /编排自检/, '覆盖齐全时不该给作者加徽标');

  // 规划的 JSON 是内部协议，不能作为 token 流到作者界面上
  const tokenText = events
    .filter((e) => e.type === 'token')
    .map((e) => e.content)
    .join('');
  assert.ok(!tokenText.includes('chapterGoal'), '规划 JSON 不能让作者看见');
});

test('分场 brief 进入规划 system 与写手组指令，且不改变原有调用次序', async () => {
  const { workId, chapterId } = await seedChapter({
    outline: 'MAGIC-大纲：主角进庙查旧案，庙祝会拦他。',
    body: 'MAGIC-正文：已经写好的段落。',
  });

  fakeModel.setBrief({
    content: JSON.stringify({
      items: [
        {
          kind: 'loss',
          text: '交出随身信物',
          keywords: ['信物'],
          source: '本章大纲',
          inferred: false,
        },
        {
          kind: 'mustPresent',
          text: '庙祝到场并当面拦门',
          keywords: ['庙祝', '拦'],
          source: '人物卡',
          inferred: false,
        },
        {
          kind: 'mustWithhold',
          text: '不得解释照片上的人是谁',
          keywords: ['照片'],
          source: '设定',
          inferred: false,
        },
        {
          kind: 'mustPresent',
          text: '主簿可能提前离场',
          keywords: ['主簿'],
          inferred: true,
        },
      ],
    }),
    finishReason: 'stop',
  });

  fakeModel.setQueue([
    { content: validPlanJson(), finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第一组'),
        reason: '第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
        reason: '第二组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '庙门半掩' },
          { id: 'B2', evidence: '庙祝不答' },
          { id: 'B3', evidence: '旧档中间缺了几页' },
          { id: 'B4', evidence: '县衙后门抬出一口箱子' },
        ],
        missing: [],
        weak: [],
        hookPresent: true,
        chapterGoalMet: true,
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const beforeBrief = fakeModel.briefCalls.length;
  const events = await chat('按大纲写这一章', { workId, chapterId });

  const briefCall = fakeModel.briefCalls[beforeBrief];
  assert.ok(briefCall, '规划前应先跑一次分场 brief');
  assert.match(String(briefCall.messages[0].content), /MAGIC-大纲/);
  assert.match(String(briefCall.messages[1].content), /分场 brief/);

  const planCall = fakeModel.calls[before];
  assert.match(String(planCall.messages[0].content), /本章分场 brief/);
  assert.match(String(planCall.messages[0].content), /交出随身信物/);

  // 覆盖齐全，不应多排一次：紧接规划的是第一组，而不是第二版规划。
  const writerCall = fakeModel.calls[before + 1];
  assert.strictEqual(writerCall.max_tokens, 10000);
  const writerSystem = String(writerCall.messages[0].content || '');
  assert.match(writerSystem, /本章分场 brief/);
  assert.match(writerSystem, /\[loss\] 交出随身信物/);

  const groupInstruction = String(
    writerCall.messages[writerCall.messages.length - 1].content || ''
  );
  assert.match(groupInstruction, /本章不可逆约束/);
  assert.match(groupInstruction, /必须到场：庙祝到场并当面拦门/);
  assert.match(groupInstruction, /不得解释（必须 withhold）：不得解释照片上的人是谁/);
  assert.ok(!groupInstruction.split('- 建议')[0].includes('主簿可能提前离场'));

  const action = events.find((e) => e.type === 'action');
  assert.strictEqual(action.briefCoverage.hardTotal, 3);
  assert.deepStrictEqual(action.briefCoverage.missing, []);
  assert.ok(action.planBrief && action.planBrief.items.length >= 3);
});

test('缺拍触发一次重写：重写后仍缺只标注，不再重写第二次', async () => {
  const { workId, chapterId } = await seedChapter({ outline: '主角进庙查旧案。' });

  fakeModel.setQueue([
    // 1. 规划
    { content: validPlanJson(), finishReason: 'stop' },
    // 2. 第一组（B1–B2）
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第一组'),
        reason: '按节拍表写第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    // 3. 第二组（B3–B4）
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组'),
        reason: '按节拍表写第二组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    // 4. 自检：缺 B4
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '第一组：进庙' },
          { id: 'B2', evidence: '第一组：冲突' },
          { id: 'B3', evidence: '第二组：旧档缺页' },
        ],
        missing: ['B4'],
        weak: [],
        hookPresent: true,
        chapterGoalMet: false,
      }),
      finishReason: 'stop',
    },
    // 5. 只重写缺拍所在的第二组
    {
      content: JSON.stringify({
        action: 'append',
        content: '重写版：补上了照片被取走的那一拍。\n\n' + segmentBody('第二组重写', '章末抬出一口箱子。'),
        reason: '补写缺失节拍',
        citations: [],
      }),
      finishReason: 'stop',
    },
    // 6. 复核：仍缺 B4
    {
      content: JSON.stringify({
        covered: [
          { id: 'B1', evidence: '第一组：进庙' },
          { id: 'B2', evidence: '第一组：冲突' },
          { id: 'B3', evidence: '重写版：旧档缺页' },
        ],
        missing: ['B4'],
        weak: [],
        hookPresent: true,
        chapterGoalMet: false,
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('写这一章', { workId, chapterId });

  assert.strictEqual(
    fakeModel.calls.length - before,
    6,
    '规划 + 两组起稿 + 自检 + 分组重写 + 复核；重写只能一次'
  );

  const rewriteCall = fakeModel.calls[before + 4];
  const rewriteInstruction = String(rewriteCall.messages[rewriteCall.messages.length - 1].content || '');
  assert.match(rewriteInstruction, /B4/, '重写指令必须明确点名缺失的拍');
  assert.match(rewriteInstruction, /确认照片上的人是谁/, '要说明该拍的目标');
  assert.match(rewriteInstruction, /只重写这一组/, '缺拍只重写对应组');
  assert.match(rewriteInstruction, /不要整章重来/);

  const action = events.find((e) => e.type === 'action');
  assert.ok(action);
  assert.match(action.content, /重写版/, '作者拿到的是重写后的版本');
  assert.match(action.content, /第一组第1段/, '没有缺拍的组必须原样保留');
  assert.match(action.content, /章末抬出一口箱子/);
  assert.match(action.reason, /重写后仍缺 B4/, '仍缺拍时要在可见处标明');
  assert.deepStrictEqual(action.beatCheck.missing, ['B4'], '报告以复核结果为准');
  assert.strictEqual(
    events.filter((e) => e.type === 'agent_thinking').some((e) => /正在重写缺少节拍的组/.test(e.label)),
    true,
    '重写过程要给作者一个进度信号'
  );
});

test('规划两次都不合格时降级直写，不阻塞这一轮起稿', async () => {
  const { workId, chapterId } = await seedChapter({ outline: '主角进庙查旧案。' });

  fakeModel.setQueue([
    // 1–2. 规划两次都缺字段
    { content: JSON.stringify({ beats: [] }), finishReason: 'stop' },
    { content: JSON.stringify({ chapterGoal: '只有目标，没有节拍' }), finishReason: 'stop' },
    // 3. 直写
    {
      content: JSON.stringify({
        action: 'append',
        content: '没有节拍表，也照样把这一章写出来。',
        reason: '直写',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('写这一章', { workId, chapterId });

  assert.strictEqual(
    fakeModel.calls.length - before,
    3,
    '规划失败后直接写作，既不重试第三次，也不跑覆盖自检'
  );

  const writerCall = fakeModel.calls[before + 2];
  assert.strictEqual(writerCall.stream, true, '第三通请求应当是写手的流式请求');
  assert.ok(
    !String(writerCall.messages[0].content).includes('本章节拍表'),
    '降级后不能把一份不存在的节拍表交给写手'
  );

  const notice = events.find((e) => e.type === 'notice' && /未规划/.test(e.content));
  assert.ok(notice, '作者要能看见这一轮没有规划');

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '规划降级不能把整轮起稿拖挂');
  assert.match(action.content, /照样把这一章写出来/);
  assert.strictEqual(action.planDegraded, 'invalid', '降级原因要能追溯');
  assert.strictEqual(action.beatCheck, null, '没有节拍表就不该有覆盖报告');
  assert.doesNotMatch(action.reason, /编排自检/, '没有规划时不该挂自检徽标');
});

// ---------------------------------------------------------------------------
// 审稿意见的结构化锚点
// ---------------------------------------------------------------------------

test('审稿 findings 透传到 SSE，并随消息读回', async () => {
  const review = JSON.stringify({
    action: 'comment',
    content: '问题清单：\n1. 开场信息太满。',
    reason: '开场信息太满',
    citations: [],
    findings: [
      { id: 'f1', blockId: 'b1', quote: '风雪压着庙檐', text: '开场信息太满，建议删一半。' },
      { id: 'f2', quote: '他把手按在门环上', text: '动作描写可以合并。' },
      { id: 'f3', quote: '雨落', text: '太短，应被丢弃。' },
      { id: 'f4', text: '缺 quote，应被丢弃。' },
      null,
    ],
  });
  fakeModel.setDefault({ content: review });

  const events = await chat('审一下这一章', { roleKey: 'critic' });

  const action = events.find((e) => e.type === 'action');
  assert.ok(action, '应当下发 action 事件');
  assert.ok(Array.isArray(action.findings), 'findings 必须是数组');
  assert.deepStrictEqual(
    action.findings.map((f) => f.id),
    ['f1', 'f2'],
    '少于 6 字或缺 quote 的条目要丢掉'
  );
  assert.strictEqual(action.findings[0].blockId, 'b1');
  assert.strictEqual(action.findings[1].blockId, undefined, '没给块 ID 就不带这个字段');

  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.conversationId, '需要会话 id 才能读回消息');

  const res = await server.request(`/api/ai/conversations/${done.conversationId}/messages`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  const assistant = body.messages.find((m) => m.role === 'assistant');
  assert.ok(assistant, '应当能读回审稿人的消息');
  assert.deepStrictEqual(
    assistant.findings.map((f) => f.id),
    ['f1', 'f2'],
    '落库后读回仍要带 findings'
  );
  assert.strictEqual(assistant.findings[0].quote, '风雪压着庙檐');
});

// ---------------------------------------------------------------------------
// 节拍表 → 知情边界：规划命中的事实必须进入「本章允许揭示」
// ---------------------------------------------------------------------------

/**
 * 等后台的记忆索引 / 事实抽取把假模型调用排空，
 * 避免它们抢走本轮 setQueue 的响应（会表现为规划莫名降级）。
 *
 * 不能用固定 sleep：后台任务可能在 sleep 之后才发请求。
 * 连续两次采样调用数不变才算排空。
 */
async function settleBackground() {
  let prev = -1;
  for (let i = 0; i < 12; i += 1) {
    if (fakeModel.calls.length === prev) return;
    prev = fakeModel.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** 从本轮新增调用里找写手请求（带节拍表的 system）。 */
function writerSystemFrom(before) {
  const call = fakeModel.calls
    .slice(before)
    .find((item) =>
      String(item.messages?.[0]?.content || '').includes('## 本章节拍表')
    );
  assert.ok(
    call,
    `本轮应当有一次带节拍表的写手请求；实际 ${fakeModel.calls
      .slice(before)
      .map(
        (item) =>
          `[len=${String(item.messages?.[0]?.content || '').length},hasBeat=${
            String(item.messages?.[0]?.content || '').includes('本章节拍表')
          },tail=${String(item.messages?.[0]?.content || '').slice(-50)}]`
      )
      .join(' || ')}`
  );
  return String(call.messages[0].content || '');
}

let knowledgeSeedSeq = 0;

async function seedKnowledgeChapter() {
  knowledgeSeedSeq += 1;
  const prefix = `kb${knowledgeSeedSeq}`;
  const { workId, chapterId } = await seedChapter({
    seq: 2,
    outline: 'MAGIC-大纲：主角进庙查旧案。',
  });
  await run("UPDATE works SET template = 'history_thriller' WHERE id = ?", [workId]);
  const now = new Date().toISOString();
  await run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, '', ?, ?)`,
    [`${prefix}-char`, workId, `甲${knowledgeSeedSeq}`, now, now]
  );
  return { workId, chapterId, now, prefix };
}

async function markKnown(workId, now, prefix) {
  await run(
    `INSERT INTO knowledge_matrix (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, 1, 'knows', ?)`,
    [`${prefix}-k1`, workId, `${prefix}-char`, `${prefix}-f1`, now]
  );
}

test('规划命中的事实进入知情边界，解除未规划 1 条上限', async () => {
  const { workId, chapterId, now, prefix } = await seedKnowledgeChapter();
  await run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    [
      `${prefix}-f1`,
      workId,
      '庙里供着的不是城隍像，而是一张旧照片，照片背面有模糊的字。',
      '旧照片',
      now,
      now,
    ]
  );
  await markKnown(workId, now, prefix);

  await settleBackground();
  fakeModel.setQueue(planningQueue());
  const before = fakeModel.calls.length;
  const events = await chat('按大纲写这一章', { workId, chapterId });

  // 规划成功后用 beatPlan 重建过上下文：写手请求带节拍表
  const writerSystem = writerSystemFrom(before);
  assert.match(writerSystem, /本章允许揭示（来自节拍表）/, '规划命中时应走计划模式');
  assert.match(writerSystem, /F1（B1/, '计划揭示的事实要带编号与拍号');
  assert.ok(
    !writerSystem.includes('本章未规划揭示点'),
    '规划命中时不能再出现未规划文案'
  );

  const action = events.find((e) => e.type === 'action');
  assert.strictEqual(action.planDegraded, '', '规划成功不应打降级标记');
});

test('infoGain 无法唯一匹配事实：回落 1 条上限并写明原因', async () => {
  const { workId, chapterId, now, prefix } = await seedKnowledgeChapter();
  // 两条事实共用同一个关键词：B1 的 infoGain 会同时命中两条，不能猜
  for (const id of [`${prefix}-f1`, `${prefix}-f2`]) {
    await run(
      `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
       VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
      [id, workId, `旧照片相关的秘密：${id}`, '旧照片', now, now]
    );
  }
  await markKnown(workId, now, prefix);

  await settleBackground();
  fakeModel.setQueue(planningQueue());
  const before = fakeModel.calls.length;
  await chat('按大纲写这一章', { workId, chapterId });

  const writerSystem = writerSystemFrom(before);
  assert.match(writerSystem, /本章允许揭示（未规划模式）/, '匹配不唯一时必须回落');
  assert.match(
    writerSystem,
    /规划中的揭示点无法唯一匹配到事实，本章维持保守上限/,
    '回落原因要明确写进注入块，不能静默'
  );
  assert.doesNotMatch(writerSystem, /来自节拍表/);
  assert.doesNotMatch(writerSystem, /F1（B1|F2（B1/, '歧义时一条都不能放行');
});

test('规划失败降级：知情边界回到未规划 1 条，system 不出现节拍表', async () => {
  const { workId, chapterId, now, prefix } = await seedKnowledgeChapter();
  await run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    [
      `${prefix}-f1`,
      workId,
      '庙里供着的不是城隍像，而是一张旧照片，照片背面有模糊的字。',
      '旧照片',
      now,
      now,
    ]
  );
  await markKnown(workId, now, prefix);

  await settleBackground();
  fakeModel.setQueue([
    { content: '{"beats":[]}', finishReason: 'stop' },
    { content: '{"beats":[]}', finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '他推门进庙，先看见供桌上的一层灰。',
        reason: '规划失败，按直写处理',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('直接写这一段', { workId, chapterId });

  const writerCall = fakeModel.calls
    .slice(before)
    .find((item) =>
      String(item.messages?.[0]?.content || '').includes('本章允许揭示（未规划模式）')
    );
  assert.ok(writerCall, '规划失败后写手仍应拿到知情边界');
  const writerSystem = String(writerCall.messages[0].content || '');
  assert.match(writerSystem, /本章未规划揭示点/, '降级后维持保守上限');
  assert.doesNotMatch(writerSystem, /来自节拍表/);
  assert.doesNotMatch(writerSystem, /## 本章节拍表/);

  const action = events.find((e) => e.type === 'action');
  assert.strictEqual(action.planDegraded, 'invalid', '降级标记要如实上报');
});

test('规划失败/降级/无节拍表：写手 system 与未规划基线逐字相等', async () => {
  const { workId, chapterId, now, prefix } = await seedKnowledgeChapter();
  await run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    [
      `${prefix}-f1`,
      workId,
      '庙里供着的不是城隍像，而是一张旧照片，照片背面有模糊的字。',
      '旧照片',
      now,
      now,
    ]
  );
  await markKnown(workId, now, prefix);

  const user = await get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  // 这就是「无节拍表」调用 assembleContext 得到的原行为。
  const baseline = (await assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    userId: user.id,
  })).messages[0].content;

  /** 取本轮所有与基线逐字相同的请求里最后一个（写手请求）。 */
  function writerSystem(before) {
    const calls = fakeModel.calls
      .slice(before)
      .filter((item) => String(item.messages?.[0]?.content || '') === baseline);
    assert.ok(calls.length > 0, '应当至少有一个沿用未规划基线的请求');
    return String(calls[calls.length - 1].messages[0].content || '');
  }

  // 1) 格式不合格（invalid）
  await settleBackground();
  fakeModel.setQueue([
    { content: '{"beats":[]}', finishReason: 'stop' },
    { content: '{"beats":[]}', finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '他推门进庙，先看见供桌上的一层灰。',
        reason: '规划失败，按直写处理',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);
  const beforeInvalid = fakeModel.calls.length;
  const invalidEvents = await chat('直接写这一段', { workId, chapterId });
  const invalidSystem = writerSystem(beforeInvalid);
  assert.strictEqual(invalidSystem, baseline, 'invalid 降级必须逐字回到基线 system');
  assert.strictEqual(
    invalidEvents.find((e) => e.type === 'action').planDegraded,
    'invalid'
  );

  // 2) 上游失败（failed）：规划连试两次都拿不到响应
  await settleBackground();
  fakeModel.setQueue([
    { httpStatus: 500, errorMessage: '规划上游失败' },
    { httpStatus: 500, errorMessage: '规划上游失败' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '他推门进庙，先看见供桌上的一层灰。',
        reason: '规划失败，按直写处理',
        citations: [],
      }),
      finishReason: 'stop',
    },
  ]);
  const beforeFailed = fakeModel.calls.length;
  const failedEvents = await chat('直接写这一段', { workId, chapterId });
  const failedSystem = writerSystem(beforeFailed);
  assert.strictEqual(failedSystem, baseline, '上游失败降级必须逐字回到基线 system');
  const failedReason = failedEvents.find((e) => e.type === 'action').planDegraded;
  assert.ok(failedReason, '上游失败要如实上报降级原因');

  console.log(
    '[fallback] baseline 长度 =',
    baseline.length,
    '；格式不合格 system 逐字相等 =',
    invalidSystem === baseline,
    '；上游失败 system 逐字相等 =',
    failedSystem === baseline,
    '；降级原因 =',
    JSON.stringify(failedReason)
  );
});

// ---------------------------------------------------------------------------
// 主角首次出场：背景事实缺项 → beatCheck 标出 → 重写一次 → 仍缺打徽标
// ---------------------------------------------------------------------------

test('没有任何背景事实：首次出场章 beatCheck 标出尚未入库，且不逼写手编造', async () => {
  const { workId, chapterId } = await seedChapter({ outline: '主角进庙查旧案。' });
  const db = require('../database');

  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, role, created_at, modified_at)
     VALUES (?, ?, '主角', '', '主角', ?, ?)`,
    [`char-missing-${workId}`, workId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );

  const coveredCheck = JSON.stringify({
    covered: [
      { id: 'B1', evidence: '庙门半掩' },
      { id: 'B2', evidence: '庙祝不答' },
      { id: 'B3', evidence: '旧档中间缺了几页' },
      { id: 'B4', evidence: '县衙后门抬出一口箱子' },
    ],
    missing: [],
    weak: [],
    hookPresent: true,
    chapterGoalMet: true,
  });

  // 没有重写调用：只有规划 + 两组正文 + 覆盖自检。
  fakeModel.setQueue([
    { content: validPlanJson(), finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第一组'),
        reason: '第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
        reason: '第二组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    { content: coveredCheck, finishReason: 'stop' },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('按大纲写这一章', { workId, chapterId });
  const action = events.find((e) => e.type === 'action');

  assert.strictEqual(action.beatCheck.mustRevealMissing.length, 1);
  assert.strictEqual(action.beatCheck.mustRevealMissing[0].notIngested, true);
  assert.match(action.beatCheck.mustRevealMissing[0].content, /尚未入库/);
  assert.match(action.reason, /【背景自检：未交代 主角背景事实/);
  assert.strictEqual(action.mustReveal.applicable, true);
  assert.strictEqual(fakeModel.calls.length - before, 4, '未入库不是写手能补的，不应触发重写');
});


test('首次出场缺少背景事实：beatCheck 标出、重写指令带事实、仍缺打徽标', async () => {
  const { workId, chapterId } = await seedChapter({ outline: '主角进庙查旧案。' });
  const db = require('../database');

  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, role, created_at, modified_at)
     VALUES (?, ?, '主角', '', '主角', ?, ?)`,
    [`char-reveal-${workId}`, workId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );
  await db.run(
    `INSERT INTO story_facts
       (id, work_id, secret_id, part_no, content, keywords, fact_type, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '主角今年十四岁', '十四岁', 'background', ?, ?)`,
    [`fact-reveal-${workId}`, workId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']
  );

  const coveredCheck = JSON.stringify({
    covered: [
      { id: 'B1', evidence: '庙门半掩' },
      { id: 'B2', evidence: '庙祝不答' },
      { id: 'B3', evidence: '旧档中间缺了几页' },
      { id: 'B4', evidence: '县衙后门抬出一口箱子' },
    ],
    missing: [],
    weak: [],
    hookPresent: true,
    chapterGoalMet: true,
  });

  fakeModel.setQueue([
    { content: validPlanJson(), finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第一组'),
        reason: '第一组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    {
      content: JSON.stringify({
        action: 'append',
        content: segmentBody('第二组', '县衙后门当晚抬出一口箱子。'),
        reason: '第二组',
        citations: [],
      }),
      finishReason: 'stop',
    },
    { content: coveredCheck, finishReason: 'stop' },
    {
      content: JSON.stringify({
        action: 'append',
        content: '他进庙时只说了一句“庙祝昨夜不在”，便再无别话。',
        reason: '补背景',
        citations: [],
      }),
      finishReason: 'stop',
    },
    { content: coveredCheck, finishReason: 'stop' },
  ]);

  const before = fakeModel.calls.length;
  const events = await chat('按大纲写这一章', { workId, chapterId });
  const action = events.find((e) => e.type === 'action');

  assert.strictEqual(action.beatCheck.mustRevealMissing.length, 1, 'beatCheck 必须标出缺的背景事实');
  assert.match(action.beatCheck.mustRevealMissing[0].content, /十四岁/);
  assert.match(action.reason, /【背景自检：未交代 主角今年十四岁】/);
  assert.strictEqual(action.mustReveal.applicable, true);
  assert.strictEqual(action.mustReveal.protagonist, '主角');

  const rewriteCall = fakeModel.calls[before + 4];
  const instruction = String(rewriteCall.messages[rewriteCall.messages.length - 1].content || '');
  assert.match(instruction, /必须交代的背景事实/);
  assert.match(instruction, /主角今年十四岁/);
});


