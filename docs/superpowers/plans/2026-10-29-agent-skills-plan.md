# Agent 技能体系（工具调用）实施计划

> **依据**：[设计文档](../specs/2026-10-29-agent-skills-design.md)（已评审，含代码审查后的 6 条修订）
>
> **执行方式**：按 Task 顺序逐个实现，每个 Task 结束跑一次 `cd web/server && npm test`，全绿再进下一个 Task。

**Goal:** 让作者在对话框里正常提问，AI 自己判断该去查什么（本期：伏笔回收盘点），把「查了什么」以折叠过程条呈现，「查到了什么」直接写在回复里。作者全程无感，不学新概念、不点新按钮。

**Architecture:** 后端新增三个模块 —— `services/agent/parse.js`（模型原文解析）、`services/agent/loop.js`（多步循环 + token 延迟推送）、`services/skills/`（技能注册表与实现）。`routes/ai.js` 改为编排层：装配上下文 → 调 loop → 归一化 → 落库 → 下发 SSE。协议沿用现有 JSON 契约，新增 `action: "call_tool"` 一种取值。

**Tech Stack:** Node.js 18 + Express + better-sqlite3 风格封装（`web/server`），React 18 + Vite（`web/client`）。**零新增运行时依赖**——不引入任何 harness 框架、不做原生 function calling、不加中文分词库。

**不做什么（本期明确排除）：** 不引入 harness 框架；不做原生 `tool_calls` 协议；不做多 agent 编排与沙箱；不做「AI 主动写回正文」；不做全书定时巡检；不做跨作品查询；不做对话历史持久化。

---

## 文件结构

```
web/server/
├── services/
│   ├── agent/
│   │   ├── parse.js                  # 新建：模型原文 → 结构化对象（纯函数）
│   │   └── loop.js                   # 新建：多步循环 + token 延迟推送
│   ├── skills/
│   │   ├── index.js                  # 新建：技能注册表（列技能 / 按名取 / 执行）
│   │   └── auditForeshadowing.js     # 新建：伏笔盘点技能（本期唯一）
│   ├── context.js                    # 改：注入「可用技能」到 system prompt（仅 chat）
│   └── providers/                    # 不动
├── routes/
│   └── ai.js                         # 改：接 loop、token 延迟推送、3 个 SSE 事件
└── test/
    ├── fakeModel.js                  # 新建：从 aiChat.test.js 提取的假模型服务
    ├── agentSkills.test.js           # 新建：循环与注册表的纯逻辑单元测试
    ├── agentLoop.test.js             # 新建：多步循环的 HTTP 集成测试
    └── auditForeshadowing.test.js    # 新建：伏笔盘点技能的单元测试

web/client/src/
├── components/Assistant/
│   ├── ToolPanel.jsx                 # 新建：折叠式过程条
│   ├── MessageList.jsx               # 改：挂载 ToolPanel（在记忆面板上方）
│   └── Sidebar.jsx                   # 改：处理 3 个新 SSE 事件
└── styles/theme.css                  # 改：.ct-tool 系列样式
```

**模块边界（不越界）：**

| 模块 | 职责 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| `agent/parse.js` | 解析模型原文 | 无 | 其它一切 |
| `agent/loop.js` | 驱动多步循环、识别 `call_tool`、喂回结果 | provider、`skills/index.js`、`agent/parse.js`、回调 | **直接**碰数据库 / HTTP / Express |
| `skills/index.js` | 注册表：列技能 / 按名取 / 执行 | 各技能模块 | provider、HTTP |
| `skills/auditForeshadowing.js` | 伏笔盘点 | database、plotCards、provider（内部判定用） | Express |
| `context.js` | 追加「可用技能」到 system prompt | `skills/index.js` | — |
| `routes/ai.js` | 编排：装配 → 调 loop → 归一化 → 落库 → SSE | context、agent/loop、database | — |

> **一条必须知道的传递依赖**：`skills/index.js` 为了注册技能，会 `require` 各技能模块；
> 技能模块要读数据库，于是 `database.js` 会被**间接**加载。
> 而 `database.js` 在**模块加载时**就打开了 SQLite 连接（`new sqlite3.Database(config.dbPath)`），
> 连接路径来自 `process.env.DATA_DIR`。
>
> 后果：**任何 `require` 到 `skills/index.js` 的代码（包括 `agent/loop.js` 和 `context.js`），
> 都必须在设好 `DATA_DIR` 之后才加载。** 测试里忘了这一步，
> 就会在真实数据目录 `web/data/` 下开出一个 `curiosity.db`——
> 测试污染生产数据，而且不留痕迹。
>
> 所以：凡是 `require` 了 `loop.js` / `skills` / `context.js` 的测试文件，
> `setupTempEnv()` 必须排在这些 require **之前**（见 Task 2 Step 3）。

---

## Task 1：提取 `services/agent/parse.js`

**Files:**
- Create: `web/server/services/agent/parse.js`
- Modify: `web/server/routes/ai.js`（删除本地 `parseModelJson`，改为引用）

- [ ] **Step 1: 新建 `web/server/services/agent/parse.js`**

把 `routes/ai.js` 第 36–62 行的 `parseModelJson` 原样搬过来，按纯函数导出。**不改变任何行为**——围栏剥离正则与「截取首个 `{` 到末个 `}`」兜底逐字保留。

```js
'use strict';

/**
 * 模型输出的解析。
 *
 * 从 routes/ai.js 搬出来的独立模块：循环层（services/agent/loop.js）
 * 也要用它，而路由文件只导出 router，循环层引用不到路由里的私有函数。
 *
 * 纯函数：不碰数据库、不碰 HTTP，输入模型原文，输出结构化对象或 null。
 */

/**
 * 解析模型的 JSON 输出。
 * 模型可能返回带 markdown 代码块的 JSON，需要剥掉。
 *
 * @param {string} text 模型原文
 * @returns {Object|null}
 */
function parseModelJson(text) {
  if (!text) return null;

  let candidate = text.trim();

  // 剥掉 ```json ... ``` 包裹
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    candidate = fence[1].trim();
  }

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // 退而求其次：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { parseModelJson };
```

- [ ] **Step 2: `routes/ai.js` 改为引用**

删除第 32–62 行（`parseModelJson` 的注释块与函数体），在文件顶部 require 区加：

```js
const { parseModelJson } = require('../services/agent/parse');
```

- [ ] **Step 3: 验证**

```bash
cd web/server && npm test
```

Expected: 全部测试通过（`aiChat.test.js` 覆盖了 `parseModelJson` 的两条路径：正常 JSON、非 JSON 兜底）。

- [ ] **Step 4: 提交**

```bash
git add web/server/services/agent/parse.js web/server/routes/ai.js
git commit -m "refactor(agent): 把 parseModelJson 抽成独立模块，循环层要用"
```

---

## Task 2：技能注册表 + 多步循环骨架

**Files:**
- Create: `web/server/services/skills/index.js`
- Create: `web/server/services/agent/loop.js`
- Create: `web/server/test/agentSkills.test.js`

- [ ] **Step 1: 新建 `web/server/services/skills/index.js`**

