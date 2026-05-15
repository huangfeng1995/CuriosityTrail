# Railway 部署指南

## 🚀 Railway 免费部署

Railway 是一个现代化的云部署平台，提供免费层支持，非常适合个人项目。

### 特点

- ✅ 免费层：每月 500 小时（足够个人使用）
- ✅ 直接连接 GitHub 仓库
- ✅ 自动构建和部署
- ✅ 支持持久化存储
- ✅ 简单易用

### 部署步骤

#### 1. 注册 Railway 账号

访问 https://railway.app

使用 GitHub 账号登录

#### 2. 创建新项目

1. 在 Railway 仪表板点击 **"New Project"**
2. 选择 **"Deploy from GitHub repo"**
3. 授权 GitHub 访问
4. 选择你的仓库：`huangfeng1995/CuriosityTrail`

#### 3. 配置项目

Railway 会自动检测到 `railway.json` 配置文件

如果需要手动配置：

1. **环境变量**（在 Settings 中设置）：
   ```
   NODE_ENV = production
   PORT = 3000
   DATA_DIR = /data
   ```

2. **启动命令**（已配置在 railway.json）：
   ```bash
   cd web/server && npm start
   ```

3. **构建命令**（已配置在 railway.json）：
   ```bash
   cd web/client && npm ci && npm run build
   ```

#### 4. 添加持久化存储

Railway 默认容器重启后数据会丢失，需要配置持久化存储：

1. 在项目视图中，点击 **"Storage"**
2. 点击 **"Add Persistent Disk"**
3. 选择项目并设置挂载点：`/data`
4. 容量：建议 1GB

#### 5. 部署

Railway 会自动：
- 检测到 GitHub 仓库有更新
- 触发构建
- 部署应用

#### 6. 访问应用

部署完成后，Railway 会提供：
- **临时域名**：`your-app.railway.app`
- **自定义域名**（可选配置）

---

## 📊 配置说明

### railway.json 详解

```json
{
  "build": {
    "builder": "NIXPACKS",  // 使用 Railway 的构建系统
    "nixpacksPlan": {
      "phases": {
        "setup": {
          "nixPackages": ["nodejs_20"]  // Node.js 环境
        },
        "install": {
          "commands": [
            "cd web/server && npm ci --production",  // 安装后端依赖
            "cd web/client && npm ci"  // 安装前端依赖
          ]
        },
        "build": {
          "commands": [
            "cd web/client && npm run build"  // 构建前端
          ]
        }
      }
    }
  },
  "deploy": {
    "numReplicas": 1,  // 1个实例（免费层）
    "restartPolicyType": "ON_FAILURE",  // 失败自动重启
    "restartPolicyMaxRetries": 10,
    "script": "cd web/server && npm start"  // 启动命令
  }
}
```

---

## 🔧 环境变量

Railway 会自动注入以下环境变量：

- `PORT`: 容器端口（默认 3000）
- `NODE_ENV`: 运行环境
- `RAILWAY_GIT_COMMIT_SHA`: Git 提交 SHA

你的应用需要的环境变量：

```bash
NODE_ENV=production
PORT=3000
DATA_DIR=/data
```

---

## 💾 数据持久化

### 重要提醒

Railway 容器重启后数据会丢失，除非：
1. 使用持久化存储（/data 目录）
2. 数据库数据会持久保存

### 配置持久化存储

```bash
# 在 Railway CLI 中（可选）
railway add persistentdisk
```

或在 Railway 仪表板：
1. 项目设置 → Storage
2. 创建 1GB 持久磁盘
3. 挂载到 `/data`

---

## 🛠 常用命令

### Railway CLI

```bash
# 安装 CLI
npm install -g @railway/cli

# 登录
railway login

# 进入项目
railway init

# 打开仪表板
railway open

# 查看日志
railway logs

# 部署
railway up
```

### 本地开发连接远程数据库

```bash
railway run npm start
```

---

## ❓ 常见问题

### Q: 构建失败？

检查 `railway.json` 配置，确保：
- Node.js 版本正确
- 所有依赖都正确安装
- 构建命令正确

### Q: 应用无法启动？

检查环境变量：
- `PORT` 是否正确设置
- `NODE_ENV` 是否为 `production`

### Q: 数据丢失？

确保已配置持久化存储，数据保存在 `/data` 目录。

### Q: 如何更新应用？

只需推送到 GitHub 仓库，Railway 会自动检测并重新部署。

---

## 🎯 部署成功

完成后，你将获得：
- 🌐 在线访问地址：`https://your-project.railway.app`
- 📊 监控仪表板
- 📝 部署日志

享受你的科学探索记录应用吧！
