# Curiosity Trail 部署指南

给太太用的完美方案！💕

---

## 🚀 方案一：使用 Railway 部署（推荐，最简单！）

### 步骤：

1. **下载项目压缩包**
   - 访问 http://localhost:3002 下载
   - 解压到你电脑上

2. **注册 GitHub 账号**
   - 访问 https://github.com
   - 创建一个免费账号（如果还没有的话）

3. **创建仓库**
   - 在 GitHub 上点击 "New repository"
   - 命名为 `curiosity-trail`
   - 选择 Public 或 Private 都可以

4. **上传代码到 GitHub**
   - 用 GitHub Desktop 或者 Git 命令上传你解压的代码

5. **注册 Railway**
   - 访问 https://railway.app
   - 用 GitHub 账号登录

6. **部署项目**
   - 在 Railway 上点击 "New Project"
   - 选择 "Deploy from GitHub repo"
   - 选择你的 `curiosity-trail` 仓库
   - 点击 "Deploy Now"

7. **配置持久化存储（重要！）**
   - 在 Railway 项目中添加 "Volume"
   - 挂载路径设为 `/data`
   - 设置环境变量：
     - `DATA_DIR=/data`
     - `DOCS_DIR=/data/documents`

8. **开心使用！**
   - Railway 会给你分配一个免费域名
   - 把这个链接发给你太太就可以用了！

---

## 🚀 方案二：使用 Render 部署（也很简单）

类似步骤，访问 https://render.com 部署

---

## 💡 小提示

- 免费额度对于个人使用完全够了
- 数据会自动备份
- 随时可以用之前下载的备份恢复数据

---

祝使用愉快！🎁
