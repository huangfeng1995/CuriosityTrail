# 分场 brief / 知情扫描确定性 / 主角背景事实

日期：2026-11-05
状态：待批准
范围：web/server 的写作链路（规划、写作注入、知情扫描、背景事实入库），不改前端表单形态，不碰 `Editor/`、`utils/selectionRect.js`，不改用户现有作品数据，不 push。

## 目标

1. **任务三**：在节拍规划前新增 `planBrief`，把粗提纲补成分场级「本章必须发生的动作清单」，并让节拍规划对 `loss` / `mustPresent` / `mustWithhold` 做硬覆盖校验与一次重排。
2. **任务四**：把知情扫描改成「规则层候选 + 模型层判定」两层，候选为空不调模型；同一正文同一参数重复扫描结果逐条一致；新增 `possible_leak` 文本越界检测（只进 pending，不判违规）。
3. **任务五**：给主角背景事实补入库路径（`fact_type='background'`，即 `mustReveal`），主角首次出场章逐项校验、缺项触发一次重写、仍缺打徽标。
4. **收尾**：同一题材、启用模板的新样本走完整 L0，与 `docs/superpowers/baseline/sample.md` 做「改前 vs 改后」逐拍对比，重点核对 B1/B2/B4/B5/B6。

## 现状事实（已核对）

- 节拍规划在 `web/server/services/agent/beatPlan.js`：`PLAN_PROMPT`、`generateBeatPlan`、`validateBeatPlan`（硬校验 goal/obstacle/cost/delta/infoGain/paragraphs/endHook）、`checkBeatCoverage`、`formatBeatPlan`、`buildRewriteInstruction`、`beatBadge`。
- 规划与写作接线在 `web/server/routes/ai.js`：
  - `planningEnabled = roleKey === 'writer' && Boolean(chapterId)`；
  - 规划前用 `assembleContext({ includeChapterBody:false })` 拿上下文；
  - 规划成功后再用同一快照 + `beatPlan` 重建一次知情边界，然后把 `formatBeatPlan` 追加到 `chatMessages[0].content`；
  - 分段起稿 `segmentWriter.draftInSegments({ plan, runSegment, ... })`；
  - 自检 `checkBeatCoverage`，缺拍/weak 走 `rewriteMissingGroups`，最多重写一次；
  - 交付前 `beatBadge` 打徽标，`payload.planDegraded` 透出降级原因。
- 知情扫描在 `web/server/services/pipeline/knowledgeScan.js`：现有四道校验（角色+事实可解析、证据句逐字在正文、跳级进 pending、`knows`/`exposed` 必须 pending），失败零写入；`knowledgeAt` 只读 `chapter_seq <= N-1`。
- `knowledge_pending` 确认路由在 `web/server/routes/pipeline.js`，单条/批量确认都校验 `STATES` 且拒绝重复 `(character, fact, chapter_seq)`。
- `story_facts` 目前没有 `fact_type` 列；人物卡、素材、锚点分别有独立表。素材升格锚点已在 `services/pipeline/upgrade.js` 与 `POST /api/pipeline/:workId/anchors/upgrade` 落地。
- 测试基座：`web/server/test/helpers.js` 的 `setupTempEnv` 必须在 `require` 业务模块前调用；`fakeModel.js` 提供 provider 注入；真实模型走 `web/.env`（deepseek）。

## 设计决策

### 任务三：planBrief

**新文件** `web/server/services/agent/planBrief.js`

- 常量：`KINDS = ['loss','mustPresent','mustWithhold','mustReveal','evidence']`；`HARD_KINDS = ['loss','mustPresent','mustWithhold']`；每类最多 6 条。
- `BRIEF_PROMPT`：要求模型输出严格 JSON `{ items:[{kind,text,keywords[],source,inferred}] }`；明确 `inferred=true` 只能是推断建议，不得伪造来源。
- `validatePlanBrief(candidate)`：
  - 兼容字符串 JSON 与对象；kind 非法丢弃；`text` 为空丢弃；`keywords` 去重、长度 ≥2、最多 6；
  - `source` 为空且 `inferred !== true` 的条目丢弃（不可追溯）；`inferred` 条目的 `source` 记为 `inferred`；
  - 同 kind + text 去重；返回 `{ ok, brief:{items, dropped}, errors }`；空 items 视为「无 brief」，路由回落旧行为。
