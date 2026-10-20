# 部署指南

单用户部署。目标是：太太在公司用浏览器就能打开平台写稿，稿子、素材、备份都持久化不丢。

默认方案是 **Fly.io**（配置见仓库根目录的 `fly.toml` 与 `Dockerfile`）。

---

## 一、准备

### 1. Fly.io 账号与 CLI

```bash
# 安装 CLI（macOS）
brew install flyctl

# 登录
fly auth login
```

### 2. 生成密钥

三个 secret 需要在部署前准备好：

```bash
# 登录密码——太太用来进平台的那一个
APP_PASSWORD='换成你自己的密码'

# 会话签名密钥。必须是随机串，别用现成的密码
JWT_SECRET=$(openssl rand -base64 32)

# DeepSeek 的 API key。对话和联网搜索共用这一把
DEEPSEEK_API_KEY='sk-xxxxxxxx'
```

> DeepSeek 的 key 可以在 https://platform.deepseek.com 充值后创建。对话端点和
> 搜索端点（`/v1/tools/search`、`/v1/tools/fetch`）用的是同一把 key。

密码和 key **不要写进代码仓库**，用 `fly secrets set` 注入。

---

## 二、首次部署

> `fly.toml` 与 `Dockerfile` 都在**仓库根目录**，所有 `fly` 命令都在根目录执行。

### 1. 创建应用

```bash
fly apps create curiosity-trail
```

> ⚠️ **不要用 `fly launch --copy-config`**：它会用模板覆盖掉仓库里已经写好的
> `fly.toml`（区域、数据卷、强制 HTTPS 都会丢）。应用建好后直接编辑仓库里的
> `fly.toml` 即可，它已经配好了 `hkg` 区域、`curiosity_trail_data` 卷和强制 HTTPS。

建完后确认一下：

```bash
fly status
```

### 2. 建持久化卷

SQLite 库和图片必须落在卷上，容器重建才不会丢：

```bash
fly volumes create curiosity_trail_data --size 1 --region hkg
```

卷名和 `fly.toml` 里 `[mounts]` 段的 `source` 必须一致（已经是 `curiosity_trail_data`）。

### 3. 注入 secret

```bash
fly secrets set \
  APP_PASSWORD='你的密码' \
  JWT_SECRET="$(openssl rand -base64 32)" \
  DEEPSEEK_API_KEY='sk-你的key'
```

确认注入成功：

```bash
fly secrets list
```

### 4. 部署

```bash
fly deploy
```

构建会走根目录的多阶段 `Dockerfile`：先构建前端，再装后端依赖，最后把两者合成运行时镜像。
构建上下文是仓库根目录，`.dockerignore` 已排除 `node_modules` 和 `data/`
（后者含 SQLite 库与密码文件，绝不能进镜像）。

> 首次构建要装编译工具给 sqlite3 兜底，慢一些。后续构建有缓存，会快很多。

### 5. 拿到网址

```bash
fly open
```

会打开 `https://curiosity-trail.fly.dev`。也可以用 `fly status` 看。

**建议现在就去 [fly.io/apps](https://fly.io/apps) 绑定一个自己的域名**，比 `.fly.dev` 好记。

### 6. 首次登录

用 `APP_PASSWORD` 里设的密码登录。进去后先去「设置 → AI 供应商」点一次「测试连接」，
确认 key 生效；再去「设置 → 备份」手动备份一次，确认卷上的东西都对。

---

## 三、日常运维

### 更新代码

```bash
git pull
fly deploy
```

卷上的数据不受影响。

### 改密码

```bash
fly secrets set APP_PASSWORD='新密码'
fly restart
```

### 备份

平台每天凌晨 3 点自动备份一次到卷上（`/app/data/backups/`），保留最近 7 份。

除了自动备份，还有两种手动方式：

- **网页里**：设置 → 备份 → 「立即备份」或「下载完整备份」
- **命令行**：

```bash
# 下载一份全量备份到本地
fly ssh console -C "cat /app/data/curiosity.db" > curiosity.db

# 或者用 HTTP 端点（需要先登录拿到 Cookie）
curl -b cookies.txt -o backup.zip https://curiosity-trail.fly.dev/api/export/backup
```

### 看日志

```bash
fly logs            # 实时
fly logs --no-deploy  # 最近的历史
```

### 恢复数据

恢复走 `POST /api/export/restore`，上传之前下载的备份 zip 即可——网页设置页里有入口，也可以用命令行：

```bash
# 先登录拿 Cookie
curl -c cookies.txt -X POST https://curiosity-trail.fly.dev/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"你的密码"}'

# 上传备份 zip 恢复
curl -b cookies.txt -X POST https://curiosity-trail.fly.dev/api/export/restore \
  -F "backup=@backup.zip"
```

恢复会覆盖当前的 `curiosity.db` 并把图片、文档合并回去。**恢复前先下载一份当前数据**，恢复操作不可逆。

或者用 fly ssh 直接看卷上的内容：

```bash
fly ssh console -C 'ls -la /app/data'
```

---

## 四、其他环境变量

在 `fly.toml` 的 `[env]` 段里改，或用 `fly secrets set`：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BACKUP_HOUR` | `3` | 每日自动备份时刻（0-23），`-1` 关闭 |
| `SESSION_TTL_DAYS` | `30` | 会话有效期 |
| `SESSION_REMEMBER_TTL_DAYS` | `90` | 「保持登录」的有效期 |

---

## 五、单机自建（不用 Fly.io）

如果更想跑在自己的 VPS 上：

```bash
# 构建镜像
docker build -t curiosity-trail .

# 运行，数据挂到宿主机目录
docker run -d \
  --name curiosity-trail \
  -p 8080:8080 \
  -v /srv/curiosity-data:/app/data \
  -e APP_PASSWORD='你的密码' \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e DEEPSEEK_API_KEY='sk-你的key' \
  curiosity-trail
```

前面挂个 Nginx 或 Caddy 做 HTTPS 反代即可。

**注意**：必须挂 `-v` 到 `/app/data`，否则容器一重建稿子全丢。

---

## 六、排查

**登录不了**
- 确认 secret 真的注入了：`fly secrets list`
- 登录限流是 5 次 / 15 分钟，输错几次就锁了，等 15 分钟

**AI 没反应**
- `fly secrets list` 看 `DEEPSEEK_API_KEY` 在不在
- 网页里进「设置 → AI 供应商」点「测试连接」，能直接看到报错
- Key 没余额也会报这个错，去平台看额度

**数据没了**
- 卷是不是建了并且挂上了：`fly volumes list`
- 是不是部署时用了新的卷名

**启动就退出**
- `fly logs` 看报错。常见是卷没挂上导致 SQLite 打不开
- 单实例保护会拒绝第二个进程：`Multiple instances` 之类。要么停掉另一个，要么设 `ALLOW_MULTI_INSTANCE=1`（不建议，SQLite 并发写会损坏数据）

**构建失败（`fly deploy` 阶段）**
- `sqlite3` 装不上：Dockerfile 的依赖层已装 python3/make/g++ 兜底，若仍失败说明是
  架构不匹配（本地是 arm64 但镜像要 amd64）。在 Fly.io 控制台或
  `fly platform setmips` 处确认架构
- 前端构建失败：检查 `web/client/package-lock.json` 是否与 `package.json` 同步，
  不一致时 `npm ci` 会直接报错。本地 `cd web/client && npm ci` 复现
