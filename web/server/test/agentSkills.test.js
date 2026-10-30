'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const { runAgentLoop, detectAction } = require('../services/agent/loop');
const { ready, close, run } = require('../database');
const skills = require('../services/skills');
const { assembleContext } = require('../services/context');

/**
 * 假 provider：按次序返回预设的模型输出。
 * @param {Array<{content: string}>} turns
 */
function fakeProvider(turns) {
  let i = 0;
  return {
    async chatStream({ messages, onToken }) {
      const turn = turns[i++] || { content: '' };
      for (const piece of turn.chunks || [turn.content]) {
        if (piece) onToken(piece);
      }
      return { content: turn.content || '', reasoning: '', finishReason: 'stop' };
    },
  };
}

test('detectAction 识别 call_tool 与正常 action', () => {
  assert.strictEqual(detectAction('{"action":"call_tool","tool":"x"}'), 'call_tool');
  assert.strictEqual(detectAction('{"action":"comment","content":"x"}'), 'other');
  // 转义过的引号 → 正文里的字面量，不算 action
  assert.strictEqual(detectAction('{"content":"他说\\"action\\":\\"call_tool\\""}'), null);
  assert.strictEqual(detectAction('{"content":"还没有 action 字段"}'), null);
});

test('工具轮次的 token 一个都不下发', async () => {
  const chunks = [];
  await runAgentLoop({
    provider: fakeProvider([
      { content: '{"action":"call_tool","tool":"noop","params":{}}' },
      { content: '{"action":"comment","content":"好了"}' },
    ]),
    messages: [{ role: 'user', content: '查一下' }],
    onToken: (t) => chunks.push(t),
  });

  const joined = chunks.join('');
  assert.ok(!joined.includes('call_tool'), '工具轮次的 JSON 不能下发');
  assert.ok(joined.includes('好了'), '最终回答轮要正常下发');
});

test('正文里提到 call_tool 字样时，内容仍要完整下发', async () => {
  // 模型输出的是散文，正文里恰好出现了 "action":"call_tool" 这串字符。
  // 缓冲区扫描会把它当成工具轮而停止下发——但最终解析出来不是工具调用，
  // 所以内容必须**补发完整**，而不是半截。
  // 这条守的是「判定为工具轮后继续攒 buffer、只是不下发」那个设计。
  const content = '他说 "action":"call_tool" 这个写法在正文里出现过。';
  const chunks = [];
  await runAgentLoop({
    provider: {
      async chatStream({ onToken }) {
        for (const piece of ['他说 "action":"call_tool" ', '这个写法在正文里出现过。']) {
          onToken(piece);
        }
        return { content, reasoning: '', finishReason: 'stop' };
      },
    },
    messages: [{ role: 'user', content: '讲讲' }],
    onToken: (t) => chunks.push(t),
  });

  assert.strictEqual(chunks.join(''), content, '内容必须完整下发，不能是半截');
});

test('技能不存在时不中断，错误被喂回模型', async () => {
  // 记下**第二轮**收到的 messages——错误必须出现在里面，
  // 否则模型根本不知道技能没跑起来，就会自己编一个结论。
  const rounds = [];
  let callNo = 0;
  await runAgentLoop({
    provider: {
      async chatStream({ messages, onToken }) {
        callNo += 1;
        rounds.push(messages);
        const content = callNo === 1
          ? '{"action":"call_tool","tool":"根本没有这个技能"}'
          : '{"action":"comment","content":"我查不了"}';
        onToken(content);
        return { content, reasoning: '', finishReason: 'stop' };
      },
    },
    messages: [{ role: 'user', content: '查一下' }],
    onToken: () => {},
  });

  assert.strictEqual(rounds.length, 2, '应当跑了两轮');
  const fed = rounds[1][rounds[1].length - 1];
  assert.strictEqual(fed.role, 'user');
  assert.match(fed.content, /工具结果/, '要把工具结果喂回模型');
  assert.match(fed.content, /失败|没有/, '要说明技能没跑起来');
});

