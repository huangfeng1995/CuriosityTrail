# 风格参照（好样例 / 坏样例）实施计划

> **依据**：[设计文档](../specs/2026-10-30-style-reference-design.md)
>
> **执行方式**：按 Task 顺序逐个实现，每个 Task 结束跑一次 `cd web/server && npm test`，全绿再进下一个 Task。

**Goal:** 作者能存下「我心中的好文章」和「我讨厌的文章」，系统把它蒸馏成可执行的文风规则（句长 / 对话占比 / 比喻密度 / 禁用词），规则常驻注入 AI 上下文，AI 写完还能自己核一遍。

**Architecture:** 后端新增 `services/style/` 目录（纯函数度量 + 规则合并 + 蒸馏 + 读卡），新增 `routes/style.js`，`services/context.js` 增加 fixed 分区注入，新增技能 `check_style`。数据库加一张 `style_cards` 表（版本 3 → 4）。

**Tech Stack:** Node.js 18 + Express + SQLite（`web/server`），React 18 + Vite + antd（`web/client`）。**零新增运行时依赖**。

**不做什么：** 原文不入库；不做多套文风切换；不做规则的自动学习；不做样本共享库；不做规则版本历史。

---

## 文件结构

```
web/server/
├── services/
│   ├── style/
│   │   ├── index.js           # 新建：读卡、解析生效规则、对外出口
│   │   ├── metrics.js         # 新建：维度计算（纯函数）
│   │   ├── rules.js           # 新建：规则合并 + 注入文本格式化（纯函数）
│   │   └── distill.js         # 新建：调模型产出规则 JSON
│   ├── skills/
│   │   ├── checkStyle.js      # 新建：文风自查技能
│   │   └── index.js           # 改：注册 checkStyle
│   ├── context.js             # 改：fixed 分区 + 风格段注入
│   └── scope.js               # 改：ownedStyleCard
├── routes/
│   └── style.js               # 新建：文风卡路由
├── database.js                 # 改：schema 3 → 4，加 style_cards 表
├── app.js                      # 改：挂载 /api/style
└── test/
    └── styleReference.test.js  # 新建

web/client/src/
├── pages/Style.jsx             # 新建：文风页
└── App.jsx                    # 改：路由 + 顶栏入口
```

**模块边界（不越界）：**

| 模块 | 职责 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| `style/metrics.js` | 维度计算 | `wordCount.js` | 数据库 / provider / HTTP |
| `style/rules.js` | 合并 + 格式化 | 无 | 数据库 / provider / HTTP |
| `style/distill.js` | 调模型 | provider、`agent/parse.js` | 数据库 / HTTP |
| `style/index.js` | 读卡 + 解析生效规则 | database、`style/rules.js` | provider / HTTP |
| `routes/style.js` | 路由编排 | `style/*`、providers、scope | — |
| `skills/checkStyle.js` | 规则层核对 | `style/index.js`、`style/metrics.js` | 改正文 |

> **加载顺序**：`style/index.js` 会 `require('../database')`，而 `database.js` 在模块加载时就打开 SQLite 连接。
> `context.js` 已经 require 了 database，所以没有新增约束；测试里仍须让 `setupTempEnv()` 排在 require 之前。

---

## Task 1：纯函数层（metrics + rules）

**Files:**
- Create: `web/server/services/style/metrics.js`
- Create: `web/server/services/style/rules.js`

- [ ] **Step 1: 写 `metrics.js`**

  导出：
  - `splitSentences(text)` → 按 `。！？；…` 与换行切句，去空白
  - `measureSentenceLength(text)` → `{ avg, max, sentences: [{ index, text, words }] }`，字数用 `countWords`
  - `measureDialogueRatio(text, blocks?)` → 百分比数字。有 blocks 时用 dialogue 块字数 / 总字数；否则用中文引号内字符数估算
  - `measureImageryDensity(text)` → 每千字比喻标记数（整数）。标记词：像、如同、仿佛、宛如、好似、犹如
  - `measureAll(text, blocks?)` → 汇总

- [ ] **Step 2: 写 `rules.js`**

  导出：
  - `mergeRules(cards)` → 合并同 kind 多卡的规则（metrics 取交集、词表取并集、summary 拼接），冲突时退回并集并标 `conflicts`
  - `formatStylePrompt(effective)` → 生成注入文本
  - `EMPTY_RULES` 常量

