# AI 辅助小说创作平台 — 设计文档

- 日期：2026-05-25
- 状态：待评审
- 作者：Trae（brainstorming 流程产出）

---

## 1. 背景与目标

### 1.1 现状

当前项目 `CuriosityTrail` 是一个"科学探索记录与文献管理工具"。后端 Express + SQLite，前端 React + Ant Design。

改造前必须先认清既有的结构性问题，它们决定了本次改造不能是"换个壳"：

| 问题 | 位置 | 影响 |
|---|---|---|
| 前端块编辑器的 `blocks` 字段被后端丢弃 | 前端 `ReportEditor.jsx` 发送 `blocks`；后端 `routes/reports.js` 只解构 `{title, content}`；`database.js` 的 `reports` 表无该列 | 块级编辑（分栏、图片块、引用块、格式）保存后 100% 丢失，重开退化为一段纯文本 |
| AI 助手前后端契约不匹配 | 前端 `AgentAssistant.jsx` POST `{messages}` 并读 `res.data.message`；后端 `routes/agent.js` 期望 `{message}`，返回 SSE | 当前 UI 上的 AI 对话完全不可用 |
| 文献 PDF 从未被解析 | `documents` 表无 `content` 列，无任何 PDF 解析库 | "AI 搜索自己的材料"当前为 0 基础 |
| 无向量检索 / 无 RAG | `services/ollama.js` 有 `embed()` 但零调用方 | 同上 |
| 零鉴权 | `index.js` 中间件只有 cors / json / fileUpload | 任何人可读写全部报告与文献 |
| Agent 工具绕过 provider 层 | `agent/tools/*` 直接 import `services/ollama.js` | 切换 chatService 后工具仍走 Ollama，服务抽象失效 |
| 951 行死代码 | `AIConfig.jsx`、`TranslationSettings.jsx` 未被 `App.jsx` 引用 | 配置入口实际不存在 |
| 翻译功能坏 | `routes/translate.js` 读 `doc.content`（该列不存在）；`TranslationSettings.jsx` POST 后端不存在的路由 | 功能不可用 |
| 知识图谱空转 | `routes/graph.js` 的 `citation_count` 恒为 `0 as citation_count` | 从未真正聚合过 |

### 1.2 目标

把项目改造为一个**单人使用的 AI 辅助小说创作平台**。使用者是一位小说作者（当前唯一用户），她需要在写长篇时获得 AI 的持续协助。

核心诉求（来自用户原始描述）：

1. AI 帮写作——起稿、编辑、以及写作过程中的一切协助
2. 平台内置搜索——用户把自己的材料放进来，AI 主动去搜并把结果返回
3. 从用户视角（写作者）、编辑视角、AI 作为"编辑"的身份三个角度规划
4. AI 主动提供灵感
5. 预制提示词来规范 AI 的输出
6. 需要一个配置区

### 1.3 已确认的决策

| 决策点 | 结论 |
|---|---|
| 用户规模 | 单人（用户本人与太太），不做登录与用户隔离 |
| 写作类型 | 小说 |
| AI 交互形态 | 行内（微观改写）+ 侧边栏（宏观协作）双通道，分工明确 |
| 大模型 | DeepSeek，API key 由用户稍后提供，放服务器环境变量 |
| 联网搜索 | DeepSeek Search API（`/v1/tools/search`）与 Fetch API（`/v1/tools/fetch`） |
| 旧功能处置 | 不需要即砍，由本设计统一裁定 |

### 1.4 非目标

明确不做，避免范围蔓延：

- 不做多用户、注册、登录、权限体系
- 不做云同步、多端、协同编辑
- 不做图片生成（文生图能力）
- 不做向量数据库（依赖外部 embedding 服务；改用 FTS5 + DeepSeek 搜索，见 §6）
- 不做移动端原生 App
- 不保留论文/学术写作场景（旧的两套报告模板整体废弃）

---

## 2. 产品形态

### 2.1 与原产品的对比

| | 原产品 | 改造后 |
|---|---|---|
| 核心对象 | 报告（扁平长文） | 作品 → 章节 → 场景（层级） |
| 上下文 | 无，AI 看不到前文 | 装配器自动注入人物卡、设定、大纲、当前场景、上一场景结尾、检索片段 |
| AI 角色 | 单一通用助手 | 作家 / 编辑 / 审稿人 / 灵感师 / 资料员，五个可切换身份 |
| 搜索 | 仅报告标题与正文 LIKE | 站内素材 FTS5 全文检索 + DeepSeek 联网搜索，AI 主动调用并带引用返回 |
| 灵感 | 无 | 灵感速记本，随手记，AI 消费后产出情节建议 |
| 配置 | 死代码 | 活的设置中心，提示词可编辑可持久化 |

