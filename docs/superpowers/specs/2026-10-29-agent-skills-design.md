# Agent 技能体系（工具调用）设计

日期：2026-10-29
状态：待评审
范围：CuriosityTrail Web 端（`web/`）

## 1. 背景与目标

### 1.1 问题

当前 AI 层的能力边界由 [context.js](../../../web/server/services/context.js) 的上下文装配决定。作者在对话框里提问时，模型能看到的东西是固定的一组切片：作品信息、当前章信息、人物设定、世界观设定、灵感速记、当前章节正文、段落索引、上一场景结尾、长期记忆、检索到的参考资料。

其中正文部分的上限极小（[context.js](../../../web/server/services/context.js) 第 26–32 行常量）：

| 注入内容 | 上限 |
| --- | --- |
| 大纲 | 4000 字符 |
| 上一场景结尾 | 500 字符 |
| 当前章正文 | 12000 字符 |
| 人物 / 设定 / 记忆 / 检索片段 | 命中才注入 |

结果是**跨章问题无法回答**。作者问「第三章那个铜钥匙，最后收了吗」，第一章根本不在上下文里，AI 只有两条路：说「我看不到第一章」，或者凭大纲硬猜然后给出一个像模像样的答案。后者更糟——作者无法分辨「AI 查过了」和「AI 编的」。

### 1.2 现有结构中已经存在、但没有被用起来的部分

数据库里已经躺着为跨章写作准备的结构化数据：

- `plot_cards.kind = 'foreshadow'`（伏笔）、`status`、`chapter_id`（[database.js](../../../web/server/database.js) 第 126–137 行）
- `characters.arc`（人物弧光，横跨全书）
- `chapters.seq` / `chapters.volume`（多卷长篇结构）

作者用这些字段追踪跨章未收的线索，但 AI 一次也读不到它们。

### 1.3 目标

1. 模型能按需**自己决定**去读它需要的数据，而不是靠关键词硬路由。
2. 作者在对话框里正常提问即可，不需要知道「技能」「工具调用」「多步循环」这些概念存在。
3. AI 读过什么必须对作者可见、可展开核对。
4. 引入的能力不能推翻已定的产品原则：角色由作者手选、写回必须人工确认、记忆策略归 Node 侧。
5. 零新增运行时依赖、零新增生产依赖。

### 非目标（本版不做）

- **不引入任何 harness 框架**（DeepSeek Harness / OpenAI Agents SDK / Agents API）。理由见 §2.1。
- 不做原生 function calling（`tools` / `tool_calls` 协议）。理由见 §2.2。
- 不做多 agent 编排、不做代码执行沙箱。
- 不做「AI 主动写回正文」——写回仍必须作者点确认。
- 不做全书自动扫描的定时任务。
- 不做跨作品查询：所有技能只读当前作品。
- 不做历史对话的持久化：当前 `/api/ai` 没有 GET 历史消息的路由，对话只在浏览器内存里，刷新即丢。本版沿用现状，不引入历史持久化。

## 2. 已确认决策

### 2.1 不引入 harness 框架

评估过 DeepSeek Harness（dsh）与 OpenAI Agents SDK / Agents API，结论是**不整体引入**：

| 冲突点 | 说明 |
| --- | --- |
| 范式不匹配 | 两套 harness 都假设「模型在沙箱里自主完成任务」。本项目的写回必须人工确认、角色由作者手选，这是产品底线，没有折中空间。 |
| 记忆双写 | dsh 自带 agent memory，本项目 Node 侧已有 8 个模块的记忆层（[memory/](../../../web/server/services/memory/)）。两套同时跑会引用互相矛盾的旧记忆。 |
| 成熟度 | dsh 处于 developer preview，官方 README 明确警告将有兼容性破坏变更。 |
| 数据边界 | Agents API 是托管 harness，未发表的小说正文要出本机。本项目已有 provider 抽象与本地 Ollama 兜底，「内容不出机器」是有价值的资产。 |
| 依赖与范式成本 | 引入后 Express 单体结构要变成插件架构（dsh 的 Cordis 内核）或多出一个 Python 运行时（Agents SDK）。 |

但 harness 里有三块设计值得直接借鉴，本版只借鉴其中两块：

