# 记忆冲突消解（软失效）设计

日期：2026-10-30
状态：待评审
范围：CuriosityTrail Web 端的长期记忆层（`web/server/services/memory/`）

## 1. 背景与目标

现有事实层（`conv_fact`）是**只增不删**的：每轮对话由模型抽取出「值得长期记住的事实」，写进台账与向量库，之后再也不会改动。作者把主角设定从「姓江」改成「姓沈」时，两条事实会同时躺在库里，召回时谁分高谁被翻出来——模型可能拿着早已作废的设定继续写。

这正是主流记忆系统（Mem0 的 ADD/UPDATE/DELETE、Zep 的双时间图谱）已经在解决的问题。本项目当前停在「检索」这一代，缺「整合」这一代。

目标：让**模型自己推断出来的事实**之间能够互相覆盖，且覆盖过程可追溯、可回退。

### 目标

1. 新事实推翻旧事实时，旧事实自动失效，不再被召回。
2. 失效是**软性**的：旧条留在台账里，标记「被谁取代、何时、为什么」。
3. 绝不自动作废作者亲手写的内容（手动层、人物卡、设定卡、章节正文）。
4. 判定失败时只写入、不作废——宁可少消解，不可误删。
5. 默认零额外成本：绝大多数对话轮次不触发任何模型调用。

### 非目标（本版不做）

- **时间区间生效/失效**（Zep 式双时间）：只记「何时被作废」，不记「从第几章起生效」。
- **作废历史的作者界面**：`MemoryPanel` 仍只展示本次有效召回，不展示作废记录。
- **跨来源冲突**：事实与人物卡矛盾时不处理，卡片是权威源。
- **对历史数据补跑**：已有的批量事实块不拆分、不重判。
- **硬删除**：不物理删除被作废的事实记录（作品/用户删除时的级联除外）。注意「删除向量」不等于删除事实——向量只是派生数据，台账里的原文与状态始终保留。

## 2. 已确认决策

| 决策点 | 结论 |
| --- | --- |
| 作废方式 | 软失效（标记 superseded，保留原文） |
| 作用范围 | 仅 `conv_fact`；`conv_manual` / `character` / `setting` / `chapter` / `conv_raw` 永不自动作废 |
| 判定时机 | 写入时判定，异步于对话，不增加对话延迟 |
| 存储形态 | 扩展现有 `memory_chunks` 台账，不新建表 |
| 事实粒度 | 一条事实一个块（`chunk_no` 递增），可单独寻址 |
| 触发条件 | 与旧事实的向量相似度 ≥ 门槛才调模型；低于门槛直接写入 |
| 失败策略 | 判定不可用时只写入、不作废 |

## 3. 数据模型

`memory_chunks` 新增三列（schema **4 → 5**，用 `ALTER TABLE ADD COLUMN`，老数据不受影响）：

| 列 | 类型 | 含义 |
| --- | --- | --- |
| `superseded_by` | TEXT NULL | 取代它的那条块 `id`；NULL = 有效 |
| `superseded_at` | TEXT NULL | 作废时间（ISO 8601） |
| `supersede_reason` | TEXT NULL | 一句话理由，供审计与将来的界面展示 |

不加新索引：召回侧的候选查询走已有的 `idx_memory_work (user_id, work_id, source_type)`，状态过滤在 Node 侧做，数据量在万级以内不构成瓶颈。

### 事实粒度调整

`rememberFacts` 目前把一轮的多条事实 `facts.join('\n')` 成**一个块**（`chunk_no = 0`）。改为**每条事实一个块**，`chunk_no = 0..n-1`。

- 已有的唯一索引 `(source_type, source_id, chunk_no)` 天然支持这种粒度，无需改动。
- `source_id` 仍是消息 id，所以「重新生成 / 删除消息时清掉三层」的现有逻辑（按 `source_type + source_id` 删除）自动覆盖多块，不需要改。
- 历史数据不迁移：已存在的批量 `conv_fact` 块当作「多事实块」保留，只能整体作废。

## 4. 写入流程

挂在现有的抽取回调里（`conversation.rememberTurn` → `onFacts`），全程异步于对话：

```
抽取返回 facts[]
  │
  ├─ 1. 每条 fact 向量查同作品的 conv_fact 候选（top 8，minScore = 冲突门槛）
  │      门槛在查询时就生效，候选集天然只包含「够像」的旧事实
  │
  ├─ 2. 候选为空 → 跳过判定，直接写入（零模型调用）
  │
  ├─ 3. 有候选 → 一次小模型调用（temperature 0.1，JSON 输出）
  │      输入：本次的新事实 + 候选旧事实（含 id 与正文）
  │      输出：{"supersedes":[{"id":"...","reason":"..."}]}
  │
  ├─ 4. 事务：写入新块 → 标记旧块 superseded_by / superseded_at / supersede_reason
  │
  └─ 5. 从 sidecar 删除旧块向量（失败不回滚台账）
```

