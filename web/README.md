# web/ —— Curiosity Trail 应用本体

AI 辅助长篇小说创作平台。`client` 是 React 前端，`server` 是 Express 后端。

完整的产品说明和快速开始见 [仓库根 README](../README.md)，部署见 [DEPLOY.md](./DEPLOY.md)。本文只讲内部结构与 API。

---

## 技术栈

- **后端** Node.js + Express 4 + SQLite（`sqlite3`）
- **前端** React 18 + Ant Design 5 + Vite 5
- **AI** DeepSeek 为主，兼容任意 OpenAI 兼容服务，本地 Ollama 兜底
- **检索** SQLite FTS5 虚表 + 应用层中文 bigram 预处理

---

## 目录结构

```
web/
├── client/
│   ├── index.html
│   ├── vite.config.js      # dev server 代理 /api → :3001
│   └── src/
│       ├── api/
│       │   ├── client.js    # axios 实例，统一错误处理
│       │   └── sse.js       # SSE 流式读取（AI 对话用）
│       ├── components/
│       │   ├── Editor/      # 块编辑器：Block / BlockPalette / BlockToolbar / ChapterEditor
│       │   ├── Assistant/   # AI 侧边栏：Sidebar / RoleTabs / MessageList / ActionCard / CitationBadge
│       │   ├── Sidebar/     # 左侧栏：WorkTree / CharacterPanel / SettingPanel / WorkInfoPanel / InspirationPanel
│       │   └── ExportButton.jsx
│       ├── hooks/
│       │   └── useMediaQuery.js
│       ├── pages/           # Works / Workspace / Materials / SettingsPage / Login
│       └── store/
│           ├── auth.jsx     # 登录态
│           └── workspace.jsx# 块数据 + 撤销栈 + 保存状态
└── server/
    ├── index.js             # 入口：中间件、路由、静态资源、定时备份
    ├── config.js            # 路径解析 + 鉴权/AI 环境变量
    ├── database.js          # 建表与增量迁移
    ├── middleware/
    │   ├── auth.js          # JWT Cookie 鉴权
    │   ├── rateLimit.js     # 登录/AI/全局三档限流
    │   └── singleInstance.js
    ├── routes/              # 每个文件一个资源域
    └── services/
        ├── providers/       # deepseek.js / openaiCompat.js / ollama.js
        ├── roles/           # writer / editor / critic / inspiler / researcher
        ├── search/          # local.js（站内 FTS5）/ deepseekSearch.js（联网）
        ├── context.js       # 上下文装配器
        ├── documentText.js  # PDF/TXT/MD 正文提取
        ├── docxExport.js    # DOCX 导出
        ├── backup.js        # 备份与定时备份
        ├── aiConfig.js      # AI 配置读写（key 掩码回传）
        └── auth.js          # 密码校验与 JWT 签发
```

---

## 数据流要点

**块是权威数据。** `chapters.blocks`（JSON 数组）存一切；`chapters.content` 只是纯文本派生快照，供检索与导出兜底用。

**撤销栈在 store 里。** `store/workspace.jsx` 维护 `past`/`future` 快照栈，最多 50 步；同块连续输入 700ms 内合并成一个撤销单元；切换章节时按章隔离重置。

**保存是防抖的。** 编辑后 800ms 自动 PUT `/api/chapters/:id`，`saveStatus` 状态机为 `idle → dirty → saving → saved | error`。

**上下文是按需装配的。** `services/context.js` 依据当前作用域（作品/章节/块）分层注入人物、设定、灵感、检索片段与衔接信息，不是把整个库塞给模型。

**AI 输出是结构化契约。** 模型必须返回 `{action, target, content, reason, citations}`，前端据此决定是替换、追加、插入还是只展示建议。

---

## API 接口

除 `/api/health` 与 `/api/auth/*` 外，全部需要登录（`ct_session` Cookie）。

### 认证

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/auth/login` | POST | 密码登录，下发会话 Cookie |
| `/api/auth/logout` | POST | 清除会话 |
| `/api/auth/session` | GET | 查询登录态 |

### 作品与章节

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/works` | GET/POST | 作品列表 / 新建 |
| `/api/works/:id` | GET/PUT/DELETE | 作品详情 / 更新 / 删除 |
| `/api/works/:id/chapters` | GET/POST | 章节列表 / 新建 |
| `/api/works/:id/chapters/reorder` | POST | 章节排序 |
| `/api/chapters/:id` | GET/PUT/DELETE | 章节详情 / 更新（blocks 为权威）/ 删除 |