- `generatePlanBrief({ provider, systemPrompt, instruction, options })`：
  - 两次尝试、`jsonOutput`、temperature 默认 0.3；失败返回 `{ brief:null, reason, errors }`，不抛到外层。
- `formatPlanBrief(brief)`：按 kind 分组输出「硬性动作 / 必须到场 / 必须 withhold / 必须交代 / 物证异常 / inferred 建议」。硬约束只含非 inferred 项。
- `briefCoverage(brief, plan)`：
  - 只对 `HARD_KINDS` 且 `inferred !== true` 的条目做硬校验；
  - 命中判定：该条任一 keyword（长度 ≥2）或原文出现在某一拍的 `goal/obstacle/cost/infoGain/endHook/delta` 文本中；
  - 返回 `{ covered:[id], missing:[{id,kind,text}], hardTotal }`，顺序按 brief 条目顺序（确定性）。
- `briefWriterBlock(brief)`：生成写手组指令里的具体约束行，如「不可逆损失/交出物：犀角弓」「必须到场：司马防」「不得解释：司马防为何保他」「必须交代：年龄、籍贯、寄养原因」；inferred 项只进「建议」一行。
- `partitionCoverage(plan, coverage)`：把缺失 brief 项映射到「最近可落点」——优先找已覆盖同 kind 的拍，否则找 `cost` 或 `goal` 含相关关键词的拍，否则追加到末拍前；仅用于重排指令文案，不修改模型返回的节拍表。

**接线（`routes/ai.js`）**

1. 规划前新增 brief 步骤，输入 = 现有 `planContext`（本章大纲/作品大纲/人物卡/设定/上一章结尾摘要）+ `scope` 素材检索结果 + 本章 `missing` 素材清单（`title`/`confidence`，最多 10 条）。
2. 背景事实（任务五）作为确定性 `mustReveal` 条目并入 brief（source=`story_facts`，inferred=false），模型没给也不能漏。
3. `generateBeatPlan` 的 `systemPrompt` 追加 `formatPlanBrief(brief)`。
4. 规划成功后立即 `briefCoverage`：
   - 有硬缺项 → 用同一计划上下文重排一次，指令追加「上一版未覆盖以下必须动作：…，请分别落到某一拍的 goal/cost/obstacle」；
   - 仍缺 → `planDegraded = 'brief_missing:' + 缺项 kind/text（≤3 条）`；
   - brief 生成失败或 items 为空 → 不注入、不校验、不重排，行为与原链路逐字一致。
5. 写手注入：
   - `chatMessages[0].content` 在 `formatBeatPlan` 之后追加 `formatPlanBrief`（若 brief 有效）；
   - 分段起稿把 `brief` 传给 `segmentWriter.draftInSegments`，组指令带 `briefWriterBlock`；续写与分组重写同样带该块。
6. 观测：`ai_plan` 日志增加 `briefOk/briefItems/briefMissing`；SSE 结果增加 `payload.planBrief`（items 截断）与 `payload.briefCoverage`。

**测试** `web/server/test/planBrief.test.js`

- 粗提纲（只给「父亲来接他，全家告别」，人物卡含司马防/司马朗，设定含犀角弓）：fake provider 返回 `loss/mustPresent/mustWithhold` 三项（其中 mustPresent 标 `inferred`），断言：
  - `validatePlanBrief` 保留可追溯项、把无来源且非 inferred 项丢弃；
  - `briefCoverage` 在只覆盖 loss 的节拍表上报出 mustPresent/mustWithhold 缺失；
  - `briefWriterBlock` 含「犀角弓」「司马防」「不得解释」；
  - inferred 项不出现在硬约束行。
- 回落：`brief = null` 时 `formatPlanBrief` 返回空串、`briefCoverage` 不参与、规划调用次数等于原实现（1 次）。

### 任务四：知情扫描确定性

**改 `web/server/services/pipeline/knowledgeScan.js`**

- 新增纯函数 `splitSentences(text)`、`factTerms(fact)`、`collectCandidates({ characters, facts, text })`：
  - 句级扫描；候选 = 同一句出现角色名/别名 + 事实关键词；
  - `factTerms`：显式 `keywords` 优先；否则把 content 按标点切段，并对每段生成 2-gram，剔除属于角色名的 bigram；
  - 候选去重键 `character_id|fact_id`，证据取首次命中的原句（≤40 字前缀，仍是正文逐字子串），编号 `C1..`，上限 24，顺序稳定。
