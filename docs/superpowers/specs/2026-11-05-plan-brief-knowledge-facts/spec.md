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
