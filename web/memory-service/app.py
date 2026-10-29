"""记忆服务 sidecar：把 openviking 包成一个只监听 127.0.0.1 的本地 HTTP 服务。

Node 侧通过四个接口使用它：

    GET    /health   -> { ok, model, dim }
    POST   /index    <- { uri, text }        -> { ok, rootUri }
    POST   /query    <- { query, targetUri, limit, minScore } -> { results: [...] }
    DELETE /index    <- { uri }               -> { ok }

sidecar 不认识 user/work 概念，也不做切块与排序：写什么、切多大、排第几，
都由 Node 侧决定。这里只负责把文本变成向量、把它找回来。

启动：
    cd web/memory-service
    python3 -m uvicorn app:app --host 127.0.0.1 --port 8019

必须单进程运行：openviking 的 AGFS 是子进程，端口独占，多 worker 会互相抢占。
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from store import InvalidUriError, VikingError, VikingStore, load_settings

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# 写入是串行的：openviking 落盘时会 mkdir 目标目录，同名目录已存在会直接失败，
# 并发写同一批数据容易撞车。索引是后台任务，排队换来的是结果可靠。
WRITE_LOCK = asyncio.Lock()


class IndexRequest(BaseModel):
    uri: str = Field(..., description="记忆块 URI，形如 viking://resources/u/{uid}/w/{wid}/chapter/{cid}/0")
    text: str = Field(..., description="该块的正文")


class QueryRequest(BaseModel):
    query: str = Field(..., description="召回用的查询文本")
    targetUri: str = Field(..., description="检索范围前缀，Node 侧传当前用户+作品")
    limit: int = Field(16, ge=1, le=100, description="最多返回多少条")
    minScore: float = Field(0.2, ge=0.0, le=1.0, description="原始相似度下限")


class DeleteRequest(BaseModel):
    uri: str = Field(..., description="要删除的记忆块 URI")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = load_settings(BASE_DIR)
    store = VikingStore(settings)
    await store.start()
    app.state.store = store
    try:
        yield
    finally:
        await store.stop()


app = FastAPI(title="CuriosityTrail Memory Service", lifespan=lifespan)


def get_store() -> VikingStore:
    store = getattr(app.state, "store", None)
    if store is None:
        raise HTTPException(status_code=503, detail="记忆服务尚未就绪")
    return store


@app.get("/health")
async def health() -> Dict[str, Any]:
    """探活。Node 侧启动时调用，不可用时整个记忆层关闭。"""
    try:
        return await get_store().health()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"记忆服务不可用：{exc}") from exc


@app.post("/index")
async def index(payload: IndexRequest) -> Dict[str, Any]:
    """写入一块正文。同 URI 重复写入按覆盖处理。"""
    try:
        async with WRITE_LOCK:
            return await get_store().index(payload.uri, payload.text)
    except InvalidUriError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VikingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"写入失败：{exc}") from exc


@app.post("/query")
async def query(payload: QueryRequest) -> Dict[str, Any]:
    """按向量相似度召回正文片段。"""
    try:
        return await get_store().query(
            payload.query, payload.targetUri, payload.limit, payload.minScore
        )
    except InvalidUriError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VikingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"召回失败：{exc}") from exc


@app.delete("/index")
async def delete(payload: DeleteRequest) -> Dict[str, Any]:
    """删除一块正文及其向量记录。目标不存在也算成功。"""
    try:
        async with WRITE_LOCK:
            return await get_store().delete(payload.uri)
    except InvalidUriError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except VikingError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"删除失败：{exc}") from exc


if __name__ == "__main__":
    import uvicorn

    # 只监听回环地址：这个服务不带鉴权，绝不能暴露到网络上。
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("VIKING_PORT", "8019")),
        workers=1,
    )