- 新增纯函数 `detectPossibleLeaks({ characters, facts, states, text })`：
  - 句子须含引号或言说动词（说/道/问/答/念/喊/叫/告诉/提及/讲/写）；
  - 同句角色名 + 事实关键词共现，且该角色当前状态低于 `knows`；
  - 产出 `{character,fact,evidence,fromState,toState}`，`toState = 当前合法状态 || 'suspects'`；去重；**只进 pending，`reason='possible_leak'`**。
- `scanKnowledge` 流程改为：
  1. 规则层算候选与泄漏；
  2. 候选为空：**不调用模型**，返回 `{applied:[], pending:leaks, skippedModel:true}`；
  3. 候选非空：模型输入只含候选编号/角色/事实/原句，输出 `{transitions:[{candidate,toState,evidence?}]}`；
  4. 保留原有闸门：证据句必须逐字在正文（模型给了 evidence 就校验它，没给就用候选原句）、跳级进 pending、`knows`/`exposed` 必须 pending、失败零写入。
- 幂等：写 pending 前按 `(work,chapter,character,fact,from,to,evidence,reason,status='pending')` 查重；已存在则不再插入但仍计入返回数组。已存在同章同状态同证据的 matrix 行按「已应用」计入 applied，不重复插入。保证同初始状态重复扫描结果逐条一致、库中不重复。
- `knowledgeAt` 逻辑不变。

**测试** `web/server/test/knowledgeScanDeterminism.test.js`

- 同一正文、同一假 provider，连跑 3 次（每次前清空该测试作品的 matrix/pending）：断言 `applied/pending` 归一化集合完全相等。
- 候选为空：provider 被调用次数为 0，`skippedModel=true`，结果不含 applied。
- `possible_leak`：角色 A 状态 `suspects`，正文含「司马懿说：你爹是司空府的人。」且事实关键词命中 → pending 一条 `reason='possible_leak'`，applied 不含该条。
- 原有 `pipelineKnowledgeScan.test.js` 七条保持通过（尤其证据句不在正文仍进 pending、跳级仍进 pending）。

### 任务五：主角背景事实

**改 `web/server/database.js`**

- `SCHEMA_VERSION` 递增到 13；
- `story_facts` 建表语句与 `ensureColumn` 增加 `fact_type TEXT NOT NULL DEFAULT 'secret'`；`background` 即 `mustReveal`。

**新文件** `web/server/services/pipeline/backgroundFacts.js`

- `FACT_TYPE_BACKGROUND = 'background'`。
- `normalizeKeywords(input)` / `deriveKeywords(text)`：显式 keywords 优先，否则按标点切段 + 2-gram。
- `upgradeMaterialsToBackgroundFacts({ userId, workId, materialIds, facts })`：
  - 支持素材升格（material 的 title/body 前 200 字 → content，tags/title → keywords，source_material_id 记录）；
  - 支持 agent 抽取（显式 `facts:[{content,keywords,source}]`）；
  - 幂等键 `(work_id, fact_type='background', content)`；不建立素材外键、不双向同步。
- `checkMustReveal({ facts, body })`：只取 `fact_type='background'`，逐项 keyword/原文命中，返回 `{total, covered, missing:[{id,content,keywords}]}`，顺序稳定。
- `pickProtagonist(characters)`：role 含「主角」优先，否则第一条人物卡。
- `mustRevealForChapter({ facts, characters, chapterSeq, priorBodies, body })`：
  - 主角在 `priorBodies` 中已出现 → `{applicable:false}`；
  - 否则首次出场章 → `checkMustReveal` 结果。

**接线（`routes/pipeline.js` + `routes/ai.js`）**

- 新路由 `POST /api/pipeline/:workId/facts/background`：
  - `{ materialIds:[...] }` 或 `{ facts:[{content,keywords}] }`，返回 `{ created, skipped, facts }`；
  - 仅 `background` 类型，不碰 secret facts；不新增表单式录入入口。
- `ai.js` 规划前读取该作品 `background` facts，并入 brief 的 `mustReveal`。
- 交付自检：
  - 取人物卡与主角；查当前章之前的章节正文（有 `seq` 的更早章）判断是否首次出场；
  - 首次出场时 `checkMustReveal`，结果写入 `beatCheck.mustRevealMissing` 并打 `ai_beat_check` 日志；
  - 缺项且未重写过 → 触发一次重写：
    - 分段路径：强制重写第 1 组（传入该组原有 beatIds + `mustReveal` 列表），组指令要求每项至少一句；
    - 单次起稿路径：`buildRewriteInstruction` 增加 `mustReveal` 段落后整章重写一次；
  - 重写后复查；仍缺 → `beatBadge` 增加「背景自检：未交代 X」。
