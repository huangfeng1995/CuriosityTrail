# 任务清单

## T3 planBrief
- [ ] 新建 `web/server/services/agent/planBrief.js`：prompt、`validatePlanBrief`、`generatePlanBrief`、`formatPlanBrief`、`briefCoverage`、`briefWriterBlock`、`partitionCoverage`
- [ ] `routes/ai.js`：规划前生成 brief（含 missing 素材与 background facts）；注入规划 system；硬缺项重排一次；仍缺写 `planDegraded`
- [ ] `routes/ai.js` + `services/agent/segmentWriter.js`：写手 system 与组指令注入 brief 具体约束
- [ ] `test/planBrief.test.js`：粗提纲推 loss/mustPresent/mustWithhold、inferred 非硬约束、覆盖报缺、空 brief 回落
- [ ] 提交 1

## T4 知情扫描确定性
- [ ] `knowledgeScan.js`：`collectCandidates` / `detectPossibleLeaks` / 模型只看候选 / 空候选不调模型 / pending 幂等 / possible_leak 进 pending
- [ ] `test/knowledgeScanDeterminism.test.js`：3 次一致、空候选零调用、possible_leak
- [ ] 回归 `test/pipelineKnowledgeScan.test.js`
- [ ] 提交 2

## T5 背景事实
- [ ] `database.js`：`fact_type` 列 + `SCHEMA_VERSION=13`
- [ ] 新建 `services/pipeline/backgroundFacts.js`：素材/agent 抽取入库、幂等、`checkMustReveal`、首次出场判定
- [ ] `routes/pipeline.js`：`POST /:workId/facts/background`
- [ ] `routes/ai.js`：brief 并入 background mustReveal；首次出场缺项触发一次重写；仍缺打徽标；`beatCheck.mustRevealMissing`
- [ ] `test/backgroundFacts.test.js`：缺失/补齐两态、幂等、首次出场
- [ ] 提交 3

## 收尾样本
- [ ] `/tmp` 真实模型脚本：新测试作品 + 锚点/素材 + 完整 L0
- [ ] 正文落 `docs/superpowers/baseline/runs/2026-11-05-v12-brief-real.md`（不提交）
- [ ] 改前 vs 改后逐拍对比表 + 三项断言 + 判断
