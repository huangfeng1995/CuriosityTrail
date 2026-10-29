"""viking（openviking）记忆索引的本地存储层。

sidecar 只做四件事：写入、召回、删除、探活。它不认识 user/work 概念，
URI 由 Node 侧拼装，这里只校验前缀格式并原样透传。

实测约束（openviking 0.1.12，本机验证）：
- AGFS 的 `port` 与 `url` 必须同时配置且一致，否则队列客户端会去连默认的 8080，
  向量根本不会生成。
- `add_resource` 对同一个 target 重复调用会报 "directory already exists"，
  所以写入一律「先删后写」。
- `rm()` 只回收文件，目录自身的向量记录要额外 `remove_by_uri` 才能清掉。
- 查询必须走底层 `storage.search()` + prefix 过滤：上层 `find()` 不做硬前缀
  隔离，实测会跨用户泄漏。
- 底层 `_score` 是稳定的原始余弦相似度，可直接当阈值用。
- MarkdownParser 默认会按 token 数二次切分正文，切完叶子文件的 parent_uri 就变了，
  台账对不上。启动时把切分阈值调大，并关掉 frontmatter 抽取。
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from openviking.async_client import AsyncOpenViking
from openviking.utils.config import OpenVikingConfig

# 记忆索引只允许落在用户命名空间下，防止 Node 侧拼错前缀写到公共区。
URI_ROOT = "viking://resources/u/"

# openviking 建目录时对名字做的清洗。我们要保证「临时文件名清洗后 == URI 末段」，
# 这样落盘路径才和请求 URI 严丝合缝。这里复刻一份同样的规则做校验。
_SANITIZE_STRIP = re.compile(r"[^\w一-鿿\s-]")
_SANITIZE_SPACE = re.compile(r"\s+")

# 召回预览的正文长度上限。上下文注入由 Node 侧裁剪，这里只给个够看的片段。
PREVIEW_LIMIT = 1200


class VikingError(Exception):
    """sidecar 内部可预期的错误，映射成 5xx 由 Node 侧重试。"""


class InvalidUriError(VikingError):
    """URI 不符合命名空间约定，属于调用方错误（4xx）。"""


def sanitize_for_path(text: str) -> str:
    """复刻 openviking MarkdownParser._sanitize_for_path。"""
    safe = _SANITIZE_STRIP.sub("", text)
    safe = _SANITIZE_SPACE.sub("_", safe)
    return safe.strip("_")[:50] or "section"


def split_uri(uri: str) -> Tuple[str, str]:
    """把请求 URI 拆成 (落盘基址, 文件名)。

    `add_resource(target=base)` 会把临时文件名拼到 target 后面，所以只要临时
    文件名用 URI 的末段，落盘结果就正好等于请求 URI。
    """
    if not uri or not uri.startswith(URI_ROOT):
        raise InvalidUriError(f"URI 必须以 {URI_ROOT} 开头：{uri}")

    segments = uri.split("/")
    # viking://resources/u/{uid}/w/{wid}/{kind}/{id}/{n} 至少 7 段
    if len(segments) < 7:
        raise InvalidUriError(f"URI 层级不足：{uri}")

    name = segments[-1]
    if not name or sanitize_for_path(name) != name:
        raise InvalidUriError(f"URI 末段不适合作为文件名：{uri}")

    base = "/".join(segments[:-1])
    return base, name


class VikingStore:
    """openviking 的单例封装。"""

    def __init__(self, settings: Dict[str, Any]) -> None:
        self._settings = settings
        self._client: Optional[AsyncOpenViking] = None
        self._storage: Any = None
        self._embedder: Any = None
        self._model: str = settings.get("model", "")
        self._dim: int = int(settings.get("dim", 2048))
        self._embed_timeout: float = float(settings.get("embedTimeoutSeconds", 10))
        self._index_timeout: float = float(settings.get("indexTimeoutSeconds", 25))

    # ---------- 生命周期 ----------

    async def start(self) -> None:
        data_dir = Path(self._settings["dataDir"]).resolve()
        agfs_port = int(self._settings["agfsPort"])

        config = OpenVikingConfig.from_dict(
            {
                "user": "curiositytrail",
                "storage": {
                    # port 与 url 必须成对出现且一致，队列客户端只认 url。
                    "agfs": {
                        "backend": "local",
                        "path": str(data_dir / "agfs"),
                        "port": agfs_port,
                        "url": f"http://localhost:{agfs_port}",
                        "log_level": "warn",
                        "timeout": 30,
                    },
                    "vectordb": {
                        "backend": "local",
                        "path": str(data_dir / "vectordb"),
                        "name": "context",
                    },
                },
                "embedding": {
                    "dense": {
                        "provider": "volcengine",
                        "model": self._model,
                        "api_key": self._settings["apiKey"],
                        "api_base": self._settings["apiBase"],
                        "dimension": self._dim,
                        # 豆包 vision 模型只接受 multimodal 接口，且一次只返回一个向量。
                        # 禁止走批量接口，批量会因响应结构不同而失败。
                        "input": self._settings.get("inputType", "multimodal"),
                    }
                },
                # 不生成 L0/L1 摘要，省掉每块的额外 embedding 调用。
                "auto_generate_l0": False,
                "auto_generate_l1": False,
                # 记忆衰减会把老向量标成 inactive，索引是派生数据，宁可整体重建。
                "enable_memory_decay": False,
                "log_level": self._settings.get("logLevel", "WARNING"),
            }
        )

        self._client = AsyncOpenViking(config=config)
        await self._client.initialize()

        self._storage = self._client.viking_fs._get_vector_store()
        self._embedder = self._client.viking_fs._get_embedder()
        self._relax_parser()

    @staticmethod
    def _relax_parser() -> None:
        """阻止 MarkdownParser 把正文切成多块。

        切分后一块正文会散落到子目录，叶子文件的 parent_uri 不再等于台账里的
        viking_uri，召回结果就对不上源了。这里把阈值抬到实际不会触发的大小，
        并关掉 frontmatter 抽取（正文里出现 `---` 会被误当元数据吃掉）。
        """
        from openviking.parse.registry import get_registry
        from openviking.utils.config.parser_config import ParserConfig

        parser = get_registry().get_parser("markdown")
        if parser is None:
            return
        parser.config = ParserConfig(max_section_size=100000, max_content_length=2000000)
        parser.extract_frontmatter = False

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.close()
            self._client = None

    # ---------- 业务动作 ----------

    async def index(self, uri: str, text: str) -> Dict[str, Any]:
        """写入一块正文，返回实际落盘路径。

        openviking 不允许对同一个 target 重复写入，所以先删后写。
        """
        base, name = split_uri(uri)
        if self._client is None:
            raise VikingError("记忆服务尚未初始化")

        await self._remove(uri)

        tmp_dir = tempfile.mkdtemp(prefix="viking-index-")
        try:
            source = Path(tmp_dir) / f"{name}.md"
            source.write_text(text, encoding="utf-8")
            result = await self._client.add_resource(
                str(source), target=base, wait=True, timeout=self._index_timeout
            )
        except Exception as exc:  # noqa: BLE001 - 统一转成可重试错误
            raise VikingError(f"写入失败：{exc}") from exc
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        if result.get("status") != "success":
            raise VikingError(f"写入失败：{result.get('errors')}")

        root_uri = result.get("root_uri")
        if not root_uri:
            raise VikingError("写入失败：未返回落盘路径")

        return {"ok": True, "rootUri": root_uri}

    async def query(
        self, query: str, target_uri: str, limit: int, min_score: float
    ) -> Dict[str, Any]:
        """按向量相似度召回正文片段。

        target_uri 是硬前缀过滤条件，Node 侧永远传当前用户+作品的前缀。
        """
        if self._storage is None or self._embedder is None:
            raise VikingError("记忆服务尚未初始化")
        if not target_uri or not target_uri.startswith(URI_ROOT):
            raise InvalidUriError(f"查询范围必须以 {URI_ROOT} 开头：{target_uri}")

        vector = await self._embed(query)

        records = await self._storage.search(
            collection="context",
            query_vector=vector,
            filter={
                "op": "and",
                "conds": [
                    {"op": "prefix", "field": "uri", "prefix": target_uri},
                    {"op": "must", "field": "is_leaf", "conds": [True]},
                ],
            },
            limit=limit,
        )

        results: List[Dict[str, Any]] = []
        for record in records:
            score = float(record.get("_score") or 0.0)
            if score < min_score:
                continue
            leaf_uri = record.get("uri")
            if not leaf_uri:
                continue
            results.append(
                {
                    # parent_uri 就是这一块的落盘目录，与台账里的 viking_uri 一致。
                    "uri": record.get("parent_uri") or leaf_uri,
                    "fileUri": leaf_uri,
                    "score": round(score, 6),
                    "text": await self._read_preview(leaf_uri),
                }
            )

        return {"results": results}

    async def delete(self, uri: str) -> Dict[str, Any]:
        """删除一块正文及其向量记录。"""
        split_uri(uri)
        await self._remove(uri)
        return {"ok": True}

    async def health(self) -> Dict[str, Any]:
        return {"ok": True, "model": self._model, "dim": self._dim}

    # ---------- 内部 ----------

    async def _embed(self, text: str) -> List[float]:
        """单条向量化。Ark 的 SDK 是同步的，放线程里跑，别堵住事件循环。"""
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(self._embedder.embed, text),
                timeout=self._embed_timeout,
            )
        except asyncio.TimeoutError as exc:
            raise VikingError("向量化超时") from exc
        except Exception as exc:  # noqa: BLE001
            raise VikingError(f"向量化失败：{exc}") from exc
        return result.dense_vector

    async def _read_preview(self, uri: str) -> str:
        try:
            content = await self._client.read(uri)
        except Exception:  # noqa: BLE001 - 正文读不到不影响召回本身
            return ""
        return content[:PREVIEW_LIMIT]

    async def _remove(self, uri: str) -> None:
        """删除目录、文件与对应的向量记录。"""
        if self._client is None:
            return
        try:
            await self._client.rm(uri, recursive=True)
        except Exception as exc:  # noqa: BLE001
            # 目录不存在是常态（首次写入、重复删除），其余错误留给写入时的报错。
            if "no such file" not in str(exc).lower():
                raise VikingError(f"删除失败：{exc}") from exc
        if self._storage is not None:
            # rm 只回收文件，目录自身的向量记录要单独清。
            await self._storage.remove_by_uri("context", uri)


def load_settings(base_dir: Path) -> Dict[str, Any]:
    """从环境变量读配置。ARK key 只存在于 sidecar 的环境里，Node 侧不接触。"""
    api_key = os.environ.get("ARK_API_KEY", "")
    if not api_key:
        raise RuntimeError("缺少 ARK_API_KEY")

    data_dir = Path(os.environ.get("VIKING_DATA_DIR", "../../data/viking"))
    if not data_dir.is_absolute():
        data_dir = (base_dir / data_dir).resolve()

    return {
        "apiKey": api_key,
        "apiBase": os.environ.get("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3"),
        "model": os.environ.get("ARK_EMBEDDING_MODEL", "doubao-embedding-vision-251215"),
        "dim": int(os.environ.get("ARK_EMBEDDING_DIM", "2048")),
        "inputType": os.environ.get("ARK_EMBEDDING_INPUT", "multimodal"),
        "dataDir": str(data_dir),
        "agfsPort": int(os.environ.get("VIKING_AGFS_PORT", "8018")),
        "embedTimeoutSeconds": float(os.environ.get("VIKING_EMBED_TIMEOUT_SECONDS", "10")),
        # 写入超时必须**短于** Node 侧的 VIKING_INDEX_TIMEOUT_MS（默认 10 秒）。
        #
        # 谁先超时很重要：sidecar 先超时的话，它返回 503，
        # Node 拿到的是一个明确的失败，台账记 failed，状态一致。
        # 反过来 Node 先放弃，sidecar 还在后台写向量，
        # 结果是「台账说失败、向量已经写进去」——两边对不上。
        "indexTimeoutSeconds": float(os.environ.get("VIKING_INDEX_TIMEOUT_SECONDS", "8")),
        "logLevel": os.environ.get("VIKING_LOG_LEVEL", "WARNING"),
    }
