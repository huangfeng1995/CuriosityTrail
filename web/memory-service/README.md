# 记忆服务 sidecar

这是 CuriosityTrail 的**长期记忆**服务，跑在 Node 后端旁边的一个独立 Python 进程里。

它做且只做一件事：把文本变成向量，存起来，需要的时候按相似度找回来。
业务上的所有判断——写什么、切多大、召回多少、哪些不要——都在 Node 侧
（`web/server/services/memory/`），sidecar 不认识用户、也不认识作品。

```
Node 后端 ──HTTP──> sidecar (127.0.0.1:8019) ──> openviking ──> 火山方舟 Ark (embedding)
   │
   └── 切块 / 权重 / 阈值 / 预算 / 隔离校验 都在这一侧
```

## 为什么是 sidecar 而不是直接调 SDK

- openviking 是 Python 的，Node 侧没有等价实现；
- 它自己会起一个 AGFS 子进程、占一个端口、往磁盘写文件——塞进 Node 进程里
  等于把两件生命周期完全不同的事绑在一起；
- 隔成 HTTP 之后，sidecar 挂掉只会让记忆层降级，对话和写作照常。

## 环境准备

```bash
cd web/memory-service

python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
```

`requirements.txt` 里 **openviking 必须锁版本**。它的写入语义（目录已存在直接失败、
向量记录的层级、filter DSL 支持范围）都随版本变化，sidecar 的实现是照着
**0.1.12** 的实测行为写的。升级前先跑一遍下面的冒烟脚本。

## 配置

```bash
cp .env.example .env
```

然后填 `ARK_API_KEY`。

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ARK_API_KEY` | 是 | — | 火山方舟的接入凭据。**只存在于这个进程的环境里**，Node 不读、不下发、不落库 |
| `ARK_BASE_URL` | 否 | `https://ark.cn-beijing.volces.com/api/v3` | |
| `ARK_EMBEDDING_MODEL` | 否 | `doubao-embedding-vision-251215` | 换模型必须重建全部向量库（维度/语义空间都变了） |
| `ARK_EMBEDDING_INPUT` | 否 | `multimodal` | **保持 `multimodal`**。这个模型只接受 multimodal 接口，且一次请求只返回一个融合向量；改成 `text` 或走批量接口会直接失败 |
| `ARK_EMBEDDING_DIM` | 否 | `2048` | 必须与实际模型一致，否则向量维度对不上 |
| `VIKING_DATA_DIR` | 否 | `../../data/viking` | 索引数据目录（AGFS 文件 + 向量库）。派生数据，可随时重建 |
| `VIKING_PORT` | 否 | `8019` | sidecar 自己的 HTTP 端口 |
| `VIKING_AGFS_PORT` | 否 | `8018` | openviking 内置的 AGFS 文件服务端口 |
| `VIKING_EMBED_TIMEOUT_SECONDS` | 否 | `10` | 单条向量化的超时 |
| `VIKING_INDEX_TIMEOUT_SECONDS` | 否 | `8` | 写入等待向量生成完成的超时 |
| `VIKING_LOG_LEVEL` | 否 | `WARNING` | |

### 端口：两个必须不同

`VIKING_PORT` 和 `VIKING_AGFS_PORT` **不能相同**。

AGFS 是 openviking 起的子进程，`AGFSManager._check_port_available()` 会真的
bind 一下这个端口做探测；端口被占着就直接抛
`RuntimeError: AGFS port 8019 is already in use, cannot start service`。
sidecar 自己要监听 8019，AGFS 自然得让开——所以默认是 8019 / 8018。

### AGFS 的 `port` 与 `url` 必须成对且一致

这条是 openviking 自己的要求，写在 `store.py` 的配置里：

```python
"agfs": {
    "port": agfs_port,
    "url": f"http://localhost:{agfs_port}",
}
```

两个都配、并且值一样，队列客户端才会连对。少配 `url` 或者两者不一致的话，
队列客户端会退回默认的 8080——**表现是「接口全部成功，但向量根本没生成」**，
不报错，只是召回永远是空的。这是这个 sidecar 最容易踩的坑。

## 启动

```bash
cd web/memory-service
source .venv/bin/activate
python3 -m uvicorn app:app --host 127.0.0.1 --port 8019
```

**必须单进程。** 不要用 `--workers N`：
- AGFS 的端口是独占的，多 worker 之间会互相抢，后起的直接启动失败；
- 写入走的是 `asyncio.Lock`（`app.py` 里的 `WRITE_LOCK`），多进程下这个锁不起作用，
  openviking 遇到同名目录会报 "directory already exists"。