### 2.2 界面布局

三栏布局，桌面优先，最小宽度 1280px：

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│ 作品/章节树   │        块编辑器（主区）          │  AI 侧边栏        │
│              │                               │                  │
│ 作品标题      │  ┌─────────────────────────┐  │ [作家|编辑|审稿|  │
│  第一卷      │  │ 正文块                   │  │  灵感|资料]     │
│   第一章 ✓   │  │ 对白块                   │  │                  │
│    场景 1 ✓  │  │ 正文块                   │  │  ┌────────────┐  │
│   第二章 ✎   │  │ [选中文字→浮出操作工具条]  │  │  │ 对话消息流  │  │
│  第二卷      │  └─────────────────────────┘  │  │            │  │
│              │                               │  └────────────┘  │
│ ─────────    │  [+正文][+对白][+场景分隔][+插图] │  [输入框][发送]  │
│ 人物 (4)     │                               │                  │
│ 设定 (12)    │                               │                  │
│ 素材 (28)    │                               │                  │
│ 灵感 (7)     │                               │                  │
└──────────────┴───────────────────────────────┴──────────────────┘
```

**左栏**是导航树，聚合六类对象：作品章节树、人物卡、世界观设定、素材库、灵感速记。每一类可折叠，折叠状态持久化到 localStorage。

**中栏**是块编辑器，承载章节内的场景块序列。选中文字时在选区上方浮出操作工具条（改写/扩写/缩写/换语气/续写/找茬/口语化）。块本身可增删、可上下移动、可切换类型。

**右栏**是 AI 侧边栏，顶部是五个角色的切换标签，下方是消息流。宏观操作（整章重写、生成下一章大纲、梳理人物关系、查资料）在此发起。侧边栏可折叠，折叠后主区获得全宽。

**双通道分工的边界**：

| 通道 | 粒度 | 典型动作 |
|---|---|---|
| 行内工具条 | 一个选区 | 改写这段、扩写、缩写、换语气、续写下一句、找出语病 |
| 侧边栏 | 整章 / 整部作品 | 重写整章、生成下一章大纲、检查人物设定一致性、搜素材、给灵感 |

同一次 AI 调用走同一条链路，只是上下文装配范围不同。行内调用的上下文 = 选区 + 邻接块 + 相关人物卡 + 设定；侧边栏调用的上下文 = 作品大纲 + 当前章 + 人物卡全集 + 设定全集 + 检索片段。

### 2.3 五个 AI 角色

角色是提示词预设 + 参数预设的组合，用户可切换，也可编辑其提示词。

| 角色 | 职责 | 典型动作 | 输出倾向 |
|---|---|---|---|
| 作家 | 生成新内容 | 起稿、续写场景、扩写描写 | 文学性，重视画面与节奏 |
| 编辑 | 修改已有内容 | 改写、润色、删冗余、调节奏 | 克制，解释改了什么、为什么 |
| 审稿人 | 挑问题 | 找逻辑漏洞、找设定冲突、找重复表达 | 直率，列条目，不客气 |
| 灵感师 | 提供点子 | 情节走向、人物动机、冲突设计、反转 | 发散，给多个方向而非单一答案 |
| 资料员 | 找信息 | 搜站内素材、搜网络、汇总并标注来源 | 只讲有来源的，无来源明说 |

角色定义存放在 `services/roles/`，每个角色包含：系统提示词、默认温度、默认动作集、输出格式约束。用户在设置页可覆盖默认提示词，覆盖后存库，不改代码。

### 2.4 结构化输出契约

AI 的输出必须能被程序消费，而不是只能复制粘贴。所有角色输出统一为 JSON：

```json
{
  "action": "replace | append | insert | comment | none",
  "target": "<选区或块 id，可空>",
  "content": "生成或改写后的正文",
  "reason": "改动理由，comment 类必填",
  "citations": [
    { "source": "material:12", "title": "素材标题", "snippet": "引用片段" }
  ]
}
```

- `replace` — 替换目标选区
- `append` — 追加到目标块末尾
- `insert` — 在目标位置插入新块
- `comment` — 只给建议，不改正文（审稿人默认）
- `none` — 纯对话回复，不涉及正文

DeepSeek 支持 JSON Output（`response_format: {"type": "json_object"}`），提示词中含 "json" 字样即可启用，实现成本低。

前端收到 `action` 后决定回写方式：`replace`/`append` 直接改块内容；`insert` 新增一个块；`comment` 在侧边栏以卡片形式呈现，不动正文。`citations` 渲染成可点击的来源角标。

---

## 3. 数据模型

### 3.1 表结构

全新 schema，与旧 `reports` / `documents` / `citations` / `keywords` 无关。旧表在迁移中重命名保留 90 天后删除。

```sql
-- 作品
CREATE TABLE works (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  genre        TEXT,                  -- 题材：悬疑/言情/科幻…
  synopsis     TEXT,                  -- 一句话简介
  outline      TEXT,                  -- Markdown 大纲
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 章节
CREATE TABLE chapters (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  seq          INTEGER NOT NULL,      -- 章节序号
  volume       TEXT,                  -- 卷名
  status       TEXT DEFAULT 'draft',  -- draft | revising | done
  content      TEXT,                  -- 纯文本派生快照，供搜索与导出
  blocks       TEXT,                  -- JSON 块数组，正式数据源
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX idx_chapters_work ON chapters(work_id, seq);

-- 人物卡
CREATE TABLE characters (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  aliases      TEXT,                  -- 逗号分隔
  role         TEXT,                  -- 主角/配角/反派…
  identity     TEXT,                  -- 身份背景
  personality  TEXT,                  -- 性格
  speech       TEXT,                  -- 说话风格、口癖
  goal         TEXT,                  -- 核心目标
  arc          TEXT,                  -- 成长弧
  relations    TEXT,                  -- JSON: [{characterId, relation}]
  notes        TEXT,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX idx_characters_work ON characters(work_id);

-- 世界观设定
CREATE TABLE settings (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,         -- 地理 | 势力 | 规则 | 物品 | 历法
  name         TEXT NOT NULL,
  content      TEXT NOT NULL,
  importance   INTEGER DEFAULT 3,     -- 1-5，决定是否优先注入上下文
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX idx_settings_work ON settings(work_id, category);

-- 素材库
-- rid 必须是 INTEGER PRIMARY KEY，才能作为 FTS5 外部内容表的 content_rowid；
-- 业务主键 id 另设 TEXT UNIQUE，两者并存
CREATE TABLE materials (
  rid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT,                  -- 正文（纯文本或 PDF 解析结果）
  source       TEXT,                  -- 来源：手记 | 书籍 | 网页 | PDF
  source_url   TEXT,
  file_path    TEXT,                  -- 原始文件路径（PDF）
  tags         TEXT,                  -- 逗号分隔
  char_count   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 素材全文检索（FTS5 外部内容表，与 materials 通过 rid 同步）
CREATE VIRTUAL TABLE materials_fts USING fts5(
  title, body, tags,
  content='materials', content_rowid='rid',
  tokenize='unicode61'
);

-- FTS5 同步触发器（INSERT / UPDATE / DELETE 三路）
CREATE TRIGGER materials_ai AFTER INSERT ON materials BEGIN
  INSERT INTO materials_fts(rowid, title, body, tags)
  VALUES (new.rid, new.title, new.body, new.tags);
END;

CREATE TRIGGER materials_ad AFTER DELETE ON materials BEGIN
  INSERT INTO materials_fts(materials_fts, rowid, title, body, tags)
  VALUES ('delete', old.rid, old.title, old.body, old.tags);
END;

CREATE TRIGGER materials_au AFTER UPDATE ON materials BEGIN
  INSERT INTO materials_fts(materials_fts, rowid, title, body, tags)
  VALUES ('delete', old.rid, old.title, old.body, old.tags);
  INSERT INTO materials_fts(rowid, title, body, tags)
  VALUES (new.rid, new.title, new.body, new.tags);
END;

-- 灵感速记
CREATE TABLE inspirations (
  id           TEXT PRIMARY KEY,
  text         TEXT NOT NULL,
  tags         TEXT,
  consumed     INTEGER DEFAULT 0,     -- 是否已被 AI 消费
  created_at   TEXT NOT NULL
);

-- AI 会话
CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  work_id      TEXT REFERENCES works(id) ON DELETE CASCADE,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,         -- user | assistant | system
  content      TEXT NOT NULL,
  role_key     TEXT,                  -- 发起时使用的 AI 角色
  action       TEXT,                  -- 结构化输出的 action
  payload      TEXT,                  -- 完整结构化输出 JSON
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);

-- 提示词覆盖（用户编辑过的角色提示词）
CREATE TABLE prompt_overrides (
  id           TEXT PRIMARY KEY,      -- 角色 key，如 'writer'
  system_prompt TEXT NOT NULL,
  temperature  REAL,
  updated_at   TEXT NOT NULL
);
```

### 3.2 blocks 的正确定义

`blocks` 是 JSON 数组字符串，存于 `chapters.blocks`。块类型：

| type | 说明 | 专属字段 |
|---|---|---|
| `paragraph` | 正文段落 | `content` |
| `dialogue` | 对白 | `content`, `speaker`（人物名，可空） |
| `inner` | 独白 / 心理描写 | `content` |
| `scene_break` | 场景分隔 | 无（渲染为 `* * *`） |
| `image` | 插图 | `content`（说明）, `fileName` |
| `setting_ref` | 设定引用 | `content`（引用的设定名） |

所有块共有字段：`id`（`crypto.randomUUID()`，不使用 `Date.now()`——现有实现存在同毫秒碰撞风险）、`type`、`content`、`format`（可选 `{fontSize, bold, italic, underline, align}`，默认继承全局）。

保存时后端同时写入 `blocks`（JSON，权威）和 `content`（`blocks.map(b => b.content).join('\n\n')`，派生快照，供搜索与导出）。读取时以 `blocks` 为准，`blocks` 为空则回退解析 `content`。

### 3.3 中文 FTS5 的处理

**已验证**：项目内 `sqlite3@5.1.7` 编译时启用了 `SQLITE_ENABLE_FTS5`，SQLite 版本 3.44.2，FTS5 可用。但 `unicode61` 分词器不切分中文——整段中文会被视为单个 token，`MATCH '断剑'` 无法命中。

解决：不引入 `jieba` 等中文分词库（增加依赖与体积），改为**bigram 索引**。写入 FTS5 前，对 `title`/`body`/`tags` 做预处理：中文串切成 2-gram（重叠），非中文保留原词，用空格连接后写入。

> "少年握着那把断剑" → "少年 年握 握着 着那 那把 把断 断剑"

查询时同样切 bigram，多个 bigram 之间用 AND 连接。`MATCH '断剑'` → `MATCH '断剑'`（2 字恰好等于 1 个 bigram，命中）。1 字查询降级为 LIKE 前缀匹配。

这个方案零额外依赖，对中文短片段检索足够。

**注意 bigram 预处理与 FTS5 触发器的配合**：触发器直接写 `materials_fts`，而 bigram 转换需要应用层完成。因此触发器方案仅适用于"原文直接入索引"的情况；启用 bigram 时改为在应用层（materials 写入后显式重建对应行索引）维护索引，`materials_ai` / `materials_au` 触发器不启用，仅保留 `materials_ad` 负责删除清理。P2 实现时二选一，落地前用真实中文样本验证召回率。

### 3.4 旧数据迁移

现有 `reports` 表内容不多，迁移策略：

1. 旧表重命名为 `reports_legacy`，不删
2. 首次启动时检测 `works` 为空且 `reports_legacy` 非空 → 自动创建一部作品"未命名作品"，把每条 report 变成一个章节，`content` 按空行切分成 paragraph 块
3. 旧 `documents` 表重命名为 `documents_legacy`；其中的 PDF 复制进素材库并解析（若 `pdf-parse` 可用），否则保留文件引用但 body 为空

---

## 4. 后端架构

### 4.1 目录结构（目标）

```
web/server/
├── index.js                 启动入口，路由挂载
├── database.js              schema 初始化 + all/get/run 封装
├── config.js                环境变量与配置读取（新增）
├── routes/
│   ├── works.js             作品/章节 CRUD（新增）
│   ├── characters.js        人物卡 CRUD（新增）
│   ├── settings.js          世界观设定 CRUD（新增）
│   ├── materials.js         素材库 CRUD + 上传 + 检索（新增）
│   ├── inspirations.js      灵感速记 CRUD（新增）
│   ├── ai.js                AI 调用：对话、角色、行内操作、流式（新增）
│   ├── prompts.js           提示词覆盖读写（新增）
│   └── settings-config.js   系统配置读写（新增）
├── services/
│   ├── providers/           AI 供应商抽象（新增）
│   │   ├── index.js         工厂 + 路由
│   │   ├── deepseek.js      DeepSeek 对话 provider
│   │   ├── ollama.js        本地 Ollama provider
│   │   └── openaiCompat.js  通用 OpenAI 兼容 provider
│   ├── search/
│   │   ├── deepseekSearch.js  DeepSeek Search/Fetch（新增）
│   │   └── local.js           站内 FTS5 检索（新增）
│   ├── roles/               五个 AI 角色定义（改造自 prompts.js）
│   │   ├── index.js         角色注册表 + 加载覆盖
│   │   ├── writer.js
│   │   ├── editor.js
│   │   ├── critic.js
│   │   ├── inspirer.js
│   │   └── researcher.js
│   ├── context.js           上下文装配器（新增，核心）
│   ├── provider.js          统一 provider 门面（改造自 chatManager.js）
│   └── aiConfig.js          配置管理（改造，含 DeepSeek 段）
└── agent/
    └── ...                  整个删除
```

### 4.2 Provider 抽象

统一接口，所有 AI 调用走此层，不再有直连 Ollama 的旁路：

```js
// services/providers/index.js
class Provider {
  async chat({ messages, temperature, maxTokens, jsonOutput, onToken })
    // 返回完整文本；onToken 存在时逐块回调（流式）
  async checkStatus()       // 返回 { ok, detail }
}
```

实现：

| Provider | 端点 | 说明 |
|---|---|---|
| `deepseek` | `POST https://api.deepseek.com/chat/completions` | OpenAI 兼容格式，模型 `deepseek-flash` / `deepseek-v4-pro` |
| `openaiCompat` | 任意 OpenAI 兼容 `base_url` | 通用兜底，将来换供应商不用改代码 |
| `ollama` | `http://localhost:11434/api/chat` | 本地兜底，key 未配时平台仍可用 |

DeepSeek 特有的 `thinking` / `reasoning_effort` 参数作为 provider 专属选项透传，不污染通用接口。

**关键点**：现有 `services/chat/` 目录（`chatService.js` / `chatManager.js` / `ollamaChat.js` / `minimaxChat.js` / `llamaCppChat.js`）与 `services/ollama.js` / `services/llamaCpp.js` 全部删除，合并进 `services/providers/`。`services/translation/` 随翻译功能一起删除。

### 4.3 上下文装配器

平台的核心。`services/context.js` 导出一个函数，根据请求类型装配消息数组。

```js
async function assembleContext({ workId, chapterId, role, selection, blockIds, scope })
```

装配内容（按顺序）：

1. **系统提示词** — 当前角色的提示词（含用户覆盖）
2. **作品层** — 标题、题材、简介、大纲（大纲可截断，超长取前 4000 字符）
3. **章节层** — 当前章节标题、卷名、状态
4. **人物层** — 与当前章节相关的人物卡。相关性判定：章节正文中出现人物名或其别名即纳入。侧边栏模式（`scope: 'work'`）时纳入全部人物卡
5. **设定层** — `importance >= 3` 的设定全部纳入；`importance < 3` 仅在正文出现设定名时纳入
6. **内容层** — 行内模式：选区文本 + 前后各 1 个块；侧边栏模式：当前章正文全文
7. **衔接层** — 上一场景最后一个块的结尾（最多 500 字符），供续写衔接
8. **检索层** — 见 §6

人物卡和设定是**按需**注入，不是全量塞。这是长篇写作能跑通的前提。

### 4.4 AI 路由

`routes/ai.js` 暴露：

| 端点 | 用途 | 特性 |
|---|---|---|
| `POST /api/ai/chat` | 侧边栏对话 | SSE 流式，消息写入 `messages` 表 |
| `POST /api/ai/inline` | 行内操作 | 非流式，返回结构化 JSON |
| `GET /api/ai/roles` | 角色列表（含用户覆盖后的实际提示词） | — |
| `POST /api/ai/prompts/:roleKey` | 保存提示词覆盖 | 写入 `prompt_overrides` |
| `GET /api/ai/status` | provider 连通状态 | — |

`POST /api/ai/chat` 走 SSE，事件格式：

```
data: {"type":"token","content":"..."}
data: {"type":"action","action":"append","content":"...","citations":[...]}
data: {"type":"done","messageId":"..."}
```

前端 `AgentAssistant.jsx` 现有的 axios 调用要重写（当前是坏的），改为 `fetch` + `ReadableStream` 解析。

### 4.5 DeepSeek 接入细节

已核实 DeepSeek 官方协议：

**对话** — `POST https://api.deepseek.com/chat/completions`
- 模型：`deepseek-flash`（快、便宜）或 `deepseek-v4-pro`（强推理）
- 上下文 1M，最大输出 384K —— 长篇小说写作非常够用
- 支持 `response_format: {"type":"json_object"}` JSON Output
- 支持 tool calls、Vision（flash 支持）
- `thinking: {"type":"enabled"}` + `reasoning_effort: "high"` 控制思考深度

**搜索** — `POST https://api.deepseek.com/v1/tools/search`
- 必填 `query`（1–128 字符）
- 可选 `count`（默认 10，最多 50）、`ori_question`、`localization`、`need_content`
- 返回每条含 `title`、`url`、`summary`（约 600-800 字，密度高于 snippet）、`snippet`、`rerank_score`（0-3，≥1.5 为高质量）、`authority`（0-4，-1 未知）、`date`
- 支持操作符：`site:` `-site:` `"精确短语"` `-词` `lang:zh,en` `after:2026-01-01` `before:2026-06-01`

**抓取** — `POST https://api.deepseek.com/v1/tools/fetch`
- 必填 `url`（最长 8192 字符）
- 返回 `{title, content}`，`content` 是 Markdown 正文

**约束**：
- 三个端点共用同一 Bearer Key，5 QPS 账号级限流（search 与 fetch 独立计算）
- 计费 \$0.75 / 千次成功请求（HTTP 200 且有结果），空结果与失败不计费
- 2026-11-01 00:00（北京时间）起正式计费
- Fetch 对同一域名有独立限流，需做域名级节流（≤1 QPS）
- 403 = 安全策略拒绝，不重试；429 / 5xx 才重试（指数退避）
- 建议用 `rerank_score >= 1.5` 过滤低质结果

Key 配置：`DEEPSEEK_API_KEY` 环境变量，key 到位后填入 `web/.env`。未配置时设置页显示"未配置"，平台自动降级到 Ollama provider。

### 4.6 安全

单用户部署在公网仍有风险——服务器上的 API key 不能被陌生人消耗。最小措施：

1. 一个 `ACCESS_TOKEN` 环境变量；前端首次访问需输入，存 localStorage，后续请求带 `X-Access-Token` 头
2. 中间件校验所有 `/api/*`（`/api/health` 除外）
3. 静态资源与 `/uploads` 不校验
4. 限流：同一 IP 每分钟最多 60 次 AI 调用（避免误触或脚本刷爆 DeepSeek 额度）

这比完整的用户体系轻得多，但能挡住"别人拿到网址就能用你额度"这个最实际的风险。

---

## 5. 前端架构

### 5.1 目录结构（目标）

```
web/client/src/
├── main.jsx
├── App.jsx                 应用壳 + 三栏布局
├── api/
│   └── client.js           axios 实例，统一注入 X-Access-Token（新增）
├── store/
│   └── workspace.js        当前作品/章节/选中项的全局状态（新增）
├── components/
│   ├── Sidebar/
│   │   ├── TreePanel.jsx       左栏导航树
│   │   ├── WorkTree.jsx       作品章节树
│   │   ├── CharacterList.jsx   人物卡列表 + 编辑抽屉
│   │   ├── SettingList.jsx    设定列表 + 编辑抽屉
│   │   ├── MaterialList.jsx   素材库
│   │   └── InspirationList.jsx 灵感速记
│   ├── Editor/
│   │   ├── ChapterEditor.jsx  块编辑器主组件（改造 ReportEditor.jsx）
│   │   ├── Block.jsx          单个块的渲染与编辑
│   │   ├── BlockToolbar.jsx   选中文字浮出的行内工具条
│   │   └── BlockPalette.jsx   底部添加块的按钮组
│   ├── Assistant/
│   │   ├── Sidebar.jsx        AI 侧边栏容器
│   │   ├── RoleTabs.jsx       五个角色切换
│   │   ├── MessageList.jsx    消息流
│   │   ├── ActionCard.jsx     结构化输出卡片（comment 类）
│   │   └── CitationBadge.jsx  来源角标
│   └── Settings/
│       ├── ConfigPage.jsx     provider / 模型 / 温度 / 限流
│       └── PromptPage.jsx     提示词编辑
```

**删除**：`KnowledgeGraph.jsx`、`TranslationModal.jsx`、`DocumentTranslationModal.jsx`、`TranslationSettings.jsx`、`AIConfig.jsx`、`SearchBar.jsx`、`Documents.jsx`、`Settings.jsx`、`Reports.jsx`、`AgentAssistant.jsx`（全部由上表取代）。

**状态管理**：项目当前无状态库，跨组件通信靠 props 提升。新增 `store/workspace.js` 用 React Context + useReducer 实现（不引入 redux/zustand，避免额外依赖）。需要共享的是：当前作品 ID、当前章节 ID、当前选区、侧边栏折叠状态、对话历史。

**路由**：当前无路由库，视图靠 `useState` 切换，URL 不可分享、无法深层链接。改造后引入 `react-router-dom`（唯一新增前端依赖），路由：

```
/                     → 重定向到 /works
/works/:workId        → 工作区（三栏）
/materials            → 素材库（独立页，便于大量素材的批量管理）
/settings             → 设置
```

**样式**：沿用 Ant Design 5 token 主题方案（`App.jsx` 现有的 `scholarlyLightTheme` / `scholarlyDarkTheme`），不引入 Tailwind。深浅主题切换保留。

### 5.2 块编辑器改造要点

现有 `ReportEditor.jsx` 的骨架（块增删改移、分栏、工具栏）可以复用，但必须改：

| 问题 | 现状 | 改造 |
|---|---|---|
| 后端不存 blocks | `reports.js` 只解构 `{title, content}` | 新 `chapters` 表有 `blocks` 列，`PUT` 完整接收 |
| id 用 `Date.now()` | 同毫秒创建两块会碰撞 | 改用 `crypto.randomUUID()` |
| 块类型 | heading/paragraph/image/reference | paragraph/dialogue/inner/scene_break/image/setting_ref |
| 引用块 | 关联 documents | 改为 `setting_ref`，引用世界观设定；人物关联通过章节正文自动识别 |
| 工具栏 | 加粗/斜体/下划线/对齐/字号 | 保留格式工具，另加"插入块类型"切换；行内 AI 工具条独立组件 |
| 双栏布局 | 支持 | 保留，小说写作中"原文/修改对照"视图仍然有用 |

### 5.3 行内工具条

选中文字时，在选区上方浮出。动作：

| 动作 | scope | 效果 |
|---|---|---|
| 改写 | selection | 换一种表达，意思不变 |
| 扩写 | selection | 增加细节与描写 |
| 缩写 | selection | 精简，保留要点 |
| 换语气 | selection | 正式 / 口语 / 冷峻 / 温暖 / 悬疑 |
| 续写 | selection | 在选区后接一句 |
| 找茬 | selection | 审稿人视角挑问题，只给建议 |
| 口语化 | selection | 把书面语改自然 |

实现：监听编辑器 `selectionchange`，有非空选区时在选区矩形上方定位浮层。点击动作 → `POST /api/ai/inline` → 收到 `replace`/`append` 后原位更新块 → 展示"撤销"提示。

---

## 6. 检索设计

两层检索，都由 AI 主动调用，也支持用户手动触发。

### 6.1 站内素材检索（本地 FTS5）

- 数据源：`materials` 表（用户上传的书籍片段、手记、网页、PDF 解析结果）
- 索引：`materials_fts` FTS5 虚表，bigram 预处理（§3.3）
- 检索接口：`services/search/local.js` 导出 `search(query, {limit})`，返回 `{id, title, snippet, source, tags}`。命中结果通过 `materials.id` 关联业务记录（`materials_fts` 内部以 `rid` 为 rowid，两者不等价，转换在 service 层完成）
- AI 调用方式：作为工具暴露给模型（tool call），或由上下文装配器在需要时自动检索

由于不引入向量库，站内检索是纯关键词匹配。**缓解措施**：检索到的片段作为"候选"交给 DeepSeek 做语义筛选（rerank），DeepSeek 的 `deepseek-v4-pro` 承担这个角色。

### 6.2 联网搜索（DeepSeek Search/Fetch）

- `services/search/deepseekSearch.js` 封装 `/v1/tools/search` 与 `/v1/tools/fetch`
- 搜索参数：`query`、`count`、`ori_question`（传入用户原始问题辅助理解意图）、`need_content`（默认 false，需要正文时用 fetch 单独抓）
- 结果过滤：`rerank_score >= 1.5`，`authority >= 2` 的结果优先
- Fetch 域名节流：同一域名 ≤1 QPS，本地维护 `Map<domain, lastFetchTime>`
- 重试策略：仅 429 与 5xx 指数退避重试（最多 3 次），4xx 不重试
- 引用溯源：每条引用记录 `{url, title, snippet, fetchedAt}`，前端可点击跳转

### 6.3 资料员角色的工作流

用户问"帮我找找有没有适合写这场雨夜追逐的环境描写"：

1. 资料员先查站内素材（FTS5）→ 得到候选片段
2. 若站内不足或用户明确要外部资料，调 DeepSeek Search → 得到带 `summary` 的结果
3. 需要正文细节时，对高分结果调 Fetch → 拿 Markdown 正文
4. 汇总成答案，输出 `action: "comment"`，`citations` 数组带上全部来源
5. 用户可把某条引用"插入为素材"存进素材库

---

## 7. 分期实施

每期结束时平台都可独立使用。

### P0 — 地基修复

**目标**：让已有功能真正可用，不新增用户可见功能。

- `database.js` 新 schema 落地，旧表重命名保留
- `services/providers/` 抽象层，DeepSeek + Ollama 两个实现（DeepSeek key 未配时用 Ollama）
- `services/roles/` 五个角色定义
- `services/context.js` 上下文装配器
- 修 `routes/ai.js`：统一 `{message, workId, chapterId, role, scope}` 契约，SSE 流式
- 前端 axios 实例 + `X-Access-Token` 中间件 + 限流
- 数据迁移脚本

**验收**：能在作品里创建章节，用侧边栏和 DeepSeek 聊天，AI 回复带上下文（知道人物名和当前章节）。

### P1 — 写作核心

- 作品/章节/人物卡/设定的完整 CRUD（后端 + 前端）
- 章节块编辑器改造：新块类型、blocks 正确持久化、行内工具条（先只接"改写""扩写""缩写"三个动作）
- 三栏布局重做，左栏导航树
- 结构化输出解析与回写（`replace` / `append` / `insert` / `comment`）
- 提示词覆盖的读写与设置页

**验收**：写一章小说，选中一段让 AI 改写，结果直接替换到原位；AI 引用了正确的人物设定。

### P2 — 检索

- `pdf-parse` 引入，PDF 上传后自动解析入库
- 素材库 CRUD + FTS5 索引 + bigram 预处理（§3.3 的两种索引维护方式落地前二选一并验证）
- 资料员角色：站内检索 + DeepSeek Search/Fetch + 引用溯源
- 灵感速记本 + 灵感师角色消费灵感产出情节建议

**验收**：上传一本 PDF，AI 引用其中的具体段落回答问题，点引用能跳回素材详情。

### P3 — 打磨

- 行内工具条补全剩余动作（换语气/续写/找茬/口语化）
- 编辑器撤销/重做
- 导出修复：DOCX 改用 `docx` 库正确处理格式（现在手写 OOXML 会丢掉全部富格式），新增 Markdown 导出
- 自动保存（防抖 2s）与版本快照
- 角色温度、思考深度等参数调节
- README 与部署文档更新

**验收**：写完一章能导出格式正确的 DOCX；刷新页面不丢内容。

---

## 8. 依赖变更

| 包 | 位置 | 原因 |
|---|---|---|
| `pdf-parse` | server | PDF 解析入库 |
| `docx` | server | 正确的 DOCX 导出 |
| `express-rate-limit` | server | AI 调用限流 |
| `react-router-dom` | client | 路由 |
| `node-llama-cpp` | server | **移除**（声明了但从未 import，实际用 spawn 调 CLI） |

不引入：向量库、中文分词库、状态管理库、Tailwind、UI 框架、embedding 服务。

---

## 9. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| 长篇上下文超出装配能力 | 长章节 AI 可能写崩 | DeepSeek 1M 上下文余量充足；装配器对超长内容做分段截断并在提示词中说明截断范围 |
| 纯关键词检索召回不佳 | 站内素材搜不到想要的 | 检索结果交 DeepSeek 语义 rerank；用户可手动补充上下文 |
| API key 泄露 | 额度被盗刷 | key 只在服务器环境变量；访问令牌拦截；调用限流 |
| 块数据迁移丢失旧报告 | 历史内容丢失 | 旧表重命名保留 90 天，不删除 |
| 范围过大导致做不完 | 平台半成品 | 四期切分，每期独立可用；P0/P1 完成即可满足"AI 辅助写作"核心诉求 |
| SQLite 单机限制 | 未来多用户会受限 | 当前单人场景无碍；真要多用户时再迁移，schema 已按作品维度组织 |

---

## 10. 待用户确认

1. **砍掉翻译功能与知识图谱**——确认无误。这两块当前都是坏的，且写小说用不上。
2. **旧报告数据迁移**——是否需要保留？保留则自动转成一部"未命名作品"下的章节。
3. **DeepSeek API key 与 Search/Fetch 是否同一账号**——官方说明三者共用同一 Bearer Key，只需一个 `DEEPSEEK_API_KEY`。若用户拿到的搜索 key 是独立的，需增加第二个环境变量。
4. **模型默认选择**——默认 `deepseek-flash`（快、便宜、适合日常改写），`deepseek-v4-pro` 作为"深度思考"档位供审稿和大纲生成使用。设置页可切换。
