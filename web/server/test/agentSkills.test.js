'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const { runAgentLoop, detectAction } = require('../services/agent/loop');
const { ready, close } = require('../database');
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