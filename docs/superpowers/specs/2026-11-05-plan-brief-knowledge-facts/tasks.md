# 任务清单

## T3 planBrief
- [x] 新建 `web/server/services/agent/planBrief.js`：prompt、`validatePlanBrief`、`generatePlanBrief`、`formatPlanBrief`、`briefCoverage`、`briefWriterBlock`、`partitionCoverage`
- [x] `routes/ai.js`：规划前生成 brief（含 missing 素材与 background facts）；注入规划 system；硬缺项重排一次；仍缺写 `planDegraded`
- [x] `routes/ai.js` + `services/agent/segmentWriter.js`：写手 system 与组指令注入 brief 具体约束
- [x] `test/planBrief.test.js`：粗提纲推 loss/mustPresent/mustWithhold、inferred 非硬约束、覆盖报缺、空 brief 回落
- [x] 提交 1

## T4 知情扫描确定性
- [x] `knowledgeScan.js`：`collectCandidates` / `detectPossibleLeaks` / 模型只看候选 / 空候选不调模型 / pending 幂等 / possible_leak 进 pending
- [x] `test/knowledgeScanDeterminism.test.js`：3 次一致、空候选零调用、possible_leak
- [x] 回归 `test/pipelineKnowledgeScan.test.js`
- [x] 提交 2

## T5 背景事实
- [x] `database.js`：`fact_type` 列 + `SCHEMA_VERSION=13`
- [x] 新建 `services/pipeline/backgroundFacts.js`：素材/agent 抽取入库、幂等、`checkMustReveal`、首次出场判定
- [x] `routes/pipeline.js`：`POST /:workId/facts/background`
- [x] `routes/ai.js`：brief 并入 background mustReveal；首次出场缺项触发一次重写；仍缺打徽标；`beatCheck.mustRevealMissing`
- [x] `test/backgroundFacts.test.js`：缺失/补齐两态、幂等、首次出场
- [x] 提交 3

## 收尾样本
- [x] `/tmp` 真实模型脚本：新测试作品 + 锚点/素材 + 完整 L0（粗提纲与同 v11 提纲各跑一次）
- [x] 正文落 `docs/superpowers/baseline/runs/2026-11-05-v12-brief-real.md`（不提交）
- [x] 改前 vs 改后逐拍对比表 + 三项断言 + 判断

## P0-C v11 真实旧库迁移（2026-11-06）
- [x] `database.js`：`idx_work_anchors_material` 移出 SCHEMA，ensureColumn 后建 `LATE_INDEXES`
- [x] `database.js`：`migrate()` 包单一事务，失败 ROLLBACK 零写入；`ensurePromptOverridesPk` 去自带事务
- [x] 新建 `test/schemaMigrationV11.test.js`：v11 形态（表存在但缺列）+ 版本/列/默认值/索引/行数/幂等
- [x] 提交 `fix(db): create late indexes after ensureColumn and migrate in one transaction`

## P0-A 迁移断言（2026-11-06）
- [x] `pipelineGate.test.js`：7 → 13，期望 13（只改版本号）
- [x] `pipelineKnowledgeSchema.test.js`：8 → 13，期望 13（只改版本号）
- [x] 重跑两条迁移用例确认幂等、行数不变
- [x] 提交 `test(migration): align user_version assertions to 13`

## P0-B model_only 通道（2026-11-06）
- [x] `knowledge_pending` 新增 `source` 列（candidate/model_only/rule），与 `reason` 解耦
- [x] `knowledgeScan.js`：无候选但角色/事实可解析 + evidence 逐字 + toState 上升 → pending，`source='model_only'`，`reason` 保持等级语义，不写 matrix
- [x] `pipelineE2E.test.js` PV8：`reason='跳级'` 不动，新增 `source='model_only'` 断言
- [x] `knowledgeScanDeterminism.test.js`：逐字进 pending、证据不存在丢弃、未确认不注入、候选优先去重
- [x] 候选 3 跑一致 / 空候选零调用 / possible_leak 回归
- [x] 前端待确认列表对 `model_only` 标「低可信 · 需人工核对」
- [x] 全量测试连跑两次，报总数与耗时
- [x] 提交 `fix(knowledge): allow literal-evidence model_only transitions into pending`

## T6 对手与托付（2026-11-06）
- [ ] `planBrief.js`：`opponent` kind、`none` 语义、内部状态拒绝、`mustPresent.handover`
- [ ] `planBrief.js`：开场对手 / 告别托付两条硬校验；`partitionCoverage` 落点；`planDegraded` 带 slot
- [ ] `planBrief.js`：`mergeHandoverIntoBrief`（人物卡 relations / 设定关键词）
- [ ] `routes/ai.js`：读取 characters/settings 并入 brief；日志与 payload 透出
- [ ] `test/planBrief.test.js`：对手/托付/注册/回落五组断言
- [ ] 真实样本 `MODE=same` 重跑，落 `2026-11-06-v13-brief-opponent-handover.md`（不提交）
- [ ] B1/B6 改前 vs 改后对比 + 「输入缺项 / 规划没排进去」结论
- [ ] 提交 3、4（与 P0 分开）