注册表只做三件事：列技能、按名取、执行。技能自己 `register` 进来——以后加技能只改这一个文件。

```js
'use strict';

/**
 * 技能注册表。
 *
 * 一个技能就是一个对象：{ name, label, description, parameters, run }。
 * 字段形状与 OpenAI function schema 对齐，将来要换原生 function calling，
 * 只换传输层，技能代码一行不改。
 *
 * 注册而不是写死数组，是为了让测试能塞进自己的技能
 * （比如一个必定抛错的技能，用来验证错误路径）。
 */

/** 已注册的技能 */
const REGISTRY = new Map();

/**
 * 注册一个技能。
 *
 * @param {Object} skill
 * @param {string} skill.name 唯一标识，模型用它来调用
 * @param {string} skill.label 中文名，显示给作者看
 * @param {string} skill.description 何时该用它，写给模型看
 * @param {Object} skill.parameters OpenAI function schema 形状
 * @param {Function} skill.run 执行体，签名 (params, ctx) => Promise<Object>
 * @returns {Function} 反注册函数
 */
function register(skill) {
  if (!skill || !skill.name) {
    throw new Error('技能必须有 name');
  }
  REGISTRY.set(skill.name, skill);
  return () => REGISTRY.delete(skill.name);
}

/**
 * 列出全部技能（给提示词用）。
 * @returns {Array<Object>}
 */
function listSkills() {
  return Array.from(REGISTRY.values()).map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    parameters: s.parameters || { type: 'object', properties: {}, required: [] },
  }));
}

/**
 * 按名取技能。
 * @param {string} name
 * @returns {Object|null}
 */
function getSkill(name) {
  return REGISTRY.get(name) || null;
}

/**
 * 执行技能。
 *
 * 技能不存在与技能抛错都**不抛出去**：调用方（loop.js）要能把错误
 * 当作工具结果喂回模型，让模型自己向作者解释，而不是让整轮对话崩掉。
 *
 * @param {string} name
 * @param {Object} params
 * @param {Object} ctx
 * @returns {Promise<{ok: boolean, result?: Object, error?: string}>}
 */
async function runSkill(name, params, ctx) {
  const skill = getSkill(name);
  if (!skill) {
    return { ok: false, error: `没有名为「${name}」的技能` };
  }
  try {
    const result = await skill.run(params || {}, ctx || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { register, listSkills, getSkill, runSkill, REGISTRY };
```

- [ ] **Step 2: 新建 `web/server/services/agent/loop.js`**

多步循环 + **token 延迟推送**（这是「用户无感」的硬保证：工具轮次的 JSON 片段一个字符都不许下发）。

```js
'use strict';

/**
 * Agent 多步循环。
 *
 * 模型可以要求调用技能，技能结果再喂回模型，模型据此给出最终回答。
 *
 * 关键约束：**纯逻辑**。不碰数据库、不碰 HTTP、不认识 Express。
 * 数据从参数进，回调出。这样它能单独测——喂一个假 provider 就能跑完整循环。
 *
 * token 延迟推送（无感的硬保证）：
 *   工具轮次模型输出的是 {"action":"call_tool",...} 这种 JSON 片段。
 *   照常下发的话，作者会看到一堆 JSON 噪音，「无感」直接破功。
 *   所以每一轮自带缓冲区：判定为工具轮就整轮丢弃，判定为正常轮才放行。
 */

const { parseModelJson } = require('./parse');
const skills = require('../skills');

/** 最多几轮模型调用 */
const DEFAULT_MAX_STEPS = 4;

/**
 * 判定缓冲区里的 action 取值。
 *
 * 模型不保证把 action 放在第一个键，所以整段扫描。
 * 但正文里可能出现字面量 "action":"xxx"，那是转义过的（\"action\"），
 * 要求匹配到的引号未被转义，否则正文会被误判成工具调用。
 *
 * @param {string} text
 * @returns {'call_tool'|'other'|null} null = 还判不出来
 */
function detectAction(text) {
  const re = /"action"\s*:\s*"([a-z_]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 匹配起点前一个字符是反斜杠 → 引号被转义 → 是正文里的字面量
    if (m.index > 0 && text[m.index - 1] === '\\') continue;
    return m[1] === 'call_tool' ? 'call_tool' : 'other';
  }
  return null;
}

/**
 * 跑一轮模型调用。
 *
 * @returns {Promise<{raw: string, parsed: Object|null, finishReason: string}>}
 */
async function runRound({ provider, messages, options, onToken }) {
  let raw = '';         // 完整原文，用于解析
  let buffer = '';      // 展示缓冲，用于延迟推送
  let released = false; // 缓冲是否已放行
  let suppressed = false; // 是否判定为工具轮（停止下发）
  let reasoning = '';   // 本轮思考内容

  const emit = (text) => {
    if (text) onToken(text);
  };

  const result = await provider.chatStream({
    messages,
    ...options,
    jsonOutput: true,
    onThinking: (chunk) => {
      reasoning += chunk;
    },
    onToken: (chunk) => {
      raw += chunk;
      if (released) { emit(chunk); return; }

      buffer += chunk;
      // 判定为工具轮后**继续攒 buffer**，只是不下发。
      // 万一最终解析出来不是工具调用（模型只是正文里提到了这个字符串），
      // 补发时才能给作者完整的内容，而不是半截。
      if (suppressed) return;

      const action = detectAction(buffer);
      if (action === 'call_tool') {
        suppressed = true;
        return;
      }
      if (action === 'other') {
        released = true;
        emit(buffer);
        buffer = '';
      }
    },
  });

  const rawText = result.content || raw;
  const parsed = parseModelJson(rawText);
  const isToolCall = Boolean(parsed && parsed.action === 'call_tool');

  // 兜底：模型没按契约输出 JSON（判不出 action），也得让作者看到内容，
  // 不能留一个空气泡。反过来，解析出来确实是工具调用就整轮丢弃。
  if (!isToolCall && !released) {
    released = true;
    emit(buffer);
  }

  return { raw: rawText, parsed, finishReason: result.finishReason || '', reasoning };
}

/**
 * 驱动多步循环。
 *
 * @param {Object} params
 * @param {Object} params.provider 已解析的 provider
 * @param {Array}  params.messages 初始消息数组
 * @param {Object} [params.options] 传给 provider 的额外参数（temperature/model/thinking）
 * @param {Function} [params.onToken] 正常回复轮的 token 回调
 * @param {Function} [params.onToolStart] 技能开始执行
 * @param {Function} [params.onToolDone] 技能执行结束
 * @param {Function} [params.onToolError] 技能失败
 * @param {Object} [params.ctx] 技能的执行上下文（userId/workId/provider/...）
 * @param {number} [params.maxSteps]
 * @returns {Promise<{parsed: Object|null, raw: string, toolCalls: Array}>}
 */
async function runAgentLoop(params) {
  const {
    provider,
    messages,
    options = {},
    onToken = () => {},
    onToolStart = () => {},
    onToolDone = () => {},
    onToolError = () => {},
    ctx = {},
    maxSteps = DEFAULT_MAX_STEPS,
  } = params;

  const convo = [...messages];
  const toolCalls = [];

  for (let step = 0; step < maxSteps; step++) {
    const round = await runRound({ provider, messages: convo, options, onToken });

    const isToolCall = round.parsed && round.parsed.action === 'call_tool';

    if (!isToolCall) {
      return {
        parsed: round.parsed,
        raw: round.raw,
        finishReason: round.finishReason,
        reasoning: round.reasoning,
        toolCalls,
      };
    }

    const toolName = String(round.parsed.tool || '');
    const toolParams = round.parsed.params || {};

    // 技能的中文名从注册表取。tool_start 事件要立刻发出去，
    // 那时技能还没执行完、拿不到结果里的 label，
    // 所以标签只能来自注册表——作者看到的是「伏笔盘点」，不是「audit_foreshadowing」。
    const skill = skills.getSkill(toolName);
    onToolStart({ tool: toolName, label: (skill && skill.label) || toolName, params: toolParams });

    const outcome = await skills.runSkill(toolName, toolParams, {
      ...ctx,
      provider,
      providerName: ctx.providerName,
    });

    if (outcome.ok) {
      const result = outcome.result || {};
      toolCalls.push({ tool: toolName, label: result.label || toolName, summary: result.summary || '', degraded: !!result.degraded });
      onToolDone({ tool: toolName, result });
      // 喂回：assistant 侧保留模型原始 JSON 原文，user 侧放工具结果
      convo.push({ role: 'assistant', content: round.raw });
      convo.push({
        role: 'user',
        content: `【工具结果：${result.label || toolName}】\n${JSON.stringify(result.findings || result)}`,
      });
    } else {
      toolCalls.push({ tool: toolName, label: toolName, summary: '', degraded: false, error: outcome.error });
      onToolError({ tool: toolName, error: outcome.error });
      convo.push({ role: 'assistant', content: round.raw });
      convo.push({
        role: 'user',
        content: `【工具结果：${toolName}】执行失败：${outcome.error}。请把这件事直接告诉作者，不要重试同一个技能。`,
      });
    }
  }

  // maxSteps 用尽：连续要技能却拿不到结果。不能静默停在一半——
  // 抛出去由路由层转成可见错误并清理孤立消息。
  const err = new Error('模型反复调用技能但没有拿到结果，这次没能查完。请换个说法再问一次。');
  err.code = 'MAX_STEPS';
  throw err;
}

module.exports = { runAgentLoop, detectAction, DEFAULT_MAX_STEPS };
```

