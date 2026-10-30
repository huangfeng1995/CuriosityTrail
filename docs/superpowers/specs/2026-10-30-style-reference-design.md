# 风格参照（好样例 / 坏样例）设计

日期：2026-10-30
状态：待评审
范围：CuriosityTrail Web 端（`web/`）

## 1. 背景与目标

### 1.1 问题

作者心里有一套「什么样的文字是好的、什么样的是不好的」的标准，但这套标准现在只存在于作者脑子里。平台给模型的文风要求是写死在角色提示词里的（[writer.js](../../../web/server/services/roles/writer.js) 的「绝对黑名单」「句式与行文纪律」两节），那是**平台的通用主张**，不是**这个作者的主张**。

两个具体表现：

1. **模型写出来的东西有统一的「AI 腔」。** 平台的黑名单能挡住「眸色一暗」这类模板词，挡不住「节奏偏快、比喻密集、对话占比太低」这种**整体调性**的偏差。作者觉得「不对味」，但说不清哪儿不对。
2. **作者写过的最好的段落无法复用。** 作者自己第三章那段最满意的描写，是他最好的样本——但它现在只是正文的一段，模型写新章节时看不到它，作者也没法告诉 AI「照这个写」。

### 1.2 目标

1. 作者能存下「我心中的好文章」和「我讨厌的文章」，并让 AI 参考。
2. 参考的方式必须是**规则**，不是**原文照抄**。理由见 §2.1。
3. 规则必须落到**可执行的维度**上（句长、对话占比、比喻密度、禁用词表），否则模型执行不住。
4. 规则要能**自查**：AI 写完之后能对着规则核一遍，不合规自己改。
5. 好样例的来源要覆盖「作者自己写过的章节」——这是质量最高、最没有版权顾虑的样本。

### 非目标（本版不做）

- 不做「把原文塞进 prompt 让模型模仿」（理由见 §2.1）。
- 不做多套文风并存切换（一个用户一份全局 + 按作品覆盖，已经够用）。
- 不做规则的自动学习（从作者长期写作里反推风格）——那是「写作指纹」需求，不在本版。
- 不做多用户共享样例库。
- 不做规则版本历史。

## 2. 已确认决策

### 2.1 好/坏样例不直接进 prompt，必须先蒸馏成规则

**决策**：样例原文只在**蒸馏那一刻**存在于内存，蒸馏完即弃。AI 实际读到的是蒸馏出来的规则。

**库里留不留摘要？分来源**：

| 来源 | 摘要 | 理由 |
| --- | --- | --- |
| 粘贴文本 | **不留** | 粘贴的原文很可能来自别人的作品，留 100 字片段等于替对方长期保管；而且短样例的「摘要」就是全文，留了等于原文入库。粘贴样例靠标题辨认就够了。 |
| 自己写过的章节 | 留 ≤100 字 | 自己的稿子没有版权问题，摘要是作者辨认「这条规则是从哪段提炼的」的唯一线索。 |

**理由**（三条，缺一不可）：

1. **负样例会反向污染。** 作者心里的「坏文章」往往文笔不差，只是调性不对。few-shot 里没有「负样本」这个位置——把坏样例和好样例一起放进 prompt，模型照样会学它的写法（它看到的是「这就是要写的样子」）。必须把「不好」翻译成**显式的禁用清单**，而不是「一段别学的文字」。
2. **原文抢预算。** 上下文总预算 24000 字符（[context.js](../../../web/server/services/context.js) 的 `CONTEXT_BUDGET`），当前章正文一项就占 12000。塞两段原文进来，正文、人物、设定、记忆都要被挤掉。
3. **版权与存储。** 坏样例最可能来自别人的作品。原文不入库，规则入库——这是最省事也最干净的边界。

### 2.2 「好/坏」必须落到维度上

**决策**：规则卡不是一段自由散文，而是一组**固定槽位**：

