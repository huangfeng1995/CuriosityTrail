# AI 辅助小说创作平台 — 设计文档

- 日期：2026-05-25
- 状态：已确认，待实施
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
| 翻译功能 | **删除** |
| 知识图谱 | **删除** |
| 旧报告数据 | **删除**，不迁移 |
| 深度思考档模型 | `deepseek-v4-pro`（低/高/最高三档思考强度） |
| 日常默认模型 | `deepseek-flash` |
| 访问方式 | **公网可达**，用户本人与太太各自从家里 / 公司浏览器访问 |
| 鉴权方式 | 密码登录 + JWT 会话 Cookie（非长期 token 头） |
| 部署平台 | **沿用 Fly.io**（`fly.toml` 已配好：hkg 区域、数据卷、强制 HTTPS、免费层） |

### 1.4 非目标

明确不做，避免范围蔓延：

- 不做多用户、注册、**权限体系**（仍需单一密码登录以防公网暴露，见 §4.6）
- 不做云同步、协同编辑
- 不做离线编辑（断网时不能写，保存需联网）
- 不做图片生成（文生图能力）
- 不做向量数据库（依赖外部 embedding 服务；改用 FTS5 + DeepSeek 搜索，见 §6）
- 不做移动端原生 App
- 不保留论文/学术写作场景（旧的两套报告模板整体废弃）
- 不做翻译功能
- 不做知识图谱可视化

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

| 角色 | 职责 | 典型动作 | 输出倾向 | 默认温度 | 默认模型 | 默认思考 |
|---|---|---|---|---|---|---|
| 作家 | 生成新内容 | 起稿、续写场景、扩写描写 | 文学性，重视画面与节奏 | 0.85 | 跟随全局 | 跟随全局 |
| 编辑 | 修改已有内容 | 改写、润色、删冗余、调节奏 | 克制，解释改了什么、为什么 | 0.60 | 跟随全局 | 跟随全局 |
| 审稿人 | 挑问题 | 找逻辑漏洞、找设定冲突、找重复表达 | 直率，列条目，不客气 | 0.40 | `deepseek-v4-pro` | 开启 |
| 灵感师 | 提供点子 | 情节走向、人物动机、冲突设计、反转 | 发散，给多个方向而非单一答案 | 0.95 | 跟随全局 | 跟随全局 |
| 资料员 | 找信息 | 搜站内素材、搜网络、汇总并标注来源 | 只讲有来源的，无来源明说 | 0.30 | 跟随全局 | 跟随全局 |

**为什么只有审稿人钉住模型与思考**：DeepSeek 思考模式下 `temperature` 完全不生效（见 §4.5），所以每个角色只能二选一——要么靠温度控制发散度，要么靠推理深度换质量。

- **温度是角色的"性格"**：写手 0.85 写得活、编辑 0.60 改得克制、灵感师 0.95 出人意料、资料员 0.30 不添油加醋。这些角色的活儿本来就靠发散度吃饭，开思考等于把温度调参变成摆设。
- **思考是审稿人的"专业能力"**：要在整章里追线索、查矛盾，需要推理深度而不是随机性。它放弃温度控制，换强模型 + 推理。

角色定义存放在 `services/roles/`，每个角色包含：系统提示词、默认温度、默认模型、默认思考开关、默认动作集、输出格式约束。用户在设置页可覆盖，覆盖后存库，不改代码。

**模型与思考的三态语义**（温度、模型、思考三项统一）：没有覆盖行 → 用角色自带默认；有覆盖行且有值 → 用作者指定的值；有覆盖行但为 NULL → 跟随全局供应商设置。注意"有覆盖行"是按角色整行存的——作者改过某个角色的提示词，这一行就存在了，于是模型与思考会被写成 NULL（跟随全局），温度会被写成角色自带值。

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

