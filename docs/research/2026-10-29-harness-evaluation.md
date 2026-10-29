# OpenAI 与 DeepSeek Harness 在 CuriosityTrail 的应用评估

> 评估日期：2026-10-29　|　评估对象：DeepSeek Harness（下称 dsh）、OpenAI Agents SDK（下称 Agents SDK）、OpenAI Agents API　|　被评估系统：CuriosityTrail（寻迹）AI 写作层
> 数据来源：三家官方文档与仓库（截至评估日），以及本仓库代码静态盘点。外部事实一律带 `[cite:N]`，代码事实一律带 `文件路径:行号`。

---

## 1. 执行摘要

本次评估回答一个问题：把 agent harness（模型之外的运行骨架）引入 CuriosityTrail，是否能让这个 AI 辅助小说写作平台少写轮子、跑得更远。

结论分三层：

**第一层，整体引入不划算。** 两家 harness 都是为「通用代码代理」设计的，其核心假设是「模型在受控环境里自主完成多目标任务」。CuriosityTrail 的核心假设完全相反：「作者手握方向盘，模型当副驾」。这个差异在两处代码里写得清清楚楚——角色选择 100% 由作者手选，模型零参与路由（[web/server/routes/ai.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js) 的 `needsRetrieval`/`needsWebSearch` 走的是关键词白名单硬路由，[web/server/routes/ai.js#L244-L269](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L244-L269)）；模型输出的写回动作必须经作者点击确认（`action` 白名单 `['replace','append','insert','comment','none']`，[web/server/routes/ai.js#L101-L134](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L101-L134)）。harness 的「工具自动执行 + 沙箱」范式与这条产品原则是正面冲突，不存在「调参折中」的空间。

**第二层，但 harness 的设计里有四块东西值得直接抄。** dsh 的 `core/tools`（scoped 工具注册表 + guarded 执行管线）、`core/session`（append-only 事件日志作为 trajectory）、turn/step 两级循环、以及事件三域分离（durable session / live agent / capability seam），这四项与本项目零冲突，且能一次性补上当前 AI 层最致命的三个洞：零 tool calling 协议、多步循环缺失、以及 `messages` 表可观测性几乎为零（[web/server/database.js#L238-L249](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/database.js#L238-L249)）。这些设计可以以「自研 ~500 行」的方式落地，不需要引入任何外部框架。

**第三层，有一个此前被低估的技术事实改变了选型空间。** DeepSeek 现已原生支持 OpenAI Responses API（`POST https://api.deepseek.com/responses`）与 Anthropic Messages API（`base_url=https://api.deepseek.com/anthropic`）[cite:11][cite:12][cite:13]。这意味着 Agents SDK 的 Responses 基础路径（function tool、json_schema 结构化输出、真实 token usage）对 DeepSeek **是可行的**——把 `base_url` 指过去即可，不需要 Chat Completions 适配层。但需要划清边界：Responses-only 的进阶能力（tool search、deferred loading、programmatic tool calling）在 DeepSeek 侧仍不可用，因为 DeepSeek 的 `tools` 表只接受 `function` / `custom(apply_patch)` / `web_search` 三类，其余内置工具被静默忽略；`previous_response_id`、`conversation`、`store`、`include`、`context_management` 也全部不支持，服务端无状态，无法用服务端存储做 reasoning 跨轮续接[cite:6][cite:12]。

综合判断：**不引入任一 harness 作为运行时依赖，改为「借架构、不借代码」，并优先把 DeepSeek provider 切到 Responses API 以拿到真实 token 用量**。本项目现有可复用资产（provider 三层抽象、SSE 事件协议、五角色系统、8 层上下文装配、8 模块记忆层）恰好覆盖 harness 的输入侧与输出侧，缺口集中在「中间层」——决策与编排，而这一层恰恰是本项目产品原则不想要自动化的部分。

---

## 2. 评估范围与证据口径

### 2.1 评估对象

| 名称 | 形态 | 许可与成熟度 | 评估立场 |
|------|------|---------------|---------|
| DeepSeek Harness (dsh) | 开源 agent harness，插件式内核 | MIT，明确标注 developer preview，官方 README 警告将有破坏性变更[cite:1] | 作为「架构范式」评估 |
| OpenAI Agents SDK | Python / TypeScript SDK，提供 agent loop 原语 | 生产就绪，TypeScript 版要求 Zod v4[cite:7] | 作为「可引入依赖」评估 |
| OpenAI Agents API | 把 Codex harness 通过 API 托管开放（2026-09-10 公测）[cite:4] | 公测阶段 | 作为「可引入服务」评估 |
| Codex harness | 开源，OpenAI Agents API 的底座[cite:4] | — | 作为 OpenAI 侧能力基线 |

三者是三个层次的东西：dsh 是「可自建的骨架」，Agents SDK 是「本地运行的库」，Agents API 是「远程托管的服务」。把它们并列比较容易失焦，因此本报告分别给出各自独立的适用性判断。

### 2.2 证据分级与时效

外部事实全部来自 P0 级来源（官方文档、官方仓库、官方 API 规范）。关键结论均有两个以上独立来源交叉验证，例如「DeepSeek 支持 Responses API」由 API schema 页[cite:11]与兼容矩阵页[cite:12]互相印证。

时效性标注如下：

- OpenAI Agents API 处于**公测**阶段（发布日 2026-09-10，评估日 2026-10-29，约 7 周）[cite:4]，接口仍可能变动。
- DeepSeek Harness 处于 **developer preview**，官方主动声明 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" [cite:1]，任何基于其 API 形态的规划都需要预留迁移成本。
- DeepSeek Responses API 的能力边界以兼容矩阵页的明示清单为准[cite:12]，未在清单中的参数一律按「不支持」处理。

### 2.3 本项目基线的取证方式

本项目侧结论全部来自代码静态盘点，结论均带 `文件路径:行号`，可复核。其中「零 tool calling 协议」这一关键判断由 `web/server` 全目录检索 `tool_call|tool_calls|tool_choice|function_call|tools\s*:` 得到——无匹配；「无 token 概念」由 `web/server/services/context.js` 全文检索 `token` 得到——无匹配。这两项是「无匹配」型证据，其证明力上限是「当前实现里不存在」，不含未来意图。

---

## 3. 两大 harness 的形态

### 3.1 DeepSeek Harness：一切皆插件的运行骨架

dsh 的架构基石是 Cordis 插件内核（`github.com/cordiverse/cordis`），其设计论文为 arXiv 2608.25512《A Programming Paradigm for Spatiotemporal Composability》[cite:2]。在这个范式下，models / tools / skills / sessions / sandboxes / storage / loops / scheduling / UI 全是插件，Cordis 内核只负责插件的 mount / unmount 与依赖解析，内核本身无特权[cite:2]。

官方核心包表给出了职责切分[cite:2]：

| 核心包 | 职责 | 对应 `ctx` 命名空间 |
|--------|------|--------------------|
| `core/session` | append-only 的 `SessionEvent` 日志 | `ctx.sessions` |
| `core/system-prompt` | 系统提示词装配 | `ctx.systemPrompt` |
| `core/tools` | scoped 工具注册表 + guarded 执行管线 | `ctx.tools` |
| `core/agent` | agent 定义与解析 | `ctx.agents` |
| `core/agent-loop` | 多步循环 | `ctx.agentLoop` |
| `core/scope` | scope 库（无 key） | — |
| `llm/llm` | 模型适配层 | `ctx.llm` |

三个概念值得单独记住：

**事件三域分离。** dsh 把事件划成 session events（durable，落日志）、agent events（`agent/*`，实时）、capability events（`fs/*`、`tools/*`、`telemetry/*`，接缝策略）三类[cite:2]。这个切分解决了一个本项目正面临的问题：当前 SSE 通道把「给作者看的 token 流」「给作者看的 notice」「给前端的 action 指令」混在同一个事件序列里，缺一层「内部可回放的 durable 事件」。

**Turn / Step 两级循环。** step = 一次模型请求 + 其触发的工具调用；turn = 0 到多个 step。官方 turn flow 顺序为 `turn/start` → 组装 prompt 与 tool schemas → `agent/pre-step` → `step/start` → `agent/request` → `llm/stream` → `agent/assistant-stream` → `tool/call*` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result*` → `step/end` → `agent/turn-stopping` → `turn/end`[cite:2]。这与本项目当前「一次请求 → 一次响应」的扁平结构（[web/server/routes/ai.js#L701-L719](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L701-L719)）相比，多出的正是 `tools/pre-execute` 这类可在执行前拦截的钩子。

**Session log 是模型可见上下文的唯一来源。** dsh 的一条硬规则是 "Model-visible means logged"：模型能看到的任何内容必须先落进 session log，再由 `deriveMessages()` 投影成消息数组[cite:2]。这条规则的价值在于它把「上下文里有什么」与「日志里记了什么」变成同一件事，天然消除了本项目当前「上下文装配了但没记录」的观测盲区。

配置层面，dsh 用 Profile / Bundle / Patch 三层：`dsh --profile web|headless|sdk|sdk-minimal|acp`，每个 profile 有独立的 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，支持 YAML HMR 热重载，`dsh-base` 承载共享底层（模型适配器、工具、持久化、sandbox 与审批策略、设置、凭据、遥测）[cite:2]。`npx @deepseek-ai/dsh web` 可起 Web UI，默认监听 `http://127.0.0.1:3080`[cite:1]。

模型接入侧，dsh 官方 provider 目录含 `anthropic`/`openai`/`moonshotai`(Kimi)/`zai`(GLM)，自定义模型 API 支持 `openai-completions`/`openai-responses`/`anthropic-messages` 三种协议；`compat` 开关用于处理 `supportsDeveloperRole`、`maxTokensField`、`thinkingFormat: deepseek` 等协议细节；`reasoningEfforts` 声明 off/low/medium/high 等级与线上值的映射[cite:3]。这部分设计对本项目的直接启发在于：provider 差异应当收敛在一层「协议兼容开关」里，而不是散落在各 provider 的 `buildBody` 里——本项目当前正是散落状态（[web/server/services/providers/deepseek.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/deepseek.js) 与 [openaiCompat.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/openaiCompat.js) 各写一份 body 构造）。

### 3.2 OpenAI Agents SDK：原语集合

Agents SDK 提供的一组原语[cite:5]：

- **Agents**：内置 loop，任务完成才停止
- **Agents-as-tools / Handoffs**：多 agent 编排的两种模式
- **Guardrails**：输入输出双向校验
- **Function tools / MCP**：工具接入
- **Sessions**：会话状态
- **Human-in-the-loop**：人工介入点
- **Tracing**：调用链路追踪
- **Sandbox agents**：真实隔离工作区，manifest 定义文件，可恢复 sandbox session
- **Realtime agents**（`gpt-realtime-2.1`）、**Voice agents**

TypeScript 版通过 `npm install @openai/agents zod` 安装（要求 Zod v4），分三个入口包：`@openai/agents`、`@openai-agents-realtime`、以及更底层的 core-openai-extensions[cite:7]。

模型侧，默认模型为 `gpt-5.6-luna`（`reasoning.effort="none"`、`verbosity="low"`），前沿场景用 `gpt-5.6-sol`；非 OpenAI 模型通过 `Model`/`ModelProvider` 抽象接入，内置 provider 集成点外还有第三方 adapter（LiteLLM 为 beta、Any-LLM）与 `MultiProvider` 前缀路由[cite:6]。

### 3.3 OpenAI Agents API：托管 harness

Agents API 于 2026-09-10 公测，把 Codex 的 harness 通过 API 开放，OpenAI 托管 harness 运行时，开发者自选沙箱环境（OpenAI hosted，或 Blaxel、Cloudflare、Daytona、DigitalOcean、E2B、Modal、Oracle、Runloop、Vercel 等自有或第三方基础设施）[cite:4]。

托管 harness 提供三项本项目目前完全没有的能力[cite:4]：

1. **自动上下文压缩**——接近上下文上限时自动 compact，无需调用方自己算预算
2. **Tool search**——按需加载工具定义，而不是一次性塞满全部 schema
3. **Programmatic tool calling**——支持并行、链式与过滤的工具调用编排
4. **Multi-agent**——`max_concurrent_subagents` 控制并发子 agent，每个子 agent 拥有独立上下文

### 3.4 三种 harness 形态与本项目的距离

| 维度 | dsh | Agents SDK | Agents API |
|------|-----|-------------|------------|
| 运行时位置 | 本地进程 | 本地进程 | OpenAI 托管 |
| 对接本项目方式 | 嵌入 Node 服务 | 嵌入 Node 服务 | HTTP 调用 |
| 数据是否出本项目控制 | 否 | 否 | 是（对话内容上云） |
| 模型自由度 | 任意 provider | 任意 provider | 以 OpenAI 模型为主 |
| 成熟度 | developer preview[cite:1] | 生产就绪 | 公测[cite:4] |

数据出本项目控制这一行对本项目尤其关键：CuriosityTrail 的对话内容是作者未发表的小说正文，任何一次「把上下文交给托管 harness」都属于把未公开创作内容送出。已经有 provider 抽象 + 本地 Ollama 兜底（[web/server/services/providers/index.js#L17](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/index.js#L17)）的前提下，这条边界不应该被 agent 特性悄悄越过。

---

## 4. 本项目 AI 层现状基线

### 4.1 已具备的 harness 职责（8 项）

盘点结果显示，CuriosityTrail 的 AI 层并非「没有骨架」，而是已经自研实现了 harness 的大部分职责：

| 职责 | 本项目实现位置 | 实现方式 |
|------|---------------|---------|
| 模型抽象与多供应商 | `web/server/services/providers/` | `Provider` 基类 + `DeepSeek`/`OpenAICompat`/`Ollama` 三实现 |
| 供应商降级路由 | `providers/index.js` `resolveProvider()` | 首选 → 降级链，命中非首选标记 `degraded` |
| 流式输出 | `base.js` `readSseStream()` + `routes/ai.js` `send()` | 自定义 SSE 事件序列 |
| 重试与退避 | `base.js` `fetchWithRetry()` | 4xx 非 429 直接抛，5xx/429 指数退避（`500 * 2^attempt`），默认 3 次 |
| 角色/人格系统 | `web/server/services/roles/index.js` | 五角色注册表 + `withOverride()` 三态覆盖 |
| 上下文装配 | `web/server/services/context.js` | 8 层按需注入（作品/章节/人物/设定/内容/衔接/记忆/检索） |
| 长期记忆 | `web/server/services/memory/` | 8 模块（chunker/client/conversation/extractor/indexer/retriever/sources/uris） |
| 结构化输出契约 | `routes/ai.js` `normalizeAction()` | JSON 契约 + action 白名单 + 人工确认写回 |

供应商降级链是 `['deepseek', 'openaiCompat', 'ollama']`（[providers/index.js#L17](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/index.js#L17)），`resolveProvider()` 依次尝试并返回 `{provider, name, degraded, reason}`，未配置首选时自动降级并附原因（[providers/index.js#L44-L73](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/index.js#L44-L73)）。这个降级链的语义在 harness 世界里没有直接对应物，属于本项目的自有资产。

`withOverride()` 的三态语义同样值得留意：`temperature: null` / `model: ''` / `thinking: null` 三者均表示「跟随全局」，而非「覆盖为该值」（[roles/index.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/roles/index.js)）。这是有意为之的细节——harness 世界的采样参数通常是「有值即生效」，不做这种区分。

### 4.2 缺失的核心 harness 能力（6 项）

| 缺失能力 | 证据 | 影响 |
|---------|------|------|
| tool calling 协议 | `web/server` 全目录检索 `tool_call\|tool_calls\|tool_choice\|function_call\|tools\s*:` 无匹配 | 模型只能「回一句话」，无法请求结构化动作 |
| 多步循环 | `routes/ai.js` 单次 `chatStream()` 后直接 `normalizeAction()` | 无「模型说还差一步 → 再调一次模型」的能力 |
| 模型自主决策 | 检索靠 `SEARCH_INTENT`/`WEB_INTENT`/`FETCH_INTENT` 关键词硬编码 | 模型不参与路由，作者问法变了就漏 |
| trajectory（可回放轨迹） | `messages` 表仅 id/conversation_id/role/content/role_key/action/payload/citations/created_at（[database.js#L238-L249](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/database.js#L238-L249)） | 无 prompt 快照、无模型参数快照、无 token、无耗时、无工具调用记录 |
| token 预算 | `context.js` 全文无 `token` 匹配；预算按字符数裁剪（`memory/retriever.js` `applyBudget()`） | 无法按真实成本做上下文分配与自动压缩 |
| 观测埋点 | 无 tracing 层；SSE 事件是面向前端的展示流，不是内部可观测流 | 出问题时无法回答「这次请求模型看到了什么」 |

其中「零 tool calling」这一项影响面最大。当前的替代方案是「结构化输出契约」：模型必须在一次响应里返回 `{"action": ..., "content": ..., "reason": ..., "citations": [...]}`，由作者人工点击确认写回（[routes/ai.js#L101-L134](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L101-L134)）。这个设计在「单轮对话」场景下完全够用，但它把「模型想调用工具」和「模型要跟作者说话」压进了同一个 JSON 契约里，模型无法表达「需要先查一下资料」这种中间态。

值得记录的是，`memory/extractor.js` 的 `extractFacts()` 已经自发实现了一次「harness 内部子 agent」：它对模型做第二次 AI 调用以抽取事实（`provider.chat({temperature: 0.2, thinking: 'disabled', jsonOutput: true, maxTokens: 800})`，[extractor.js#L141-L162](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/memory/extractor.js#L141-L162)）。这是项目内最接近 harness 多步结构的现成代码，也是引入任何 harness 机制时的天然锚点。

### 4.3 结构性约束（4 处硬冲突）

这四点是「不整体引入 harness」结论的主要依据。

**冲突一：记忆策略归属。** 本项目已在设计文档中明确把记忆层策略归到 Node 侧——切块、打标、重排、预算裁剪全部自研（[docs/superpowers/specs/2026-10-27-viking-memory-design.md](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-10-27-viking-memory-design.md)）。dsh 与 Agents SDK 都自带 memory/session 管理，且两者的记忆是围绕 agent 轨迹组织的，与「按作品/章节/人物维度组织的长程创作记忆」不是同一种东西。引入框架记忆 = 记忆双写 = 召回冲突。

**冲突二：采样参数决策。** 项目现行设计决策 11 明确写「参数不留，提示词留」（[docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L1128](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L1128)）。而 harness 的核心卖点之一就是「开放采样参数，让模型自主调节」。且 DeepSeek 思考模式下 temperature 根本无效（设了不报错但无效果），官方明确说明[cite:10]——本项目已经处理了这一点（`decorateRole()` 计算 `temperatureEffective`，[routes/ai.js#L147-L171](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L147-L171)），说明「参数语义」在写作场景里本质是「提示词工程」的一部分，交给模型自主调节收益为负。

**冲突三：人工确认写回 vs 工具自动执行。** 本项目所有会改动用户数据的动作都经过作者点击确认。harness 的范式是「工具自动执行 + 沙箱隔离 + 事后回滚」，两者的安全假设相反。dsh 的 `tools/pre-execute` / `tools/post-execute` 钩子[cite:2]倒是可以承载「执行前请作者确认」，但这意味着把 harness 的自动执行管线改造成半自动执行管线——改动成本高于自研。

**冲突四：无 token 估算。** `context.js` 的 8 层装配用字符上限控制体积（`OUTLINE_LIMIT=4000`、`CONTINUITY_LIMIT=500`、`CONTENT_LIMIT=12000`、`INSPIRATION_LIMIT=10`，[context.js#L26-L32](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/context.js#L26-L32)），记忆层 `applyBudget()` 同样按字符裁剪。依赖 token 预算做编排的框架（包括 Agents API 的自动 compact、Agents SDK 的上下文管理）无法直接复用这套装配——要么换算字符↔token 比例（不稳定，且中文场景比例与英文差异大），要么双轨维护。

### 4.4 其他工程事实

| 事实 | 位置 | 对选型的影响 |
|------|------|---------------|
| 生产依赖仅 12 个，无任何 AI SDK | [web/server/package.json](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/package.json) | 引入 SDK 会打破「零 AI 依赖」现状，供应链面扩大 |
| 无 monorepo，三包并列 | 根目录 + `web/server` + `web/client` | SDK 的 workspace 依赖管理优势用不上 |
| E2E 无任何 AI 对话覆盖 | `web/e2e/specs/` 检索 `/api/ai` 无匹配 | 引入 harness 后无法靠现有 E2E 保证不回归，需从零建测试 |
| `web/server/agent/tools`、`web/server/agent/memory` 为空目录 | 2026-05 重构删除 `agent/` 目录的遗留 | 目录名有误导性，若引入 agent 概念需先清理 |
| Node 版本声明不一致 | 根 `package.json` 声明 `18.x`，CI 三处用 `20` | SDK 的最低 Node 要求需与 CI 一致，先统一 |
| 旧文档完全过时 | `docs/AGENT_ARCHITECTURE.md`（326 行）、`docs/AI助手使用指南.md`（108 行） | 描述的是旧产品形态，与现行代码不符，需在引入任何新架构前废弃 |
| provider 层已透传 usage，但流式路径不返回 | `chat()` 返回 usage；`chatStream()` 返回 `{content, reasoning, finishReason}`，无 usage（[providers/deepseek.js#L110-L160](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/deepseek.js#L110-L160)） | 流式路径是主路径，token 统计在这里断掉，是可观测性缺口的直接来源 |

---

## 5. 能力对比矩阵

### 5.1 九维度 feature matrix

图例：✅ 完整支持　⚠️ 基础/受限　❌ 不支持　🔜 规划中

| 维度 | dsh | Agents SDK | Agents API | 本项目现状 |
|------|-----|------------|-----------|-----------|
| 工具调用（function tool） | ✅ scoped 注册表 + guarded 管线[cite:2] | ✅ 原语[cite:5] | ✅ Codex harness[cite:4] | ❌ 零协议 |
| 多步 agent 循环 | ✅ turn/step 两级[cite:2] | ✅ 内置 loop[cite:5] | ✅ 托管[cite:4] | ❌ 单次请求 |
| 轨迹可回放 | ✅ append-only session log[cite:2] | ⚠️ Tracing[cite:5] | ⚠️ 平台侧[cite:4] | ❌ 无快照 |
| 上下文自动压缩 | ⚠️ 需自建[cite:2] | ⚠️ 需自建[cite:5] | ✅ 自动 compact[cite:4] | ❌ 按字符裁剪 |
| 工具按需加载 | ⚠️ 需自建[cite:2] | ⚠️ 仅 OpenAI 模型侧[cite:6] | ✅ tool search[cite:4] | ❌ 不适用 |
| 多 agent 编排 | ✅ 插件化[cite:2] | ✅ as-tools / handoffs[cite:5] | ✅ `max_concurrent_subagents`[cite:4] | ❌ 不适用 |
| 沙箱隔离 | ✅ 内置[cite:2] | ✅ sandbox agents[cite:5] | ✅ 多云可选[cite:4] | ❌ 不适用 |
| 人工介入（HITL） | ✅ 审批策略在 dsh-base[cite:2] | ✅ 原语[cite:5] | 🔜 未列明 | ✅ 人工确认写回 |
| 非 OpenAI 模型接入 | ✅ 三协议 + compat[cite:3] | ✅ ModelProvider / LiteLLM / Any-LLM[cite:6] | ⚠️ 以 OpenAI 为主 | ✅ 三 provider 抽象 |

### 5.2 关键差异归因

三行最重要的结论：

**「工具按需加载」与「上下文自动压缩」两行，Agents API 领先，原因是它托管了 harness。** 这两项本质是「在客户端拼装请求」的工作，托管方拥有完整的历史，因此可以做出更聪明的取舍；本地 SDK 必须自己实现，而 dsh 虽然有 `ctx.llm` 这样的扩展点[cite:2]，官方并未把它做成开箱能力。

**「人工介入（HITL）」一行，本项目领先于所有三方。** 本项目的 action 白名单 + 作者点击确认，是一套已经跑通的、写回安全的产品级设计。harness 侧的 HITL 更偏向「agent 请求批准工具执行」，语义粒度不同，但都指向同一件事：模型不能直接改用户数据。这条不用改。

**「非 OpenAI 模型接入」一行，dsh 与 Agents SDK 成熟度接近，本项目现状也够用。** 引入任何框架在这一点上都不带来增量收益。

### 5.3 借鉴适用性交叉矩阵

把两个框架拆成「可直接借鉴的设计」与「会与本项目冲突的部分」，落入四象限：

| | 契合本项目产品原则 | 存在冲突或高改造成本 |
|---|---|---|
| **低改造成本**（能直接抄） | 工具注册表 + scoped 执行管线[cite:2]；append-only session log 作为 trajectory[cite:2]；turn/step 循环骨架[cite:2]；事件三域分离[cite:2]；compat 协议开关层[cite:3] | 上下文自动压缩[cite:4]（依赖 token 统计，当前断链） |
| **高改造成本**（能抄但要重写） | Handoff 作为「角色切换」[cite:5]（需适配五角色三态覆盖语义）；Guardrails 用于校验模型 JSON 契约[cite:5]（现为手写 `normalizeAction()`）；tool search[cite:4]（需先有工具注册表） | 多 agent 编排[cite:2][cite:4]（与「角色由作者手选」直接冲突）；沙箱[cite:2][cite:5]（本项目无代码执行需求）；框架内置 memory[cite:2]（与 Node 侧记忆层双写）；托管式 harness[cite:4]（数据出本项目控制） |

---

## 6. 冲突点分析

### 6.1 「模型零参与路由」是产品决策，不是技术缺陷

本项目的检索触发靠关键词白名单：`SEARCH_INTENT`（站内检索）、`WEB_INTENT`（联网检索）、`FETCH_INTENT`（抓原文），加上一条特例——`researcher` 角色无条件触发检索与联网（[routes/ai.js#L244-L269](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L244-L269)）。这套规则确实有漏判风险（作者换个说法就检索不到），但它的另一面是**确定性**：作者知道「资料员角色一定会联网查资料」，不会担心模型这次没查就给答案。

harness 的解法是让模型自己决定要不要调工具。这在通用任务里是净收益，在创作辅助里是负收益——因为「模型这次忘了查」对作者是不可见的失败模式。折中方案存在但不来自 harness：把关键词白名单当作「快捷方式」，把模型决策当作「兜底」，两者并存，由作者在 UI 上看到本次是否触发了检索即可。

### 6.2 「人工确认写回」与 harness 安全模型的不可调和点

harness 的安全边界建立在「沙箱 + 可回滚」上：工具可以自动执行，因为执行环境是隔离的，出错了能恢复。dsh 的 `tools/pre-execute`/`tools/post-execute` 钩子[cite:2]提供了介入点，Agents SDK 的 HITL 也提供了同等能力[cite:5]。

但本项目的写回对象不是代码文件，是作者的章节正文。一个 harness 沙箱不解决「模型把作者的稿子改坏了」这个问题——沙箱隔离的是进程环境，不是数据语义。真正管用的是「改动必须有 diff 且经人确认」，这恰恰是本项目现有的 action 契约在做的事。所以这里的正确结论不是「引入 harness 的 HITL」，而是「保留现有契约，把 harness 的事件钩子思路用在观测侧」。

### 6.3 dsh 特有的三个障碍

**developer preview 的破坏性变更承诺。** 官方 README 明确警告会有兼容性破坏变更[cite:1]。对一个已经跑在生产上的写作平台，引入一个自己承诺会破坏 API 的运行时依赖，意味着每一次上游更新都要重新评估。

**Cordis 插件内核与 Express 单体的范式冲突。** dsh 的世界假设「一切皆插件，内核无特权」[cite:2]。本项目是 Express 单体 + 12 个生产依赖的服务端结构，模块之间用直接 `require` 调用。把 dh 装进来意味着要么把现有 `services/` 全部改写成插件（工作量极大），要么让 dsh 插件与现有模块两套并存（依赖关系混乱）。

**记忆层冲突最直接。** dsh 的 session log 是 append-only 的对话事件流；本项目的记忆层是按作品/章节/人物/设定组织的可检索长程记忆（8 个模块）。两者语义完全不同，把 dsh 的 session log 当记忆用，会丢掉「跨作品、跨时间的人物一致性」这一写作场景的核心能力；把本项目记忆层当 tool 用，则 dsh 的轨迹完整性会被破坏。

### 6.4 Agents SDK 特有的三个障碍

**Responses-only 能力在 DeepSeek 侧大面积不可用。** Agents SDK 的下列特性只支持 Responses API：`ToolSearchTool`、`tool_namespace()`、`defer_loading=True`、`ProgrammaticToolCallingTool`/`allowed_callers`/`tool_choice="programmatic_tool_calling"`，以及 `reasoning.mode`/`reasoning.context`[cite:6]。DeepSeek 侧的 `tools` 表只接受 `function`、`custom`（仅 `apply_patch`）、`web_search`（仅 `deepseek-v4-pro`），其余内置工具被忽略[cite:11][cite:12]。

**无状态导致 reasoning 无法跨轮续接。** DeepSeek 不支持 `previous_response_id`、`conversation`、`store`、`background`、`metadata`、`include`、`truncation`、`context_management`、`stream_options`、`prompt_cache_key`；不支持的参数被**静默忽略而非报错**[cite:12]。这意味着不能用服务端存储做 reasoning 的跨轮续接，多步循环里的每一轮 reasoning 都要靠客户端自己回传。

**非 OpenAI 模型的实际支持面窄于抽象层。** SDK 提供了 `Model`/`ModelProvider` 抽象、LiteLLM（beta）与 Any-LLM adapter[cite:6]，但这些 adapter 面向的是「OpenAI 兼容协议」。DeepSeek 虽然原生支持 Responses API 与 Anthropic Messages API[cite:11][cite:13]，但走 SDK 抽象时能否完整吃下 Responses-only 语义，取决于 adapter 实现，官方文档未给出承诺。

### 6.5 DeepSeek 侧的能力真相（与前期判断的修正）

前期基于只采集 Chat Completions 文档的判断是「OpenAI Agents SDK 的 Responses 路径对 DeepSeek 不可用」。本轮补充核实 API schema 页[cite:11]与兼容矩阵页[cite:12]后，该判断需要修正：

| 能力 | DeepSeek Responses API | 说明 |
|------|------------------------|------|
| function 工具 | ✅ | `tools` 支持 `function` 类型 |
| json_schema 结构化输出 | ✅ | `text.format` 支持 `json_object` / `json_schema` |
| 真实 token usage | ✅ | `usage` 含 `input_tokens`/`output_tokens`/`reasoning_tokens`/`cached_tokens` |
| reasoning effort | ✅ | `reasoning.effort` 支持 none/low/high/max |
| 语义化 SSE 事件流 | ✅ | 含 `response.output_text.delta` 等，无 `data: [DONE]` |
| tool search / deferred loading | ❌ | `tools` 表不含对应类型 |
| programmatic tool calling | ❌ | 不支持 |
| 服务端状态续接 | ❌ | `previous_response_id`/`conversation`/`store` 均不支持 |
| context_management | ❌ | 不支持，自动压缩需自建 |
| MCP 工具 | ❌ | Anthropic 兼容层同样不支持 `mcp_tool_use`[cite:13] |

修正后的结论：**Responses 基础路径（function tool + json_schema + usage）可行**，且是本项目最该利用的一格——因为 `usage` 里的真实 token 数恰好能补上「无 token 估算」这个冲突四。

DeepSeek 侧还有一个对本项目特别有用的资产：官方提供了 Codex 集成脚本（写 `~/.codex/models.json` 与 `config.toml`），其模型目录显式声明了 `context_window: 1048576`、`supported_reasoning_levels: [low, high, max]`、`apply_patch_tool_type: freeform`、`web_search_tool_type: text`、`truncation_policy: {mode: tokens, limit: 10000}`[cite:14]。这份声明说明 DeepSeek 端对「上下文预算 + 截断策略 + 推理等级」是有明确设计的，客户端可以照抄这套参数语义。

---

## 7. 各 harness 的引入评估

### 7.1 DeepSeek Harness：建议不引入

**判定：不引入作为运行时依赖，借鉴其架构。** 信心：高。

理由按权重排序：

1. developer preview 阶段，官方承诺破坏性变更[cite:1]（信心：高，官方文档直述）
2. Cordis 插件内核与 Express 单体范式冲突（信心：高，项目结构可验证）
3. 记忆层双写冲突（信心：高，两侧语义可对照）
4. 模型零参与路由是产品决策（信心：中高，代码与设计文档一致）

采纳的部分：工具注册表 + guarded 执行管线、append-only session log、turn/step 循环、事件三域分离、compat 协议开关层——五项全部可自研落地，合计估算 ~500 行 Node 代码，不引入外部依赖。

### 7.2 OpenAI Agents SDK：建议不引入，但保留 Responses API 切换

**判定：作为依赖不引入；作为协议参照采纳。** 信心：高。

不引入的理由：Responses-only 特性在 DeepSeek 侧大面积不可用（§6.4）、无状态导致多步 reasoning 续接不可行、且当前主路径是 DeepSeek + Chat Completions，SDK 抽象带来的收益不足以抵消迁移成本。

需要采纳的两点：

- **Responses API 作为 DeepSeek provider 的升级目标。** 它同时解决三件事：拿到真实 token usage（补冲突四）、拿到语义化 SSE 事件（补可观测性）、拿到 json_schema 结构化输出（当前是 `response_format: {type: 'json_object'}` 的宽松 JSON，需要手写 `parseModelJson` 容错[providers/deepseek.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/deepseek.js)）。
- **Guardrails 思路用于加固 `normalizeAction()`。** 当前 `normalizeAction()` 只做类型归一与白名单过滤[routes/ai.js#L101-L134](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L101-L134)，没有「模型输出的 content 是否超出预期长度/是否包含禁用字段」这类约束。Agent SDK 的 guardrail 模式（输入输出双向校验[cite:5]）可以直接借鉴为一条本地校验链，不需要引入 SDK。

### 7.3 OpenAI Agents API：建议不引入

**判定：明确不引入。** 信心：高。

三条独立理由，任何一条都足以否决：

1. **数据出本项目控制。** 未发表的小说正文将进入 OpenAI 托管的 harness。本项目已有 provider 抽象 + 本地 Ollama 兜底，向作者承诺「对话内容不出你的机器」是有产品价值的资产，不应被 agent 特性悄悄越过。
2. **公测阶段。** 发布至今约 7 周[cite:4]，接口稳定性存疑。
3. **核心优势无法迁移。** 自动 compact、tool search、programmatic tool calling 三项[cite:4]都依赖服务端状态，而 DeepSeek 侧不支持 `store`/`previous_response_id`/`context_management`[cite:12]——即便换个模型用托管 harness，本项目的 DeepSeek 主力配置也用不上。

---

## 8. 可借鉴项与不该引入项

### 8.1 建议借鉴（按优先级）

**P0-1　工具注册表 + scoped 执行管线（源自 dsh `core/tools`）[cite:2]**

在本项目新增 `web/server/services/tools/` ，包含：工具声明表（name / description / 参数 JSON Schema / 执行函数 / 是否需要作者确认）、注册表、按 scope 过滤的解析、执行管线（pre-execute → execute → post-execute → 产出结果事件）。首批工具建议：`searchMaterials`（站内检索）、`webSearch`、`webFetch`、`readOutline`、`readChapter`、`readCharacterSheet`。每个工具的 `pre-execute` 钩子直接对接现有的 action 白名单与作者确认流程。

工具声明的字段集合（`type` / `name` / `description` / `parameters` / `strict`）与 namespace 机制可参照 OpenAI 的 function calling 规范[cite:8]；参数 JSON Schema 的可用子集则受 DeepSeek 侧约束——其 `strict` 模式仍是 Beta，要求 `base_url=https://api.deepseek.com/beta`、所有 function 标记 `strict: true`、object 必须声明 `additionalProperties: false` 且把所有属性列入 `required`[cite:9]。因此工具声明应按「最小可用子集」设计，不要直接照搬 OpenAI 的完整 schema 能力。

这是本次评估中收益最高的一项：它一次性解决「零 tool calling 协议」和「模型零参与路由」两个洞，且不触碰任何产品原则。

**P0-2　真实 token 统计（源自 DeepSeek Responses API usage 字段）[cite:11]**

把 DeepSeek provider 从 Chat Completions 切到 Responses API，取 `usage.input_tokens`/`output_tokens`/`reasoning_tokens`/`cached_tokens`，并在流式路径上补齐（当前 `chatStream()` 返回值不含 usage）。这一步的成本低于「自研字符↔token 换算」，且精度更高。

**P0-3　append-only session log 作为 trajectory（源自 dsh `core/session`）[cite:2]**

在 `messages` 表之外新增一张 `agent_runs` / `agent_events` 表，记录每次请求的：完整 prompt 快照、生效的模型与采样参数、token 用量、耗时、工具调用序列、最终 action。规则取自 dsh 的 "Model-visible means logged"[cite:2]——模型看到的任何内容必须先落库。当前 `messages` 表缺少这些字段（[database.js#L238-L249](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/database.js#L238-L249)），这是排查「模型为什么这么写」的唯一途径。

**P1-1　turn/step 循环骨架（源自 dsh turn flow）[cite:2]**

按 dsh 的 turn flow 顺序实现 turn 状态机：`turn/start` → 组装 prompt 与 tool schemas → `step/start` → `agent/request` → `llm/stream` → `tool/call*` → `tools/pre-execute` → `tools/execute` → `tools/post-execute` → `tool/result*` → `step/end` → `turn/end`。关键点是保留 `tools/pre-execute` 这个可拦截位置——本项目可以在这里插入「作者确认」，从而在不放弃人工确认原则的前提下获得多步能力。

**P1-2　事件三域分离（源自 dsh）[cite:2]**

把当前混在一起的 SSE 流拆成三层：durable（落库，可回放）、live（推给前端）、capability（工具/文件系统/遥测接缝）。当前 `routes/ai.js` 的 SSE 序列（notice → notice → memory → token → error → done → action → done）[routes/ai.js#L670-L841](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L670-L841) 全部属于 live 域，durable 域是空的。

**P1-3　compat 协议开关层（源自 dsh `compat`）[cite:3]**

把 provider 差异（`supportsDeveloperRole`、`maxTokensField`、`thinkingFormat`、`reasoningEfforts` 映射）收敛为一张显式的兼容表，而不是散落在各 provider 的 `buildBody` 里。当前 deepseek.js 与 openaiCompat.js 各写一份 body 构造（[providers/deepseek.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/deepseek.js)、[providers/openaiCompat.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/openaiCompat.js)），每次新增模型协议都要改两处。

**P2-1　Guardrails 用于 JSON 契约加固（源自 Agents SDK）[cite:5]**

在 `normalizeAction()` 之上加一层约束校验：字段白名单、长度上限、引用格式合法性。失败时降级为 `action: 'comment'` 而不是抛错。

### 8.2 明确不该引入

| 不该引入的东西 | 理由 |
|----------------|------|
| dsh 作为运行时依赖 | developer preview + 破坏性变更承诺[cite:1]；Cordis 内核范式与 Express 单体不匹配 |
| dsh 的 Cordis 插件内核 | 「一切皆插件」与项目现有模块组织无重叠，迁移成本高于收益 |
| Agents SDK 作为 npm 依赖 | Responses-only 特性在 DeepSeek 侧大面积不可用[cite:6][cite:12]；收益不足以抵消迁移 |
| Agents API 作为服务 | 未发表创作内容出本项目控制；公测阶段；核心优势依赖服务端状态[cite:4] |
| 任何形式的框架内置 memory | 与 Node 侧 8 模块记忆层双写，召回冲突 |
| 多 agent 自动编排 | 与「角色由作者手选」直接冲突（[roles/index.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/roles/index.js)） |
| 代码沙箱 | 本项目无代码执行场景；写回对象是正文而非代码，沙箱解决不了数据语义问题 |
| 托管式 tracing | 同 Agents API，创作内容出控制 |

---

## 9. 分阶段应用建议

### 阶段一：把观测补上（无行为变更）

- 新增 `agent_runs` 表：prompt 快照、生效模型与采样参数、token 用量、耗时、工具调用序列、最终 action
- DeepSeek provider 切 Responses API，取真实 usage；在 `chatStream()` 返回值中补齐 usage
- 把模型可见上下文按 "Model-visible means logged" 原则落库

**验收**：任意一次历史对话都能重放出「模型当时看到了什么、输出了什么、消耗多少 token」。

### 阶段二：引入工具注册表（行为增强）

- 新增 `services/tools/`，先落地 `searchMaterials`、`readOutline`、`readChapter`、`webSearch` 四个只读工具
- 工具声明走 JSON Schema，与模型输出契约并存（工具调用结果作为下一 step 的上下文回灌）
- `pre-execute` 钩子接人工确认，保持写回安全模型不变

**验收**：模型能自主决定是否查资料，且作者能在 UI 上看到「本次调用了哪个工具、返回了什么」。

### 阶段三：多步循环

- 实现 turn/step 状态机，参照 dsh 的 turn flow 顺序
- 引入 step 级上限（防跑飞），超出即回落到单步行为
- 循环事件按事件三域分离落库

**验收**：一次对话可完成「查资料 → 写段落 → 作者确认」的多步链路，且每一步可单独回放。

### 阶段四：按需引入

- 上下文自动压缩（依赖阶段一的真实 token）
- 工具按需加载（依赖阶段二的注册表）
- 子 agent（仅限记忆抽取这类内部任务，参照现有 `extractFacts()` 的形态）

### 贯穿各阶段的工程债清理

- 统一 Node 版本声明（根 `package.json` 的 `18.x` vs CI 的 `20`）
- 废弃 `docs/AGENT_ARCHITECTURE.md` 与 `docs/AI助手使用指南.md`（描述的是旧产品形态）
- 清理 `web/server/agent/tools`、`web/server/agent/memory` 两个空目录残留
- 补 E2E 的 AI 对话覆盖（当前 `web/e2e/specs/` 完全无 `/api/ai` 用例）

---

## 10. 结论

两套 harness 回答的都是同一个问题——「模型之外还需要什么」。DeepSeek Harness 给出的答案是「插件」，OpenAI 给出的答案是「托管的 Codex harness + SDK 原语」。这两个答案都不适配 CuriosityTrail。

适配的原因是产品形态的差异：harness 服务于「模型在沙箱里自主完成任务」，CuriosityTrail 服务于「作者与模型协作完成一次创作」。前者需要模型有最大的行动自由，后者需要模型行动之前先问一句。

但两套 harness 在别的地方留下了值得带走的痕迹，而且这些痕迹恰好落在本项目最薄弱的环节上：dsh 的 `core/tools` 补工具注册表，`core/session` 补轨迹，turn/step 补多步，事件三域补观测；OpenAI 的 Responses API 补真实 token 与结构化输出，guardrail 补契约加固。这些都不需要引入框架，全部可以以自研方式落地，估算总改动在千行以内，且不触碰任何已定的产品原则。

真正需要警惕的不是「引入不引入框架」，而是「AI 层继续按单次请求的形态长下去」。当前零 tool calling、零 token 统计、零轨迹快照的现状，在功能上看似稳定，但每增加一个依赖多轮交互的特性（自动查资料、跨章节一致性校验、长篇上下文管理），都会撞到同一个天花板——没有步的概念。

---

## Sources

<a id="cite-1"></a>[cite:1] DeepSeek Harness 官方仓库 README — https://github.com/deepseek-ai/deepseek-harness

<a id="cite-2"></a>[cite:2] DeepSeek Harness 架构参考（Architecture Reference） — https://deepseek-harness.github.io/deepseek-harness/en/reference/

<a id="cite-3"></a>[cite:3] DeepSeek Harness 模型配置指南（Providers） — https://deepseek-harness.github.io/deepseek-harness/en/guide/providers

<a id="cite-4"></a>[cite:4] Introducing the OpenAI Agents API（2026-09-10） — https://openai.com/index/introducing-the-agents-api/

<a id="cite-5"></a>[cite:5] OpenAI Agents SDK for Python 官方文档首页 — https://openai.github.io/openai-agents-python/

<a id="cite-6"></a>[cite:6] OpenAI Agents SDK — Models 指南 — https://openai.github.io/openai-agents-python/models/

<a id="cite-7"></a>[cite:7] OpenAI Agents SDK for TypeScript 官方文档首页 — https://openai.github.io/openai-agents-js/

<a id="cite-8"></a>[cite:8] OpenAI Platform — Function Calling 指南 — https://platform.openai.com/docs/guides/function-calling

<a id="cite-9"></a>[cite:9] DeepSeek API — Tool Calls 指南（含 strict 模式 Beta） — https://api-docs.deepseek.com/guides/tool_calls

<a id="cite-10"></a>[cite:10] DeepSeek API — Thinking Mode 指南 — https://api-docs.deepseek.com/guides/thinking_mode

<a id="cite-11"></a>[cite:11] DeepSeek API — Responses API 请求 schema（create-response） — https://api-docs.deepseek.com/api/create-response

<a id="cite-12"></a>[cite:12] DeepSeek API — Responses API 兼容矩阵与流式事件（responses_api） — https://api-docs.deepseek.com/guides/responses_api

<a id="cite-13"></a>[cite:13] DeepSeek API — Anthropic Messages 兼容层（anthropic_api） — https://api-docs.deepseek.com/guides/anthropic_api

<a id="cite-14"></a>[cite:14] DeepSeek API — Agent Integrations: Codex（models.json 模型目录） — https://api-docs.deepseek.com/quick_start/agent_integrations/codex

### 项目侧证据索引（不占引用编号）

| 结论 | 位置 |
|------|------|
| 零 tool calling 协议 | `web/server` 全目录检索 `tool_call\|tool_calls\|tool_choice\|function_call\|tools\s*:` 无匹配 |
| 无 token 概念 | `web/server/services/context.js` 全文检索 `token` 无匹配 |
| provider 降级链 | [providers/index.js#L17](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/index.js#L17)、[providers/index.js#L44-L73](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/providers/index.js#L44-L73) |
| action 白名单与归一化 | [routes/ai.js#L101-L134](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L101-L134) |
| 角色三态覆盖与温度生效判定 | [routes/ai.js#L147-L171](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L147-L171) |
| 检索意图硬路由 | [routes/ai.js#L244-L269](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L244-L269) |
| 流式调用与 SSE 事件序列 | [routes/ai.js#L701-L719](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L701-L719)、[routes/ai.js#L670-L841](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/ai.js#L670-L841) |
| 上下文 8 层装配与字符上限 | [context.js#L1-L32](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/context.js#L1-L32) |
| 记忆按字符裁剪 | `web/server/services/memory/retriever.js` `applyBudget()` |
| 已有的内部子 agent 调用 | [memory/extractor.js#L141-L162](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/services/memory/extractor.js#L141-L162) |
| messages 表字段缺口 | [database.js#L238-L249](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/database.js#L238-L249) |
| 生产依赖清单（12 个，无 AI SDK） | [web/server/package.json](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/package.json) |
| Node 版本声明不一致 | 根 `package.json:9`（`18.x`）vs `.github/workflows/ci.yml:16,33,50`（`20`） |
| E2E 无 AI 覆盖 | `web/e2e/specs/` 检索 `/api/ai` 无匹配 |
| 删除 agent/ 目录的设计决策 | [docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L479](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L479)、[#L972](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L972) |
| 「参数不留，提示词留」决策 | [docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L1128](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-05-25-ai-novel-writing-platform-design.md#L1128) |
| 记忆策略归 Node 侧 | [docs/superpowers/specs/2026-10-27-viking-memory-design.md](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/docs/superpowers/specs/2026-10-27-viking-memory-design.md) |