| 借鉴项 | 来源 | 本版如何落地 |
| --- | --- | --- |
| 技能注册表 + 作用域化执行 | dsh `core/tools` | `services/skills/` 目录，见 §4 |
| 多步循环（turn / step） | dsh `core/agent-loop` | `services/agent/loop.js`，见 §5 |
| 事件三域分离 | dsh 事件模型 | 本版只取「会话事件持久化、agent 事件实时下发」这一层，见 §6。能力事件（工具边界策略）本期不做。 |

### 2.2 协议选型：扩展现有 JSON 契约

两种可选协议：

| 方案 | 做法 | 代价 |
| --- | --- | --- |
| **方案 1（采纳）** | 复用现有 JSON 输出契约，加一个 `action` 取值 `call_tool` | 靠提示词约束模型行为，稳定性略低于原生 |
| 方案 2（不采纳） | 改用 DeepSeek 原生 function calling（`tools` / `tool_calls`） | 要改 3 个 provider（DeepSeek/OpenAI 走 `delta.tool_calls[].function.arguments` 分片累积，Ollama 走 `message.tool_calls`，两套流式格式）；`response_format: json_object` 与 `tools` 同用行为官方未定义；Ollama 接 tools 就得放弃 `format=json`，而 json 模式是现在唯一的输出格式保障；5 个角色提示词的「输出格式」段全要改写，而 `prompt_overrides` 表里还有作者自己覆盖过的提示词，改不动。 |

**方案 1 的关键设计约束**：技能定义从第一天起就用 OpenAI function schema 的形状（`{ name, description, parameters }`）。将来若要切换到原生 function calling，**只换传输层，技能代码一行不改**。迁移成本被提前锁死在一个文件里。

### 2.3 其它已确认决策

| 决策点 | 结论 |
| --- | --- |
| 技能触发 | **不需作者确认**。技能全部只读，无副作用。作者的控制感靠可展开的过程条满足，不靠弹窗打断心流。 |
| 伏笔盘点范围 | 默认只处理作者点名的那张卡（`params.target` 有值）。追问「还有哪些没收」才触发全书盘点。 |
| 过程可见性 | 折叠式过程条，位置与现有记忆面板一致。 |
| 工具调用落库 | 中间过程不落库。只有最终那条 assistant 消息进 `messages` 表；技能调用摘要写进该消息的 `payload.skills` 字段。**落库前必须扩展现有的字段归一化白名单**——`normalizeAction` 目前只输出 `action` / `target` / `content` / `reason` / `citations` 五个字段，未列入的字段会被静默丢弃（不报错）。 |
| `reasoning_content` 回传 | 一律不回传。DeepSeek 文档明确「不含 tool call 的多轮对话，reasoning_content 可不回传」，换取三个 provider 行为一致。代价是思考连续性略降。 |

## 3. 架构

```
作者在对话框提问
   │  POST /api/ai/chat (SSE)
   ▼
routes/ai.js ──── assembleContext() ──→ 上下文 + 【可用技能】注入
   │
   ▼
services/agent/loop.js  ← 多步循环，纯逻辑，不碰数据库、不碰 HTTP
   │    │
   │    ├─ provider.chatStream({ messages, jsonOutput: true, onToken })
   │    │     └─ token 先进缓冲区，识别出 action 前不下发
   │    │
   │    ├─ action === 'call_tool' ?
   │    │     ├─ 是 → 丢弃本轮缓冲 → 执行技能 → 结果喂回 → 继续循环
   │    │     └─ 否 → 释放缓冲 → 正常回复路径
   │    │
   │    └─ maxSteps 用尽 → 可见错误
   │
   ▼
services/skills/  ← 技能注册表 + 技能实现
   ├─ index.js                 注册表：列技能、按名取、执行
   └─ auditForeshadowing.js    伏笔盘点（本期唯一技能）
```

### 3.1 数据流

一次「第三章那个铜钥匙收了吗」的完整链路：

1. 作者发消息，`routes/ai.js` 装配上下文，其中 system prompt 末尾追加「可用技能」段。
2. `loop.js` 调 `provider.chatStream`。token 进缓冲区，**不下发**。
3. 模型返回 `{"action":"call_tool","tool":"audit_foreshadowing","params":{"target":"铜钥匙"}}`。
4. `loop.js` 识别出 `call_tool`，**丢弃整个缓冲**——作者一个字符都看不到。
5. 执行技能：规则层定位候选章节 → 模型层批量判定 → 返回结构化结果。
6. `loop.js` 把结果作为一条 `user` 消息追加到 `messages`，继续循环。
7. 模型这次返回正常 JSON（`action: 'comment'`），缓冲区释放给前端，token 实时下发。
8. 前端收到 `tool_start` / `tool_done` 事件，渲染折叠过程条；收到 `action` 事件，渲染正文。

