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

### 决策 B（独立后续任务）：把 sidecar 迁到 Linux 可安装的版本

版本与改动方案已在 §8 收敛为可执行清单，结论是锁定 `openviking==0.2.11`。
该任务验收通过后，再把生产 `MEMORY_ENABLED` 改回 `true`。

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

---

## 8. 决策 B 落地：sidecar 迁移到 openviking 0.2.11

### 8.1 版本结论

锁定 `openviking==0.2.11`。PyPI 提供 `openviking-0.2.11-cp310-abi3-manylinux_2_31_x86_64.whl`，
服务器 Python 3.10.12 与镜像 `python:3.10-slim-bookworm` 都满足该 ABI。

已逐条核实的事实（解包 0.2.11 / 0.2.15 / 0.5.2.1 wheel 后确认）：

| 事实 | 依据 |
| --- | --- |
| 0.1.12 已从 PyPI 下架，本机装的是 macOS universal2 轮子 | `pypi/openviking/0.1.12/json` 返回 404；`openviking/bin/agfs-server` 是 Mach-O arm64 |
| 0.2.11 轮子自带原生库，无外网下载步骤 | `openviking/lib/libagfsbinding.so`、`openviking/storage/vectordb/engine/_x86_*.abi3.so` |
| 默认 `storage.agfs.mode = "binding-client"`，不启动 AGFS 子进程 | `agfs_config.py` 默认值；`service/core.py` 只在 `mode == "http-client"` 时才 `AGFSManager.start()` |
| 0.5.x 结构大改（`openviking/async_client.py` 已不存在），适配成本最高 | 解包 0.5.2.1 确认 |

因此 0.2.11 适配面最小，且 **AGFS 端口彻底退役**（`VIKING_AGFS_PORT` 不再需要）。

### 8.2 API 差异（0.1.12 → 0.2.11）

| 位置 | 0.1.12（现状代码） | 0.2.11（目标） |
| --- | --- | --- |
| 配置入口 | `from openviking.utils.config import OpenVikingConfig`；`AsyncOpenViking(config=config)` | 该模块不存在。用 `openviking_cli.utils.config.open_viking_config.OpenVikingConfigSingleton.initialize(config_dict=...)` 先写全局单例，再 `AsyncOpenViking()` |
| 配置读取时机 | 构造时直接吃 config 对象 | `AsyncOpenViking()` → `LocalClient` → `OpenVikingService` → `initialize_openviking_config()` → `get_openviking_config()`，即**读上面那个单例** |
| 存储路径 | `storage.agfs.path` + `storage.vectordb.path` 分开 | 只用 `storage.workspace`；两个 `path` 会被 workspace 覆盖 |
| 切块阈值 | 运行时改 parser：`parser.config = ParserConfig(...)`、`parser.extract_frontmatter = False` | 配置段 `markdown: {...}`（`MarkdownConfig` 继承 dataclass `ParserConfig`，含 `extract_frontmatter`） |
| 写入 | `add_resource(path, target=base, wait=True, timeout=...)` | `add_resource(path, to=base, wait=True, timeout=...)`（`to` 与 `parent` 互斥） |
| 召回 | `storage.search(collection="context", query_vector=..., filter=...)` | 无 `collection` 参数；`search(query_vector=..., filter=..., limit=..., *, ctx=RequestContext)`，按 `ctx` 路由到账号后端 |
| 删除向量记录 | `storage.remove_by_uri("context", uri)` | `remove_by_uri(uri, *, ctx=RequestContext)` |
| 请求上下文 | 无 | `openviking.server.identity.RequestContext(user: UserIdentifier, role: Role)`；必须与 `LocalClient` 内部 `_ctx` 一致，否则会路由到另一个账号的向量库、召回永远为空 |
| 过滤器语法 | `{"op":"and","conds":[{"op":"prefix",...},{"op":"must",...}]}` | 完全一致（`vectordb_adapters/base.py` 仍支持 `and/must/prefix`） |
| `_score` | 原始余弦相似度 | 完全一致（`record["_score"]` 仍由 `vectordb_adapters/base.py` 写入） |
| `read` / `rm` | `read(uri)`、`rm(uri, recursive=False)` | 签名不变 |

`LocalClient` 构造的上下文是 `RequestContext(user=UserIdentifier.the_default_user(), role=Role.USER)`，
即 account/user/agent 全为 `default`。因此 sidecar 也构造同一份，并且**不要**在配置里改 `default_account/user/agent`。

### 8.3 `web/memory-service/store.py` 改动

1. 顶部 import 换成：

```python
from openviking.async_client import AsyncOpenViking
from openviking.server.identity import RequestContext, Role
from openviking_cli.session.user_id import UserIdentifier
from openviking_cli.utils.config.open_viking_config import OpenVikingConfigSingleton
```

2. `__init__` 增加 `self._ctx = RequestContext(user=UserIdentifier.the_default_user(), role=Role.USER)`。

3. `start()` 改为「先写全局配置，再建客户端」：

```python
OpenVikingConfigSingleton.initialize(config_dict=<见 8.3.1>)
self._client = AsyncOpenViking()          # 单例，读上面的全局配置
await self._client.initialize()
fs = getattr(self._client, "viking_fs", None) or self._client._client.service.viking_fs
self._storage = fs._get_vector_store()
self._embedder = fs._get_embedder()
```

