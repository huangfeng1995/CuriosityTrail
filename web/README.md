# Curiosity Trail Web 版

## 项目简介

Curiosity Trail 是一款个人科学探索记录与文献管理工具，Web 版提供更现代化的界面和更好的跨平台体验。

## 技术栈

- **后端**: Node.js + Express + SQLite
- **前端**: React + Ant Design + Vite

## 功能特点

- 📝 探索报告管理（支持模板）
- 📚 PDF 文献管理与分类
- 🔗 报告与文献关联
- 📤 报告导出（TXT/DOCX）
- 💾 数据备份与恢复
- 🌓 深色/浅色主题切换

## 快速开始

### 安装依赖

首先安装后端和前端依赖：

```bash
# 后端依赖
cd server
npm install

# 前端依赖
cd ../client
npm install
```

### 开发模式

需要同时启动后端和前端服务：

```bash
# 启动后端（端口 3001）
cd server
npm run dev

# 启动前端（端口 3000，新终端）
cd client
npm run dev
```

然后在浏览器访问 http://localhost:3000

### 生产部署

首先构建前端，然后启动后端：

```bash
# 构建前端
cd client
npm run build

# 启动后端
cd ../server
npm start
```

访问 http://localhost:3001 即可使用。

## 项目结构

```
web/
├── server/          # 后端服务
│   ├── database.js  # 数据库初始化
│   ├── index.js     # 服务入口
│   ├── routes/      # API 路由
│   ├── data/        # 数据目录（运行时创建）
│   └── documents/   # PDF 存储（运行时创建）
└── client/          # 前端应用
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── App.jsx
        └── components/  # React 组件
```

## API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| /api/reports | GET/POST | 报告列表/新建 |
| /api/reports/:id | GET/PUT/DELETE | 报告详情/更新/删除 |
| /api/documents | GET | 文献列表 |
| /api/documents/upload | POST | 上传 PDF |
| /api/documents/:id | GET/PUT/DELETE | 文献详情/更新/删除 |
| /api/categories | GET/POST | 分类列表/新建 |
| /api/export/report/:id/:type | GET | 导出报告 |
| /api/export/backup | GET | 创建备份 |
| /api/export/restore | POST | 恢复备份 |