| 槽位 | 含义 | 可否自动核对 |
| --- | --- | --- |
| `sentenceLength` | 每句字数区间 | 可（本地精确算） |
| `dialogueRatio` | 对白占比（%） | 可（块类型或引号估算） |
| `imageryDensity` | 每千字的比喻数 | 可（比喻标记词计数，近似） |
| `bannedWords` | 禁用词表 | 可（命中即违规） |
| `notes` | 定性要求（自由文本） | 不可，只进 prompt |

理由：自由散文形式的规则，模型只能「大致理解」，写手角色已经有一份散文式的纪律清单了，再加一段散文只会互相稀释。固定槽位可以被 `check_style` 技能**确定地**核对，作者也能一眼看出「我的要求是什么」。

### 2.3 好样例的最佳来源是作者自己已写的章节

**决策**：添加样例时提供两个来源——粘贴文本 / 从「我已写的章节」里选。

理由：自己写的段落是**最准的风格样本**（它天然包含了作者的口味），且没有版权顾虑。而且这种样本往往比随手找的一段网文更接近「这部作品该有的样子」。从章节选还能拿到**块结构**（哪些是对白），对话占比算得比粘贴文本准。

### 2.4 其它已确认决策

| 决策点 | 结论 |
| --- | --- |
| 规则卡作用域 | **全局一份 + 可按作品覆盖**。作品级存在该类规则时，作品级**整类替换**全局级（不是叠加），因为叠加会产生「既要 A 又要 非A」的矛盾要求。 |
| 样例原文 | 不入库。库里只留标题、来源标注；自己章节的样例额外留 ≤100 字摘要（粘贴的不留，见 §2.1）。 |
| 自查形式 | 做成技能 `check_style`，与 `check_character_consistency` 并列出现在技能清单里。 |
| 蒸馏失败 | 不写卡，返回明确错误让作者重试。**不写半张卡**——半张卡会被当成生效规则，比没有更糟。 |
| 降级 provider | 蒸馏走本地模型时，卡片上标「可信度有限」，但**照常生效**（规则是作者自己确认过的，模型的判断只影响精度）。 |

## 3. 架构

```
作者在「文风」页添样例
   │  POST /api/style/cards  { kind, title, content | chapterId, workId }
   ▼
routes/style.js
   │
   ├─ 取原文：粘贴的 content，或按 chapterId 读自己的章节（归属校验）
   ├─ services/style/distill.js ──→ 调模型，产出规则 JSON
   │      ├─ services/style/metrics.js 先本地算一遍客观指标，作为模型的事实依据
   │      └─ temperature 0.2 / thinking disabled / jsonOutput
   ├─ 原文在此丢弃（从不写库）
   ▼
style_cards 表（规则卡）
   │
   ├─ services/style/index.js  resolveEffectiveStyle(userId, workId)
   │      ├─ 按 kind 分组取卡（作品级优先，整类替换）
   │      ├─ 多卡合并（数值取交集、词表取并集）
   │      └─ formatStylePrompt() → 注入文本
   │
   ├─ services/context.js  ──→ 把注入文本作为 fixed 分区拼进 system prompt
   │
   └─ services/skills/checkStyle.js ──→ 对着规则核对正文（规则层，免费、确定）
```

### 3.1 数据表

```sql
CREATE TABLE IF NOT EXISTS style_cards (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id      TEXT REFERENCES works(id) ON DELETE CASCADE,  -- NULL = 全局
  kind         TEXT NOT NULL CHECK (kind IN ('good','bad')),
  title        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'paste',  -- paste | chapter
  chapter_id   TEXT,                          -- source=chapter 时记录来源章节
  excerpt      TEXT,                          -- ≤100 字摘要，仅供辨认
  rules        TEXT NOT NULL,                 -- JSON：维度化规则
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_style_cards_user ON style_cards(user_id, work_id, kind);
```

`schema` 版本 3 → 4。这是**新增表**，不改动任何已有表，不删数据。

