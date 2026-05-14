# Curiosity Trail 部署指南

## ⚡ 快速开始（推荐：只需要 Fly.io，完全免费）

### 前置准备

1. 安装 [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/)
2. 注册 [Fly.io](https://fly.io/)

### 一键部署

```bash
# 1. 登录
fly auth login

# 2. 初始化应用（首次部署）
fly launch

# 按照提示：
# - 选择应用名称（如：curiosity-trail）
# - 选择区域：hkg（香港，国内访问更快）
# - 不设置 Postgres/Redis

# 3. 创建数据卷（永久保存数据）
fly volumes create curiosity_trail_data --region hkg --size 1

# 4. 部署！
fly deploy
```

部署成功后，访问你的应用：`https://your-app-name.fly.dev`

---

## 目录

1. [快速开始](#快速开始推荐只需要-flyio完全免费)
2. [常用命令](#常用命令)
3. [备份与恢复](#备份与恢复)
4. [其他部署方案](#其他部署方案)
5. [费用说明](#费用说明)

---

## 常用命令

```bash
# 部署
fly deploy

# 查看日志
fly logs

# SSH 进入服务器
fly ssh console

# 查看应用状态
fly status

# 查看应用信息
fly info
```

---

## 备份与恢复

### 备份数据

```bash
# 1. SSH 进入服务器
fly ssh console

# 2. 在服务器中，查看数据目录
ls -la /app/data

# 3. 在本地使用 SFTP 下载（或者你可以用 scp）
# 或者：直接在 fly.io 后台的 Volumes 里下载快照
```

### 恢复数据

上传备份文件到 `/app/data` 目录即可。

---

## 其他部署方案

### 方案二：Render（简单，付费）

### 优点

- 部署简单，不需要懂 Docker
- 支持完整的 Node.js 服务

### 部署步骤

1. 访问 [render.com](https://render.com/)
2. 用 GitHub 账号登录
3. 点击 "New" → "Web Service"
4. 选择你的仓库
5. 配置：
   - Name: `curiosity-trail`
   - Root Directory: `web/server`
   - Runtime: `Node`
   - Build Command: `cd ../client && npm ci && npm run build && cd ../server && npm ci`
   - Start Command: `node index.js`
   - 添加环境变量：`DATA_DIR=/app/data`
6. 在 Render 的 Dashboard，创建一个 "Disk" 并挂载到 `/app/data`
7. 点击 "Create Web Service"

---

### 方案三：国内服务器（稳定，长期）

| 厂商 | 配置 | 月费用 |
|------|------|--------|
| 阿里云 | 2核 2GB | ¥60 |
| 腾讯云 | 2核 2GB | ¥50 |
| 华为云 | 2核 2GB | ¥50 |

### 部署步骤

1. 购买服务器（Ubuntu 22.04 推荐）
2. 安装 Docker 和 Docker Compose
3. 上传项目到服务器
4. 使用 Docker Compose 启动服务

创建 `docker-compose.yml`：

```yaml
version: '3'
services:
  app:
    build: .
    ports:
      - "80:8080"
    volumes:
      - ./data:/app/data
    restart: always
```

---

## 费用说明

| 方案 | 月费用 | 说明 |
|------|--------|------|
| Fly.io | $0 | 个人使用完全免费 |
| Render | $5起 | 稳定但需付费 |
| 国内服务器 | ¥50起 | 国内访问快 |

---

## 故障排除

### 问题：部署失败

解决：检查 `fly.toml` 和 `Dockerfile` 配置是否正确，确保数据卷已创建。

### 问题：数据丢失

解决：确保已配置数据卷，数据目录挂载正确。

### 问题：应用无法访问

解决：
1. 运行 `fly status` 检查应用状态
2. 运行 `fly logs` 查看日志
3. 确认端口配置正确