- `payload.beatCheck` 保持原字段并新增 `mustRevealMissing`；不改变已有字段语义。

**测试** `web/server/test/backgroundFacts.test.js`

- 无背景事实入库但人物卡有主角 + 本章正文没提年龄/籍贯/寄养 → `checkMustReveal` 不适用（total=0）；补齐 3 条 background 事实后同一正文 → `missing` 3 条；正文加入对应句子 → `missing` 0（`applicable:true`）。
- `upgradeMaterialsToBackgroundFacts`：同素材重复升格幂等；`missing` 置信度素材仍可升格为 background（背景事实不做 sourced 门禁），但 content 保留「证据不足」来源标记。
- 首次出场判定：更早章正文含主角名 → `applicable:false`；不含 → `applicable:true`。
- 路由级：`beatCheck.mustRevealMissing` 字段由纯函数结果直接写入（在 `ai.js` 用同一函数，测试直接断言该函数输出形状与 ai.js 调用一致）。

### 收尾样本

- 在 `/tmp` 写一次性脚本（不入库、不提交），使用启用模板的新测试作品，锚点/素材真实入库（可含 `missing`/`inferable`），走完整 L0（规划 → 分段 → 覆盖自检 → 锚点/知情注入）。
- 正文落 `docs/superpowers/baseline/runs/2026-11-05-v12-brief-real.md`（沿用既有命名规范，不提交 git）。
- 输出改前（`2026-11-05-v11-upgrade-real.md`）vs 改后逐拍表，重点 B1/B2/B4/B5/B6；另报单钩子、每拍信息增量、知情反查。

## 验证命令

```bash
cd web/server
node --test --test-concurrency=1 --require ./test/setup.js test/planBrief.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/knowledgeScanDeterminism.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/backgroundFacts.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/beatPlan.test.js test/pipelineKnowledgeScan.test.js test/anchorUpgrade.test.js test/materialsStore.test.js
```

若测试库初始化报 `no such table: login_codes`：先用 `test/setup.js` 走一次全新临时库，确认 `database.js` 的建表/`ensureColumn` 全部成功，再跑用例（这是环境初始化问题，不通过调阈值绕过）。

## 提交与回滚

1. `feat(brief): add planBrief with traceable must-do items and beat coverage` —— planBrief 服务 + 测试。
2. `feat(ai): inject planBrief into beat planning and writer segments` —— ai.js / segmentWriter.js 接线。
3. `refactor(knowledge): deterministic candidate layer and possible leak` —— knowledgeScan + 测试。
4. `feat(facts): background facts ingestion and first-appearance mustReveal` —— database/pipeline/ai 接线 + 测试。
每步单独提交，精确 `git add` 对应文件，不 push。

## 不做

- 不为让样本好看调阈值或改 `sample.md`；
- 不新增表单式素材/事实录入；
- 不动 `Editor/`、`utils/selectionRect.js`、用户现有作品数据；
- 不做素材↔锚点↔事实的自动双向同步。

---

# 2026-11-06 追加：质量门前 4 条失败（P0）+ 任务六（P1）

状态：待批准。P0 先做，P1 随后；两者提交分开。

## P0-A 迁移断言过期（只改断言）

已核对：`SCHEMA_VERSION = 13`（`web/server/database.js:38`），两条测试仍断言 12。

- `web/server/test/pipelineGate.test.js:128` 标题 `7 → 12` 改为 `7 → 13`；`:130` 期望 `12` 改为 `13`。
- `web/server/test/pipelineKnowledgeSchema.test.js:162` 标题 `8 → 12` 改为 `8 → 13`；`:164` 期望 `12` 改为 `13`。
- 只改版本号断言；`LEGACY_COUNTS` 行数不变、四列默认 NULL、新表存在等实际校验保持原样。
- 验证：分别跑这两条迁移用例，再重跑一次，确认幂等（版本仍为 13、返回 ok、行数不变）。

## P0-C 真实 v11 旧库迁移失败：索引早于补列