- [ ] **Step 3: 新建 `web/server/test/agentSkills.test.js`（先只测纯逻辑）**

用假 provider 直接喂循环，不起 HTTP。

> **require 顺序不能反**：`loop.js` 会 `require` 技能注册表，注册表会加载技能模块，
> 技能模块会加载 `database.js`——而 `database.js` 在模块加载时就打开了 SQLite 连接。
> `setupTempEnv()` 必须在这些 require **之前**调用，否则测试会在真实数据目录
> `web/data/` 下开出库文件。

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const { runAgentLoop, detectAction } = require('../services/agent/loop');

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
        return { content, finishReason: 'stop' };
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

test.after(() => {
  env.cleanup();
});
```

（Task 4 之后再回来补「第二次请求的 messages 末尾含【工具结果：…】」「连续 call_tool 超过 maxSteps」两条断言。）

- [ ] **Step 4: 验证**

```bash
cd web/server && npm test
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add web/server/services/skills/index.js web/server/services/agent/loop.js web/server/test/agentSkills.test.js
git commit -m "feat(agent): 技能注册表与多步循环骨架，工具轮次 token 不下发"
```

---

## Task 3：`context.js` 注入技能清单

**Files:**
- Modify: `web/server/services/context.js`

- [ ] **Step 1: 在 `assembleContext` 末尾追加「可用技能」段**

追加位置在 `systemParts.push('## 本次任务要求'...)` 之后、`messages` 组装之前——**必须在 system prompt 的末尾**，因为角色提示词已经规定了 `action` 的取值范围，追加段必须在其之后才能被看见。

在文件顶部 require 区加：

```js
const skills = require('./skills');
```

在 `assembleContext` 里，`// ---- 附加指令 ----` 之后加：

```js
  // ---- 技能清单 ----
  // 放在 system prompt 末尾：角色提示词已经规定了 action 的取值范围，
  // 追加段必须在其之后才能被模型看见。
  //
  // 只对侧边栏对话注入：行内操作（inline）不做跨章查询，
  // 给它塞技能清单只会让模型多想。
  if (scope !== 'inline') {
    const list = skills.listSkills();
    if (list.length) {
      const lines = ['## 可用技能'];
      lines.push('当你需要当前上下文之外的信息时，可以调用下面的技能。');
      lines.push('调用方式：只输出一个 JSON 对象，action 填 "call_tool"，');
      lines.push('tool 填技能名，params 填技能参数。');
      for (const s of list) {
        lines.push('');
        lines.push(`### ${s.label}（${s.name}）`);
        lines.push(`说明：${s.description}`);
        lines.push(`参数：${JSON.stringify(s.parameters)}`);
      }
      lines.push('');
      lines.push('示例：');
      lines.push(JSON.stringify({
        action: 'call_tool',
        tool: list[0].name,
        params: Object.keys(list[0].parameters.properties || {}).length
          ? { [Object.keys(list[0].parameters.properties)[0]]: '示例' }
          : {},
      }));
      systemParts.push(lines.join('\n'));
    }
  }
```

- [ ] **Step 2: 验证**

```bash
cd web/server && npm test
```

Expected: 全绿。`context.js` 的改动不影响既有行为（目前还没有技能注册，所以 `listSkills()` 为空，注入段不会出现）。

- [ ] **Step 3: 提交**

```bash
git add web/server/services/context.js
git commit -m "feat(agent): system prompt 末尾注入可用技能清单"
```

---

## Task 4：`routes/ai.js` 接循环 + 三个 SSE 事件

**Files:**
- Modify: `web/server/routes/ai.js`

这是前后端联动的关键一步：**后端不下发这三个事件，前端就无从接线**。

- [ ] **Step 1: 扩展 `normalizeAction` 的字段白名单**

第 101–134 行的 `normalizeAction` 目前只输出 `action`/`target`/`content`/`reason`/`citations` 五个字段，**未列入的字段会被静默丢弃**。工具调用摘要要写进 `payload.skills` 并落库，所以必须先把 `skills` 加进白名单。

```js
  // 工具调用摘要。技能执行结果由 loop.js 收集，通过 payload.skills 传进来。
  // 这一列必须在白名单里，否则会被静默丢弃——不报错，只是数据不见了。
  const skills = Array.isArray(payload.skills)
    ? payload.skills.map((s) => ({
        tool: String(s.tool || ''),
        label: String(s.label || ''),
        summary: String(s.summary || ''),
        degraded: Boolean(s.degraded),
      }))
    : [];

  return { action, target, content, reason, citations, skills };