作者看到的是：

```
┌──────────────────────────────────────────────┐
│ ⌄ 伏笔盘点 · 读了第 3、7、12 章 · 8.2k 字      │  ← 点开看每步
└──────────────────────────────────────────────┘
铜钥匙在第 3 章随尸体一起出现，第 7 章被陈默收进铁盒，
第 12 章开盒时已经空了——收是收了，但没交代去向，建议补一句。
```

### 3.2 模块边界

| 模块 | 职责 | 依赖 | 不碰 |
| --- | --- | --- | --- |
| `services/agent/loop.js` | 驱动多步循环、识别 `call_tool`、喂回结果 | provider、skills 注册表、`agent/parse.js`、回调 | 数据库、HTTP、Express |
| `services/agent/parse.js` | 把模型原文解析成结构化对象（含 markdown 围栏剥离、截取兜底） | 无 | 其它一切 |
| `services/skills/index.js` | 技能注册表：列技能、按名取、执行 | 具体技能模块 | provider、HTTP |
| `services/skills/auditForeshadowing.js` | 伏笔盘点 | database、provider（内部判定用）、plotCards | Express |
| `services/context.js` | 追加「可用技能」到 system prompt | skills 注册表 | — |
| `routes/ai.js` | 编排：装配上下文 → 调 loop → 归一化 → 落库 → 下发 SSE | context、agent/loop、database | — |

**`services/agent/parse.js` 是必需的搬迁，不是可选优化。** 现有的 `parseModelJson`（`routes/ai.js` 第 36–62 行）是路由文件内的私有函数，文件末尾只导出 router，循环层无法引用。它必须被提取成独立模块，由 `loop.js` 与 `routes/ai.js` 共用，否则要么复制出两份实现，要么让循环层反向依赖 HTTP 层。

每个模块都能独立测试：`loop.js` 不碰 IO，可以用一个假 provider 喂它预设响应序列；`auditForeshadowing.js` 可以用临时库测；`parse.js` 是纯函数，直接喂字符串。

## 4. 技能体系

### 4.1 技能定义

一个技能就是一个对象。字段形状与 OpenAI function schema 一致：

```js
{
  name: 'audit_foreshadowing',
  label: '伏笔盘点',
  description: '盘点伏笔的回收情况。当作者问某个伏笔/线索是否回收、埋下的东西有没有用上、还有哪些没收时使用。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '作者问到的具体伏笔名或关键词。留空则盘点全书。' },
    },
    required: [],
  },
  async run(params, ctx) { /* 返回结果对象 */ },
}
```

`run` 的返回值：

```js
{
  summary: '读了第 3、7、12 章 · 8.2k 字',   // 过程条折叠态显示
  detail: [ { label: '第 3 章', text: '…' } ], // 过程条展开态显示
  findings: [ /* 结构化结论，回传给模型 */ ],
}
```

`ctx` 提供 `userId`、`workId`、`provider`、`role` 等。技能**必须**按 `userId` + `workId` 取数据，不得越权读取他人作品。

### 4.2 技能清单注入

`context.js` 的 `assembleContext` 在 system prompt **末尾**追加一段：

```
## 可用技能
当你需要当前上下文之外的信息时，可以调用下面的技能。
调用方式：只输出一个 JSON 对象，action 填 "call_tool"，
tool 填技能名，params 填技能参数。

### 伏笔盘点（audit_foreshadowing）
说明：盘点伏笔的回收情况。当作者问某个伏笔/线索是否回收、
埋下的东西有没有用上、还有哪些没收时使用。
参数：{"target": "作者问到的具体伏笔名或关键词。留空则盘点全书。"}

示例：
{"action": "call_tool", "tool": "audit_foreshadowing", "params": {"target": "铜钥匙"}}
```

**注入在末尾**是因为角色提示词（`services/roles/*.js`）已经规定了 `action` 的取值范围，追加段必须在其之后才能被看见。5 个角色文件**零改动**，技能增减也不用动它们。

### 4.3 伏笔盘点技能（本期唯一技能）

