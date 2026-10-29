# 长期记忆（viking）上线规格

## 1. 目标

把当前仓库的改动安全地上线，同时明确处理「生产缺 memory-service sidecar」这个遗留问题。

不是本次目标：把 viking 记忆跑在 Linux 服务器上。原因见 §2，它需要一个独立的版本迁移任务。

## 2. 已确认的事实（排查结论）

1. `docker-compose.yml` 只有 `app` 服务；`web/server/config.js` 默认
   `MEMORY_ENABLED=true`、`VIKING_BASE_URL=http://127.0.0.1:8019`。
   容器内 127.0.0.1 是容器自己，sidecar 永远不可达 —— 记忆层在线上静默失效，
   召回每次都是 `degraded`，索引台账会持续记 `failed`。
2. `web/memory-service/requirements.txt` 钉 `openviking==0.1.12`。该版本：
   - **PyPI 上没有**（`https://pypi.org/simple/openviking/` 无 0.1.12，也无 0.1.x）；
   - 本机安装的是 `openviking-0.1.12-cp39-cp39-macosx_11_0_universal2.whl`，
     `openviking/bin/agfs-server` 为 `Mach-O 64-bit executable arm64`；
   - PyPI 可下载的 0.2.10+ / 0.3.x / 0.5.2 只提供 `cp310-abi3-manylinux_*`（要求 Python ≥ 3.10），
     且 README 明确记录实现是照 0.1.12 的实测行为写的，跨版本要重新验证。
   → **0.1.12 没有 Linux 发行包，Linux 服务器上装不起来；macOS arm64 的 agfs-server 也不能跨平台运行。**
3. 本机无 Docker（`docker: command not found`）、无 SSH 私钥（`ssh-agent` 无身份、
   `~/.ssh` 只有 known_hosts），无法在本机构建镜像或直接部署。
   部署入口是服务器上的 `deploy/deploy.sh`。

## 3. 决策

### 决策 A（本次执行）：线上显式关闭记忆层，其余功能全部上线

- 生产 `deploy/.env.production` 落 `MEMORY_ENABLED=false`，让记忆层明确关闭：
  前端「长期记忆」开关不生效、`/api/memory/*` 返回未启用，
  不再产生失败索引与无意义召回。
- 不改 `config.js` 的默认值（本地开发要继续默认开启；本机 sidecar 正在 8019 正常服务）。
- 不往 `docker-compose.yml` 加 memory-service 服务。理由：镜像里装不上 0.1.12，
  `docker compose up -d --build` 会因构建失败整体中断，连编辑器修复都上不去。

### 决策 B（独立后续任务，不在本次提交内）：把 sidecar 迁到 Linux 可安装的版本

- 目标版本：PyPI 上同时有 `manylinux_2_31_x86_64` 与 `manylinux_2_31_aarch64` 的稳定版
  （0.3.x / 0.5.x 之一，先取最接近 0.2.11 的稳定版）。
- 需要：Linux + Python ≥ 3.10 环境、按新版 openviking API 改 `store.py`、
  跑通 `smoke_test.py`、补 `web/memory-service/Dockerfile` 并在 compose 加服务
  （`VIKING_BASE_URL=http://memory:8019`、`VIKING_DATA_DIR=/app/data/viking`、
  `ARK_API_KEY` 走独立的 `deploy/.env.memory`，不进 `app` 容器）。
- 该任务验收通过后，再把生产 `MEMORY_ENABLED` 改回 `true`。

## 4. 改动清单（仅决策 A）

### 4.1 `deploy/deploy.sh`

(a) 第 111-128 行的 heredoc 里，在 `DEEPSEEK_API_KEY=` 之后追加：

```bash
# 长期记忆（viking sidecar）：线上默认关闭。
# sidecar 依赖的 openviking==0.1.12 只有 macOS arm64 构建，
# Linux 服务器装不起来。本轮先关，等 sidecar 迁到 Linux 可安装版本后改回 true。
MEMORY_ENABLED=false
```

(b) 在 `ENV_FILE` 的 `if/else` 之后追加幂等补齐：已有环境文件里没有 `MEMORY_ENABLED=`
时补一行 `MEMORY_ENABLED=false`（现有服务器跑脚本时也能生效，且不覆盖用户已经写的值）。

```bash
# 老服务器上 .env.production 是之前生成的，没有 MEMORY_ENABLED。
# 补一行默认关闭，保证这次部署不会去连不存在的 sidecar。
if ! grep -q '^MEMORY_ENABLED=' "$ENV_FILE"; then
	echo 'MEMORY_ENABLED=false' >> "$ENV_FILE"
fi
```

(c) 健康检查通过后的「接下来」提示里追加一条：说明记忆层当前关闭、何时能开。

### 4.2 `deploy/README.md`

新增一节「长期记忆（viking）线上为什么是关的」：

- 现象：写作对话正常，但「长期记忆」不生效。
- 原因：sidecar 钉的 openviking 0.1.12 无 Linux 发行包（本机是 macOS universal2 轮子，
  `agfs-server` 是 Mach-O arm64）；PyPI 可用的 0.2.x+ 要求 Python ≥ 3.10 且需重新验证 API。
- 现状：`MEMORY_ENABLED=false`，本地开发不受影响（本机 sidecar 正常）。
- 开启条件：sidecar 完成 Linux 版本迁移并通过冒烟测试后，把该值改为 `true` 并重启容器。

## 5. 验证

1. `bash -n deploy/deploy.sh` —— 语法检查。
2. 用临时目录模拟「全新环境文件」与「已存在环境文件」两种分支，确认最终内容都含且仅含一行
   `MEMORY_ENABLED=false`（脚本里的幂等块可单独抽出来跑）。
3. `git diff --check` —— 无空白错误。
4. 不改动前后端代码，故不重跑 `npm test` / `npm run build`（编辑器修复的验证已在上轮完成：
   147/147 通过、构建通过、Playwright 压线验证通过）。

## 6. 部署动作（需要用户执行或提供服务器访问）

服务器上（代码已在 `/opt/curiosity-trail`）：

```bash
cd /opt/curiosity-trail
bash deploy/deploy.sh            # 已配过域名的话：bash deploy/deploy.sh 域名 邮箱
```

脚本会 `git reset --hard origin/main` → 补齐 `MEMORY_ENABLED=false` → `docker compose build` →
`up -d` → 健康检查。完成即代表编辑器修复与其余功能上线（记忆层关闭）。

## 7. 需要你确认的点

1. 是否接受「先上线、记忆层在线上暂时关闭」（决策 A）？
2. 若更希望记忆功能一起上线，则需要先做决策 B 的版本迁移；请确认是否把它排为下一步。
3. 服务器地址/登录方式是否有？没有的话按 §6 自行执行，我这边无法代跑。