test('技能抛错时错误被喂回模型，整轮对话不中断', async () => {
  const unregister = skills.register({
    name: 'boom_skill',
    label: '会炸的技能',
    description: '测试用：执行时必定抛错。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => {
      throw new Error('技能内部炸了');
    },
  });

  try {
    const rounds = [];
    const errors = [];
    let callNo = 0;

    const result = await runAgentLoop({
      provider: {
        async chatStream({ messages, onToken }) {
          callNo += 1;
          rounds.push(messages);
          const content = callNo === 1
            ? '{"action":"call_tool","tool":"boom_skill"}'
            : '{"action":"comment","content":"这个技能跑不起来"}';
          onToken(content);
          return { content, reasoning: '', finishReason: 'stop' };
        },
      },
      messages: [{ role: 'user', content: '查一下' }],
      onToken: () => {},
      onToolError: ({ error }) => errors.push(error),
    });

    assert.strictEqual(rounds.length, 2, '应当跑了两轮');
    assert.strictEqual(errors.length, 1, '工具失败要回调一次');
    assert.match(errors[0], /技能内部炸了/);

    const fed = rounds[1][rounds[1].length - 1];
    assert.strictEqual(fed.role, 'user');
    assert.match(fed.content, /工具结果/, '要把工具结果喂回模型');
    assert.match(fed.content, /执行失败/, '要说明技能没跑起来');
    assert.match(fed.content, /技能内部炸了/, '要把原始错误带回去');

    assert.strictEqual(result.parsed.action, 'comment', '模型仍能给出最终回答');
  } finally {
    unregister();
  }
});

test('模型连续要技能超过 maxSteps 时停下并抛 MAX_STEPS', async () => {
  const unregister = skills.register({
    name: 'noop_skill',
    label: '空技能',
    description: '测试用：只返回空结果。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: async () => ({ label: '空技能', summary: '', detail: [], findings: [] }),
  });

  try {
    let calls = 0;
    const err = await runAgentLoop({
      provider: {
        async chatStream({ onToken }) {
          calls += 1;
          const content = '{"action":"call_tool","tool":"noop_skill"}';
          onToken(content);
          return { content, reasoning: '', finishReason: 'stop' };
        },
      },
      messages: [{ role: 'user', content: '一直查' }],
      onToken: () => {},
      maxSteps: 3,
    }).then(() => null, (e) => e);

    assert.ok(err, '用尽步数必须抛错，不能静默停在一半');
    assert.strictEqual(err.code, 'MAX_STEPS');
    assert.strictEqual(calls, 3, '不该超过 maxSteps 次模型调用');
  } finally {
    unregister();
  }
});

test('技能清单注入到 system prompt 末尾，行内操作不注入', async () => {
  const unregister = skills.register({
    name: 'audit_foreshadowing',
    label: '伏笔盘点',
    description: '检查全书里已经埋下但没有回收的伏笔。',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: '要查的伏笔关键词' } },
      required: [],
    },
    run: async () => ({}),
  });

  try {
    const chat = await assembleContext({ userId: 'u1', roleKey: 'writer', scope: 'chapter' });
    const sys = chat.messages[0].content;

    assert.ok(sys.includes('## 可用技能'), '侧边栏对话要注入技能清单');
    assert.ok(sys.includes('audit_foreshadowing'), '要列出技能名');
    assert.ok(sys.includes('"action":"call_tool"'), '要给出调用示例');
    // 角色提示词已经规定了 action 的取值范围，技能段必须在其之后
    // 才不会被前面的白名单盖掉。
    assert.ok(
      sys.indexOf('## 可用技能') > sys.indexOf('## 输出格式'),
      '技能段必须在角色提示词之后'
    );

    const inline = await assembleContext({ userId: 'u1', roleKey: 'writer', scope: 'inline' });
    assert.ok(
      !inline.messages[0].content.includes('## 可用技能'),
      '行内操作不做跨章查询，不该塞技能清单'
    );
  } finally {
    unregister();
  }
});

test('模型只吐空白时不下发 token，原文留给上层判定', async () => {
  // JSON 模式在长上下文下会退化成只输出空格和换行。
  // 这些字符上屏看不见，却会让"这一轮到底有没有内容"变得难以判断。
  const tokens = [];
  const result = await runAgentLoop({
    provider: {
      async chatStream({ onToken }) {
        onToken('          \n\n');
        onToken('        ');
        return {
          content: '          \n\n        ',
          reasoning: '',
          finishReason: 'stop',
          usage: null,
        };
      },
    },
    messages: [{ role: 'user', content: 'hi' }],
    onToken: (t) => tokens.push(t),
  });

  assert.strictEqual(tokens.length, 0, '纯空白不该推给前端');
  assert.strictEqual(result.parsed, null);
  assert.strictEqual(result.raw.trim(), '', '原文要保留，让路由据此判空并重试');
});