复用 [consistency.js](../../../web/server/services/consistency.js) 的两层范式。

**规则层（本地、免费、立刻出结果）**

1. 取 `plot_cards` 中 `kind = 'foreshadow'` 的卡片，连同其 `chapter_id` 指向的章节。
2. 若 `params.target` 非空，先把目标卡筛出来（标题或备注包含 `target` 即算命中）。
3. 取全书章节正文，按**多关键词**召回候选章节，而不是只做标题子串匹配：
   - 关键词来源 = 卡片 `title` 与 `content` 两部分分别抽取（标题整串 + 备注中出现的名词性短语）。
   - 每个关键词独立命中，命中结果做并集，并按「命中关键词数量」降序排序。
   - 同时记录**首次出场章**与**后续再次出场章**——伏笔的价值在于"埋下的地方"与"回收的地方"这一对，只看有没有出现是不够的。

   chapters 表**没有** FTS 索引（只有 materials 表有，见 [database.js](../../../web/server/database.js) 第 202–215 行），所以这里走内存匹配：一部长篇几十章、几十万字，分批读入内存做 `String.includes` 完全够用。

   **为什么不能只匹配标题**：卡片标题是作者写的短标签（例如「铜钥匙」），而正文常用变体指代（例如「那把钥匙」「铁盒里的东西」）。只做标题子串匹配，这类伏笔会被判成"没找到"，而作者据此去补写已经交代过的情节，直接损害正文质量。卡片 `content`（备注）里往往写着更接近正文的措辞，必须一起用上。

4. 若一张卡的关键词一个都没命中，**不能直接判定为「未回收」**。这类卡要单独归入「未定位到原文」一档，明确告诉作者"没有在正文里找到相关段落"，并建议补充卡片关键词。把"没搜到"和"没回收"混为一谈是这个技能最容易造成误导的地方。

**模型层（花钱，只喂候选片段）**

只把候选章节的正文片段 + 卡片信息交给模型判定，每批最多 8 张卡：

- 判定结果三选一：`已回收` / `未回收` / `未定位到原文`
- 必须给出**章节引用**，作者要能核对
- 模型只判「找到了什么」，不判「该怎么改」——改法由主对话给出

**这次内部调用必须显式限定参数**，不能跟随角色或全局设置：

- `thinking: 'disabled'` —— 任务只是对少量片段做三态归类，不需要长链推理。开启思考会让每一批判定多付一份思考 token 并多等数秒，叠加在多步循环上作者会明显感到卡顿。
- `jsonOutput: true` —— 复用现有 JSON 输出约束。
- `maxTokens` 限制在判定所需的量级。

这个做法在项目里已有先例：[extractor.js](../../../web/server/services/memory/extractor.js) 第 147–159 行的 `extractFacts` 就是同类内部小判定，显式传了 `thinking: 'disabled'` 与 `jsonOutput: true`、`maxTokens: 800`。

**provider 降级规则**

技能的 `ctx.provider` 可能就是降级后的 provider。`resolveProvider` 会在 DeepSeek 未配置时按 `FALLBACK_ORDER` 退到 `openaiCompat` 或 `ollama`，并带 `degraded: true`（见 [providers/index.js](../../../web/server/services/providers/index.js) 第 16–72 行）。本地 Ollama 的结构化输出只是 `format: 'json'`，无 usage 统计，判定质量明显弱于云端。

因此：

- `ctx` 必须把 provider 的 `degraded` 状态一并传进来，技能据此决定是否走模型层。
- **降级时仍走模型层，但过程条必须标注「本次判定由本地模型完成，可信度有限」**——不能静默降级，否则作者会把本地小模型的结论当成云端结论，一次判错就摧毁对整套巡检能力的信任。

**成本控制**：作者问「铜钥匙收了吗」时，`params.target` 命中，只处理这一张卡、只喂它的候选片段。全书盘点时才走批量，且只喂命中片段，不喂全书。

## 5. 多步循环

### 5.1 循环骨架

```js
// services/agent/loop.js
async function runAgentLoop({ provider, messages, options, onToken, onToolStart, onToolDone, maxSteps = 4 })
```

每一步：

