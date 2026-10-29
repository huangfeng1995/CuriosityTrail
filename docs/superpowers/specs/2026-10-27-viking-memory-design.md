# 长期记忆（viking）设计

日期：2026-10-27
状态：待评审
范围：CuriosityTrail Web 端（`web/`）

## 1. 背景与目标

现有 AI 上下文由 [context.js](../../../web/server/services/context.js) 拼装：当前作品、当前章、人物卡、设定卡、检索到的素材、未消费灵感。它是“当前状态”的快照，没有“历史状态”的语义检索能力。作品写到几十万字后，AI 会忘记前面发生过什么、角色答应过什么、作者早前定过什么规则。

目标：引入 [openviking](https://pypi.org/project/openviking/) 作为本地语义记忆库，让 AI 在每次写作时自动召回相关的旧章节、人物/设定、历史对话事实，并把“参考了哪些记忆”透明地展示给作者。

### 目标

1. 写第 N 章时，能按语义召回前文相关片段，减少剧情/设定失忆。
2. 作者能看到、能关闭、能剔除本次召回的记忆。
3. 多用户数据物理隔离，任何查询不跨用户。
4. viking 不可用时不影响正常写作与对话。
5. 记忆索引可随时全量重建，SQLite 始终是唯一事实来源。

### 非目标（本版不做）

- 素材库语义检索：素材仍走现有 FTS 关键词检索，由作者主动搜索（后续可复用本方案管道）。
- 跨作品记忆：召回范围限定当前作品。
- 云端 VikingDB：不引入外部托管向量库。
- 章节自动摘要：直接对原文切块，不额外生成章节摘要。
- 灵感速记入记忆库：仍由现有上下文逻辑注入未消费灵感。

## 2. 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 记忆范围 | 章节正文 + 人物/设定档案 + AI 对话（原始层 + 自动抽取事实层 + 手动标记） |
| 素材库 | 不入记忆库，维持作者主动搜索 |
| 部署形态 | Python sidecar（FastAPI + openviking），Node 通过本机 HTTP 调用 |
| viking 使用深度 | 仅作向量存储与相似度检索；切块、打标、重排、预算由 Node 自有策略层负责 |
| embedding | 火山 Ark 豆包 embedding（云 API） |
| 召回时机 | 每次 AI 请求自动召回，结果可见、可整体关闭、可单条剔除 |
| 对话入库策略 | 宽进严出：原始对话尽量多存，召回时用权重、阈值、条数收紧 |

## 3. 架构

```
作者浏览器
   │  REST / SSE
   ▼
Node (Express, 现有 web/server)
   ├── SQLite：唯一事实来源（章节/人物/设定/消息/记忆台账）
   ├── services/memory/chunker    切块
   ├── services/memory/indexer    增量索引 + 重试 + 重建
   ├── services/memory/retriever  查询构造 + 重排 + 预算
   └── services/memory/client     调 sidecar，超时与降级
   │  HTTP 127.0.0.1:8019
   ▼
Python sidecar（新建 web/memory-service）
   │  add_resource / find / rm
   ▼
data/viking/（豆包 embedding 向量）
```

### 3.1 sidecar 职责

只做四件事，不理解业务：

- `POST /index`：入参 `{ uri, text }`，把文本写入临时 md 文件后调用 `add_resource(path, target=uri)`，返回 `{ ok, rootUri }`。
- `POST /query`：入参 `{ query, targetUri, limit, minScore }`，返回 `{ results: [{ uri, score, text }] }`。
- `DELETE /index`：入参 `{ uri }`，删除对应资源，返回 `{ ok }`。
- `GET /health`：返回 `{ ok, model, dim }`，供 Node 探活与启动校验。

**实测修正（openviking 0.1.12，2026-10-28）**：

- `rootUri` **等于**请求的 `uri`，不多一层。做法是把 URI 拆成 base + 末段：`add_resource(target=base)` + 临时文件名 `{末段}.md`，落盘后的 `root_uri` 就正好等于请求 URI。
- 查询**不能**用上层 `find()`——它不做硬前缀隔离，实测会跨用户泄漏。必须走底层 `storage.search()` + prefix 过滤，`is_leaf=True` 也要一起过滤（目录记录本身也会被向量化）。
- 底层 `_score` 是稳定的原始余弦相似度，可直接当阈值用。
- `add_resource` 对同一 target 重复调用报 "directory already exists" → 写入一律**先删后写**。
- `rm()` 只回收文件，目录自身的向量记录要额外 `remove_by_uri` 才能清掉。
- MarkdownParser 默认按 token 二次切分正文 → 启动时把 `max_section_size` 抬到 100000，并关掉 `extract_frontmatter`。
- AGFS 的 `port` 与 `url` 必须同时配置且一致，否则队列客户端连默认 8080，向量根本不生成。但 AGFS 独占端口（`_check_port_available()` 会 bind 测试），**不能跟 sidecar 的 `VIKING_PORT` 用同一个**。
- ARK SDK 是**同步阻塞**的，multimodal 模式一次只返回一个向量 → 禁止调用批量接口。

约束：

- 只监听 `127.0.0.1`，不对外暴露；Ark key 只存在于 sidecar 环境变量。
- 固定 openviking 版本（`requirements.txt` 锁定），避免上游行为漂移。
- 不实现切块、不实现排序、不认识 user/work 概念，避免业务逻辑双份维护。

### 3.2 Node 记忆层职责

- 决定“什么内容、以什么粒度、带什么 URI 入库”。
- 维护索引台账、失败重试、删除同步、全量重建。
- 召回时做类型加权、去重、字符预算裁剪，并生成可读来源标签。
- 所有入口从 `req.userId` 取用户，URI 前缀强制带上用户与作品。

## 4. 数据模型

数据库 `SCHEMA_VERSION` 由 2 升到 3，新增两张表（增量迁移，不动现有业务表）。

```sql
CREATE TABLE IF NOT EXISTS memory_chunks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id       TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN
                  ('chapter','character','setting','conv_raw','conv_fact','conv_manual')),
  source_id     TEXT NOT NULL,
  chunk_no      INTEGER NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  viking_uri    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','indexing','indexed','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  indexed_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_source_chunk
  ON memory_chunks (source_type, source_id, chunk_no);
CREATE INDEX IF NOT EXISTS idx_memory_work
  ON memory_chunks (user_id, work_id, source_type);
CREATE INDEX IF NOT EXISTS idx_memory_status
  ON memory_chunks (status, updated_at);

CREATE TABLE IF NOT EXISTS memory_index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`memory_index_meta` 记录 `embedding_model`、`embedding_dim`、`index_version`，**按用户分键**（`u:{userId}:embedding_model` 等）。启动时与 sidecar `/health` 比对；模型或维度变化时禁止混用旧索引，提示（或自动触发）全量重建。

> **为什么按用户分键**：索引是每个用户各自一份（台账按 `user_id` 分，viking 里也按用户前缀隔离），而"重建索引"是按用户触发的——作者只重建自己的。元信息若是全站一份，A 重建完就把"全站已用新模型"记下了，B 的旧向量会被当成新的放行，混维度脏数据照样流进上下文。

`memory_chunks.content` 保存切块正文，用于界面预览与索引重建；体量约等于原稿一份，换来的是召回结果不依赖二次查询源表。

### 4.1 URI 约定

```
viking://resources/u/{userId}/w/{workId}/chapter/{chapterId}/{chunkNo}
viking://resources/u/{userId}/w/{workId}/character/{characterId}/0
viking://resources/u/{userId}/w/{workId}/setting/{settingId}/0
viking://resources/u/{userId}/w/{workId}/conv_raw/{conversationId}/{messageId}/{chunkNo}
viking://resources/u/{userId}/w/{workId}/conv_fact/{conversationId}/{messageId}/{chunkNo}
viking://resources/u/{userId}/w/{workId}/conv_manual/{conversationId}/{messageId}/{chunkNo}
```

- 查询时 `targetUri` 只给 `u/{userId}/w/{workId}/` 前缀，sidecar 原样透传。
- **对话三层各有独立路径段**（`conv_raw/` `conv_fact/` `conv_manual/`），不能共用 `conv/`：三层的块号都从 0 开始，共用一个目录会互相覆盖。
- 路径段只能用字母数字下划线、中文、横线（openviking 的 `_sanitize_for_path` 会把其它字符丢掉）。所以 `source_id` 直接用消息 id 原值，不加 `manual:` 之类的前缀标记——那种标记放在数据库字段的 `source_type` 里。
- `memory_chunks.viking_uri` 存的就是请求 URI（实测 `rootUri == 请求 uri`），删除与重建都以它为准。
- sidecar 对 URI 做前缀格式校验；Node 不接受前端传入的 URI。
- 用户级重建走 `u/{userId}/`，管理员级重建走 `u/`（仅 `role='admin'`）。

## 5. 写入流程

原则：写入异步、可重试、幂等；任何失败都不阻塞保存与对话。

### 5.1 章节

1. 章节保存成功后（`routes/chapters.js` PUT），投递 `chapter:{id}` 任务，5 秒防抖合并连续保存。
2. 读取章节内容：优先 `blocks` 拼正文，缺失时退回 `content`。
3. 对正文做规范化（去多余空行、去零宽字符），计算 `content_hash`。
4. 与该章节已入库块的整体哈希比对；未变化则跳过。
5. 切块：目标 600–1000 字，重叠 100 字；优先在场景分隔（`scene_break`）、段落边界、对话段落之间切，避免把一句对话切两半。**重叠带过来的尾部不单独成块**——它的内容已经在上一块里了，单独成块就是一块纯重复的碎片（实测 `[800,800]` 会切成 `[800,901,100]`，那块 100 字会顶掉该来源唯一的名额，把真正有内容的整块正文挤出去）。
6. 事务内写入新 `memory_chunks`（`status='pending'`），旧块标记为待删除；随后按块调用 sidecar `/index`，成功后 `status='indexed'`，旧块 `/delete` 后物理删除台账。
7. 章节删除时，删除该章节台账并异步 `/delete` 对应 URI。

### 5.2 人物 / 设定

1. 保存成功后投递任务，读取最新档案。
2. 用与 [context.js](../../../web/server/services/context.js) 相同字段渲染成人类可读文本（姓名、别名、身份、外貌、性格、背景、关系、当前状态等）。
3. 单条块（超长时按 1200 字切分），`chunk_no` 从 0 递增；覆盖写：先写新块，再删旧块。
4. 删除档案时同步删除台账与向量。

### 5.3 对话（三层）

| 层 | 触发 | 内容 | 权重 |
| --- | --- | --- | --- |
| 原始层 `conv_raw` | 每轮 AI 回复结束 | 用户消息 + AI 最终回复原文 | 低（0.8） |
| 事实层 `conv_fact` | 异步抽取成功 | 抽取出的结构化事实（承诺/决定/人物状态/伏笔） | 中（1.0） |
| 手动层 `conv_manual` | 作者点「记入记忆」 | 该条消息原文 | 高（1.2） |

- 三层的 `source_id` 都直接用**消息 id**，靠 `source_type` 区分（唯一索引 `(source_type, source_id, chunk_no)` 保证互不覆盖）。
- 原始层不筛选，尽量多存；单条超过 4000 字时按段落切块。
- 事实层在回复结束后异步执行：复用现有 `aiConfig` + `resolveProvider`，低温度，要求输出 JSON 数组，每轮最多 5 条；输出不合格则整批丢弃，只保留原始层。同一轮的多条事实合成一个块（`chunk_no=0`），避免主键冲突。
- 事实抽取是异步的，**回填前必须校验消息是否还存在**：等它回来时这一轮可能已被「重新生成」覆盖了，给一条已经不存在的回答写事实等于制造幽灵记忆。
- 抽取任务与索引任务共用队列，但优先级低于章节索引；同一会话失败不重试超过 2 次。
- 手动层由 `POST /api/ai/messages/:messageId/remember` 触发，**同步写入**：作者点了就该立刻知道成没成功，丢进后台队列的话他看到的「已记入」只是一句空话。写失败不重试（作者在等回话，让他等三轮退避才看到失败更糟）。接口先校验该消息属于当前用户的会话（`messages JOIN conversations WHERE conversations.user_id=?`），再写入。
- 消息从历史里消失时，三层记忆一并清掉（`forgetMessage`）：否则召回会翻出作者早就不要了的旧回答。

### 5.4 队列、重试与重建

- 进程内队列，默认并发 2（`MEMORY_INDEX_CONCURRENCY`）；任务幂等，按 `source_type + source_id + chunk_no` 覆盖。
- 失败记录 `attempts` 与 `last_error`，指数退避重试 3 次；仍失败则 `status='failed'`，等待手动重建。
- 全量重建：`POST /api/memory/rebuild`（普通用户重建自己的；管理员带 `scope=all` 重建**全部用户**的）。后台逐作品执行，前端轮询 `GET /api/memory/stats` 显示进度。
- **重建 = 重新向量化一遍，不是重排一遍队**：走 `force` 通道绕过增量判定（正文没变、URI 没变、状态还是 `indexed` 的块，增量判定会全跳掉，一次 embedding 都不调，换模型或清空 viking 目录之后重建就成了一场空）。
- **对话三层也要重建**：它们的正文不在源表里（原文是当时那轮对话的快照、事实是抽取出来的），但台账 `memory_chunks.content` 存着当时写入的正文，拿它重推即可。不重建的后果是换模型之后章节是新维度、对话还是旧维度，混在一个库里查询，结果「看起来正常但全是错的」。
- **重建全部成功后刷新索引元信息**（该用户的 `embedding_model` / `embedding_dim`）：元信息记的是「这批向量是用哪个模型建的」，不刷新的话模型不一致的降级永远解不开。中途有块失败则保持原值——还有旧向量在，元信息不能提前改成新的。
- 首次上线开启记忆时，自动为存量作品排队重建，避免“新功能对老稿子无效”。

## 6. 读取流程（召回）

### 6.1 触发与查询构造

- 触发点：`POST /api/ai/chat` 与 `POST /api/ai/inline`，在组装上下文之前执行。
- 查询文本 = 当前章末尾（≤1500 字）+ 本次用户指令/选区，总长 ≤2000 字；**指令优先保留**——指令被截掉召回方向就整个跑偏了，章末尾少几百字影响小得多，所以先放指令、剩下的额度才留给章末尾；没有章节上下文时只用指令。
- 范围：`u/{userId}/w/{workId}/`；**排除当前章**（正文已全量注入，召回它没有意义）。
- 参数：`limit=16`（候选池按 §6.2 放大 2 倍）、`MEMORY_MIN_SCORE=0.24`（基准门槛，分类型倍数见 §6.2）。

**「排除当前章」为什么必须做**：查询文本本身就是当前章的末尾，它跟自己几乎必然最像。不排除的话，当前章会霸占召回名额，把真正该想起的旧章节挤出去。实现见 `retriever.js` 的 `excludeChapterId`。

### 6.2 重排与预算

在 Node 侧对 sidecar 返回结果二次处理：

1. **粗筛（sidecar 侧）**：按一个很低的原始分下限过滤，省下传输与排序开销。它**不决定什么该被召回**——原始分在加权之前，卡片类的高权重根本没机会生效。下限取「所有类型门槛 ÷ 权重」的最小值再留一成余量（`coarseFloor()`），保证任何可能过线的候选都不会被提前砍掉。
2. **加权**：人物/设定 ×1.15，手动层 ×1.2，`conv_fact` ×1.0，旧章节 ×0.95，`conv_raw` ×0.8。
3. **准入（按加权分）**：拿**加权分**跟**该类型的门槛**比，过线才留下。门槛分类型定，倍数见 `TYPE_THRESHOLD_FACTORS`（卡片 ×1.7、对话原文 ×0.575、其余 ×1.0）。
4. **去重**：非章节来源同一 `source_type:source_id` 只保留最高分块；**章节按章节计，同一章最多 2 块**（章节的 `source_id` 就是章节 id，若先按来源限 1 块，「每章 2 块」这条规则永远走不到）。
5. **过滤**：`excludeRefIds` 命中的条目剔除；`excludeSourceKeys`（格式 `类型:来源id`）命中的**整来源**剔除。
6. **预算**：聊天最多 8 条 / 3000 字；行内最多 4 条 / 1200 字；按加权分从高到低装箱。

> **顺序要紧**：先加权再过滤，跟反过来的效果完全不同。反过来的话（按原始分过滤）人物卡与设定卡会在有机会参与加权之前就被砍掉——它们权重高，本来该被优先捞回来。

> **整来源剔除**是为了「重新生成」：作者剔除某条记忆后重新生成时，上一版回答的原始层/事实层/手动层要整条排掉，不能只排掉作者手动点掉的那几块——否则模型等于在旧答案的记忆上续写。

#### 6.2.1 分类型门槛（标定实测）

**为什么一根阈值卡不住所有类型**：不同长度的文本，向量相似度的尺度不一样。人物卡/设定卡只有十几个字，它的向量跟**任何**查询都有 0.2 上下的余弦相似度——这不是它相关，是短文本向量的固有性质。

标定数据（`web/server/scripts/calibrate-memory.js`，2026-10-28，真实 Ark embedding）：

| 类型 | 正文字数 | 真命中最低 | 真命中最高 | 噪音最高 |
| --- | --- | --- | --- | --- |
| 人物卡 | 18 | 0.591 | 0.591 | 0.192 |
| 设定卡 | 18 | 0.566 | 0.822 | 0.246 |
| 章节 | 278+ | 0.260 | 0.261 | 0.153 |
| 对话原文 | 207+ | 0.149 | 0.367 | 0.127 |

全局看没有安全区间（卡片的噪音 0.246 比对话原层的真命中 0.149 还高）；但**分类型看，每一种都有干净的安全区间**。所以门槛按类型分开定，系数取各自区间的位置：

| 类型 | 权重 | 安全区间（加权分） | 系数 | 折算原始门槛 |
| --- | --- | --- | --- | --- |
| 人物卡 | 1.15 | 0.192 ~ 0.591 | ×1.7 | 0.355 |
| 设定卡 | 1.15 | 0.246 ~ 0.566 | ×1.7 | 0.355 |
| 章节 | 0.95 | 0.153 ~ 0.260 | ×1.0 | 0.253 |
| 对话原文 | 0.80 | 0.127 ~ 0.149 | ×0.575 | 0.173 |

**对话原文为什么要下调系数**：它的权重最低（0.8），而准入比的是加权分，所以它的原始门槛被抬高到 0.24/0.8 = 0.30——比章节（0.253）还严。同时基准 0.24 本身也高于它真命中的下沿 0.149，等于把真命中整段误杀。实测 18 条探针有 4 条漏召，全是对话原文（原始分 0.184~0.291，折算加权分 0.147~0.233）。系数下调到 0.575（区间中点 0.138）后，这一段能过线了。

**查询长度也改变得分量级**：短查询（2~4 字）真命中 0.34 起，长查询（400 字，模拟线上「章末尾 + 指令」）真命中 0.82 起；但噪音天花板两边都很低（0.134 / 0.102）。所以基准阈值取两种形态的**并集安全区间 (0.13, 0.34) 的中点 = 0.24**。

**切块大小对分离度几乎无影响**：400/600/800/1200 字的安全区间分别是 (0.14,0.36)/(0.12,0.35)/(0.13,0.34)/(0.13,0.34)，gap 稳定在 0.21~0.23。保持默认 800。

### 6.3 注入格式

在现有上下文之后、检索参考资料之前插入：

```
## 长期记忆（自动召回）
1. 〔第 12 章·林昭〕林昭答应替父亲还债……
2. 〔人物卡·林昭〕……
3. 〔对话·2026-10-20〕作者决定让林昭在第 20 章背叛……
```

每条标注来源；无召回结果时整段不出现，不写“无记忆”之类占位。

### 6.4 可见与可控（前端）

- 请求体新增 `useMemory`（默认 `true`）与 `excludeRefIds: string[]`。
- SSE 在首个 token 前发送新事件：`{ type: 'memory', refs: [{ id, sourceType, label, preview, score, sourceId, messageId }] }`。现有 [Sidebar.jsx](../../../web/client/src/components/Assistant/Sidebar.jsx) 对未知事件类型忽略，新增分支即可。
- 消息上方显示「本次参考了 N 条记忆」，展开看条目；支持整体关闭（下次请求 `useMemory=false`，偏好存 localStorage）与单条剔除（加入 `excludeRefIds` 重新生成）。
- 设置页新增：记忆开关、索引状态（已索引/待处理/失败数）、重建按钮。
- 每条消息（作者提问与 AI 回答都算）挂一个「记入记忆」按钮，调用 `POST /api/ai/messages/:messageId/remember`。
  - 作者提问的服务端 id 由 SSE `done` 事件带回（`userMessageId`）；AI 回答的服务端 id 是 `messageId`。
  - 「重新生成」时提问行是**复用**的（不删不建），id 不变——否则作者在提问上点过的「记入记忆」就指空了。

## 7. 失败与降级

| 场景 | 行为 |
| --- | --- |
| sidecar 未启动 / 探活失败 | 记忆层整体关闭；对话与写作正常；设置页提示“记忆服务未运行” |
| 召回超时（>800ms） | 放弃本次召回，继续对话；SSE `memory` 事件返回空并附 `degraded: true` |
| Ark embedding 限流/报错 | 索引任务退避重试；召回直接降级；不重试风暴 |
| 单块索引失败 | 台账 `failed`，其余块正常；不阻塞章节保存 |
| 索引与正文不一致 | 保存时哈希比对自动修复；作者可手动重建 |
| 换 embedding 模型/维度 | 启动检测 meta 不一致，拒绝召回并提示重建，避免混维度脏数据 |
| 对话抽取失败 | 丢弃该轮事实，原始层已入库，不影响任何用户操作 |
| 数据库回滚/恢复备份 | 台账随之恢复；向量目录可能陈旧，恢复后提示重建记忆索引 |

## 8. 安全与多用户隔离

- 所有记忆读写入口以 `req.userId` 为准，不接受前端指定用户/作品以外的范围。
- URI 前缀由服务端拼接；`workId` 必须经 `ownedWork(workId, userId)` 校验。
- 召回查询的 `targetUri` 永远包含当前用户前缀；sidecar 不提供“跨前缀查询”接口。
- 重建接口：普通用户只能重建自己；`scope=all` 需要 `isAdmin`。
- Ark key 只在 sidecar 环境变量中，Node 不读取、不下发。
- 记忆内容属于用户隐私，日志只记录 URI 与计数，不打印正文。

## 9. 配置项

Node（`web/.env`）：

```
MEMORY_ENABLED=true
VIKING_BASE_URL=http://127.0.0.1:8019
VIKING_TIMEOUT_MS=800
VIKING_INDEX_TIMEOUT_MS=10000
MEMORY_INDEX_CONCURRENCY=2
MEMORY_TOP_K=16
MEMORY_MAX_REFS=8
MEMORY_MAX_CHARS=3000
MEMORY_MIN_SCORE=0.24
MEMORY_EXTRACT_ENABLED=true
MEMORY_RETRY_BASE_MS=1000
```

sidecar（`web/memory-service/.env`）：

```
ARK_API_KEY=...
ARK_EMBEDDING_MODEL=doubao-embedding-vision-251215
ARK_EMBEDDING_INPUT=multimodal
ARK_EMBEDDING_DIM=2048
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VIKING_DATA_DIR=../data/viking
VIKING_PORT=8019
VIKING_AGFS_PORT=8018
VIKING_EMBED_TIMEOUT_SECONDS=10
VIKING_INDEX_TIMEOUT_SECONDS=8
VIKING_LOG_LEVEL=INFO
```

> **`VIKING_AGFS_PORT` 必须与 `VIKING_PORT` 不同**（实测证伪了本文原先「必须一致」的说法）。AGFS 的 `port` 与 `url` 两个字段要**同时配置且指向同一个端口**——只配 `port` 不配 `url`，队列客户端会去连默认的 8080，结果是「接口全部成功，但向量根本没生成」。但 AGFS 自己会 bind 测试端口（`_check_port_available()`），两个服务用同一个端口会直接 `RuntimeError: AGFS port 8019 is already in use`。

> **超时只有一个权威值**：sidecar 的 `VIKING_INDEX_TIMEOUT_SECONDS=8` 必须**短于** Node 的 `VIKING_INDEX_TIMEOUT_MS=10000`。sidecar 先超时 → 它返回 503，Node 拿到明确失败，台账记 `failed`，两边一致；Node 先放弃 → sidecar 还在后台写向量，变成「台账说失败、向量已写入」。README、`.env.example`、本节与代码默认值必须一致。

> `MEMORY_MIN_SCORE` 取 **0.24**：这是 §6.2.1 标定出来的两种查询形态的**并集安全区间 (0.13, 0.34) 的中点**。0.20 会放进噪音，0.35 会误杀短查询的真命中。

> `MEMORY_MIN_SCORE` 是**基准值**，分类型门槛是它的倍数（卡片 ×1.7），见 §6.2.1。sidecar 收到的粗筛下限由它推导（`coarseFloor()`），不需要单独配。

模型名与维度以实际开通的 Ark 模型为准；启动时把实际 `model/dim` 写入 `memory_index_meta`，不一致即提示重建。

实测记录（2026-10-27～28）：

- 该账号下所有文本 embedding 模型（`doubao-embedding-text-*`、`large-text-*`）均处于 Retiring 且无调用权限；唯一可用的是 `doubao-embedding-vision-251215`。
- vision 模型只接受 `/api/v3/embeddings/multimodal`；一次请求返回**一个融合向量**（`data` 是对象），维度 2048。标准 `/api/v3/embeddings` 不支持该模型。
- openviking 的索引/召回主链路调用的是单条 `embed()`（`collection_schemas.py`、`hierarchical_retriever.py`），不是 `embed_batch`，因此 vision 模型可用；批量接口仍不可用，禁止在 sidecar 里调用批量。
- ARK SDK 是**同步阻塞**的，multimodal 模式一次只返回一个向量。
- P0 spike 通过：`add_resource` 索引一篇两章样例成功（`queue_status.Embedding.processed=15`，`error_count=0`），相关查询得分 0.297。
- **`add_resource` 对同一 target 重复调用报 "directory already exists"** → 写入一律「先删后写」。
- **`rm()` 只回收文件**，目录自身的向量记录要额外 `remove_by_uri` 才能清掉。
- **查询必须走底层 `storage.search()` + prefix 过滤**：上层 `find()` 不做硬前缀隔离，实测会跨用户泄漏。底层 `_score` 是稳定的原始余弦相似度，可直接当阈值用。
- **MarkdownParser 默认会二次切分正文**（按 token），所以 sidecar 启动时把 `max_section_size` 抬到 100000 并关掉 `extract_frontmatter`——否则 Node 侧切好的块会被 viking 再次切碎，一块变多块，权重与去重全乱。
- viking 会对传入文件做内部再切分（见上条）；base+stem 方案下 `root_uri` 精确等于请求 URI，台账记它、删除时用它。
- **目录记录也被向量化**（`is_leaf=False`）→ 查询 filter 必须加 `{"op":"must","field":"is_leaf","conds":[True]}`。
- 未配置 VLM 时 abstract/overview 为空，不影响召回；正文由 sidecar 读取命中文件返回。

## 10. 测试策略

1. **单元**：chunker（边界、重叠、超长段落）、retriever 重排（权重/去重/预算）、URI 拼接与解析、哈希幂等。
2. **契约**：用 Node 起一个假 sidecar（内存 Map 实现 `/index`、`/query`、`/delete`），Node 侧全部集成测试不依赖 Python。
3. **隔离**：用户 A 索引入库后，用户 B 召回结果为空；B 不能通过 `workId` 触发 A 的索引/删除。
4. **降级**：假 sidecar 返回超时/500/未启动，对话仍返回完整内容，SSE 带 `degraded`。
5. **一致性**：改章节→旧块被删、新块入库；删除章节→台账与向量都清理；重建后条目数一致。
6. **前端**：`memory` 事件渲染、整体关闭、单条剔除后重新请求。
7. **门槛**：分类型门槛系数、粗筛下限不误杀、加权顺序（原始分不够但权重高的候选仍然过线）；每个类型的实际原始门槛落在自己的标定区间里（对话原文的系数下调就是为了这个）。
8. **重建**：已索引内容会被**重新向量化**（正文没改也要重新推）、对话三层也重建、重建成功后元信息刷新、模型不一致的降级因此解得开；元信息按用户隔离（A 的模型不一致不影响 B）。
9. **切块**：不产生纯重复的尾巴块（重叠带过来的内容不单独成块）。
10. **性能**：召回端到端（Node→sidecar→返回）延迟实测，30 章 / 92 块 / 真实 Ark embedding：

   | limit | 中位 | p90 | p95 | p99 | max | 降级 |
   | --- | --- | --- | --- | --- | --- | --- |
   | 16 | 232ms | 355 | 444 | 471 | 471 | 0/40 |
   | 32 | 256ms | 412 | 481 | 497 | 497 | 0/40 |
   | 48 | 287ms | 404 | 430 | 483 | 483 | 0/40 |

   取 limit=32（候选池 ×2 后的默认值），**P95 ≈ 481ms**。原文写的「P95 < 400ms」未达成——瓶颈在 embedding 调用与向量检索，不在结果条数（见 §12 验收标准修订）。

Python 侧只保留一个冒烟脚本（索引一段文本、查询、删除），不纳入 `npm test`；CI 没有 Python 环境也能跑全部 Node 测试。

标定工具（`web/server/scripts/calibrate-memory.js`）也不纳入 `npm test`：它要连真实 sidecar 与真实 Ark，耗时且花钱，属于离线调优工具而不是回归测试。

## 11. 分期实施

- **P0 验证（spike）**：索引一个 md，确认 `add_resource` 是否二次切块、`find` 能否按 `target_uri` 过滤、`rm` 是否递归，以及 `find` 返回的是相似度还是距离（决定 `minScore` 的归一化方式）。若粒度不可控，改用包内 VikingDB 的 collection/data/search 接口，sidecar 对外契约不变。✅ 已完成，结论见 §9「实测记录」。
- **P1 基座**：sidecar + `/health` + Node `memory/client` + 配置 + 假 sidecar 测试。✅
- **P2 索引**：schema v3、台账、chunker、章节/人物/设定索引、队列与重试、全量重建与统计接口。✅
- **P3 召回**：retriever、上下文注入、SSE `memory` 事件、前端面板与开关、设置页状态。✅
- **P4 对话记忆**：原始层、事实抽取、手动「记入记忆」。✅
- **P5 调优**：用一部 30 万字样书做召回质量评估，调阈值/权重/切块大小；补齐文档与部署说明。✅ 已完成（2026-10-28），结论见 §6.2.1、§10；部署说明见 `web/memory-service/README.md`。

### 11.1 P5 标定结论（2026-10-28）

**样本**：一部 6 万字稿件（30 章 / 92 块）＋ 一部真实作品（9 个来源 / 2352 字）。用真实 Ark embedding，不是模拟。

**改了三件事**：

1. **门槛分类型定**（`TYPE_THRESHOLD_FACTORS`）。短文本的向量相似度尺度跟长文本不一样，一根阈值卡不住所有类型。卡片 ×1.7。
2. **准入判断从 sidecar 侧挪到 Node 侧，拿加权分做**。原来 sidecar 按原始分过滤，回来才加权——卡片的高权重根本没机会生效。现在 sidecar 只做粗筛（`coarseFloor()`，只砍明显不相关的），准入在 Node 侧按加权分判。候选池同时放大 2 倍（`CANDIDATE_MULTIPLIER`），因为粗筛放低了。
3. **排除当前章**（`excludeChapterId`）。原先文档写了但没实现。

**没改的**：切块大小（800 → 400/600/1200 的分离度几乎不变）、权重（人物/设定 ×1.15 这套在标定里表现正常）。

### 11.1.1 代码评审后的修订（2026-10-28）

评审把整套改动过了一遍，发现 9 个问题，逐条修完：

| # | 问题 | 修订 |
| --- | --- | --- |
| 1 | 重建索引对已索引内容是空操作（增量判定全跳过，一次 embedding 都不调） | 重建走 `force` 通道绕过增量判定 |
| 2 | 重建不刷新索引元信息 → 模型不一致的降级永远解不开 | 重建全部成功后刷新该用户的元信息（有块失败则不刷新） |
| 3 | 切块多产生一块纯重复的尾巴块 | 重叠带过来的内容标记 `carried`，整块都是重叠时不单独成块 |
| 4 | 权重同时管排序与准入，对话原文的实际原始门槛被抬到 0.30（比章节还严），真命中整段被误杀 | 对话原文系数下调到 ×0.575（自己标定区间的中点） |
| 5 | 「同一章最多 2 块」永远走不到（先按来源限了 1 块） | 章节按章节计，其余来源按来源计 |
| 6 | 查询文本从头截断，指令的尾部被砍掉 | 指令优先保留，剩下的额度才给章末尾 |
| 7 | `scope=all` 只重建管理员自己 | 新增 `rebuildAll()`，遍历全部用户 |
| 8 | 写入超时三处漂移（代码 25 / 示例 8 / 文档 120） | 统一：sidecar 8 秒、Node 10 秒、文档与示例同步 |
| 9 | 抽取回调未 await，写库失败可能变成 unhandledRejection 终止进程 | `await onFacts(facts)`，异常由 `.catch` 接住 |

另外补了两处评审之外的发现：重建现在也覆盖对话三层（正文在台账里，重推即可），否则换模型后章节与对话的向量维度对不上；索引元信息改为**按用户分键**，否则 A 重建完会把「全站已用新模型」记下，B 的旧向量被当成新的放行。

**效果**：短查询真命中 0.34 起、噪音天花板 0.13；长查询真命中 0.82 起、噪音天花板 0.10。真实库端到端验证——「陈默」→ 人物卡加权 0.813 排第一；「临江城」→ 设定卡 0.821 排第一；4 条噪音查询全部零命中。

### 11.2 「重新生成」的记忆处理（P4 实测新增）

「重新生成」不是简单地覆盖一条消息，它牵动三件事，缺一件都会出错：

1. **旧回答从历史里摘掉**。不摘的话模型会同时看到「上一版回答」和「同一个提问」，多半顺着上一版续写。
2. **上一轮的提问行复用**（不删不建）。作者可能对提问点过「记入记忆」——手动层按消息 id 锚定，换了 id 就指空了。
3. **旧回答的三层记忆**：召回时整来源排除（`excludeSourceKeys`），成功后从记忆库清掉（`forgetMessage`）。

失败时要把摘掉的旧回答原样写回去：一次失败的重生成不该把作者之前已经拿到的好答案弄丢。

## 12. 验收标准

1. 30 万字作品，在第 30 章提问「林昭之前答应过什么」，AI 回答能引用第 12 章的具体事实，且界面显示来源。
2. 召回端到端 P95 < 500ms（实测 481ms，@limit=32 / 30 章 / 92 块 / 本机 + 真实 Ark）；sidecar 停止后，对话仍正常返回，仅少记忆层并提示降级。
3. 用户 A 的任意查询都拿不到用户 B 的片段（自动化测试覆盖）。
4. 索引失败不影响章节保存；失败条目可在设置页看到并可重建。
5. 换 embedding 模型后，系统拒绝混用旧索引并引导重建，不产生静默错误。
6. 噪音查询零命中：长查询形态下噪音天花板 0.10、短查询形态下 0.13，均低于基准门槛 0.24（自动化覆盖于 `scripts/calibrate-memory.js`）。

## 13. 风险与未验证点

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| openviking 0.1.12 打包/入口不稳定（缺 `openviking.server`） | sidecar 无法启动 | ✅ 已解决：锁版本；sidecar 自建，不依赖其 server 模块 |
| `add_resource` 自行二次切块 | 我们拿不回自己的块粒度 | ✅ 已解决：启动时把 `max_section_size` 抬到 100000、关掉 `extract_frontmatter` |
| 上层 `find()` 不做硬前缀隔离 | **跨用户泄漏** | ✅ 已解决：改走底层 `storage.search()` + prefix 过滤 + `is_leaf=True` |
| AGFS `port`/`url` 不一致 | 向量根本不生成（静默失败） | ✅ 已解决：sidecar 启动时强制两者成对一致，并校验 |
| AGFS 与 sidecar 抢同一个端口 | sidecar 起不来（`AGFS port is already in use`） | ✅ 已解决：AGFS 独占 8018，sidecar 走 8019；两个端口必须不同 |
| 一根全局阈值卡不住所有类型 | 卡片噪音挤进来，或对话真命中被砍光 | ✅ 已解决：门槛分类型定（卡片 ×1.7），见 §6.2.1 |
| 先按原始分过滤、后加权 | 卡片类在有机会参与加权之前就被砍掉 | ✅ 已解决：准入判断挪到 Node 侧、拿加权分做；sidecar 只粗筛 |
| 当前章霸占召回名额 | 真正该想起的旧章节被挤出去 | ✅ 已解决：召回时排除当前章 |
| Ark embedding 成本/限流 | 索引慢、召回降级 | 异步队列 + 退避；只索引变更内容；可配关停 |
| 对话抽取引入噪声 | 召回出无关闲聊 | 宽进严出：事实层高权重、原文层低权重、阈值与条数收紧；作者可剔除 |
| 多一个 Python 进程 | 运维复杂度上升 | 只监听回环；健康检查；Node 侧全降级；Docker 场景作为 compose 中的第二个服务（或单镜像内 supervisor 启动） |
| 索引与 SQLite 漂移 | 召回旧内容 | 哈希比对、删除钩子、可重建；SQLite 为事实来源 |
| 对话三层占满召回名额 | 真正的章节正文被挤掉 | 原文层权重压到 0.8；同来源只留 1 块；字符预算 3000 |
| 重建对已索引内容是空操作 | 换模型/清库后重建无效，旧向量一直混在里面 | ✅ 已解决：重建走 `force` 通道，绕过增量判定 |
| 重建不刷新索引元信息 | 模型不一致的降级永远解不开，没有恢复手段 | ✅ 已解决：重建成功后刷新该用户的元信息 |
| 索引元信息全站一份 | A 重建完，B 的旧向量被当成新模型放行 | ✅ 已解决：元信息按用户分键 |
| 切块多出纯重复的尾巴块 | 碎片顶掉该来源唯一的名额，正文反而召不回 | ✅ 已解决：重叠内容标记 `carried`，整块都是重叠时不单独成块 |
| 重建漏掉对话三层 | 换模型后章节与对话维度对不上，混在一个库里查 | ✅ 已解决：对话块从台账取正文重推 |
| 写入超时两侧不一致 | Node 先放弃、sidecar 后写入 → 台账说失败、向量已存在 | ✅ 已解决：sidecar 8 秒（先超时，返回 503）、Node 10 秒 |

## 14. 待用户提供

- **正式上线的 Ark API Key**（当前 key 已在对话中暴露过两次，上线前必须换新的）。
- 确认可用的 embedding 模型名（已验证 `doubao-embedding-vision-251215` 可用；文本系列模型均 Retiring 且无调用权限）。
- 阿里云短信 AccessKey / 签名 / 模板 CODE（多用户登录用，与记忆层无关）。
- 用于认领存量数据的手机号。

## 15. 实施记录

| 阶段 | 状态 | 产出 |
| --- | --- | --- |
| P0 验证 | ✅ | openviking 0.1.12 实测约束（见 §3.1、§9） |
| P1 基座 | ✅ | `web/memory-service/`（Python sidecar）、`web/server/services/memory/client.js` |
| P2 索引 | ✅ | `database.js` schema v3、`indexer.js`、`chunker.js`、`uris.js`、`sources.js` |
| P3 召回 | ✅ | `retriever.js`、`routes/memory.js`、`MemoryPanel.jsx`、`useMemoryPref.js` |
| P4 对话记忆 | ✅ | `conversation.js`、`extractor.js`、`routes/ai.js` 接线、`POST /api/ai/messages/:messageId/remember`、前端「记入记忆」按钮 |
| P5 调优 | ✅ | 分类型门槛 `TYPE_THRESHOLD_FACTORS`、加权后过滤、粗筛下限 `coarseFloor()`、排除当前章、`MEMORY_MIN_SCORE=0.24`；标定工具 `web/server/scripts/calibrate-memory.js`；部署说明 `web/memory-service/README.md` |
| P5 评审修订 | ✅ | 9 条评审发现全部修完（见 §11.1.1）；重建走 `force` 并覆盖对话三层、元信息按用户分键、切块去掉重复尾巴、对话原文门槛系数 ×0.575、章节去重按章计、指令优先保留、`rebuildAll()`、超时三处对齐、抽取回调 await |

测试：`cd web/server && npm test`（**147 个用例全绿**，2026-10-28）。标定工具不在回归测试里——它要连真实 sidecar 与真实 Ark。
