# Curiosity Trail 部署指南

## 🚀 Fly.io 免费部署（推荐）

### 准备工作

1. **注册 Fly.io 账号**
   - 访问 https://fly.io
   - 使用 GitHub 账号登录

2. **安装 Fly CLI**
   - macOS: `brew install flyctl`
   - Windows: `iwr https://fly.io/install.ps1 -useb | iex`
   - Linux: `curl -L https://fly.io/install.sh | sh`

### 一键部署步骤

```bash
# 1. 进入项目目录
cd /path/to/CuriosityTrail

# 2. 登录 Fly.io
flyctl auth login

# 3. 初始化应用（如果已配置 fly.toml，跳过此步）
fly launch

# 4. 创建数据卷（保存数据）
flyctl volumes create curiosity_trail_data --region hkg --size 1

# 5. 部署！
flyctl deploy
```

### 部署配置说明

项目已包含以下配置文件：

- `fly.toml` - Fly.io 应用配置
  - 应用名: curiosity-trail
  - 区域: hkg（香港，访问速度快）
  - 端口: 8080
  - 数据卷: curiosity_trail_data

- `Dockerfile` - Docker 构建配置
  - 多阶段构建（前端 + 后端）
  - 自动构建 React 应用
  - 数据持久化支持

### 部署成功

访问你的应用: https://curiosity-trail.fly.dev

### 常用命令

```bash
# 查看日志
flyctl logs

# 查看状态
flyctl status

# SSH 进入服务器
flyctl ssh console

# 重新部署
flyctl deploy
```

---

## 📱 备用方案：本地运行

如果暂时不想部署，可以在本地运行：

```bash
# 1. 进入后端目录
cd web/server

# 2. 安装依赖
npm install

# 3. 启动服务
npm start

# 4. 打开浏览器访问
# http://localhost:3000
```

---

## 💾 数据管理

### 备份数据

```bash
# SSH 进入服务器
flyctl ssh console

# 查看数据
ls -la /app/data

# 复制数据
cp -r /app/data ./backup/
```

### 恢复数据

```bash
# 上传备份
flyctl ssh console

# 将备份文件复制到 /app/data
```

---

## ❓ 常见问题

**Q: 部署失败？**
A: 确保已创建数据卷，并检查 Dockerfile 是否正确。

**Q: 数据丢失？**
A: 确保配置了数据卷，数据会持久化保存。

**Q: 应用无法访问？**
A: 运行 `flyctl status` 检查应用状态，运行 `flyctl logs` 查看日志。