**为什么一张表同时承担「样例」和「规则卡」两个角色**：作者提交的是一段样例，蒸馏后产出一张卡。这张卡同时记着「它来自哪段样例」（`source` / `chapter_id` / `excerpt`）和「它现在是什么规则」（`rules`）。作者手改 `rules` 不会丢来源信息；重新蒸馏时（提交新内容）会新建一张卡，旧卡保留以便回退。

### 3.2 规则 JSON

```json
{
  "summary": "冷硬短句，白描为主，几乎不比喻",
  "metrics": {
    "sentenceLength": { "min": 8, "max": 25 },
    "dialogueRatio": { "min": 10, "max": 35 },
    "imageryDensity": { "max": 2 }
  },
  "bannedWords": ["仿佛", "一丝", "不禁", "眸色一暗"],
  "notes": ["不解释人物动机", "不写上帝视角评价"]
}
```

**`good` 卡与 `bad` 卡的 `metrics` 语义不同**：

- `good`：`min`/`max` 是**期望落在这个区间**。句长 8–25 字表示「每句 8 到 25 字」。
- `bad`：`max` 是**警戒上限，超过即违规**；`min` 忽略（坏样例的「至少多少」没有意义）。句长 `max: 30` 表示「每句不要超过 30 字」。

两者的 `bannedWords` 语义一致：**出现即违规**。

### 3.3 维度计算（本地，规则层）

`services/style/metrics.js`，纯函数，无 IO：

| 指标 | 算法 |
| --- | --- |
| `sentenceLength` | 按中文句末标点（`。！？；…` 与换行）切句，逐句用 [wordCount.js](../../../web/server/services/wordCount.js) 的 `countWords` 口径计字数，取平均与最长 |
| `dialogueRatio` | 有块结构时：对话块字数 / 总字数；纯文本时：中文引号（`“”「」`）内字符数 / 总字数（近似） |
| `imageryDensity` | 比喻标记词命中数 / 千字 × 1000。标记词表固定：像、如同、仿佛、宛如、好似、犹如。「像」有动词义噪声，属于已知近似，注释里写明 |

口径统一用 `countWords`，与作品进度、编辑器字数统计一致。

### 3.4 注入位置与预算

风格规则作为 **fixed 分区**拼进 system prompt，位置在**角色提示词之后、作品信息之前**：

```
[角色提示词]      ← 模型先知道「你是谁」
---                ← 分隔符
[文风要求]        ← 再知道「写成什么样」
---
[作品信息 / 人物 / 正文 / 记忆 / 检索]
---
[可用技能]        ← 末尾：角色提示词规定了 action 白名单，追加段必须在其后
```

**fixed 的含义**：不参与预算竞争，不被截断。

理由：技能清单已经用了这个做法（`context.js` 里 `applyBudget(parts, CONTEXT_BUDGET - skillsText.length)` 再把技能清单单独 push）。风格规则同理——它是作者定的硬约束，被裁掉模型就只能瞎猜。实现上给 `applyBudget` 的 part 增加一个 `fixed` 标记：fixed 的部分不计入总和、不参与截断。

预算改为：

```js
const fitted = applyBudget(parts, Math.max(2000, CONTEXT_BUDGET - skillsText.length - styleText.length));
```

### 3.5 生效规则解析

```js
resolveEffectiveStyle(userId, workId) → {
  good: { cards: [...], rules: { metrics, bannedWords, notes, summary } },
  bad:  { cards: [...], rules: { ... } },
}
```

规则：

1. 按 `kind` 分成 good / bad 两组，**分别**解析。
2. 每组先查作品级（`work_id = ?`）；**有卡就用作品级，整类替换全局级**；没有才用全局级（`work_id IS NULL`）。
3. 同组多卡的合并：
   - `metrics`：**数值取交集**（`min` 取各卡最大值、`max` 取各卡最小值）。多张好样例的共性就是交集。若交集为空（矛盾），退回并集并在该维度上标注冲突。
   - `bannedWords` / `notes`：取并集。
   - `summary`：多条拼接。
4. `enabled = 0` 的卡不参与。