实测：线上 v11 库副本跑 `initDatabase()` 报 `SQLITE_ERROR: no such column: source_material_id`（`database.js:659` exec，`database.js:722` migrate），`user_version` 仍 11。

根因（已核对）：
- `SCHEMA` 里 `idx_work_anchors_material ON work_anchors (work_id, source_material_id)`（`database.js:480-481`）在 `exec(SCHEMA)`（`:722`）时就执行，而 `ensureColumn('work_anchors','source_material_id',...)` 在 `:740` 才补列；v11 老库的 `work_anchors` 表已存在但无该列 → `CREATE INDEX` 中止整次迁移。
- 同类扫描结论：`story_facts.fact_type`（v13 新列）无依赖索引；其余 `user_id` 索引已在 `USER_INDEXES` 中延后。需要挪的只有 `idx_work_anchors_material`，但统一收口到 `LATE_INDEXES` 机制，避免未来重犯。

改 `web/server/database.js`：

1. 从 `SCHEMA` 删除 `idx_work_anchors_material`，新增 `LATE_INDEXES`（依赖 ensureColumn 新列的索引都放这里）。
2. 在全部 `ensureColumn(...)` 之后、`USER_INDEXES` 之前执行 `LATE_INDEXES`。
3. 迁移包进单一事务：
   - `migrate()` 在 `exec(SCHEMA)` 之前 `BEGIN IMMEDIATE`；
   - 成功路径写 `PRAGMA user_version = 13` 后 `COMMIT`；
   - 任一步失败 `ROLLBACK` 后再抛出，保证 `user_version` 与库内容零写入；
   - `ensurePromptOverridesPk()` 去掉自带的 `BEGIN/COMMIT`，由外层事务统一提交/回滚；
   - v0 路径仍在事务外先 `PRAGMA foreign_keys = OFF` 与清遗留表，提交后再 `ON`。
4. 迁移仍只做 CREATE/ALTER/INDEX，不 DROP/DELETE/UPDATE 业务数据。

新回归测试 `web/server/test/schemaMigrationV11.test.js`（新文件）：

- 用 `setupTempEnv()` 造 **v11 真实形态** 库：`PRAGMA user_version = 11`；`work_anchors` 已存在但不含 `source_material_id`；`story_facts` 已存在但不含 `fact_type`；各放 1 行；另放 1 行 `works` 作为外键父行。
- 加载 `database.js` 跑真实迁移，断言五项：
  1. 不抛错，日志出现 `数据库 schema 版本 11 → 13`；
  2. `user_version = 13`；
  3. `work_anchors.source_material_id` 新增且 `NOT NULL DEFAULT ''`、老行为 `''`；`story_facts.fact_type` 新增且 `NOT NULL DEFAULT 'secret'`、老行为 `'secret'`；
  4. `sqlite_master` 中存在 `idx_work_anchors_material`；
  5. `works/work_anchors/story_facts` 行数与迁移前一致。
- 幂等：`db.reopen()` 二次启动，断言不再打印迁移日志、`user_version` 仍 13、行数不变。

提交（不 push，精确 add）：
0. `fix(db): create late indexes after ensureColumn and migrate in one transaction`

## P0-B PV8/PV1 召回断链：受控 `model_only` 通道

根因（已核对）：PV8 的事实 F2 关键词是 `密诏`，正文 `杨平道：我知道司马懿举荐过我。那封举荐信的封泥是青色的。` 不含 `密诏` → `collectCandidates` 不产出 F2 → `scanKnowledge` 在 `web/server/services/pipeline/knowledgeScan.js:563` 的 `if (!candidate) continue;` 丢掉了模型明确给出的 `character=杨平 / factId=F2 / evidence=杨平道：我知道司马懿举荐过我` → pending=0 → PV1 的矩阵行只剩 F3（1 !== 2）。

改 `web/server/services/pipeline/knowledgeScan.js`。

**两个维度分开**：`reason` 回答「为什么进 pending」（等级语义，`'跳级'` 仍是 `'跳级'`），`source` 回答「从哪来、可信度如何」。不用一个字段压另一个。