```

同时在 `validActions` 里加上 `'call_tool'`——否则循环喂回结果时，工具轮次会被归一化成 `'none'`，白跑一次。

```js
  const validActions = ['replace', 'append', 'insert', 'comment', 'none', 'call_tool'];
```

- [ ] **Step 2: require 新模块**

文件顶部 require 区加：

```js
const { runAgentLoop } = require('../services/agent/loop');
```

- [ ] **Step 3: 把 `provider.chatStream` 换成 `runAgentLoop`**

替换 `routes/ai.js` 第 697–723 行（从 `// 流式输出` 到 `const payload = normalizeAction(parsed);`）。注意第 695 行的 `const role = await roles.getRole(...)` **在替换范围之外**，不要重复声明。

```js
    // 流式输出
    let fullText = '';

    // 进入循环之前先告诉作者"正在判断"。
    // 第一轮模型调用的 token 全被缓冲不下发（见 loop.js），
    // 没有这个信号，作者从发问到看到任何反馈之间只有一个不动的空占位。
    send({ type: 'agent_thinking', label: '正在判断需要查什么' });

    const toolCalls = [];

    const loopResult = await runAgentLoop({
      provider,
      messages: chatMessages,
      options: {
        temperature: role?.temperature,
        // 角色模型只在 DeepSeek 下生效——别的 provider 用的是自己的模型名，
        // 硬套 DeepSeek 的模型名会直接报"模型不存在"。
        model: role?.model && name === 'deepseek' ? role.model : undefined,
        thinking: role?.thinking === null || role?.thinking === undefined
          ? undefined
          : (role.thinking ? 'enabled' : 'disabled'),
      },
      ctx: {
        userId: req.userId,
        workId: conversation.work_id,
        providerName: name,
        degraded,
        role: roleKey,
      },
      onToken: (token) => {
        fullText += token;
        send({ type: 'token', content: token });
      },
      onToolStart: ({ tool, label }) => {
        send({ type: 'tool_start', tool, label });
      },
      onToolDone: ({ tool, result }) => {
        toolCalls.push({
          tool,
          label: result.label || tool,
          summary: result.summary || '',
          degraded: Boolean(result.degraded),
        });
        send({
          type: 'tool_done',
          tool,
          label: result.label || tool,
          summary: result.summary || '',
          detail: result.detail || [],
          degraded: Boolean(result.degraded),
        });
      },
      onToolError: ({ tool, error }) => {
        toolCalls.push({ tool, label: tool, summary: '', degraded: false });
        send({ type: 'tool_done', tool, label: tool, summary: '', detail: [], degraded: false, error });
      },
    });

    const rawText = loopResult.raw || fullText;
    const parsed = loopResult.parsed;
    const payload = normalizeAction({ ...(parsed || {}), skills: toolCalls });
```

> **`result` 变量没了**：原代码第 744 行的 `describeEmptyReply(result, reasoning)` 依赖
> provider 返回的 `result`（里面有 `finishReason`）。循环把它收进 `loopResult` 了，
> 所以那一行要改成：
>
> ```js
>       const reason = describeEmptyReply(
>         { finishReason: loopResult.finishReason },
>         loopResult.reasoning || ''
>       );
> ```
>
> `reasoning` 不再是路由里的局部变量：原来它由 `provider.chatStream` 的
> `onThinking` 回调累加，现在由 loop.js 在 `runRound` 里收集、
> 随最终轮一起回传（`loopResult.reasoning`）。
>
> 为什么不能丢掉：思考模式下「模型只做了思考没给正文」是常见失败，
> `describeEmptyReply` 靠 `reasoning` 把它和「模型什么都没给」区分开，
> 给作者两种不同的补救指引。丢了它，这两种失败会给同一句没头没尾的话。

- [ ] **Step 4: 异常路径补 maxSteps**

第 823 行的 `catch (err)` 里，现有逻辑已经会清掉孤立用户消息并下发 `error` + `done`。但 `MAX_STEPS` 要给作者一句看得懂的话。在 catch 开头加：

```js
    // 模型反复调用技能却拿不到结果：这句话要说明白，
    // 作者才知道是自己问得太绕，而不是平台坏了。
    if (err.code === 'MAX_STEPS') {
      err.message = '这次没能查完：模型反复调用技能但没有拿到结果。请换个说法再问一次。';
    }
```

- [ ] **Step 5: 验证**

```bash
cd web/server && npm test
```

Expected: 全绿。既有 `aiChat.test.js` 的回归用例（正常回复 / 非 JSON 兜底 / 空回复报错）必须仍然通过——它们走的就是同一条 `/api/ai/chat` 路径。

- [ ] **Step 6: 提交**

```bash
git add web/server/routes/ai.js
git commit -m "feat(agent): /api/ai/chat 接多步循环，下发 agent_thinking/tool_start/tool_done"
```

---

## Task 5：伏笔盘点技能

**Files:**
- Create: `web/server/services/skills/auditForeshadowing.js`
- Create: `web/server/test/auditForeshadowing.test.js`

复用 [consistency.js](../../../web/server/services/consistency.js) 的两层范式：**规则层本地免费定位，模型层花钱判定**。

- [ ] **Step 1: 新建 `web/server/services/skills/auditForeshadowing.js`**