1. 调 `provider.chatStream({ messages, jsonOutput: true, onToken })`。
2. `parse.js` 的 `parseModelJson(result.content)` 解析出结构化输出（该函数从 `routes/ai.js` 提取，不在此复制）。
3. 若 `parsed.action === 'call_tool'`：
   - 查注册表拿技能。**技能不存在 → 不中断**，把「没有这个技能」作为工具结果喂回，让模型自己向作者解释它做不到什么。
   - 执行技能。**技能抛错 → 同样不中断**，把错误信息喂回模型。
   - 追加两条消息：assistant 侧保留模型原始 JSON 原文，user 侧放 `【工具结果：<技能名>】<结果>`。
   - `continue`。
4. 否则：返回解析结果，循环结束。

`maxSteps = 4`：最多 4 次模型调用。模型连续要工具而拿不到有用结果时，第 4 步后强制结束，并给出可见错误（**不能静默停在一半**）。

### 5.2 token 延迟推送（无感的硬保证）

`call_tool` 那一轮，模型输出的是 `{"action":"call_tool",...}` 这样的 JSON 片段。如果照常下发，作者会看到一堆 JSON 噪音——「无感」直接破功。

**做法**：每一轮模型调用各自持有一个缓冲区。`onToken` 回调里，token 先累进本轮缓冲区，**不下发**。服务端持续扫描缓冲区：

- 一旦能判定 `action` 的值：
  - 是 `call_tool` → **整轮缓冲丢弃**，不下发任何 token
  - 是其它值 → 把缓冲原样释放，之后的 token 继续实时下发
- 直到流结束仍无法判定 → 按「非工具轮」处理，释放缓冲（兜底：模型没按契约输出时也不能让作者看到空白）

**判定规则**（要能容忍模型不把 `action` 放在第一个键）：扫描缓冲文本，用正则 `/"action"\s*:\s*"([a-z_]+)"/` 找 `action` 的取值，并要求匹配到的引号**未被转义**（前一个字符不是 `\`）——否则正文里出现的字面量 `"action":"xxx"` 会被误判。

判定延迟约 20–40 个 token（几十毫秒），视觉上无感。

**这条逻辑不修复现有的流式显示行为**。当前实现里，流式期间前端显示的就是模型原始输出（含 JSON 片段），`action` 事件到达后才被干净正文替换（[Sidebar.jsx](../../../web/client/src/components/Assistant/Sidebar.jsx) 第 153–191 行）。本版保持这个行为不变——修它是另一件事，不在本版范围。实现第一步需用真实模型核实一次当前实际显示内容。

### 5.3 技能结果如何喂回

用一条 `role: 'user'` 消息，**不**用 `role: 'tool'`。DeepSeek 的 tool 消息要求带 `tool_call_id`，而 JSON 契约里没有这个概念，强行构造会与 `tool_calls` 语义冲突。

消息内容形如：

```
【工具结果：伏笔盘点】
{"findings":[{"card":"铜钥匙","chapter":"第 7 章","status":"已回收","evidence":"…"}]}
```

前缀 `【工具结果：…】` 让模型能明确区分「作者说的话」和「系统回灌的数据」。

## 6. SSE 协议

现有事件序列（[routes/ai.js](../../../web/server/routes/ai.js) 第 670–841 行）：`notice` → `memory` → `token` → `action` → `done`，异常时 `error` → `done`。

新增三个事件：

```json
{ "type": "agent_thinking", "label": "正在判断需要查什么" }
{ "type": "tool_start", "tool": "audit_foreshadowing", "label": "伏笔盘点" }
{ "type": "tool_done", "tool": "audit_foreshadowing", "label": "伏笔盘点",
  "summary": "读了第 3、7、12 章 · 8.2k 字", "detail": [ { "label": "第 3 章", "text": "…" } ],
  "degraded": false }