判定提示词要求模型只回答「新事实是否在**同一维度上**更新/推翻了某条旧事实」，并列明不构成冲突的情形（补充细节、不同时间点的事件、不同人物）。

候选查询复用 `client.query`，`targetUri` 限定到作品根；结果在 Node 侧再过滤一次 `sourceType === 'conv_fact'`，并排除本轮自己刚写入的块。

## 5. 召回侧调整

1. **去重规则**：`MAX_CHUNKS_PER_SOURCE = 1` 会把同一消息的多条事实压成一条。对 `conv_fact` 单独放宽到 **3 条**（`MAX_CHUNKS_PER_SOURCE_CONV_FACT`），其余类型维持 1。总预算仍是 8 条 / 3000 字，不会被撑爆。
2. **双保险过滤**：作废时虽然会删掉向量，但删除可能失败。因此召回结果回到 Node 侧后，按 `(source_type, source_id, chunk_no)` 回查台账，`superseded_at` 非空的一律丢弃。只靠删向量不够——**召回一条作废的设定，比少召回一条危害大得多**。

## 6. 失败处理

| 情况 | 行为 |
| --- | --- |
| sidecar 不可用，拿不到候选 | 跳过判定，事实照常写入，不作废任何东西 |
| 判定模型超时 / 报错 | 同上 |
| 判定返回非法 JSON / 空结果 | 同上（按「无冲突」处理） |
| 作废时向量删除失败 | 台账照样标记作废；靠召回侧台账过滤兜底 |
| 索引写入失败 | 走现有重试机制，与消解无关 |

## 7. 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEMORY_CONSOLIDATE_ENABLED` | `true` | 总开关；`false` 即完全回到当前行为 |
| `MEMORY_CONFLICT_MIN_SCORE` | `0.35` | 候选相似度门槛，低于它不调模型 |
| `MEMORY_CONFLICT_CANDIDATES` | `8` | 每次拉取的候选条数上限 |

判定调用复用 `aiConfig` 的当前 provider，不新增密钥。

## 8. 观测

每次消解打一行结构化日志：

```json
{"event":"memory_consolidate","newFacts":3,"superseded":1,"skipped":""}
```

`skipped` 取值：`disabled` / `low_score` / `no_candidate` / `failed`。排查时能直接区分「没触发」与「触发了但没判出冲突」。

## 9. 测试

### 单元

- 判定输出解析：合法 JSON / 带 markdown 围栏 / 非法 JSON / 空结果
- 相似度低于门槛时**不发起**模型调用
- 判定失败时返回空决策，不产生作废

### 集成（复用 `test/fakeModel.js`）

1. 新事实推翻旧事实 → 旧块 `superseded_by/at/reason` 有值；sidecar 删除被调用；召回不再返回旧条
2. 新事实与旧事实不冲突 → 旧块保持有效
3. `conv_manual` 即使语义高度相似也**永不被作废**
4. 删除消息 / 重新生成 → 该消息的全部事实块（含已作废的）一并清除
5. 全量重建索引 → 跳过 `superseded_at` 非空的行，不复活废条目
6. sidecar 不可用 → 事实照常写入，零作废
7. 台账过滤：模拟向量删除失败（sidecar 删接口报错），作废条目仍不出现在召回结果里

## 10. 影响面

| 文件 | 改动 |
| --- | --- |
| `web/server/database.js` | schema 4 → 5，新增三列与迁移 |
| `web/server/services/memory/consolidate.js` | 新增：候选检索、模型判定、决策解析 |
| `web/server/services/memory/conversation.js` | `rememberFacts` 拆分为一事一块 |
| `web/server/services/memory/indexer.js` | 作废标记、向量删除、重建跳过废行 |
| `web/server/services/memory/retriever.js` | `conv_fact` 去重放宽、召回按台账过滤作废块 |
| `web/server/config.js` | 三个新配置项 |
| `web/server/test/memoryConsolidate.test.js` | 新增测试 |

不影响：对话链路时延、`MemoryPanel` 展示、前端代码。

## 11. 风险与回退

| 风险 | 缓解 |
| --- | --- |
| 模型误判，把有效设定作废 | 软失效：库里仍在、可查、可手工恢复；只作用于 `conv_fact` |
| 消解调用增加成本 | 相似度门禁；绝大多数轮次零调用；开关可关 |
| 向量删除失败导致旧条被召回 | 召回侧二次按台账过滤 |
| 判定给错旧事实 | 决策里携带旧块 id，不回退到「按相似度猜」 |
| 上线后行为异常 | `MEMORY_CONSOLIDATE_ENABLED=false` 立即回到当前行为，无需回滚代码 |