1. 新增常量 `SOURCE_CANDIDATE='candidate'`、`SOURCE_MODEL_ONLY='model_only'`、`SOURCE_RULE='rule'`；`knowledge_pending` 新增 `source` 列（`NOT NULL DEFAULT 'candidate'`，CHECK 三值）。
2. 候选命中路径的闸门一字不动：证据逐字、只升一级、跳级进 pending、`knows`/`exposed` 必须确认；`reason` 语义不变（PV8 的 `'跳级'` 断言不动）。
3. 第二遍 `model_only` 通道，只处理「解析不到候选」的 transition：
   - 必须能解析出角色（姓名/别名）与事实（`factId` 或 `F#` 编号）；
   - `toState` 必须在 `STATES` 内；
   - `evidence` 必须由模型显式给出，且 `body.includes(evidence)` 逐字成立（不做模糊/子串放宽，也不回退到候选原句）；
   - `STATE_RANK[to] > STATE_RANK[from]`（只接受状态上升）；
   - 满足后 `pushPending({..., reason: 原等级语义, source: SOURCE_MODEL_ONLY})`；绝不进 `applied`、绝不写 `knowledge_matrix`。
   - 任一条不满足 → `continue` 丢弃。
4. 去重：`pushPending` 按 `(characterId, factId, fromState, toState)` 只留一条 pending；候选路径先跑，因此候选优先，`model_only` 不重复堆积。
5. 候选为空时仍不调用模型；`knowledgeAt` 只读 matrix，因此 `model_only` pending 在作者确认前天然不参与注入。确认路由不改：仍校验角色/事实/状态/重复。
6. 前端：`pending` 接口透出 `source`；待确认列表对 `source === 'model_only'` 显示「低可信 · 需人工核对」，候选路径不显示。

测试：

- `web/server/test/pipelineE2E.test.js` PV8：`reason` 仍断言 `'跳级'`，新增 `source === 'model_only'` 断言；`applied=0`、`pending=1`、确认后写 matrix、下一章注入、PV1 矩阵 2 行全部保留。
- `web/server/test/knowledgeScanDeterminism.test.js` 新增三条：
  1. 逐字证据 + 事实关键词不在正文 → `pending` 1 条、`source='model_only'`、`reason='跳级'`、`applied=0`、matrix=0、`knowledgeAt(workId, seq+1)` 看不到该事实；
  2. 模型给的 evidence 不在正文 → 丢弃，`pending=0`；
  3. 同一 transition 既被候选命中又被模型返回 → 只产生 1 条 pending，`source='candidate'` 优先。
- 既有三条确定性用例保持：同正文同参数 3 跑候选集合逐条一致；候选为空零模型调用；possible_leak 仍进 pending。
- `pipelineKnowledgeScan.test.js` 七条回归通过。

验证：

```bash
cd web/server
node --test --test-concurrency=1 --require ./test/setup.js test/pipelineGate.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/pipelineKnowledgeSchema.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/knowledgeScanDeterminism.test.js test/pipelineKnowledgeScan.test.js
node --test --test-concurrency=1 --require ./test/setup.js test/pipelineE2E.test.js
```

全量：`node --test --test-concurrency=1 --require ./test/setup.js`，连跑两次，报总数/通过数/耗时。若出现既有环境问题 `no such table: login_codes`，先确认临时库建表完成再重跑，不跳过、不放宽断言。

提交（不 push，精确 add）：
1. `test(migration): align user_version assertions to 13`
2. `fix(knowledge): allow literal-evidence model_only transitions into pending`

## P1 任务六：brief 的「对手」与「托付」

只做规划输入层，不改写手提示词来「求它写得更用力」。

### `planBrief.js`

- `KINDS` 增加 `opponent`，`KIND_ID_PREFIX.opponent='OP'`；`HARD_KINDS` 仍只含 `loss/mustPresent/mustWithhold`。
- `BRIEF_PROMPT` 增加：
  - `opponent`：本章对抗/牵制主角的外部主体，必须具体到人或势力（如「张杨征粮的使者」「司马家不让他带弓」）；不接受「心软/犹豫/内心挣扎」等内部状态；确实没有时输出 `{"kind":"opponent","none":true,"reason":"为什么没有","source":"..."}`，不硬编。
  - `mustPresent` 支持 `handover=true`：托付人/长辈必须在告别或离场拍当场交付一句可引用的话或一件物。