```

- `agent_thinking` 在**进入循环、发起第一次模型调用之前**下发。这是必需的：第一次调用期间 token 被全部缓冲（§5.2），若不在此处给一个信号，作者从发出提问到 `tool_start` 到达之间，界面上只有一个不会动、没有任何字的空占位气泡——恰恰是本节要避免的体验。文案说明「正在判断需要查什么」，不暴露技能、工具调用这些概念。
- `tool_start` 在技能开始执行时下发。注意它只能等到第一次模型调用结束、识别出 `call_tool` 之后才可能发出，所以它**不能**承担「消除空白等待」的职责，那个职责属于 `agent_thinking`。
- `tool_done` 在技能返回后下发，带摘要与明细；`degraded: true` 时前端在过程条上标注「本次判定由本地模型完成，可信度有限」（见 §4.3）。
- 这三个事件都**只对当前这条 assistant 消息生效**，挂在消息的 `toolTrace` 数组上。

完整顺序：`notice` → `memory` → `agent_thinking` →（第一轮缓冲期，**无 token 下发**）→ `tool_start` → `tool_done` →（第二轮的）`token` → `action` → `done`。

若模型第一轮就直接作答（没有 `call_tool`），`agent_thinking` 之后紧接缓冲释放的 `token`，过程条不出现——多出的这一个事件对作者只是一句极短的提示，不影响正常对话。

## 7. 前端改动

### 7.1 组件

| 文件 | 改动 |
| --- | --- |
| `components/Assistant/ToolPanel.jsx` | **新建**。折叠条组件，与 `MemoryPanel.jsx` 同构：`collapsed` 态显示 `label · summary`，展开态显示 `detail` 列表。 |
| `components/Assistant/MessageList.jsx` | 在记忆面板位置（正文上方）挂 `ToolPanel`。 |
| `components/Assistant/Sidebar.jsx` | 处理 `agent_thinking` / `tool_start` / `tool_done`，把 `toolTrace` 写进 assistant message。 |
| `store/workspace.jsx` | assistant message 初始态加 `toolTrace: []`。 |
| `styles/theme.css` | 新增 `.ct-tool` 系列样式，沿用 `.ct-memory` 的视觉语言（[theme.css](../../../web/client/src/styles/theme.css) 第 2047 行起）。 |

### 7.2 交互

- 过程条在**正文上方**，与记忆面板同一位置。作者先看到「AI 查了什么」，再看答案。
- 折叠态：`⌄ 伏笔盘点 · 读了第 3、7、12 章 · 8.2k 字`
- 展开态：逐条列出读过的章节与摘要片段。
- **不做**「点某条跳到第 7 章」的跳转——那需要正文视图与侧边栏联动，超出本期范围。

### 7.3 与记忆面板的关系

两者都是「AI 自己翻出来的东西」，位置一致、样式同族，但语义不同：记忆面板是「参考了哪些旧账」，过程条是「这次现查了什么」。同屏出现时，过程条在上、记忆面板在下（过程条是本轮新增的即时动作，更贴近当前问题）。

## 8. 错误处理

| 情况 | 行为 |
| --- | --- |
| 模型返回 `call_tool` 但技能名不存在 | 不中断。把「没有这个技能」作为工具结果喂回，让模型自己向作者解释它做不到什么。 |
| 技能执行抛错 | 不中断。把错误信息喂回模型。作者看到的是「这个技能没跑起来」，而不是整轮对话崩掉。 |
| 技能返回空结果 | 不中断。喂回「没找到相关内容」，模型据此回答「查过了，没找到」。 |
| 连续 `maxSteps` 步都在要工具 | 强制结束，**下发可见错误**（文案说明「模型反复调用技能但没拿到结果」），并清理孤立用户消息——与现有的空回复处理一致（[ai.js](../../../web/server/routes/ai.js) 第 738–759 行）。 |
| 模型没按契约输出 JSON | 沿用现有兜底：原文当回复内容（[ai.js](../../../web/server/routes/ai.js) 第 725–729 行）。 |
| provider 报错 | 沿用现有兜底：可见错误 + 清理孤立消息 + 补 `done`。 |

**铁律**：任何失败路径都不能让作者看到空白气泡，也不能在历史里留下「作者问了但没人答」的孤立消息。

## 9. 测试策略

### 9.1 后端单元测试

新增 `web/server/test/agentSkills.test.js`。

假 OpenAI 兼容服务目前在 [aiChat.test.js](../../../web/server/test/aiChat.test.js) 里是文件内私有函数（`startFakeModel`），没有导出。本版把它**提取**到 `web/server/test/fakeModel.js`，两个测试文件共用。提取时保持行为不变：按 `body.stream` 决定回 SSE 流还是普通 JSON，内容与 `finish_reason` 由测试注入。

本版还需要给假服务加一个能力：**按调用次序返回不同的响应**（第一轮返回 `call_tool`，第二轮返回正常 JSON）。现在 `behavior` 是单个全局变量，多轮场景需要改成响应队列。

| 用例 | 断言 |
| --- | --- |
| 模型第一轮返回 `call_tool`，第二轮返回正常 JSON | 技能被调用；结果被喂回；第二次请求的 `messages` 末尾含 `【工具结果：…】`；最终下发 `action` 事件。 |
| `call_tool` 轮次不下发 token | 该轮**没有** `token` 事件到达前端。 |
| 技能名不存在 | 不崩溃；模型收到「没有这个技能」；仍然下发 `action` 事件。 |
| 技能抛错 | 不崩溃；错误被喂回；仍然下发 `action` 事件。 |
| 连续 `call_tool` 超过 maxSteps | 停下并下发可见 `error` 事件；历史里没有孤立用户消息。 |
| 模型返回正常 JSON（回归） | 现有行为零变化：`action` 事件内容正确、无 `tool` 事件。 |
| 模型没给 JSON（回归） | 现有行为零变化：原文当回复内容。 |

### 9.2 技能测试

新增 `web/server/test/auditForeshadowing.test.js`：

- 规则层：造几张伏笔卡和章节正文，断言候选章节定位正确。
- `params.target` 命中时只处理那一张卡。
- 关键词一个都没命中的卡归入「未定位到原文」，不调模型，且**不得**断言为「未回收」。
- 卡片备注（`content`）里的关键词能被召回（只匹配标题会漏召的用例）。
- 降级 provider 下走模型层时，结果带 `degraded` 标记。

### 9.3 前端

`web/e2e/` 当前对 AI 对话**零覆盖**（`/api/ai` 无匹配）。本期不补 E2E——补它需要起真实模型服务，投入产出不成比例。前端改动靠人工验收。

### 9.4 人工验收清单

1. 问「第三章那个铜钥匙最后收了吗」→ 先看到 `agent_thinking` 提示，随后过程条出现；**工具轮次的 JSON 片段完全不可见**。最终回答轮仍沿用现有的原始流式显示（本版不修，见 §5.2），验收这一轮时不要把它当新问题。
2. 展开过程条 → 能看到读了哪几章。
3. 问「还有哪些伏笔没收」→ 走全书盘点路径；未定位到原文的卡单独成一档，不被说成「未回收」。
4. 问一个与伏笔无关的问题（「这段怎么改」）→ **不触发**技能，无过程条。
5. 断网 / 改坏 API key / 清空 DeepSeek key 触发降级 → 可见错误或明确标注的降级提示，不是空白气泡。
6. 问一句之后立刻看界面：从发出到 `agent_thinking` 到达之间不应出现无提示的长时间空等。

## 10. 不做与后续

**本期不做**

- 原生 function calling 迁移（技能定义已按该形状设计，迁移只换传输层）
- 技能写回数据（如自动把伏笔卡标成「已完成」）。作者确认写回的原则不变；即使以后要做，也必须走作者点确认。
- 过程条跳转到具体章节
- 对话历史持久化
- 更多技能（人物一致性、设定核对、时间线）

**后续可加的技能**（按对作者的价值排序）

1. `audit_foreshadowing`（本期）——伏笔回收
2. `check_character_consistency`——跨章人物一致性，与 `audit_foreshadowing` 共用规则层定位 + 模型层判定结构
3. `check_setting_conflict`——设定冲突，与现有「一致性检查」功能重叠，实现前需要先确认两者如何分工
4. `timeline_check`——时间线校验，需要先给章节加时间标记字段

## 11. 实施顺序建议

1. **`services/agent/parse.js`** —— 把 `routes/ai.js` 里的 `parseModelJson` 原样搬出并按纯函数导出，`routes/ai.js` 改为引用它。这一步不改变任何行为，先做它是为了让后续所有工作有一个共享的解析入口，避免复制出两份实现。
2. `services/skills/index.js` + `services/agent/loop.js` 骨架 + 单元测试（先跑通纯逻辑，不接路由）
3. `context.js` 注入技能清单
4. `routes/ai.js` 接 loop + token 延迟推送 + SSE 三个新事件（含 `agent_thinking`）+ 扩展字段归一化白名单以保住 `payload.skills`
5. `auditForeshadowing.js` 规则层（多关键词召回 + 未定位到原文分档）+ 模型层（显式关闭思考、降级标注）
6. 前端 `ToolPanel` + 接线（含 `agent_thinking` 与降级标注）
7. 人工验收清单逐条走