4. 删除 `_relax_parser()` 整个方法与它的调用（切块阈值改由配置段控制）。

5. `index()`：`target=base` → `to=base`。

6. `query()`：去掉 `collection="context"`，补 `ctx=self._ctx`。

7. `_remove()`：`self._storage.remove_by_uri(uri, ctx=self._ctx)`。

8. `load_settings()`：删掉 `VIKING_AGFS_PORT`，`dataDir` 直接作为 workspace。

#### 8.3.1 `config_dict`（只含已核实字段，模型是 `extra: forbid`）

```python
{
    "storage": {
        "workspace": str(data_dir),
        "agfs": {"backend": "local", "mode": "binding-client", "log_level": "warn", "timeout": 30},
        "vectordb": {"backend": "local", "dimension": dim},
    },
    "embedding": {
        "dense": {
            "provider": "volcengine", "model": model, "api_key": api_key,
            "api_base": api_base, "dimension": dim, "input": "multimodal", "batch_size": 1,
        },
        # 不生成 L0/L1 摘要，向量只能来自正文本身
        "text_source": "content_only",
        "max_input_chars": 4000,
    },
    "markdown": {
        "max_content_length": 2_000_000,
        "max_section_size": 100_000,
        "max_section_chars": 200_000,
        "extract_frontmatter": False,
    },
    "auto_generate_l0": False,
    "auto_generate_l1": False,
    "enable_memory_decay": False,
    "log": {"level": "WARNING", "output": "stdout"},
}
```

`auto_generate_l0/l1` 与 `enable_memory_decay` 在新版默认是 `True`，必须显式关掉。

### 8.4 依赖与容器

1. `web/memory-service/requirements.txt` → `openviking==0.2.11`（其余三条不动）。
2. 新增 `web/memory-service/Dockerfile`（构建上下文为仓库根）：
   - `FROM python:3.10-slim-bookworm`
   - `COPY web/memory-service /app`，`WORKDIR /app`
   - `pip install --no-cache-dir -r requirements.txt`
   - `ENV VIKING_HOST=0.0.0.0 VIKING_DATA_DIR=/app/data/viking`
   - `CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8019"]`
   - 非 root 用户运行，`data` 目录 `chown`
3. `app.py` 的 `__main__` 分支里 host 改 `os.environ.get("VIKING_HOST", "127.0.0.1")`（默认仍只回环）。
4. `docker-compose.yml` 增加 `memory` 服务：
   - `build: {context: ., dockerfile: web/memory-service/Dockerfile}`
   - **不写 `ports`**（只在 compose 内网可达，绝不暴露到宿主）
   - `volumes: ./data/viking:/app/data/viking`
   - `env_file: deploy/.env.memory`（`required: false`）
   - `restart: unless-stopped`
   - healthcheck 用 `python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8019/health')"`
   - `app` 服务增加 `environment: VIKING_BASE_URL: http://memory:8019`（compose 的 `environment` 优先级高于 `env_file`）
   - `app` **不** `depends_on: memory`：记忆层是加分项，sidecar 挂了 app 必须照常起。
5. `deploy/deploy.sh` 幂等生成 `deploy/.env.memory`：从已有 `.env.production` 取 `ARK_API_KEY` 的值，
   其余（`VIKING_DATA_DIR=/app/data/viking`、`VIKING_PORT=8019`、超时两项）写默认；
   `.gitignore` 追加 `deploy/.env.memory`（密钥不进版本库）。

### 8.5 验证（按顺序，任一步失败就停）

1. `docker compose build memory`（服务器上）。
2. 一次性冒烟，隔离目录、不污染生产数据：

```bash
docker compose run --rm -e VIKING_DATA_DIR=/tmp/viking-smoke memory python smoke_test.py
```

   期望：13 项全 PASS（含 `dim == 2048`、跨用户不泄漏、覆盖写、删除）。
3. `docker compose up -d memory app`；`docker compose ps` 两个服务 healthy。
4. `curl -s http://127.0.0.1:8080/api/memory/status` 返回已启用且 sidecar 可用。
5. 回退演练（在切 `MEMORY_ENABLED=true` 之前先确认）：把 `.env.production` 改回 `false` 后
   `docker compose up -d app`，`/api/memory/status` 立即回到未启用，写作不受影响。

### 8.6 风险与现场确认项

1. `AsyncOpenViking` 是否仍暴露 `viking_fs` 属性：代码已写 `getattr(...)` 回退到
   `self._client._client.service.viking_fs`，即使属性改名也能拿到。
2. `storage.vectordb` 是否接受 `dimension`：若 `extra: forbid` 报错，容器内先打印
   `OpenVikingConfig().storage.vectordb` 的字段再删键。同理 `embedding.dense.batch_size`。
3. 内存：服务器 2 核 / 1.7GB（可用约 947MB）。sidecar 只加载本地向量引擎 + 远程 embedding，
   不含 torch；若 `docker stats` 观察到 OOM，先给 `memory` 加 `mem_limit: 512m` 并观察。