- [ ] **Step 3: 写单测**（并入最终测试文件，先建文件）

  建 `web/server/test/styleReference.test.js`，先只放纯函数用例。

- [ ] **Step 4: 跑测试** `cd web/server && npm test`

---

## Task 2：数据层（建表 + 归属）

**Files:**
- Modify: `web/server/database.js`
- Modify: `web/server/services/scope.js`

- [ ] **Step 1: `database.js` 建表**

  `SCHEMA_VERSION` 3 → 4；SCHEMA 里加 `style_cards` 表与索引；`USER_SCOPED_TABLES` 加 `style_cards`。

- [ ] **Step 2: `scope.js` 加 `ownedStyleCard(id, userId)`**

  查 `style_cards WHERE id = ? AND user_id = ?`。

- [ ] **Step 3: 跑测试**

---

## Task 3：生效规则解析（`style/index.js`）

**Files:**
- Create: `web/server/services/style/index.js`

- [ ] **Step 1: 实现**

  - `listCards(userId, workId?)` → 全部卡（作品级 + 全局）
  - `getCard(id, userId)`
  - `createCard(...)` / `updateCard(...)` / `deleteCard(...)`
  - `resolveEffectiveStyle(userId, workId)` → `{ good: {...}, bad: {...} }`，按 §3.5 规则
  - `formatStylePrompt` 转出自 `style/rules.js`

- [ ] **Step 2: 跑测试**

---

## Task 4：蒸馏（`style/distill.js`）

**Files:**
- Create: `web/server/services/style/distill.js`

- [ ] **Step 1: 实现**

  `distill({ provider, kind, text, notes })` → 规则对象。
  - 先用 `metrics.js` 算客观指标，一并喂给模型
  - `provider.chat({ messages, temperature: 0.2, thinking: 'disabled', jsonOutput: true, maxTokens: 1200 })`
  - `parseModelJson` 解析 + 字段校验；不合法抛错

- [ ] **Step 2: 跑测试**（用假 provider 测成功/失败两条路径）

---

## Task 5：路由（`routes/style.js` + 挂载）

**Files:**
- Create: `web/server/routes/style.js`
- Modify: `web/server/app.js`

- [ ] **Step 1: 写路由**

  - `GET /api/style/cards`
  - `POST /api/style/cards`（取原文 → 蒸馏 → 写卡；原文不写库）
  - `PUT /api/style/cards/:id`
  - `DELETE /api/style/cards/:id`
  - `GET /api/style/chapters`（列自己作品的章节，供选样例）

- [ ] **Step 2: `app.js` 挂载** `app.use('/api/style', styleRouter);`

- [ ] **Step 3: 跑测试**（覆盖归属隔离、蒸馏失败不落库、原文不入库）

---

## Task 6：上下文注入

**Files:**
- Modify: `web/server/services/context.js`

- [ ] **Step 1: `applyBudget` 支持 `fixed` 分区**

  fixed 的 part 不计入总和、不参与截断。

- [ ] **Step 2: 装配风格段**

  在角色提示词之后、作品信息之前插入 `## 文风要求` 段；风格段本身作为 fixed 分区。
  预算改为 `CONTEXT_BUDGET - skillsText.length - styleText.length`。

- [ ] **Step 3: 跑测试**

---

## Task 7：`check_style` 技能

**Files:**
- Create: `web/server/services/skills/checkStyle.js`
- Modify: `web/server/services/skills/index.js`
- Modify: `web/server/routes/ai.js`（ctx 补 `chapterId`）

- [ ] **Step 1: 写技能**

  按 §3.6 判定；只读；返回 `{ label, summary, detail, findings }`。

- [ ] **Step 2: 注册 + 补 ctx.chapterId**

- [ ] **Step 3: 跑测试**

---

## Task 8：前端

**Files:**
- Create: `web/client/src/pages/Style.jsx`
- Modify: `web/client/src/App.jsx`

- [ ] **Step 1: 写页面**

  好/坏两个分区、卡片列表、添加样例弹窗、编辑规则弹窗。

- [ ] **Step 2: 挂路由与顶栏入口**

- [ ] **Step 3: `cd web/client && npm run build`**

---

## Task 9：收尾

- [ ] **Step 1: 后端全量测试** `cd web/server && npm test`
- [ ] **Step 2: 前端构建** `cd web/client && npm run build`
- [ ] **Step 3: 人工验收清单**（设计文档 §7）