### 人物与设定

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/characters` | GET/POST | 人物卡列表 / 新建 |
| `/api/characters/:id` | GET/PUT/DELETE | 人物卡详情 / 更新 / 删除 |
| `/api/settings` | GET/POST | 世界观设定列表 / 新建 |
| `/api/settings/:id` | GET/PUT/DELETE | 设定详情 / 更新 / 删除 |
| `/api/inspirations` | GET/POST | 灵感速记列表 / 新建 |
| `/api/inspirations/:id` | PUT/DELETE | 灵感更新 / 删除 |

### 素材库

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/materials` | GET/POST | 素材列表（只回 preview + page_count）/ 新建 |
| `/api/materials/upload` | POST | 上传 PDF/TXT/MD，自动抽取正文并建索引 |
| `/api/materials/search` | GET | 站内检索（`?q=&limit=`） |
| `/api/materials/:id` | GET/PUT/DELETE | 素材详情 / 更新 / 删除 |
| `/api/materials/:id/file` | GET | 下载原始文件 |

### 检索

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/search/web` | GET | 联网检索（`?q=`） |
| `/api/search/fetch` | POST | 抓取网页正文 |

### AI

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/ai/chat` | POST | 侧边栏对话，SSE 流式 |
| `/api/ai/inline` | POST | 行内操作（改写/续写/审稿），返回结构化 JSON |
| `/api/ai/roles` | GET | 五个角色（含用户覆盖后的实际提示词与参数，并附 `effectiveModel` / `effectiveThinking` / `temperatureEffective` 供前端提示） |
| `/api/ai/prompts/:roleKey` | POST | 保存角色覆盖（提示词/温度/模型/思考） |
| `/api/ai/prompts/:roleKey` | DELETE | 恢复默认 |
| `/api/ai/status` | GET | 各 provider 连通状态 |

### 配置

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/config/ai` | GET/PUT | 读取 / 更新 AI 配置（key 只回掩码） |
| `/api/config/ai/test` | POST | 测试某 provider 连通性 |

### 上传与导出

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/upload/image` | POST | 上传插图 |
| `/api/export/work/:id/{txt\|markdown\|docx}` | GET | 导出整部作品 |
| `/api/export/chapter/:id/{txt\|markdown\|docx}` | GET | 导出单章 |
| `/api/export/backup` | GET | 下载全量备份 zip |
| `/api/export/restore` | POST | 从备份 zip 恢复 |
| `/api/export/backups` | GET/POST | 列出定时备份 / 立即生成一份 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3001` | 监听端口 |
| `DATA_DIR` | `web/../data` | 数据目录（SQLite、图片、备份） |
| `UPLOADS_DIR` | `$DATA_DIR/uploads` | 插图存储 |
| `DOCS_DIR` | `$DATA_DIR/documents` | 导入的原始文档 |
| `JWT_SECRET` | 首次启动生成 | 会话签名密钥 |
| `ALIYUN_SMS_ACCESS_KEY_ID` | 空 | 阿里云短信 AccessKey ID |
| `ALIYUN_SMS_ACCESS_KEY_SECRET` | 空 | 阿里云短信 AccessKey Secret |
| `ALIYUN_SMS_SIGN_NAME` | 空 | 短信签名 |
| `ALIYUN_SMS_TEMPLATE_CODE` | 空 | 短信模板 CODE（模板变量需为 `${code}`） |
| `SMS_DEV_CODE` | 空 | 开发用固定验证码，仅非 production 生效 |
| `DEEPSEEK_API_KEY` | 空 | DeepSeek key（对话与搜索共用） |
| `BACKUP_HOUR` | `3` | 每日自动备份时刻（0-23），`-1` 关闭 |
| `NODE_ENV` | `development` | `production` 时关闭 CORS、开启同域静态资源 |

登录方式是手机号 + 短信验证码，首次登录自动注册。四项 `ALIYUN_SMS_*` 不全时生产环境发不出验证码，用户无法登录；本地开发可设 `SMS_DEV_CODE` 跳过真实短信。`JWT_SECRET` 未注入时会退回 `DATA_DIR` 下的持久化文件，生产环境应该用平台 secret 注入。

---

## 开发命令

```bash
# 后端
cd web/server
npm install
npm run dev        # 端口 3001

# 前端
cd web/client
npm install
npm run dev        # 端口 3000，/api 代理到 3001
npm run build      # 产物在 web/client/dist
```

生产模式下后端同时提供静态前端（`web/server/public` 或 `web/client/dist`）与 API，只需跑一个进程。
