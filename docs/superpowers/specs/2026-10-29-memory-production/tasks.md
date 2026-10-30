# 任务清单 · 长期记忆（viking）上线

决策 A：线上显式关闭记忆层，其余功能上线。决策 B（sidecar 迁到 Linux 可安装版本）另行排期，见 `spec.md` §3。

## T1 生产环境变量默认关闭记忆层

- [x] `deploy/deploy.sh` 生成 `.env.production` 的 heredoc 末尾追加 `MEMORY_ENABLED=false` 及注释
- [x] `deploy/deploy.sh` 在 `if/else` 之后追加幂等补齐：缺 `MEMORY_ENABLED=` 时追加一行
- [x] 末尾「接下来」提示追加一条：记忆层当前关闭及开启条件

验收：`bash -n deploy/deploy.sh` 通过；模拟全新/已存在两种环境文件，结果都含唯一一行 `MEMORY_ENABLED=false`。

## T2 部署文档说明原因与开启路径

- [x] `deploy/README.md` 新增「长期记忆（viking）线上为什么是关的」一节（现象、根因、现状、开启条件）

验收：文档能独立解释「为什么关」「关有什么影响」「怎么打开」。

## T3 提交并推送

- [x] `git diff --check`
- [x] 提交信息说明：线上默认关闭记忆层 + 原因（ebdd35c）
- [x] 推送到 `origin/main`

验收：`git status` 除 `.claude/worktrees/web-version`、`.trae-html-share-packages/` 外干净；推送成功。

## T4 部署（需用户执行或提供服务器访问）

- [x] 在服务器 `/opt/curiosity-trail` 执行 `bash deploy/deploy.sh`（走阿里云 Workbench CLI，无需 SSH）
- [x] 确认 `http://127.0.0.1:8080/api/health` 返回 200
- [x] 确认 `deploy/.env.production` 含 `MEMORY_ENABLED=false`
- [x] 验收：`/api/memory/status` 返回未启用，写作与 AI 对话正常

## T4.1 登录通道打通（短信未配置时的临时方案）

- [x] `web/server/config.js` 新增 `SMS_FIXED_CODE` + `SMS_FIXED_PHONE`，两项都填才生效
- [x] `web/server/services/auth.js`：`issueLoginCode` 对指定手机号直接放行、不发短信；`consumeLoginCode` 校验固定码
- [x] `web/server/index.js` 启动日志提示固定验证码模式
- [x] `deploy/deploy.sh` 环境变量模板 + `git reset` 后重新 exec（修脚本被自己覆盖的坑）
- [x] `scripts/migrate-owner.js` 把老数据归属到 18689979305

验收：手机号 18689979305 + 验证码 960315 能登录，看到迁移后的作品。

## T5 决策 B：sidecar 迁移到 openviking 0.2.11

规格见 `spec.md` §8。版本已定 `openviking==0.2.11`，AGFS 走 binding-client（无子进程、无端口）。

### T5.1 改 `web/memory-service/store.py`

- [x] import 改为 `AsyncOpenViking` / `RequestContext, Role` / `UserIdentifier` / `OpenVikingConfigSingleton`
- [x] `__init__` 增加 `self._ctx`（`the_default_user()` + `Role.USER`，必须与 `LocalClient` 一致）
- [x] `start()`：先 `OpenVikingConfigSingleton.initialize(config_dict=...)`，再 `AsyncOpenViking()`、`initialize()`
- [x] `viking_fs` 取法加回退：`getattr(client, "viking_fs", None) or client._client.service.viking_fs`
- [x] 删除 `_relax_parser()` 及其调用（切块阈值改走 `markdown` 配置段）
- [x] `index()`：`target=` → `to=`
- [x] `query()`：去掉 `collection="context"`，补 `ctx=self._ctx`
- [x] `_remove()`：`remove_by_uri(uri, ctx=self._ctx)`
- [x] `load_settings()` 删除 `VIKING_AGFS_PORT`，`dataDir` 直接当 workspace
- [x] `config_dict` 按 §8.3.1：`storage.workspace` 单路径、`agfs.mode=binding-client`、
      `embedding.text_source=content_only`、`auto_generate_l0/l1=False`、`enable_memory_decay=False`、
      `markdown.extract_frontmatter=False` + 大阈值
- [x] 文件头「实测约束」注释按 0.2.11 更新（AGFS 端口那条作废）

验收：`python -m py_compile store.py` 通过；无残留 `target=` / `collection=` / `openviking.utils.config`。

### T5.2 依赖

- [x] `web/memory-service/requirements.txt` 锁 `openviking==0.2.11`
- [x] `web/memory-service/.env.example` 删 `VIKING_AGFS_PORT` 并补 `VIKING_HOST` 说明

验收：`pip download openviking==0.2.11 --only-binary=:all: --platform manylinux_2_31_x86_64 --python-version 310` 能拿到 wheel。

### T5.3 容器化

- [x] 新增 `web/memory-service/Dockerfile`（`python:3.10-slim-bookworm`、非 root、`VIKING_HOST=0.0.0.0`）
- [x] `app.py` 的 `__main__` host 改 `os.environ.get("VIKING_HOST", "127.0.0.1")`
- [x] `docker-compose.yml` 增加 `memory` 服务（无 `ports`、`./data/viking` 持久卷、
      `env_file: deploy/.env.memory` 可选、healthcheck、`restart: unless-stopped`）
- [x] `app` 服务 `environment` 加 `VIKING_BASE_URL: http://memory:8019`，且**不** `depends_on: memory`

验收：`docker compose config` 输出里 `memory` 没有 `published` 端口，`app` 的 `VIKING_BASE_URL` 为 `http://memory:8019`。

### T5.4 密钥落盘与部署脚本

- [x] `deploy/deploy.sh` 幂等生成 `deploy/.env.memory`（复用 `.env.production` 里的 `ARK_API_KEY`）
- [x] `.gitignore` 增加 `deploy/.env.memory`
- [x] `deploy/README.md` 补「记忆层如何开启 / 如何回退」（改写原「为什么是关的」一节）

验收：本地模拟两种分支（文件不存在 / 已存在）都不会重复写行、不会覆盖已填值；`git status` 里不出现该文件。

### T5.5 服务器验收

- [x] `docker compose build memory` 成功
- [x] `docker compose run --rm -e VIKING_DATA_DIR=/tmp/viking-smoke memory python smoke_test.py` 全部 PASS（17 项）
- [x] `docker compose up -d memory app`，两服务 healthy
- [x] `deploy/.env.production` 改 `MEMORY_ENABLED=true`，`git pull` + 重建
- [x] `/api/memory/status` 显示已启用且 sidecar 可用；写一段正文后索引台账不再 `failed`

> 冒烟暴露并修掉三个 0.2.11 专有坑：`xxhash.xxh64(str)` TypeError（猴补编码）、
> `add_resource` 的 `to` 是精确 URI（改为 `to=uri`）、记录里没有 `is_leaf`
> 字段（改用 `level == 2` 选正文叶子）。另修宿主目录属主（uid 10001）。
> 生产实测：6 章全量重建 → `total 8 / indexed 8 / failed 0`，真实召回命中第 1 章正文。

### T5.6 回退与文档回写

- [x] 回退演练：`MEMORY_ENABLED=false` + `docker compose up -d app`，`/api/memory/status` 立即未启用
- [x] `docs/superpowers/specs/2026-10-27-viking-memory-design.md` 中「固定 0.1.12」改为「0.2.11 + binding-client」
- [x] `docs/superpowers/specs/2026-10-29-memory-production/tasks.md` 勾选完成项