```js
'use strict';

/**
 * 伏笔盘点技能。
 *
 * 回答作者两类问题：
 *   1. 「第三章那个铜钥匙，最后收了吗」→ 点名的那张卡
 *   2. 「还有哪些伏笔没收」            → 全书盘点
 *
 * 两层：
 *   规则层（本地、免费、立刻出结果）——按关键词召回候选章节
 *   模型层（花钱，只喂候选片段）    ——对片段做三态判定
 *
 * 关键设计：**「没搜到」不等于「没回收」**。
 * 关键词一个都没命中的卡单独立档，绝不断言成「未回收」——
 * 那是会直接损害正文的错误结论（作者会跑去补写已经交代过的情节）。
 */

const { all } = require('../../database');
const { parseModelJson } = require('../agent/parse');

/** 判定状态的三个取值 */
const STATUS = {
  RECOVERED: '已回收',
  UNRECOVERED: '未回收',
  NOT_FOUND: '未定位到原文',
};

/** 一批喂给模型的卡片上限 */
const BATCH_SIZE = 8;

/**
 * 从卡片里抽关键词。
 *
 * 标题整串 + 备注里切出来的短语。
 *
 * 为什么不能只匹配标题：卡片标题是作者写的短标签（「铜钥匙」），
 * 而正文常用变体指代（「那把钥匙」「铁盒里的东西」）。
 * 只做标题子串匹配，这类伏笔会被判成"没找到"，
 * 而作者据此去补写已经交代过的情节，直接损害正文质量。
 *
 * @param {Object} card
 * @returns {Array<string>}
 */
function extractKeywords(card) {
  const keywords = new Set();

  const title = String(card.title || '').trim();
  if (title.length >= 2) keywords.add(title);

  // 备注按常见分隔符切短语
  const content = String(card.content || '');
  const parts = content
    .split(/[\s，。、；：？！,.;:?!（）()【】\[\]「」『』"'"''|—…\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 20);

  for (const p of parts) keywords.add(p);

  return Array.from(keywords);
}

/**
 * 规则层：按关键词召回候选章节。
 *
 * chapters 表没有 FTS 索引（只有 materials 表有），
 * 所以走内存匹配：一部长篇几十章、几十万字，分批读入做 includes 完全够用。
 *
 * @param {Array} cards 伏笔卡片
 * @param {Array} chapters 全书章节 [{ id, title, seq, content }]
 * @returns {Map<string, {card: Object, hits: Array}>} 按卡片 id 索引
 */
function recallChapters(cards, chapters) {
  const result = new Map();

  for (const card of cards) {
    const keywords = extractKeywords(card);
    if (!keywords.length) {
      result.set(card.id, { card, hits: [], keywords: [] });
      continue;
    }

    // 每章记录：命中了哪些关键词
    const perChapter = new Map();
    for (const ch of chapters) {
      const text = ch.content || '';
      if (!text) continue;
      const hitWords = keywords.filter((k) => text.includes(k));
      if (hitWords.length) {
        perChapter.set(ch.id, { chapter: ch, hitWords });
      }
    }

    // 按命中关键词数量降序
    const hits = Array.from(perChapter.values()).sort(
      (a, b) => b.hitWords.length - a.hitWords.length || (a.chapter.seq || 0) - (b.chapter.seq || 0)
    );

    result.set(card.id, { card, hits, keywords });
  }

  return result;
}

/**
 * 章节正文。blocks 里存的是结构化块，content 是纯文本快照——
 * 两者都在，取 blocks 拼出来的纯文本（更准），没有就用 content。
 */
function chapterText(ch) {
  if (ch.blocks) {
    try {
      const blocks = JSON.parse(ch.blocks);
      if (Array.isArray(blocks) && blocks.length) {
        const joined = blocks
          .map((b) => (b && b.content ? b.content : ''))
          .filter(Boolean)
          .join('\n');
        if (joined) return joined;
      }
    } catch (e) {
      // blocks 不是合法 JSON 就退回 content
    }
  }
  return ch.content || '';
}

/**
 * 找一张卡「埋在哪一章」。
 *
 * 伏笔的价值在于"埋下的地方"与"回收的地方"这一对，
 * 只看有没有出现是不够的。所以要同时记录首次出场章与后续再次出场章。
 *
 * @param {Object} card
 * @param {Array} hits 召回结果（按命中数降序）
 * @returns {{first: Object|null, later: Array}}
 */
function splitByFirstAppearance(card, hits) {
  if (!hits.length) return { first: null, later: [] };

  // 卡片本身挂在某一章上时，那一章就是作者自己认定的"埋下点"
  const pinned = card.chapter_id
    ? hits.find((h) => h.chapter.id === card.chapter_id)
    : null;

  const first = pinned || hits[hits.length - 1]; // 无 pinned 时取最靠后的一章（时间上最早）
  const later = hits.filter((h) => h.chapter.id !== first.chapter.id);

  return { first, later };
}

/**
 * 模型层：判定一批卡片的三态。
 *
 * 每次只喂候选片段，不喂全书。每批最多 8 张卡。
 *
 * @param {Object} params
 * @returns {Promise<Array>} findings
 */
async function judgeWithModel({ provider, items, workTitle }) {
  const prompt = [
    '你是小说校对。下面每条是一个伏笔线索和它可能出现的章节片段。',
    '请判断每条伏笔的状态，三选一：',
    `  ${STATUS.RECOVERED}：片段里能看出作者对这条伏笔做了回收或呼应`,
    `  ${STATUS.UNRECOVERED}：片段里有这条线索，但看不出任何回收动作`,
    `  ${STATUS.NOT_FOUND}：片段与这条线索无关，读不出任何关联`,
    '每条必须给出 status 和 evidence（片段里的原句或摘要）。',
    '',
    '只输出一个 JSON 对象：{"results":[{"id":"卡片id","status":"...","evidence":"..."}]}',
  ].join('\n');

  const itemsText = items
    .map((it) => {
      const snippets = it.hits
        .slice(0, 4)
        .map((h) => `  【第 ${h.chapter.seq} 章 ${h.chapter.title}】${snippetAround(h.chapter, h.hitWords[0])}`)
        .join('\n');
      return `卡片 id=${it.card.id}\n标题：${it.card.title}\n备注：${it.card.content || '（无）'}\n候选片段：\n${snippets || '（没有召回到任何片段）'}`;
    })
    .join('\n\n');

  const result = await provider.chat({
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `作品：${workTitle || '（未命名）'}\n\n${itemsText}` },
    ],
    temperature: 0.2,
    // 这次内部调用必须显式限定参数，不能跟随角色或全局设置：
    // 任务只是对少量片段做三态归类，不需要长链推理。
    // 开启思考会让每一批判定多付一份思考 token 并多等数秒，
    // 叠加在多步循环上作者会明显感到卡顿。
    // 这个做法在项目里已有先例：memory/extractor.js 的 extractFacts。
    thinking: 'disabled',
    jsonOutput: true,
    maxTokens: 1200,
  });

  const parsed = parseModelJson(result && result.content);
  const rows = parsed && Array.isArray(parsed.results) ? parsed.results : [];

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return items.map((it) => {
    const row = byId.get(it.card.id);
    const status = row && Object.values(STATUS).includes(row.status) ? row.status : STATUS.NOT_FOUND;
    return {
      id: it.card.id,
      card: it.card.title,
      status,
      evidence: (row && row.evidence) || '',
      chapter: it.hits.length ? `第 ${it.hits[0].chapter.seq} 章` : '',
    };
  });
}

/**
 * 取关键词命中位置前后的一段文字。
 */
function snippetAround(chapter, keyword) {
  const text = chapterText(chapter);
  const idx = text.indexOf(keyword);
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + keyword.length + 90);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * 技能主体。
 *
 * @param {Object} params
 * @param {string} [params.target] 作者点名的伏笔名/关键词。留空则盘点全书。
 * @param {Object} ctx
 * @returns {Promise<Object>} { label, summary, detail, findings, degraded }
 */
async function run(params, ctx) {
  const { userId, workId, provider } = ctx;
  const target = String((params && params.target) || '').trim();

  if (!workId) {
    return { label: '伏笔盘点', summary: '没有找到要查的作品', detail: [], findings: [] };
  }

  // 只读当前用户自己的作品
  const cards = (
    await all(
      `SELECT c.*, ch.title AS chapter_title, ch.seq AS chapter_seq
       FROM plot_cards c
       JOIN works w ON w.id = c.work_id
       LEFT JOIN chapters ch ON ch.id = c.chapter_id
       WHERE c.work_id = ? AND w.user_id = ? AND c.kind = 'foreshadow'
       ORDER BY c.seq, c.created_at`,
      [workId, userId]
    )
  ).map((c) => ({
    ...c,
    chapter_title: c.chapter_title,
    chapter_seq: c.chapter_seq,
  }));

  if (!cards.length) {
    return {
      label: '伏笔盘点',
      summary: '这部作品还没有伏笔卡',
      detail: [],
      findings: [],
    };
  }

  // 点名时只处理那一张卡；留空才全书盘点
  const selected = target
    ? cards.filter((c) => String(c.title || '').includes(target) || String(c.content || '').includes(target))
    : cards;

  if (!selected.length) {
    return {
      label: '伏笔盘点',
      summary: `没找到叫「${target}」的伏笔卡`,
      detail: [],
      findings: [],
    };
  }

  const chapters = (
    await all(
      'SELECT id, title, seq, content, blocks FROM chapters WHERE work_id = ? ORDER BY seq',
      [workId]
    )
  ).map((ch) => ({ ...ch, content: chapterText(ch) }));

  const recalled = recallChapters(selected, chapters);

  // 规则层先分档：一个关键词都没命中的卡不调模型
  const items = [];
  const notFound = [];

  for (const card of selected) {
    const rec = recalled.get(card.id);
    if (!rec || !rec.hits.length) {
      notFound.push({
        id: card.id,
        card: card.title,
        status: STATUS.NOT_FOUND,
        evidence: '全书正文里没有找到与这条伏笔相关的段落',
        chapter: '',
      });
      continue;
    }
    items.push({ card, hits: rec.hits });
  }

  // 模型层：分批判定
  const findings = [...notFound];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const judged = await judgeWithModel({ provider, items: batch, workTitle: ctx.workTitle });
    findings.push(...judged);
  }

  // 汇总：读了多少章
  const touched = new Set();
  for (const it of items) {
    for (const h of it.hits) touched.add(h.chapter.id);
  }
  const chaptersRead = Array.from(touched)
    .map((id) => chapters.find((c) => c.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const chars = chaptersRead.reduce((sum, c) => sum + (c.content || '').length, 0);

  const detail = chaptersRead.map((c) => {
    const related = items.filter((it) => it.hits.some((h) => h.chapter.id === c.id));
    return {
      label: `第 ${c.seq} 章 ${c.title}`,
      text: related.length
        ? related
            .map((it) => `${it.card.title}：${it.hits.find((h) => h.chapter.id === c.id).hitWords.join('、')}`)
            .join('；')
        : '相关章节',
    };
  });

  // provider 降级时要标出来，不能静默降级——
  // 作者会把本地小模型的结论当成云端结论，一次判错就摧毁对整套巡检能力的信任。
  const degraded = Boolean(ctx.degraded);

  const summary = `读了 ${chaptersRead.length} 章 · ${(chars / 1000).toFixed(1)}k 字`;

  return {
    label: '伏笔盘点',
    summary: degraded ? `${summary}（本地模型，可信度有限）` : summary,
    detail,
    findings,
    degraded,
  };
}

module.exports = {
  name: 'audit_foreshadowing',
  label: '伏笔盘点',
  description:
    '盘点伏笔的回收情况。当作者问某个伏笔/线索是否回收、埋下的东西有没有用上、还有哪些没收时使用。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '作者问到的具体伏笔名或关键词。留空则盘点全书。',
      },
    },
    required: [],
  },
  run,
  // 导出内部函数供单元测试
  _internal: { extractKeywords, recallChapters, splitByFirstAppearance, STATUS },
};
```