test('正常结束时标记 stopReason=final，并累计各轮 usage', async () => {
  const result = await runAgentLoop({
    provider: {
      async chatStream({ onToken }) {
        const content = '{"action":"comment","content":"好"}';
        onToken(content);
        return {
          content,
          reasoning: '',
          finishReason: 'stop',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    },
    messages: [{ role: 'user', content: 'hi' }],
    onToken: () => {},
  });

  assert.strictEqual(result.stopReason, 'final');
  assert.deepStrictEqual(result.usage, {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });
});

test('技能参数不合规时直接返回错误，不执行技能', async () => {
  let called = 0;
  const unregister = skills.register({
    name: 'param_skill',
    label: '参数校验技能',
    description: '测试用：要求必填的 count。',
    parameters: {
      type: 'object',
      properties: { count: { type: 'number' } },
      required: ['count'],
    },
    run: async () => {
      called += 1;
      return { label: '参数校验技能', summary: '', detail: [], findings: [] };
    },
  });

  try {
    const missing = await skills.runSkill('param_skill', {}, {});
    assert.strictEqual(missing.ok, false);
    assert.match(missing.error, /count/);

    const wrongType = await skills.runSkill('param_skill', { count: { n: 1 } }, {});
    assert.strictEqual(wrongType.ok, false);

    // 模型常把数字写成字符串，这种要放行
    const asString = await skills.runSkill('param_skill', { count: '3' }, {});
    assert.strictEqual(asString.ok, true);
    assert.strictEqual(called, 1, '只有合规的那次真正执行了技能');
  } finally {
    unregister();
  }
});

test('技能超时被转成工具错误，不拖住整轮对话', async () => {
  const unregister = skills.register({
    name: 'slow_skill',
    label: '慢技能',
    description: '测试用：永远不返回。',
    parameters: { type: 'object', properties: {}, required: [] },
    run: () => new Promise(() => {}),
  });

  try {
    const outcome = await skills.runSkill('slow_skill', {}, { timeoutMs: 30 });
    assert.strictEqual(outcome.ok, false);
    assert.match(outcome.error, /超时/);
  } finally {
    unregister();
  }
});

test('一致性核对技能：能报出未登场的人物', async () => {
  await ready;

  const now = new Date().toISOString();
  const userId = (await createUser()).id;
  const workId = 'work-consistency';

  await run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '一致性测试', now, now]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, 1, '', 'draft', ?, '[]', '', 0, ?, ?)`,
    ['ch-consistency', workId, '第一章', '正文里只提到陈默。', now, now]
  );
  await run(
    `INSERT INTO characters (id, work_id, name, aliases, role, identity, personality, speech, goal, arc, relations, notes, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', '', '', '', '', '', '', ?, ?)`,
    ['char-consistency', workId, '从未露面的人', now, now]
  );

  const outcome = await skills.runSkill('check_consistency', {}, { userId, workId });
  assert.strictEqual(outcome.ok, true);
  assert.match(outcome.result.summary, /1 处/);
  assert.ok(
    outcome.result.findings.some((f) => f.type === 'unused_character'),
    '未登场的人物要被报出来'
  );

  // 别人的作品查不到
  const other = await skills.runSkill('check_consistency', {}, { userId: 'someone-else', workId });
  assert.match(other.result.summary, /没有找到要查的作品/);
});

// 库初始化要放在 before 钩子里，不能塞进某个测试体。
//
// database.js 在模块加载时就异步开始建表，它的 console.log 会打进测试的
// TAP 输出流。如果初始化日志落在测试用例之间，Node 的测试运行器会把这
// 段输出当成损坏的帧，整个文件报 "Unable to deserialize cloned data"。
// before 钩子在任何用例之前跑完，日志就落在文件头，不会插到用例中间。
test.before(async () => {
  await ready;
});

test.after(async () => {
  // 先关库再删目录：连接开着的时候删库文件，
  // sqlite 的收尾读写会打到一个已经没了的路径上。
  await close().catch(() => {});
  env.cleanup();
});