- `normalizeItem`：识别 `none:true`（或 text 以 `none/无/没有` 开头）→ 归一为 `none:true` + `reason`；非 none 的 opponent 若命中内部状态词表（心软|犹豫|内心|挣扎|动摇|怯懦|恐惧|自责|纠结|矛盾|不忍|舍不得）或不足 4 字 → 丢弃并记 `dropped`；`mustPresent` 保留 `handover:true`。
- `formatPlanBrief` 增加「外部对手（开场拍必须由它施加阻碍）」与「托付（告别/离场拍必须当场交付话或物）」两段；`none` 输出原因；inferred 仍只进建议段。
- `briefWriterBlock` 增加对应两行，非 inferred 才进硬约束。
- `briefCoverage` 在现有硬覆盖后增加两条机械校验：
  - **开场对手**：取 `beats[0].obstacle`；非 inferred、非 none 的 opponent 至少一条的 keyword/原文命中该 obstacle → covered；否则 missing `{kind:'opponent', slot:'opening'}`。有 none 项则记 `opponent.status='none'`，不报缺。
  - **告别托付**：取首个命中 `告别|辞行|离场|送别|启程|出城|离开|上路|动身` 的拍，否则末拍；每个非 inferred、`handover:true` 的 mustPresent 必须在该拍文本里命中人物词，且同拍出现交付语义（`托付|嘱|交|递|塞|赠|留|收着|带上|拿着|「」“”`）；否则 missing `{kind:'mustPresent', slot:'handover'}`。
  - 无 opponent 项 / 无 handover 项时：不新增 missing，保持旧行为（`status='absent'`），不改变既有回落断言。
- `partitionCoverage`：`slot='opening'` 指向 `beats[0]`；`slot='handover'` 指向告别/离场拍；hint 写明「必须由外部主体造成 / 必须由托付人当场交付」。
- 新增纯函数 `mergeHandoverIntoBrief(brief, {characters, settings})`：
  - 人物卡 `relations`（JSON）或设定 `name/category/content` 命中 `寄养|托付|拜师|代养|养父|养母|义父|义母|收养|监护人|师父`；
  - 主角由 `role` 含「主角」优先；托付人取 relations 对端或设定里出现的非主角人物卡名；
  - 确定性地加一条 `mustPresent`、`handover:true`、`source='人物卡'|'设定'`、`inferred:false` 的条目（若已有同人物的 mustPresent，则把该条标成 `handover:true`，不重复加）；
  - `brief` 为 null 时原样返回 null（保持 brief 失败回落旧链路）。

### `routes/ai.js`

- brief 生成后读取该作品 `characters(role,relations,identity)` 与 `settings(name,category,content)`，调用 `mergeHandoverIntoBrief`。
- 覆盖失败重排一次的逻辑沿用；`planDegraded` 文案带 slot：`kind/slot/text`（普通项仍 `kind/text`）。
- `payload.briefCoverage` 透出 `opponent`/`handover` 状态；日志加 `briefOpponent/briefHandover`。

### 测试 `test/planBrief.test.js`

- opponent：内部状态项被丢弃；具体主体通过；`none` 合法且不进硬覆盖。
- 开场对手：opponent 只在 B1 goal/cost、不在 obstacle → 报 `opponent/opening` 缺；写进 obstacle → 覆盖。
- 托付：handover 项只在 B3、告别拍无该人 → 报 `mustPresent/handover` 缺；告别拍有人物 + 交付语义 → 覆盖。
- `mergeHandoverIntoBrief`：人物卡「养父」关系与设定「寄养」都能确定性加项；已有同人物 mustPresent 时只加 `handover:true`。
- `brief=null`、空 items 的旧回落断言保持通过。

### 重跑样本

- 复用 `/tmp/ct-run-brief.cjs` 的 `MODE=same`：同题材、同 v11 提纲、同素材、模板开启、完整 L0。
- 落 `docs/superpowers/baseline/runs/2026-11-06-v13-brief-opponent-handover.md`（不提交）。
- 逐拍对比 `2026-11-05-v12-brief-real.md`，只看 B1（阻碍是否由具体外部主体造成）与 B6（是否有长辈当面托付）。
- brief 仍推不出对手/托付 → 如实报「输入不足」并列出需补素材/设定类型，不编造。

提交（不 push，精确 add）：
3. `feat(brief): add opponent and handover planning constraints`
4. `test(brief): cover opponent/handover hard checks and handover registration`

## P0/P1 不做

- 不 push；不为好看调阈值；不改写手提示词去「求它写得更用力」。
- 不碰 `Editor/`、`utils/selectionRect.js`、用户现有作品数据。
- P0 与 P1 不混提交。