全新 schema。旧表（`reports` / `documents` / `categories` / `citations` / `keywords` / `translation_history` / `agent_memory`）**直接删除，不迁移**——已确认旧数据无保留价值。

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
  page_count   INTEGER DEFAULT 0,     -- PDF 页数
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 素材全文检索。
-- 不是 external content 表：external content 模式要求索引内容与 materials 原文一致，
-- 而索引里存的是 bigram 化后的文本，两者对不上。
-- rowid 对齐 materials.rid，业务 id 另存一列供回查。
CREATE VIRTUAL TABLE materials_fts USING fts5(
  title, body, tags,
  material_id UNINDEXED,
  tokenize='unicode61'
);

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
-- 三项（temperature / model / thinking）统一三态语义：
--   没有覆盖行        → 用角色自带默认（见 services/roles/*.js）
--   有覆盖行且有值    → 用作者指定的值
--   有覆盖行但为 NULL → 跟随全局供应商设置
-- 注意"有覆盖行"是按角色整行存的：改过某个角色的提示词，这一行就存在了。
CREATE TABLE prompt_overrides (
  id           TEXT PRIMARY KEY,      -- 角色 key，如 'writer'
  system_prompt TEXT NOT NULL,
  temperature  REAL,
  model        TEXT,                  -- 空 = 跟随全局模型
  thinking     INTEGER,               -- NULL = 跟随全局，0/1 = 显式关/开
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

**bigram 与 FTS5 触发器的配合**：触发器直接写 `materials_fts`，而 bigram 转换需要应用层完成。两者不能同时生效，实现时二选一：

- 方案 A（触发器）：索引存原文，中文检索退化——**不满足需求**
- 方案 B（应用层，推荐）：materials 写入/更新后，由应用层显式重建该行的 bigram 索引；删除时用 `materials_ad` 触发器清理残留

采用方案 B。`materials_ai` / `materials_au` 触发器不启用，只保留 `materials_ad`。P2 落地时用真实中文样本验证召回率。

### 3.4 旧数据处理

旧表直接 `DROP`，不迁移。首次启动时 `initDatabase()` 检测到旧表存在即删除，建新表。

注意：旧 `documents` 表的 PDF 文件保留在磁盘（不删文件），但失去索引关联。用户如需素材，在新版素材库重新上传即可。

---

## 4. 后端架构

### 4.1 目录结构（实际落地）

```
web/server/
├── index.js                 启动入口：路由挂载、静态资源、定时备份
├── database.js              schema 初始化 + 增量迁移 + all/get/run 封装
├── config.js                环境变量与配置读取（新增）
├── routes/
│   ├── works.js             作品/章节 CRUD（新增）
│   ├── chapters.js          章节详情/更新/删除（新增）
│   ├── characters.js        人物卡 CRUD（新增）
│   ├── settings.js          世界观设定 CRUD（新增）
│   ├── materials.js         素材库 CRUD + 上传 + 检索（新增）
│   ├── inspirations.js      灵感速记 CRUD（新增）
│   ├── ai.js                AI 调用：对话、行内操作、角色、提示词覆盖、流式（新增）
│   ├── auth.js              登录 / 登出 / 会话校验（新增）
│   ├── search.js            联网搜索 / 抓取网页（新增）
│   ├── export.js            导出 TXT/Markdown/DOCX + 备份/恢复（改造）
│   ├── upload.js            图片上传（保留）
│   └── config.js            系统配置读写（新增）
├── services/
│   ├── providers/           AI 供应商抽象（新增）
│   │   ├── index.js         工厂 + 路由 + 降级
│   │   ├── base.js          Provider 基类 + SSE 读取 + 重试
│   │   ├── deepseek.js      DeepSeek 对话 provider
│   │   ├── ollama.js        本地 Ollama provider
│   │   └── openaiCompat.js  通用 OpenAI 兼容 provider
│   ├── search/
│   │   ├── deepseekSearch.js  DeepSeek Search/Fetch（新增）
│   │   └── local.js           站内 FTS5 检索（新增）
│   ├── roles/               五个 AI 角色定义（改造自 prompts.js）
│   │   ├── index.js         角色注册表 + 加载覆盖 + 参数合并
│   │   ├── writer.js
│   │   ├── editor.js
│   │   ├── critic.js
│   │   ├── inspiler.js
│   │   └── researcher.js
│   ├── context.js           上下文装配器（新增，核心）
│   ├── documentText.js      PDF / TXT / MD 正文提取（新增）
│   ├── docxExport.js        DOCX 导出（新增）
│   ├── backup.js            备份与定时备份（新增）
│   ├── auth.js              密码校验 + JWT 签发（新增）
│   └── aiConfig.js          配置管理（改造，含 DeepSeek 段）
└── middleware/
    ├── auth.js              JWT 会话校验（新增）
    ├── rateLimit.js         登录 / AI / 全局限流（新增）
    └── singleInstance.js    单实例保护（新增）
```

**提示词覆盖没有单独的路由文件**：读写合并在 `routes/ai.js` 的 `/prompts/:roleKey`（GET/POST/DELETE），因为它和角色列表是同一块数据。

**整个删除**：`agent/` 目录（`orchestrator.js` / `memory/` / `tools/`）、`routes/translate.js`、`routes/graph.js`、`routes/categories.js`、`routes/agent.js`、`routes/aiConfig.js`、`services/chat/`、`services/translation/`、`services/ollama.js`、`services/llamaCpp.js`、`services/prompts.js`。

**保留但重写**：`routes/reports.js` → `routes/works.js`；`routes/documents.js` → `routes/materials.js`；`routes/export.js` 保留并扩展（新增 Markdown/DOCX 导出、备份列表与定时备份）；`routes/upload.js` 保留（图片上传）。

### 4.2 Provider 抽象

统一接口，所有 AI 调用走此层，不再有直连 Ollama 的旁路：

```js
// services/providers/index.js
class Provider {
  async chat({ messages, temperature, maxTokens, jsonOutput, thinking, reasoningEffort, onToken })
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

`thinking` 参数的取值是 `'enabled'` / `'disabled'` 字符串（不是布尔），且**必须显式传给 DeepSeek**——官方默认就是 `enabled`，不传等于开思考。`temperature` 只在非思考模式下发送（思考模式忽略它，见 §4.5）。

**关键点**：现有 `services/chat/`（`chatService.js` / `chatManager.js` / `ollamaChat.js` / `minimaxChat.js` / `llamaCppChat.js`）与 `services/ollama.js` / `services/llamaCpp.js` 全部删除，合并进 `services/providers/`。`services/translation/` 随翻译功能一起删除。

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

**模型**（依 2026-09-10 官方更新日志）：

| 模型名 | 实际版本 | 上下文 | 最大输出 | 视觉 | 思考档位 |
|---|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 1M | 384K | 支持 | high/max |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 1M | 384K | 不支持 | high/max |

已停用，不要使用：`deepseek-chat`、`deepseek-reasoner`（2026-07-24 停用）、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`（已退役，兼容期内路由到 V4.1-Flash）。

1M 上下文对长篇小说写作非常够用。

**对话** — `POST https://api.deepseek.com/chat/completions`
- OpenAI 兼容格式，也支持 Anthropic 格式（`https://api.deepseek.com/anthropic`）与 Responses API
- 支持 `response_format: {"type":"json_object"}` JSON Output
- 支持 tool calls
- 思考控制：`thinking: {"type": "enabled" | "disabled"}` + `reasoning_effort: "high" | "max"`

**思考模式与温度互斥**（官方明确，写在思考模式文档里）：

> Thinking mode does not support the `temperature`, `top_p`, `presence_penalty`, or `frequency_penalty` parameters. Please note that, for compatibility with existing software, setting these parameters will not trigger an error but will also have no effect.

三条由此推出的硬规则：

1. **`thinking` 必须显式下发。** 官方默认就是 `enabled`，不传等于开了思考——设置页里那个"关闭深度思考"的开关会形同虚设。
2. **开了思考就不发 `temperature`。** 发了不会报错，但也没任何效果；不发至少不会让人误以为温度在起作用。前端据此把温度滑块置灰。
3. **`reasoning_effort` 只有 `high` / `max` 两档。** 官方为兼容性把 `low`/`medium` 映射成 `high`、`xhigh` 映射成 `max`，所以设置页不提供"低"档——那个选项本来就不比"高"省思考。

因此平台的参数分配原则是**创作靠温度、分析靠思考**：靠发散度吃饭的角色（写手、编辑、灵感师、资料员）走非思考模式，温度真正生效；需要跨线索推理的角色（审稿人）走思考模式，用强模型 + 推理深度换质量，放弃温度控制。

**搜索** — `POST https://api.deepseek.com/v1/tools/search`
- 必填 `query`（1–128 字符）
- 可选 `count`（默认 10，最多 50）、`ori_question`、`localization`、`need_content`
- 返回每条含 `title`、`url`、`summary`（约 600-800 字，密度高于 snippet）、`snippet`、`rerank_score`（0-3，≥1.5 为高质量）、`authority`（0-4，-1 未知）、`date`
- 支持操作符：`site:` `-site:` `"精确短语"` `-词` `lang:zh,en` `after:2026-01-01` `before:2026-06-01`

**抓取** — `POST https://api.deepseek.com/v1/tools/fetch`
- 必填 `url`（最长 8192 字符）
- 返回 `{title, content}`，`content` 是 Markdown 正文

**鉴权与限流**：
- 三个端点**共用同一把 Bearer Key**（DeepSeek 账号体系内统一），只需一个环境变量 `DEEPSEEK_API_KEY`
- 5 QPS 账号级限流，search 与 fetch 独立计算
- 计费 \$0.75 / 千次成功请求（HTTP 200 且有结果），空结果与失败不计费
- 2026-11-01 00:00（北京时间）起正式计费
- Fetch 对同一域名有独立限流，需做域名级节流（≤1 QPS）
- 403 = 安全策略拒绝，不重试；429 / 5xx 才重试（指数退避，最多 3 次）
- 建议用 `rerank_score >= 1.5` 过滤低质结果

Key 配置：`DEEPSEEK_API_KEY` 环境变量，key 到位后填入 `web/.env`。未配置时设置页显示"未配置"，平台自动降级到 Ollama provider。

### 4.6 鉴权与公网部署

**使用场景**：用户本人与太太各有一台电脑（家 / 公司），都需要通过浏览器访问平台写作。因此平台需要公网可达，且必须鉴权。

#### 4.6.1 现有代码中的三个必修问题

| 问题 | 现状 | 公网后果 |
|---|---|---|
| `dotenv` 未安装 | `package.json` 缺 `dotenv`，`index.js` 里 `require('dotenv')` 静默失败 | **`.env` 从未被加载**。DeepSeek key 写进 `.env` 也不生效。必须补装依赖 |
| `cors()` 全开 | `app.use(cors())` 无来源白名单 | 任意第三方网站的 JS 都能读取 API 响应。必须收紧为同源 / 白名单 |
| `uploads` 静态直出 | `app.use('/uploads', express.static(...))` 无鉴权 | 任何人可枚举下载图片。必须纳入鉴权 |

#### 4.6.2 鉴权方案：密码登录 + 会话 Cookie

不用长期 token 头，改用服务端会话，理由：她从公司浏览器访问，token 方案要求每次手动粘贴且无法安全存储；Cookie 方案登录一次后长期有效，浏览器自动携带。

```
POST /api/auth/login   { password }   → 设置 HttpOnly 会话 Cookie
POST /api/auth/logout                → 清除 Cookie
GET  /api/auth/session                → 返回 { authenticated: true }
```

- 密码存 `APP_PASSWORD` 环境变量（**只存哈希**：用 Node 内置 `crypto.scrypt` 计算 `scrypt(password, salt)`，salt 存环境变量 `APP_PASSWORD_SALT`；不引入 bcrypt 依赖）
- 会话：随机 32 字节 token 存内存 `Map`（服务重启后失效，需重新登录——可接受，且更安全）；或用 `jsonwebtoken` 签发带过期时间的 token（**推荐**，无状态，重启不掉线）
- Cookie 属性：`httpOnly: true`、`sameSite: 'strict'`、`secure: true`（生产环境经 HTTPS）
- 会话有效期 30 天，支持"记住我"延长到 90 天
- 中间件 `requireAuth` 保护所有 `/api/*`（除 `/api/health`、`/api/auth/login`）
- 前端：未认证时路由跳转到 `/login`，登录成功后跳回原页面

**为什么用 `jsonwebtoken` 而不是内存 Map**：单用户场景下 JWT 无需存储、天然支持多实例、重启不掉线，实现成本约 30 行。代价是无法主动踢下线（可接受）。

#### 4.6.3 限流

`express-rate-limit`（新增依赖）：

| 范围 | 限制 | 理由 |
|---|---|---|
| `/api/auth/login` | 5 次 / 15 分钟 / IP | 防密码爆破 |
| `/api/ai/*` | 60 次 / 分钟 / IP | 防脚本刷爆 DeepSeek 额度 |
| 全局 API | 300 次 / 15 分钟 / IP | 防一般滥用 |

#### 4.6.4 CORS 收紧

Fly.io 上前后端同域（Node 同时 serve 静态前端与 API），**生产环境不需要 CORS**，直接移除 `app.use(cors())` 即可——这样也顺带消除了"任意第三方网站读 API"的攻击面。

仅本地开发需要（Vite dev server `localhost:5173` 直连后端 `localhost:3001`）：

```js
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
}
```

生产环境保留 `APP_ORIGIN` 环境变量以便将来启用独立前端域名。

#### 4.6.5 部署形态：沿用 Fly.io

**项目此前已部署在 Fly.io**，配置见 `fly.toml`（应用名 `curiosity-trail`，区域 `hkg` 香港，数据卷 `curiosity_trail_data` 挂载 `/app/data`，`force_https = true`，`min_machines_running = 1`）。**保持该平台不变**，理由：

| 理由 | 说明 |
|---|---|
| 配置现成 | 数据卷、区域、HTTPS 均已配好，无需重做 |
| 自动 HTTPS | `force_https = true` + `*.fly.dev` 域名，开箱即用；不必买域名、不必配 Nginx |
| 成本 | 免费层足够单人使用（`DEPLOY.md` 明确标注"个人使用完全免费"） |
| 免运维 | 系统更新、进程重启、证书续期都由平台托管 |

`railway.json` 是一次未完成的尝试（`buildCommand` 指向不存在的 `npm run build`），**不采用**。

##### Fly.io 特有的三个约束

**1. Volume 只能单实例挂载**

Fly.io 的 volume 一次只能挂载到一个 machine。SQLite 在多实例并发写入时会损坏数据库，因此必须保持 `min_machines_running = 1`（`fly.toml` 已是此配置）。

应用启动时增加校验：若检测到 `FLY_ALLOC_ID` 缺失但 `/app/data` 未挂载，或环境变量 `ALLOW_MULTI_INSTANCE` 未开启而实例数 > 1，则拒绝启动并打印明确错误。避免误操作 `fly scale count 2` 导致数据损坏。

**2. 容器可替换，本地文件不持久**

容器重建后 `/app/web/server/uploads` 会丢失。因此**所有运行时写入路径必须基于 `DATA_DIR`**：

- 当前 [upload.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/upload.js) 写死 `path.join(__dirname, '../uploads')` → 改为 `path.join(process.env.DATA_DIR || <默认>, 'uploads')`
- SQLite 数据库路径同样基于 `DATA_DIR`
- 插图、PDF 原文件都必须落在卷内

**3. 备份需主动触发**

单机 SQLite 没有时间点自动快照，需用 Fly.io 的定时机制（`fly scale count` + 外部 cron，或在应用内加 `POST /api/admin/backup` 由外部定时器调用）。沿用现有 [export.js](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/web/server/routes/export.js) 的备份能力，补一个定时触发入口。

##### 密钥注入

不使用 `.env` 文件，改为 Fly.io secrets（平台加密存储，不进 Git、不进镜像）：

```bash
fly secrets set DEEPSEEK_API_KEY=... APP_PASSWORD=... APP_PASSWORD_SALT=... JWT_SECRET=...
```

- `DEEPSEEK_API_KEY` — DeepSeek key
- `APP_PASSWORD` — 登录明文密码（用于 scrypt 校验），**由实施时生成并单独告知用户，不写入任何文件**
- `APP_PASSWORD_SALT` — scrypt salt（随机串）
- `JWT_SECRET` — JWT 签名密钥（随机串）
- `APP_ORIGIN` — `https://curiosity-trail.fly.dev`

本地开发仍支持 `.env`（需先安装 `dotenv`），但 `.env` 已在 `.gitignore` 中。

##### 备用方案

若将来需要迁出 Fly.io（国内访问速度、或平台政策变化），现有 [Dockerfile](file:///Users/openclaw/Documents/trae_projects/CuriosityTrail/Dockerfile) 是正确的多阶段构建版本，可直接用于国内服务器 + Docker Compose，届时再补 Nginx。

过渡期若完全不想动云平台，可用 SSH 隧道（`ssh -L 3001:localhost:3001 user@server`）让公司电脑直连家里的机器，安全性等价于内网访问。

#### 4.6.6 移动端可访问性

公司里可能用手机查看进度。当前 `App.jsx` 已有 `isMobile` 判断（`< 992px` 走底部 Tab 布局）。三栏布局在手机上无法三栏并列，需要：

- 中间编辑器占满
- 左栏与右栏改为抽屉（Drawer），由顶部按钮唤出
- 保留核心能力：读稿 + 发消息给 AI + 行内改写
- 写作（长文本输入）在手机上体验有限，这是次要场景

---

## 5. 前端架构

### 5.1 目录结构（实际落地）

```
web/client/src/
├── main.jsx
├── App.jsx                 应用壳 + 顶栏导航 + 路由
├── api/
│   ├── client.js           axios 实例，统一注入 Cookie 凭据（新增）
│   └── sse.js              SSE 流式读取（新增）
├── store/
│   ├── workspace.jsx       块数据 + 撤销栈 + 保存状态 + 选区（新增）
│   └── auth.jsx            登录态管理（新增）
├── hooks/
│   └── useMediaQuery.js    断点判断（新增）
├── pages/
│   ├── Login.jsx           登录页（新增）
│   ├── Works.jsx           作品列表页（新增）
│   ├── Workspace.jsx       三栏工作区（新增）
│   ├── Materials.jsx       素材库页（新增）
│   └── SettingsPage.jsx    设置页：AI 供应商 / 角色提示词 / 备份（新增）
├── components/
│   ├── Sidebar/
│   │   ├── WorkTree.jsx       作品章节树
│   │   ├── CharacterPanel.jsx 人物卡列表 + 编辑抽屉
│   │   ├── SettingPanel.jsx   设定列表 + 编辑抽屉
│   │   ├── WorkInfoPanel.jsx  作品信息（题材/简介/大纲）
│   │   └── InspirationPanel.jsx 灵感速记
│   ├── Editor/
│   │   ├── ChapterEditor.jsx  块编辑器主组件（改造 ReportEditor.jsx）
│   │   ├── Block.jsx          单个块的渲染与编辑
│   │   ├── BlockToolbar.jsx   选中文字浮出的行内工具条
│   │   ├── BlockPalette.jsx   底部添加块的按钮组
│   │   └── blocks.js          块类型定义与工具函数
│   ├── Assistant/
│   │   ├── Sidebar.jsx        AI 侧边栏容器
│   │   ├── RoleTabs.jsx       五个角色切换
│   │   ├── MessageList.jsx    消息流
│   │   ├── ActionCard.jsx     结构化输出卡片（comment 类）
│   │   └── CitationBadge.jsx  来源角标
│   └── ExportButton.jsx    导出格式下拉（Word / Markdown / 纯文本）
```

**设置页没有拆成 `components/Settings/`**：三个标签页（AI 供应商、角色提示词、备份）逻辑上都只服务于设置页，拆成独立目录反而要跨目录传状态，所以留在 `pages/SettingsPage.jsx` 内部组件里。

**整个删除**：`KnowledgeGraph.jsx`、`TranslationModal.jsx`、`DocumentTranslationModal.jsx`、`TranslationSettings.jsx`、`AIConfig.jsx`、`SearchBar.jsx`、`Documents.jsx`、`Settings.jsx`、`Reports.jsx`、`AgentAssistant.jsx`。

**状态管理**：项目当前无状态库，跨组件通信靠 props 提升。新增 `store/workspace.js` 用 React Context + useReducer 实现（不引入 redux/zustand，避免额外依赖）。需要共享的是：当前作品 ID、当前章节 ID、当前选区、侧边栏折叠状态、对话历史。

**路由**：当前无路由库，视图靠 `useState` 切换，URL 不可分享、无法深层链接。改造后引入 `react-router-dom`（唯一新增前端依赖），路由：

```
/                     → 未登录跳 /login；已登录跳 /works
/login                 → 登录页
/works/:workId        → 工作区（三栏）
/materials            → 素材库（独立页，便于大量素材的批量管理）
/settings             → 设置
```

路由守卫：`RequireAuth` 包装器检查 `/api/auth/session`，未认证跳转到 `/login` 并记录原路径，登录成功后跳回。

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

由于不引入向量库，站内检索是纯关键词匹配。**缓解措施**：检索到的片段作为"候选"交给 DeepSeek 做语义筛选（rerank），`deepseek-v4-pro` 承担这个角色。

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

**落地补充（P2）**：

- **PDF 页码**：解析时在每页开头插入 `[[PAGE n]]` 标记，检索命中后据此算出页码，
  引用角标显示"第 N 页"，作者可回原文核对。标记本身不显示在片段里。
- **Fetch 触发条件**：不是每次都抓。search 返回的 `summary` 已有 600-800 字，
  只有作者话里出现"原文/全文/完整版"这类词时才 fetch 最相关的那一条，
  否则每次提问都要多等 1 秒域名节流。
- **站内优先、联网兜底**：资料员在站内命中时也查联网（内外对照更有价值），
  但非资料员角色只有作者明确说"上网/联网/查一下维基"才走联网，避免每次聊天都花搜索额度。
- **联网不可用要说出来**：没配 key 或请求失败时，响应里带 `notice` 事件告诉作者
  "本次只用了站内素材"，不能默默少给资料。

---

## 7. 分期实施

每期结束时平台都可独立使用。

### P0 — 地基与鉴权

**目标**：让平台在公网上安全可用。这是所有后续工作的前提——DeepSeek key 一旦在无鉴权的公网服务上，就是给别人送钱。

**P0-a 鉴权与加固（最高优先级）**

- 安装 `dotenv`（修复 `.env` 从未加载的问题），补 `.env.example`
- `routes/auth.js`：登录 / 登出 / 会话查询，密码用 `crypto.scrypt` 校验，签发 JWT
- `middleware/auth.js`：`requireAuth` 保护所有 API（`/api/health`、`/api/auth/login` 除外）
- `middleware/rateLimit.js`：登录 5次/15min、AI 60次/min、全局 300次/15min
- 收紧 CORS：生产环境移除（Fly.io 同域），仅开发环境保留 `localhost:5173` 白名单
- `/uploads` 纳入鉴权（改为经鉴权中间件后 `express.static`）
- **所有运行时写入路径改基于 `DATA_DIR`**：当前 `upload.js` 写死 `__dirname/../uploads`，容器重建后会丢图；SQLite 路径同理
- 启动时校验单实例约束（Fly.io volume 只能挂一个 machine，多实例会损坏 SQLite）
- 前端：`api/client.js` 走 `withCredentials`，`store/auth.js` 管理登录态，`pages/Login.jsx` 登录页，`RequireAuth` 路由守卫
- 验收：未登录访问任何 API 返回 401；登录后正常；连续错误密码被限流

**P0-b 数据与 AI 地基**

- `database.js` 新 schema 落地，旧表直接删除
- 删除 `agent/` 目录、`routes/translate.js`、`routes/graph.js`、`routes/categories.js`、`routes/agent.js`、`routes/aiConfig.js`、`services/chat/`、`services/translation/`
- `services/providers/` 抽象层，DeepSeek + Ollama 两个实现（DeepSeek key 未配时用 Ollama）
- `services/roles/` 五个角色定义
- `services/context.js` 上下文装配器
- 修 `routes/ai.js`：统一 `{message, workId, chapterId, role, scope}` 契约，SSE 流式
- 死代码清理（`AIConfig.jsx`、`TranslationSettings.jsx` 等）

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
- 素材库 CRUD + FTS5 索引 + bigram 预处理（应用层维护索引，§3.3 方案 B）
- 资料员角色：站内检索 + DeepSeek Search/Fetch + 引用溯源
- 灵感速记本 + 灵感师角色消费灵感产出情节建议

**验收**：上传一本 PDF，AI 引用其中的具体段落回答问题，点引用能跳回素材详情。

### P3 — 打磨与部署

| # | 条目 | 状态 |
|---|---|---|
| 1 | 行内工具条补全剩余动作（换语气/续写/找茬/口语化） | ✅ 已完成 |
| 2 | 编辑器撤销/重做 | ✅ 已完成（reducer 内 past/future 快照栈，`MAX_UNDO=50`，输入合并窗口 700ms，按章隔离，Ctrl/Cmd+Z / Shift+Z） |
| 3 | 导出修复：DOCX 改用 `docx` 库，新增 Markdown 导出 | ✅ 已完成（work/chapter × txt/markdown/docx 六条端点，前端统一格式选择） |
| 4 | 自动保存（防抖 2s）与版本快照 | ✅ 已完成（自动保存 ✅；版本快照由备份系统承担，见第 7 项） |
| 5 | 角色模型与思考强度调节 | ✅ 已完成（`prompt_overrides` 增 `model` / `thinking` 列，模型、温度、思考强度统一三态语义；角色自带默认参数，审稿人钉住 `deepseek-v4-pro` + 思考） |
| 6 | **公网部署**：删掉非法 `web/server/Dockerfile`；Fly.io secrets 说明；备份定时触发入口 | ⚠️ 代码与配置已完成（`fly.toml` 指向根目录多阶段 Dockerfile、`[env]`/`[mounts]` 齐全、`BACKUP_HOUR` 定时注册已实测）；**实际 `fly deploy` 尚未执行**，待用户提供平台 secret |
| 7 | 备份定时触发 + 设置页备份 UI | ✅ 已完成（`setTimeout` 计算下一个整点，滚动保留 7 份；设置页可手动备份/下载/恢复） |
| 8 | **移动端适配**：窄屏降级（§4.6.6） | ✅ 已完成（新增 `useMediaQuery` hook；作品列表/素材库/设置页/块操作按钮/章节头均已适配，375×812 实测无溢出） |
| 9 | README 与 DEPLOY.md 更新（部署步骤、备份恢复、密钥轮换） | ✅ 已完成（新建根 README，重写 web/README.md 与 web/DEPLOY.md） |
| 10 | **思考模式与温度互斥的修正** | ✅ 已完成（依官方文档：`thinking` 显式下发、开思考时不发 `temperature`、`reasoning_effort` 归一化为 high/max；角色按"创作靠温度、分析靠思考"分配；前端温度滑块在开思考时置灰并说明原因。详见 §2.3 / §4.5 / §9 / §10） |

**验收**：写完一章能导出格式正确的 DOCX ✅；刷新页面不丢内容 ✅；公司浏览器可通过 HTTPS 域名访问并正常写作 ⏳（待 Fly.io 实际部署）。

---

## 8. 依赖变更

| 包 | 位置 | 原因 |
|---|---|---|
| `dotenv` | server | **必须补装**。当前 `require('dotenv')` 静默失败，`.env` 从未被加载 |
| `jsonwebtoken` | server | 签发会话 token，无状态登录态 |
| `express-rate-limit` | server | 登录爆破 / AI 额度 / 全局滥用限流 |
| `pdf-parse` | server | PDF 解析入库（实际安装 v1.1.4；用自定义 `pagerender` 逐页渲染并在页首插 `[[PAGE n]]` 标记） |
| `docx` | server | 正确的 DOCX 导出（v9.13.0，CJS 入口 `dist/index.cjs`） |
| `react-router-dom` | client | 路由 + 登录守卫 |
| `node-llama-cpp` | server | **移除**。两个原因：① 声明了但从未 import，实际靠 spawn 调 CLI；② 其 postinstall 会拉取大型原生二进制，在 Fly.io 镜像构建里既拖慢构建又让镜像体积失控。翻译功能已整体砍掉，不需要它 |
| `axios` | server | **移除**。后端改用 Node 18+ 内置 `fetch` 调 DeepSeek / Search / Fetch 三个端点，无须 HTTP 客户端依赖（前端仍保留 axios） |
| `uuid` | server | **移除**。项目内 id 全部是 SQLite 自增整数或自写的短哈希字符串，用不到 UUID |
| `multer` | server | 保留，素材 PDF 上传复用 |
| `adm-zip` | server | 保留，备份/恢复复用 |
| `archiver` | server | 保留，备份复用 |

不引入：向量库、中文分词库、状态管理库、Tailwind、UI 框架、embedding 服务、翻译相关库、bcrypt（用 Node 内置 `crypto.scrypt`）、定时任务库（备份定时用 `setTimeout` 计算下一个整点触发，不引 node-cron）。

---

## 9. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| **公网暴露导致额度被盗刷** | 陌生人用你的 DeepSeek key 刷到破产 | P0-a 鉴权 + 限流是硬性前置；DeepSeek 侧再设账户级用量告警 |
| **`.env` 从未生效（现存缺陷）** | 配了 key 也不生效，误判为"key 无效" | P0-a 第一件事装 `dotenv`，并加启动日志打印"key 已加载 / 未加载" |
| 弱密码被爆破 | 小说稿泄露 | 登录限流 5次/15min；密码用 192 位随机串（非人工设定） |
| **Fly.io 多实例导致 SQLite 损坏** | 数据库文件损坏，稿件全丢 | 保持 `min_machines_running = 1`；启动时校验实例数；误操作 `fly scale count 2` 时直接拒绝启动 |
| **容器重建导致插图丢失** | 已插入的插图消失 | 所有写入路径基于 `DATA_DIR`（卷内）；P0-a 必修项 |
| 未上 HTTPS | 密码与 Cookie 明文过网 | Fly.io `force_https = true` 已强制；Cookie 设 `secure` 标志 |
| 长篇上下文超出装配能力 | 长章节 AI 可能写崩 | DeepSeek 1M 上下文余量充足；装配器对超长内容做分段截断并在提示词中说明截断范围 |
| 纯关键词检索召回不佳 | 站内素材搜不到想要的 | 检索结果交 `deepseek-v4-pro` 语义 rerank；用户可手动补充上下文 |
| 删掉旧数据后无法回退 | 历史报告丢失 | 已确认旧数据无保留价值；且旧报告可从 git 历史找回（提交 `44be5b0` 及之前） |
| 范围过大导致做不完 | 平台半成品 | 四期切分，每期独立可用；P0/P1 完成即可满足"AI 辅助写作"核心诉求 |
| SQLite 单机限制 | 未来多用户会受限 | 当前单人场景无碍；真要多用户时再迁移，schema 已按作品维度组织 |
| 公司网络策略限制 | 打不开或加载慢 | SSE 流式在部分企业代理下可能缓冲；提供非流式降级开关 |
| **思考模式下温度调参失效** | 作者调了半天温度，输出毫无变化，以为是 bug | DeepSeek 官方明确思考模式忽略 `temperature`。已在三处处理：① `thinking` 显式下发（官方默认是 enabled，不传就等于开）；② 开思考时不发 `temperature`；③ 前端把温度滑块置灰并说明原因。角色按"创作靠温度、分析靠思考"分配（§2.3） |
| 思考强度档位名存实亡 | 设置页上的"低"档其实和"高"一样 | 官方只认 `high` / `max`，`low`/`medium` 会被映射成 `high`。服务端归一化后只回传这两档，前端不再提供"低"档 |

### 9.1 安全审计结论（2026-10-21）

围绕"key 交给平台后会不会出问题"做了一轮专项审计，结论与处置如下。

**密钥与凭据（重点）**

| 检查项 | 结论 | 证据 |
|---|---|---|
| git 历史里是否提交过真实 key | 安全 | 全历史 `git log -S 'sk-'` 只命中 `DEPLOY.md` 里的 `sk-xxxxxxxx` 占位符 |
| key 是否会进 Docker 镜像 | 安全 | `.dockerignore` 排除 `data/`、`.env`、`.env.*` |
| key 是否会进备份 zip | 安全 | `services/backup.js` 只打包 `curiosity.db` + `uploads/` + `documents/`，不含 `ai-config.json` 与密钥文件 |
| 前端能否拿到明文 key | 安全 | `GET /api/config/ai` 只回 `apiKeyMasked`（前后四位掩码），实测响应不含 `sk-` 原文 |
| 日志是否泄露 key | 安全 | 全部 `console.*` 调用点逐条核查，只打错误信息与文件名，无配置对象、无请求头 |
| 密钥文件权限 | 已加固 | `.app-password` / `.session-secret` / `.app-password-salt` 生成时即 0600；`ai-config.json` 原为 0644（明文 key 机器上其他账户可读），已改为写入时 0600 并显式 `chmod` |
| 密码比对 | 安全 | scrypt + 持久化随机 salt + `timingSafeEqual`，无明文比对路径 |

**鉴权与会话**

| 检查项 | 结论 | 证据 |
|---|---|---|
| 路由鉴权覆盖 | 安全 | `app.use('/api', apiLimiter, requireAuth)` 单一护栏兜底（`index.js`），59 条业务路由无一漏挂；仅 `/api/health`、`/api/auth/*`、静态资源豁免，均合理 |
| Cookie | 安全 | `httpOnly` + `sameSite: strict` + `secure(生产)` 三件套；JWT 与 Cookie 过期时间同源（30/90 天） |
| 登录爆破 | 安全 | 5 次 / 15 分钟 / IP 限流，且限流在 scrypt 计算之前 |
| SQL 注入 | 安全 | 全部参数化；FTS5 的 MATCH 表达式对词元做过双引号转义 |
| 路径穿越 | 安全 | 上传文件名由服务端生成，下载用 `path.basename` 剥目录成分；恢复解压依赖 adm-zip 自带的 `sanitize()` 防 zip-slip |
| SSRF | 安全 | 联网抓取只把 URL 转发给 DeepSeek 的 `/v1/tools/fetch`，本服务器不直连目标 |

**已修复（本轮）**

| 问题 | 原状 | 处置 |
|---|---|---|
| `/uploads` 存储型 XSS | 上传文件的扩展名取自客户端 `originalname`，可声明 `image/png` 上传 `x.html`，被静态服务当 HTML 返回执行 | 扩展名改由服务端 `EXT_BY_MIME` 映射表决定，客户端输入不参与；实测伪装 `.html` 落盘成 `.png` |
| 错误响应泄露堆栈 | Express 默认错误页把完整堆栈（含服务器绝对路径）吐给浏览器 | 加统一错误处理：堆栈只进日志，前端只拿一句人话；客户端错误 400、超限 413 |
| 上传无大小/数量上限 | `materials.js` 的 multer 未配 `limits`，`restore` 的 `express-fileupload` 也无限制且整个 zip 进内存 | 素材限 50MB / 10 个文件；恢复改为 `useTempFiles` 落盘处理 + 500MB 上限，用完即删临时文件 |
| 缺安全响应头 | 无 `nosniff` / 防 iframe | 补 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`；HTTPS 强制由 `fly.toml` 的 `force_https` 承担 |

**已知残留（低危，暂不处理）**

- 登出只清 Cookie，无法吊销已签发的 JWT（token 无 `jti`、无服务端黑名单）。单人自用影响小，真要吊销可换 `JWT_SECRET` 全体失效。
- CSRF 防护只靠 `sameSite: strict` 一层，无 token/Origin 校验。切勿为了跨站体验把它改成 `lax`/`none`。
- `trust proxy: 1` 在非 Fly 直连场景可被伪造 `X-Forwarded-For` 绕过 IP 限流。只走 Fly.io 部署不受影响。
- 依赖版本偏旧（`multer` 1.x、`adm-zip` 0.5.x）。均非鉴权绕过类问题，待后续统一升级。
- `sameSite: strict` 的固有副作用：从邮件/微信点外链进来会显示未登录，需重新输密码。这是安全换体验，属预期行为。

---

## 10. 决策记录（已确认）

| # | 问题 | 决定 |
|---|---|---|
| 1 | 翻译功能与知识图谱是否砍掉 | **砍掉**。两者当前均为坏功能，且写小说用不上 |
| 2 | 旧报告数据是否迁移 | **不迁移，直接删除**。需要时从 git 历史找回 |
| 3 | DeepSeek 对话与搜索是否需要两把 key | **一把**。三个端点（Chat / Search / Fetch）共用同一 Bearer Key，环境变量 `DEEPSEEK_API_KEY` |
| 4 | 模型选择 | 按官方最新文档：日常 `deepseek-flash`，深度思考 `deepseek-v4-pro`（思考强度只有 high/max 两档有效） |
| 5 | 访问方式 | **公网可达**。用户本人与太太各自从家里 / 公司浏览器访问。鉴权用密码登录 + JWT 会话 Cookie |
| 6 | 部署平台 | **沿用 Fly.io**（`fly.toml` 已配好：hkg 区域 + 数据卷 + 强制 HTTPS + 免费层）。不引入 Nginx / 域名 |
| 7 | 鉴权优先级 | **P0-a 最高优先级**，是公网部署的硬性前置，不可后置到 P1 |
| 8 | 登录密码 | 实施时生成 192 位随机串（`crypto.randomBytes(24)`），单独告知用户，不写入任何文件或 Git |
| 9 | 全局默认开不开深度思考 | **默认关闭**。官方文档明确思考模式下 `temperature` 完全不生效，开着思考等于把温度调参变成摆设；默认走非思考模式，快、便宜、温度真起作用。审稿人这类需要推理的角色在角色级单独开启 |
| 10 | 角色参数如何分配 | **创作靠温度、分析靠思考**。写手 0.85 / 编辑 0.60 / 灵感师 0.95 / 资料员 0.30 走非思考模式；审稿人走 `deepseek-v4-pro` + 思考，放弃温度控制换推理深度 |