**为什么作品级整类替换而不是叠加**：叠加会出现「全局要求句长 ≤30，作品要求句长 ≥40」这类互相矛盾的要求，模型只能瞎猜。整类替换的语义是「这部作品我另有一套」，符合直觉。

### 3.6 `check_style` 技能

**定位**：只做规则层核对，**不做定性判断**。

与 [checkConsistency.js](../../../web/server/services/skills/checkConsistency.js) 同构——只报能确定的问题，不花模型的钱做语义判断。定性要求（`notes`）已经随规则进了 prompt，由模型自己在写的时候遵守；技能只负责把**能算的**那部分核出来。

核对项：

| 维度 | 判定 |
| --- | --- |
| `sentenceLength` | good：平均句长须落在区间内，超出记一条违规（附最长几句）。bad：平均句长超过 `max` 记一条违规 |
| `dialogueRatio` | good：实际占比须落在区间内。bad：超过 `max` 记一条违规 |
| `imageryDensity` | good：实际密度须 ≤ `max`。bad：超过 `max` 记一条违规 |
| `bannedWords` | 命中即违规，列出命中词与所在句子（最多 10 处） |

参数：

```js
{
  target: { type: 'string', description: '要检查的正文片段。不填则检查当前章节全文。' }
}
```

需要 `ctx.chapterId` 才能查当前章节——现有 `ctx` 里没有，本次在 [routes/ai.js](../../../web/server/routes/ai.js) 的 `runAgentLoop` 调用处补上 `chapterId`。

**技能只读，不改正文**：结果回灌给模型，模型自己决定要不要重写。这与另外两个技能一致。

### 3.7 蒸馏

`services/style/distill.js`，一次模型调用，输入样例原文（截断到 4000 字）+ `kind`，输出规则 JSON。

提示词要点：

- 明确告诉模型**不要模仿原文、不要复述原文内容**，只输出**可执行的风格特征**。
- good：说清「哪些特征值得学」，给出每句字数的目标区间等。
- bad：说清「哪些特征必须避免」，`metrics` 只给 `max`。
- 给出**本地已算好的客观指标**作为事实依据（模型自己估句长不可靠）。
- 要求输出严格 JSON，字段固定。

调用参数与 [auditForeshadowing.js](../../../web/server/services/skills/auditForeshadowing.js) 一致：`temperature: 0.2`、`thinking: 'disabled'`、`jsonOutput: true`、`maxTokens: 1200`。

解析用 `parseModelJson`（[parse.js](../../../web/server/services/agent/parse.js)）。**解析失败或字段非法 → 抛错，不写卡**。

### 3.8 模块边界

| 模块 | 职责 | 依赖 | 不碰 |
| --- | --- | --- | --- |
| `services/style/metrics.js` | 维度计算（纯函数） | `wordCount.js` | 数据库、provider |
| `services/style/rules.js` | 规则合并 + 注入文本格式化（纯函数） | 无 | 数据库、provider |
| `services/style/distill.js` | 调模型产出规则 JSON | provider、`agent/parse.js` | 数据库、HTTP |
| `services/style/index.js` | 读卡、解析生效规则、对外出口 | database、`rules.js` | provider、HTTP |
| `routes/style.js` | 路由：取原文、编排蒸馏、写卡 | `style/index.js`、`style/distill.js`、providers | — |
| `services/context.js` | 把风格段作为 fixed 分区拼进 prompt | `style/index.js` | — |
| `services/skills/checkStyle.js` | 对着规则核对正文 | `style/index.js`、`style/metrics.js` | 正文写入 |

## 4. API

```
GET    /api/style/cards?workId=...   列出全部卡（全局 + 作品），标记哪张生效
POST   /api/style/cards              添样例 → 蒸馏 → 建卡
PUT    /api/style/cards/:id          改标题 / 改规则（作者手改）/ 停用启用
DELETE /api/style/cards/:id          删卡
GET    /api/style/chapters           列出「我已写的章节」供选样例
```