- [ ] **Step 2: 在注册表里注册这个技能**

在 `web/server/services/skills/index.js` 里，`module.exports` 之前加两行：

```js
const auditForeshadowing = require('./auditForeshadowing');
register(auditForeshadowing);
```

> 注意方向：只能是 `index.js` 引用技能，**不能**让技能文件自己 `require('./index')` 去注册——
> 那会形成循环依赖（index → 技能 → index），技能文件在初始化时拿到的是半成品 exports。
> 以后加技能也只改 `index.js` 这一处。

- [ ] **Step 3: 新建 `web/server/test/auditForeshadowing.test.js`**

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();

const { ready, run, all } = require('../database');
const { extractKeywords, recallChapters, splitByFirstAppearance, STATUS } =
  require('../services/skills/auditForeshadowing')._internal;

test.before(async () => {
  await ready;
});

test.after(() => {
  env.cleanup();
});

test('关键词来自标题与备注两部分', () => {
  const kws = extractKeywords({ title: '铜钥匙', content: '第 3 章随尸体出现，后来收进铁盒' });
  assert.ok(kws.includes('铜钥匙'), '标题整串要在');
  assert.ok(kws.some((k) => k.includes('铁盒')), '备注里的短语也要在');
});

test('备注里的关键词能召回章节——只匹配标题会漏召', () => {
  const cards = [{ id: 'c1', title: '铜钥匙', content: '收进铁盒里的东西' }];
  const chapters = [
    { id: 'ch1', title: '第三章', seq: 3, content: '陈默把铁盒里的东西塞进背包。' },
    { id: 'ch2', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' },
  ];

  const recalled = recallChapters(cards, chapters);
  const rec = recalled.get('c1');
  assert.strictEqual(rec.hits.length, 1);
  assert.strictEqual(rec.hits[0].chapter.id, 'ch1');
});

test('关键词一个都没命中的卡不得被断言为未回收', () => {
  const cards = [{ id: 'c1', title: '银钥匙', content: '' }];
  const chapters = [{ id: 'ch1', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' }];

  const rec = recallChapters(cards, chapters).get('c1');
  assert.strictEqual(rec.hits.length, 0, '不该召回到任何章节');
  // 关键断言：命中为 0 时，不能走到「未回收」那一档
  assert.notStrictEqual(STATUS.NOT_FOUND, STATUS.UNRECOVERED);
});

test('能分出首次出场章与后续再次出场章', () => {
  const card = { id: 'c1', title: '铜钥匙', content: '', chapter_id: 'ch1' };
  const hits = [
    { chapter: { id: 'ch2', seq: 7 }, hitWords: ['铜钥匙'] },
    { chapter: { id: 'ch1', seq: 3 }, hitWords: ['铜钥匙'] },
  ];
  const { first, later } = splitByFirstAppearance(card, hits);
  assert.strictEqual(first.chapter.id, 'ch1', '卡片挂着的章就是埋下点');
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].chapter.id, 'ch2');
});
```

- [ ] **Step 4: 验证**

```bash
cd web/server && npm test
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add web/server/services/skills/auditForeshadowing.js web/server/services/skills/index.js web/server/test/auditForeshadowing.test.js
git commit -m "feat(agent): 伏笔盘点技能，规则层多关键词召回 + 模型层三态判定"
```

---

## Task 6：前端接线（ToolPanel + 事件处理）

**Files:**
- Create: `web/client/src/components/Assistant/ToolPanel.jsx`
- Modify: `web/client/src/components/Assistant/MessageList.jsx`
- Modify: `web/client/src/components/Assistant/Sidebar.jsx`
- Modify: `web/client/src/styles/theme.css`

后端事件已经在 Task 4 下发了。这一步把它们变成作者看得见的东西——**前后端必须一起上**，只有后端没有前端等于没做。

- [ ] **Step 1: 新建 `web/client/src/components/Assistant/ToolPanel.jsx`**

与 `MemoryPanel.jsx` 同构：折叠态显示一行摘要，展开态列出读过的章节。

```jsx
import React, { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';

/**
 * 工具过程条。
 *
 * AI 自己翻出来的东西必须让作者看见，否则作者无法判断这次回答靠不靠谱。
 * 与记忆面板同位置、同视觉语言，但语义不同：
 *   记忆面板 = 参考了哪些旧账
 *   过程条   = 这次现查了什么
 *
 * 降级时必须标出来。作者会把本地小模型的结论当成云端结论，
 * 一次判错就摧毁对整套巡检能力的信任。
 */
export default function ToolPanel({ trace = [] }) {
  const [open, setOpen] = useState(false);

  if (!trace.length) return null;

  const last = trace[trace.length - 1];
  const summary = trace.map((t) => t.label).join('、');

  return (
    <div className="ct-tool">
      <button type="button" className="ct-tool-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{summary}</span>
        {last.summary && <span className="ct-tool-summary">{last.summary}</span>}
      </button>

      {open && (
        <div className="ct-tool-list">
          {trace.map((item, idx) => (
            <div key={`${item.tool}-${idx}`} className="ct-tool-item">
              <div className="ct-tool-item-head">
                <span className="ct-tool-label">{item.label}</span>
                {item.summary && <span className="ct-tool-summary">{item.summary}</span>}
              </div>
              {item.degraded && (
                <div className="ct-tool-degraded">
                  本次判定由本地模型完成，可信度有限
                </div>
              )}
              {item.error && <div className="ct-tool-degraded">执行失败：{item.error}</div>}
              {(item.detail || []).map((d, i) => (
                <div key={i} className="ct-tool-detail">
                  <span className="ct-tool-detail-label">{d.label}</span>
                  <span className="ct-tool-detail-text">{d.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `MessageList.jsx` 挂载 ToolPanel**

在 import 区加：

```jsx
import ToolPanel from './ToolPanel';
```

在助手消息分支里，`MemoryPanel` **上方**挂 `ToolPanel`（过程条是本轮新增的即时动作，更贴近当前问题）：

```jsx
            <div className="ct-msg-body">
              {msg.roleLabel && <div className="ct-msg-role">{msg.roleLabel}</div>}

              {/* 过程条在最上方：作者先看到"这次现查了什么"，再看答案 */}
              {msg.toolTrace?.length > 0 && <ToolPanel trace={msg.toolTrace} />}

              {/* 记忆面板在正文上方：作者先看到"AI 参考了什么"，再看答案 */}
              {(msg.memoryRefs?.length || msg.memoryDegraded) && (
                <MemoryPanel ... />
              )}
```

- [ ] **Step 3: `Sidebar.jsx` 处理三个新事件**

import 区不需要新东西（事件处理在已有的 `streamPost` 回调里）。

在 `assistantMsg` 初始化对象里加一个字段：

```jsx
        memoryRefs: [],
        memoryDegraded: false,
        memoryReason: '',
        // 工具过程：AI 自己翻出来的东西，作者要能核对
        toolTrace: [],
```

在 `send` 外面加一个 ref 累积工具过程。**注意**：事件回调闭包里的 `msg` 永远是旧快照，
直接读 `msg.toolTrace` 会丢掉前面几次调用；而 `message/update` 是覆盖不是追加，
所以必须用 ref 累，再整份写回。

在组件顶部（`const streamBufRef = useRef('');` 旁边）加：

```jsx
  // 工具过程累积器。事件回调闭包里的 msg 永远是旧快照，
  // 直接读 msg.toolTrace 会丢掉前面几次调用——必须用 ref 累。
  const toolTraceRef = useRef([]);
```

在 `send` 里，初始化 `toolTraceRef.current = [];`（放在 `streamBufRef.current = '';` 旁边）。

在事件回调里，`event.type === 'memory'` 分支之后加三个分支：

```jsx
            } else if (event.type === 'agent_thinking') {
              // 进入多步循环的信号。作者此刻还看不到任何 token，
              // 没有这个提示就只有一个不动的空占位。
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { thinking: event.label || '正在判断需要查什么' },
              });
            } else if (event.type === 'tool_start') {
              toolTraceRef.current = [
                ...toolTraceRef.current,
                { tool: event.tool, label: event.label, status: 'running' },
              ];
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { thinking: '', toolTrace: toolTraceRef.current },
              });
            } else if (event.type === 'tool_done') {
              // tool_done 是把 tool_start 那一条**补全**，不是新增一条。
              // 两次都往后追加的话，过程条里会出现两行「伏笔盘点」——
              // 一行永远停在"正在跑"，作者会以为卡住了。
              const done = {
                tool: event.tool,
                label: event.label,
                status: 'done',
                summary: event.summary || '',
                detail: event.detail || [],
                degraded: !!event.degraded,
                error: event.error || '',
              };
              const list = [...toolTraceRef.current];
              const lastIdx = list.length - 1;
              if (lastIdx >= 0 && list[lastIdx].status === 'running') {
                list[lastIdx] = { ...list[lastIdx], ...done };
              } else {
                list.push(done);
              }
              toolTraceRef.current = list;
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: { thinking: '', toolTrace: toolTraceRef.current },
              });
            }
```

在 `action` 分支里清掉 `thinking`：

```jsx
            } else if (event.type === 'action') {
              gotReply = true;
              dispatch({
                type: 'streaming/set',
                streaming: '',
              });
              dispatch({
                type: 'message/update',
                id: assistantId,
                patch: {
                  content: event.content,
                  action: event.action,
                  target: event.target,
                  reason: event.reason,
                  citations: event.citations,
                  thinking: '',
                },
              });
```

- [ ] **Step 4: `theme.css` 加 `.ct-tool` 样式**

在 `.ct-memory` 那组样式之后（[theme.css](../../../web/client/src/styles/theme.css) 第 2148 行附近）加：

```css
/* ---------- 工具过程条 ---------- */
/* 与记忆面板同族：都是"AI 自己翻出来的东西"。
   位置一致、样式同族，但语义不同——过程条是这次现查了什么。 */
.ct-tool {
  margin-bottom: 8px;
  border: 1px solid var(--border-faint);
  border-radius: 8px;
  background: var(--bg-sunken);
  overflow: hidden;
}
.ct-tool-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: color 0.18s ease;
}
.ct-tool-head:hover {
  color: var(--accent);
}
.ct-tool-summary {
  font-size: 11.5px;
  color: var(--text-quaternary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ct-tool-list {
  padding: 0 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ct-tool-item {
  border-top: 1px solid var(--border-faint);
  padding-top: 7px;
}
.ct-tool-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ct-tool-label {
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
}
.ct-tool-degraded {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--amber);
}
.ct-tool-detail {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--text-tertiary);
  display: flex;
  gap: 6px;
}
.ct-tool-detail-label {
  color: var(--text-quaternary);
  flex-shrink: 0;
}
.ct-tool-detail-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 5: 验证构建**

```bash
cd web/client && npm run build
```

Expected: vite build 成功，无未定义变量报错。

- [ ] **Step 6: 提交**

```bash
git add web/client/src/components/Assistant/ToolPanel.jsx web/client/src/components/Assistant/MessageList.jsx web/client/src/components/Assistant/Sidebar.jsx web/client/src/styles/theme.css
git commit -m "feat(agent): 工具过程条与三个事件的前端接线"
```

---

## Task 7：集成测试与人工验收

**Files:**
- Create: `web/server/test/fakeModel.js`
- Create: `web/server/test/agentLoop.test.js`
- Modify: `web/server/test/aiChat.test.js`

- [ ] **Step 1: 把假模型服务提取到 `test/fakeModel.js`**

`aiChat.test.js` 里的 `startFakeModel` 是文件内私有函数，没导出。本版要新增两个测试文件共用它，所以提取出来。

`web/server/test/fakeModel.js`：

```js
'use strict';

/**
 * 假的 OpenAI 兼容端点。
 *
 * 起一个真的 HTTP 服务，把它当成真正的 DeepSeek 端点用——
 * 好处是 finish_reason 的捕获、SSE 的解析、路由的兜底逻辑全都在测试射程内。
 *
 * 行为由外部注入：每轮请求取一个 behavior。
 * 支持按次序返回不同响应（队列），用来测多步循环。
 */

const http = require('http');

/**
 * @param {Object} [options]
 * @param {Array} [options.queue] 按次序返回的响应。取完就用 defaultBehavior。
 * @param {Object} [options.defaultBehavior]
 * @returns {Promise<{server, close, setQueue, setDefault, calls}>}
 */
function startFakeModel(options = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    let queue = Array.isArray(options.queue) ? [...options.queue] : [];
    let defaultBehavior = options.defaultBehavior || { content: '', finishReason: 'stop' };
    const calls = [];

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

        calls.push(body);

        const b = queue.length ? queue.shift() : defaultBehavior;

        // 模拟供应商直接报错（限流、鉴权失败等）
        if (b.httpStatus) {
          res.writeHead(b.httpStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: b.errorMessage || '供应商出错了' } }));
          return;
        }

        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: b.content || '',
                    reasoning_content: b.reasoning || '',
                  },
                  finish_reason: b.finishReason || 'stop',
                },
              ],
            })
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (b.reasoning) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_content: b.reasoning }, finish_reason: null }],
            })}\n\n`
          );
        }
        if (b.content) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: b.content }, finish_reason: null }],
            })}\n\n`
          );
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: b.finishReason || 'stop' }],
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
        calls,
        setQueue(next) {
          queue = [...next];
        },
        setDefault(next) {
          defaultBehavior = next;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => srv.close(done));
        },
      })
    );
  });
}

