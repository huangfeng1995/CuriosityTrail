# Curiosity Trail 免费部署方案

## 🎉 最简单的免费部署方案

### 方案一：Replit（推荐，最简单）

Replit 可以一键部署整个应用，完全免费，不需要信用卡！

### 步骤

1. **访问 Replit**
   - 打开 [https://replit.com](https://replit.com)
   - 用 GitHub 账号登录

2. **导入项目**
   - 点击 **"Create Repl"**
   - 选择 **"Import from GitHub"**
   - 输入你的仓库 URL: `https://github.com/huangfeng1995/CuriosityTrail`
   - 语言选择 **Node.js**

3. **配置运行命令**
   在 Replit 的 **"Config"** 标签页中设置：
   - **Run Command**: `cd web/server && npm start`
   - **Build Command**: `cd web/client && npm install && npm run build && cd ../server && npm install`

4. **启动应用**
   - 点击 **"Run"** 按钮
   - Replit 会自动构建和启动应用
   - 完成后会给你一个访问地址（类似：`https://curiosity-trail.yourusername.repl.co`）

---

## 📦 方案二：Vercel + PocketBase（推荐用于生产环境）

### Vercel（前端）
1. 访问 [vercel.com](https://vercel.com)，用 GitHub 登录
2. 点击 **"New Project"**，导入你的仓库
3. Vercel 会自动检测 Vite 项目并部署
4. 获得访问地址

### PocketBase（后端 + 数据库）
1. 访问 [pocketbase.io](https://pocketbase.io)
2. 下载 PocketBase 并在免费的 VPS 上运行（或使用免费服务如 Fly.io）
3. 这是一个完整的后端 + 数据库解决方案

---

## 🎯 方案三：Railway（如果有信用卡）

按照之前配置的 `railway.json` 直接部署。

---

## 🌟 推荐流程

**如果你想要最简单的方式，直接使用 Replit！**

只需要：
1. 打开 Replit
2. 导入 GitHub 仓库
3. 点击 Run
4. 完成！

数据会自动保存在 Replit 的存储中，完全免费！
