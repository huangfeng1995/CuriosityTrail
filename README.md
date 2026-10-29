# Curiosity Trail

AI 辅助长篇小说创作平台。

作者写稿，AI 扮五种角色帮忙：写手起稿续写、编辑把关节奏、审稿人挑毛病、灵感师给点子、资料员查素材。五种角色各有各的提示词、模型和温度，可以单独调。

---

## 它能干什么

**五个 AI 角色**

| 角色 | 干什么 | 默认模型 | 默认温度 |
|------|--------|----------|----------|
| ✍️ 写手 | 把思路变成正文，起稿、续写、扩写 | deepseek-flash | 0.85 |
| 📝 编辑 | 结构、节奏、语气的把关 | deepseek-flash | 0.60 |
| 🔍 审稿人 | 挑毛病：逻辑漏洞、设定冲突、人物失真 | deepseek-v4-pro | 0.40 |
| 💡 灵感师 | 给点子、补设定、想情节 | deepseek-v4-pro | 0.95 |
| 📚 资料员 | 查站内素材库 + 联网检索，带来源返回 | deepseek-flash | 0.30 |

每个角色都能在「设置 → 角色提示词」里单独改提示词、温度、模型、思考开关。留空就是跟随全局设置。

**块编辑器**

正文不是一个大文本框，是一串块：正文、对白、独白、分场符、插图、设定引用。块可以随时互相转换，写作时按块取词、续写、加对白。

**素材库 + 检索**

导入 PDF / TXT / Markdown，自动抽取正文并按页建索引。AI 检索站内素材时用 FTS5 + 中文 bigram 匹配，命中的片段带页码标注，作者能直接核对"这句出自哪一页"。也可以让资料员联网查外部资料。

**导出**

单章或整部作品导出成 Word（.docx）、Markdown、纯文本。DOCX 保留标题层级、段落缩进、对白缩进、插图和图注。

**备份**

服务器每天凌晨 3 点自动备份一次，保留最近 7 份。设置页可以随时手动备份，或下载完整备份到本地。

---

## 技术栈

- **后端** Node.js + Express + SQLite（`sqlite3` 原生模块，Promise 封装）
- **前端** React 18 + Ant Design 5 + Vite
- **AI** DeepSeek（也支持任意 OpenAI 兼容服务，以及本地 Ollama 兜底）
- **检索** SQLite FTS5 + 应用层中文 bigram

---

## 目录结构

```
CuriosityTrail/
├── Dockerfile              # 多阶段构建：前端构建 → 后端依赖 → 运行时
├── docker-compose.yml      # 单机生产部署编排（香港轻量服务器方案）
├── .dockerignore          # 排除 node_modules 与 data/
├── fly.toml                # Fly.io 部署配置（备选路径）
├── deploy/                 # 一键部署资产
│   ├── deploy.sh           # 装 Docker→克隆→生成密码→构建→启动→配 Caddy
│   ├── Caddyfile           # 自动 HTTPS 反代（关缓冲以支持 SSE）
│   ├── sync-offsite.sh     # 备份同步到对象存储
│   └── README.md           # 国内服务器部署完整指南
├── data/                   # 运行时数据（SQLite、图片、备份），不入库
├── docs/superpowers/specs/ # 设计文档
└── web/
    ├── client/             # 前端（React + Vite）
    │   └── src/
    │       ├── components/  # Editor / Assistant / Sidebar
    │       ├── pages/       # Works / Workspace / Materials / SettingsPage
    │       ├── hooks/       # useMediaQuery 等
    │       └── store/       # workspace（块+撤销栈）、auth
    └── server/             # 后端（Express）
        ├── index.js         # 入口
        ├── config.js        # 路径与鉴权配置
        ├── database.js      # 表结构与迁移
        ├── middleware/      # 鉴权、限流、单实例
        ├── routes/          # API 路由
        └── services/
            ├── providers/   # DeepSeek / OpenAI 兼容 / Ollama
            ├── roles/       # 五个角色的提示词定义
            ├── search/      # 站内检索、联网检索
            ├── context.js   # 上下文装配器
            ├── docxExport.js
            └── backup.js
```

---

## 本地运行

```bash
# 1. 后端依赖
cd web/server && npm install

# 2. 前端依赖
cd ../client && npm install

# 3. 启动后端（端口 3001）
cd ../server && npm run dev

# 4. 启动前端（端口 3000，新终端）
cd ../client && npm run dev
```

打开 http://localhost:3000。

首次启动时用手机号 + 短信验证码登录，首次登录自动注册。本地开发不想接阿里云短信，就在 `web/.env` 里设 `SMS_DEV_CODE=000000`（仅非 production 生效），登录时填这个固定码即可。

**配置 AI Key**（也可以在网页「设置 → AI 供应商」里填，填了会存进 `data/ai-config.json`）：

```bash
# web/.env
DEEPSEEK_API_KEY=sk-xxxx
```

DeepSeek 的对话端点和搜索端点（`/v1/tools/search`、`/v1/tools/fetch`）共用同一把 key。

---

## 部署

**主路径：香港轻量服务器 + Docker Compose（国内厂商，免备案）**

见 [deploy/README.md](deploy/README.md)。买台阿里云/腾讯云的香港轻量服务器，
SSH 上去粘一条命令就上线：

```bash
curl -fsSL https://raw.githubusercontent.com/huangfeng1995/CuriosityTrail/main/deploy/deploy.sh | bash
```

脚本会自己装 Docker、克隆代码、生成会话密钥、构建镜像、启动容器，
打印访问地址。配了域名就顺带开 HTTPS。

> 为什么选香港节点：大陆节点对外用 80/443 必须先 ICP 备案（1-3 周），
> 香港节点免备案，买完就能上线。

**备选路径：Fly.io**，见 [web/DEPLOY.md](web/DEPLOY.md)（配置在 `fly.toml`）。

---

## 重要约定

- **多用户模型**：手机号 + 短信验证码登录，首次登录自动注册；作品、素材、灵感每人一份。
- **单实例**：SQLite 不支持多进程并发写，服务启动时会检测并拒绝第二个实例。
- **数据全在 `data/`**：SQLite 库、上传的图片、导入的文档、备份都在这。搬家拷这个目录即可。