module.exports = { startFakeModel };
```

- [ ] **Step 2: `aiChat.test.js` 改为引用共享版本**

删掉文件里的 `startFakeModel` 函数定义（现第 37–133 行）与 `const http = require('http');`，改为：

```js
const { startFakeModel } = require('./fakeModel');
```

调用处保持 `fakeModel = await startFakeModel();` 不变（返回结构里 `server` 字段一致）。

> **注意**：原版 `behavior` 是模块级变量，测试里直接 `behavior = {...}` 赋值。
> 提取后要改成 `fakeModel.setDefault({...})`。逐个替换。

- [ ] **Step 3: 新建 `web/server/test/agentLoop.test.js`（HTTP 集成测试）**

单测文件（`agentSkills.test.js`）测纯逻辑，不起 HTTP；要验证三个新 SSE 事件
真的从路由里发出来了，就得走完整链路。**另开一个文件**而不是往单测文件里塞：
一个文件一套环境（`setupTempEnv` / `test.after` 各一次），混在一起会互相打架。

`web/server/test/agentLoop.test.js`：

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好 DATA_DIR：
// app 会加载 skills → 技能模块 → database.js，
// 而 database.js 在模块加载时就打开了 SQLite 连接。
// DATA_DIR 没设对，测试就会在真实数据目录 web/data/ 下开出库文件。
const env = setupTempEnv();

const app = require('../app');
const { ready } = require('../database');
const aiConfig = require('../services/aiConfig');

let server;
let fakeModel;
let originalConfig;

/**
 * 发一条消息，收集整条 SSE 流里的事件。
 * 与 aiChat.test.js 里的同名函数一致。
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

  // aiConfig 是单例，改过不复原的话，后面的测试会一直指向这个假服务
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
```