`POST /api/style/cards` 请求体：

```json
{
  "kind": "good" | "bad",
  "title": "第三章那段雨夜",
  "content": "粘贴的原文",       // 与 chapterId 二选一
  "chapterId": "xxx",            // 从自己章节选
  "workId": "xxx",               // 作用范围：省略 = 全局
  "notes": "作者的补充说明"       // 可选，喂给蒸馏模型
}
```

归属校验：读章节按 `chapter_id + user_id` 联表查，拿到别人的章节 id 一律 404。

## 5. 前端

新页面「文风」，顶栏加一项（`navItems` 加 `文风`，图标 `Palette`）。

页面结构：

- 顶部说明 + 「添加样例」按钮。
- 两个分区：「要学的（好样例）」/「要避开的（坏样例）」，各列卡片。
- 卡片显示：标题、来源标注（粘贴 / 第 X 章）、摘要、维度 chips、禁用词 tags、操作（编辑规则 / 停用 / 删除）。
- 「添加样例」弹窗：类型（好/坏）→ 标题 → 来源（粘贴文本 / 从我的章节选）→ 作用范围（全局 / 某部作品）→ 备注 → 提交（提交时显示蒸馏中）。
- 「编辑规则」弹窗：可改 `summary`、`notes`、三个维度的数值、`bannedWords`。数值留空表示不约束。

样式沿用 `theme.css` 的语义变量，不引入新色系。

## 6. 测试策略

新增 `web/server/test/styleReference.test.js`：

| 用例 | 断言 |
| --- | --- |
| 建卡 | 蒸馏成功后卡入库；**原文不出现在库里任何字段** |
| 蒸馏失败 | 返回 502；库里没有卡 |
| 归属隔离 | 读别人的章节做样例 → 404；改别人的卡 → 404；删别人的卡 → 404 |
| 生效规则 | 有作品级 good 卡时，全局 good 卡整类替换；作品级只有 bad 时，good 仍取全局 |
| 多卡合并 | 数值取交集；禁用词取并集 |
| 维度计算 | 句长切句与字数口径；对话占比（有块 / 纯文本两种）；比喻密度 |
| 上下文注入 | prompt 含风格段；风格段在角色提示词之后；超预算时风格段不被截 |
| `check_style` | 禁用词命中能报出来；句长超区间能报出来；无生效规则时明确说「没有可核对的规则」 |

前端无自动化测试（仓库当前前端测试只覆盖纯函数 `applyPlan.js`），靠 `npm run build` 与人工验收。

## 7. 人工验收清单

1. 「文风」页添一条好样例（粘贴）→ 蒸馏出规则卡，维度数值合理（对照样例实际句长）。
2. 从自己已写章节选一段做样例 → 对话占比算得准（对照块类型）。
3. 添一条坏样例 → 禁用词表确实包含坏样例里的模板词。
4. 在侧边栏让 AI 写一段 → 展开看上下文里能看到「文风要求」段，且该段没被截断。
5. 问「这段文风有什么问题」→ 触发 `check_style`，过程条列出具体违规（禁用词、句长）。
6. 给某部作品单独添一张好样例 → 在该作品里对话时生效的是作品级那张；换另一部作品则仍用全局。
7. 手动改一张卡的规则 → 立即生效，AI 的输出随之改变。
8. 降级到本地 Ollama → 蒸馏仍能完成，卡片标注「可信度有限」。

## 8. 实施顺序

1. `services/style/metrics.js` + `services/style/rules.js`（纯函数，先单测）
2. 数据库加表（版本 3 → 4）+ `scope.js` 加 `ownedStyleCard`
3. `services/style/index.js`（读卡、解析生效规则）
4. `services/style/distill.js`（蒸馏）
5. `routes/style.js` + `app.js` 挂载
6. `services/context.js` 注入（`applyBudget` 支持 fixed 分区）
7. `services/skills/checkStyle.js` + 注册进 `skills/index.js`
8. 前端页面 + 路由
9. 全量测试 + 构建