探活：

```bash
curl http://127.0.0.1:8019/health
# {"ok":true,"model":"doubao-embedding-vision-251215","dim":2048}
```

## 接口

sidecar 只监听 `127.0.0.1`，**没有鉴权**，绝对不要暴露到网络上。

### `GET /health`

```json
{ "ok": true, "model": "doubao-embedding-vision-251215", "dim": 2048 }
```

### `POST /index`

写入一块正文。同 URI 重复写入按覆盖处理（内部是「先删后写」）。

```json
// 请求
{ "uri": "viking://resources/u/{uid}/w/{wid}/chapter/{cid}/0", "text": "正文" }
// 响应
{ "ok": true, "rootUri": "viking://resources/u/{uid}/w/{wid}/chapter/{cid}/0" }
```

`uri` 必须以 `viking://resources/u/` 开头，且至少 7 段；末段要能直接当文件名用
（不能带标点）。不合法返回 400。

### `POST /query`

按向量相似度召回。

```json
// 请求
{ "query": "查询文本", "targetUri": "viking://resources/u/{uid}/w/{wid}", "limit": 16, "minScore": 0.2 }
// 响应
{ "results": [ { "uri": "...", "fileUri": ".../0.md", "score": 0.31, "text": "命中的正文前 1200 字" } ] }
```

`targetUri` 是**硬前缀过滤**，永远传当前用户+作品的前缀。

### `DELETE /index`

```json
// 请求
{ "uri": "viking://resources/u/{uid}/w/{wid}/chapter/{cid}/0" }
// 响应
{ "ok": true }
```

## 数据与重建

索引数据在 `VIKING_DATA_DIR`（默认 `../../data/viking`）：

```
data/viking/
├── agfs/       # 落盘的正文文件
└── vectordb/   # 向量库
```

两个都是**派生数据**——正文在数据库里，重建得回来。删掉整个目录再让 Node 侧
重新索引即可，不需要备份。

Node 侧的重建入口：

```bash
# 重建当前用户的全部作品
curl -X POST http://127.0.0.1:3001/api/memory/rebuild -b "ct_session=..."
```

换 embedding 模型或维度之后**必须重建**，否则新旧向量混在一个库里，
召回结果是「看起来正常但全是错的」。

## 故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `AGFS port 8018 is already in use` | AGFS 端口被别的进程占了（多半是上一次没退干净） | `lsof -i :8018` 找到进程杀掉，或换端口 |
| `/health` 正常，但召回永远是空 | AGFS 的 `port`/`url` 不一致，队列连到 8080，**向量根本没生成** | 核对 `store.py` 里两个值一致；删掉 `VIKING_DATA_DIR` 重来 |
| 召回结果串到别的用户 | 用了上层 `find()` 而不是底层 `storage.search()` | `store.py` 的查询必须走 `storage.search()` + prefix filter，不能用 `find()` |
| 写入报 `directory already exists` | openviking 不允许对同一个 target 重复写入 | sidecar 内部已经是「先删后写」，若是并发写入撞的，确认是单进程 |
| 召回结果对不上源 | MarkdownParser 把正文二次切分了 | `store.py` 启动时把 `max_section_size` 抬到 100000 并关掉 `extract_frontmatter` |
| `向量化失败` / `向量化超时` | Ark 侧限流或网络抖动 | 等一下重试；索引队列会指数退避，最多 3 次 |

## 冒烟测试

Python 侧只保留一个冒烟脚本，**不进 `npm test`**——CI 没有 Python 环境，
但 Node 侧全部集成测试用内存假 sidecar 跑，不依赖这个进程。

```bash
cd web/memory-service
source .venv/bin/activate
python3 smoke_test.py
```

它会依次验证：索引一段文本、查询命中、覆盖写、删除、跨用户隔离、非法 URI 拒绝。

## Node 侧的对应关系

| sidecar | Node |
| --- | --- |
| `VIKING_PORT=8019` | `VIKING_BASE_URL=http://127.0.0.1:8019` |
| `VIKING_DATA_DIR` | 无（Node 不关心数据目录） |
| `ARK_API_KEY` | 无（**Node 侧没有、也不应该有 Ark key**） |
| — | `MEMORY_ENABLED` / `MEMORY_MIN_SCORE` / `MEMORY_TOP_K` / `MEMORY_MAX_REFS` / `MEMORY_MAX_CHARS` |

完整的环境变量清单见设计文档
[`docs/superpowers/specs/2026-10-27-viking-memory-design.md`](../../docs/superpowers/specs/2026-10-27-viking-memory-design.md)
的 §9。