再补三条用例（用 HTTP 层的假模型，走完整路由）：

> **为什么只需要两个队列响应**：测试请求没带 `workId`，所以 `conversation.work_id` 是空，
> 技能在 `run()` 开头就返回「没有找到要查的作品」，**不会**调模型做判定，
> 也就不会多消耗一个队列响应。真要测判定逻辑，那是 `auditForeshadowing.test.js` 的事。

```js
test('模型要求调用技能时，技能被调用、结果被喂回、最终下发 action', async () => {
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
```

- [ ] **Step 4: 跑全量测试**

```bash
cd web/server && npm test
```

Expected: 全绿。

- [ ] **Step 5: 人工验收清单**

`web/e2e/` 对 AI 对话零覆盖，本期不补 E2E（补它需要起真实模型服务，投入产出不成比例）。按下面 6 条人工过一遍：

1. 问「第三章那个铜钥匙最后收了吗」→ 先看到 `agent_thinking` 提示，随后过程条出现；**工具轮次的 JSON 片段完全不可见**。最终回答轮仍沿用现有的原始流式显示（本版不修），验收这一轮时不要把它当新问题。
2. 展开过程条 → 能看到读了哪几章。
3. 问「还有哪些伏笔没收」→ 走全书盘点路径；未定位到原文的卡单独成一档，不被说成「未回收」。
4. 问一个与伏笔无关的问题（「这段怎么改」）→ **不触发**技能，无过程条。
5. 断网 / 改坏 API key / 清空 DeepSeek key 触发降级 → 可见错误或明确标注的降级提示，不是空白气泡。
6. 问一句之后立刻看界面：从发出到 `agent_thinking` 到达之间不应出现无提示的长时间空等。

- [ ] **Step 6: 提交**

```bash
git add web/server/test/fakeModel.js web/server/test/aiChat.test.js web/server/test/agentLoop.test.js
git commit -m "test(agent): 提取共享假模型服务，补多步循环集成测试"
```

---

## 完成标准

- [ ] `cd web/server && npm test` 全绿
- [ ] `cd web/client && npm run build` 成功
- [ ] 人工验收清单 6 条逐条通过
- [ ] 设计文档的 6 条审查修订全部落地（可对照 [设计文档 §2.3 / §3.2 / §4.3 / §6 / §9.2 / §11](../specs/2026-10-29-agent-skills-design.md)）

**回滚方式：** 每个 Task 独立提交。任一 Task 出问题，`git revert` 对应 commit 即可，前面的 Task 不受影响。

**后续（本期不做）：** 原生 function calling 迁移；技能写回数据（自动把伏笔卡标成「已完成」）；过程条跳转到具体章节；对话历史持久化；更多技能（人物一致性 / 设定核对 / 时间线）。

