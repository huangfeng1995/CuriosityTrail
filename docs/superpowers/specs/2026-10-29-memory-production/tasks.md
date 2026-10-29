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

## T5（决策 B，另行排期，不在本次提交内）

- [ ] 选 PyPI 上有 manylinux 轮子的稳定版 openviking
- [ ] 在 Linux + Python ≥ 3.10 环境改 `store.py` 并跑通 `smoke_test.py`
- [ ] 新增 `web/memory-service/Dockerfile`、compose 增加 `memory` 服务（`VIKING_BASE_URL=http://memory:8019`、`ARK_API_KEY` 走 `deploy/.env.memory`）
- [ ] 验收通过后把 `MEMORY_ENABLED` 改回 `true`
