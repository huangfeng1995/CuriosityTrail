"""sidecar 冒烟测试：直接调 store 层，不经过 HTTP。

覆盖四件事：写入、召回（带跨用户隔离检查）、删除、探活。
跑法：
    cd web/memory-service
    python3 smoke_test.py

它会写进 VIKING_DATA_DIR 指向的目录，用完可以整个删掉。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

from store import VikingStore, load_settings  # noqa: E402

FAILED: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILED.append(label)


async def main() -> int:
    settings = load_settings(BASE_DIR)
    store = VikingStore(settings)
    await store.start()

    try:
        health = await store.health()
        check("health 返回模型与维度", health.get("ok") is True and health.get("dim") == 2048, str(health))

        user_a = "viking://resources/u/smokeA/w/W1/chapter/C1/0"
        user_b = "viking://resources/u/smokeB/w/W1/chapter/C1/0"

        # --- 写入 ---
        r1 = await store.index(user_a, "林昭答应替父亲还债，期限三年。")
        check("写入返回落盘路径", r1.get("ok") is True and r1.get("rootUri") == user_a, str(r1))

        r2 = await store.index(
            "viking://resources/u/smokeA/w/W1/chapter/C1/1",
            "沈知微带着一封旧信回到镇上，没有人认出她。",
        )
        check("同一章的第二块写入成功", r2.get("ok") is True, str(r2))

        r3 = await store.index(user_b, "这是另一个用户的章节内容，绝不能被检索到。")
        check("另一个用户的写入成功", r3.get("ok") is True, str(r3))

        # --- 召回 ---
        out = await store.query(
            "林昭答应过什么", "viking://resources/u/smokeA/w/W1/", limit=10, min_score=0.0
        )
        results = out.get("results", [])
        check("召回有结果", len(results) > 0, f"{len(results)} 条")
        top = results[0] if results else {}
        check("命中的正是林昭那块", "林昭" in top.get("text", ""), top.get("uri", ""))
        check("返回的是块级 URI", top.get("uri") == user_a, top.get("uri", ""))
        check("分数在 0~1 之间", 0.0 <= top.get("score", -1) <= 1.0, str(top.get("score")))

        leaked = [r for r in results if "另一个用户" in r.get("text", "")]
        check("没有跨用户泄漏", not leaked, f"{len(leaked)} 条越界")

        # 只查 smokeA，即使 prompt 里出现 smokeB 的内容也不该命中。
        narrow = await store.query(
            "沈知微 旧信", "viking://resources/u/smokeA/w/W1/", limit=10, min_score=0.0
        )
        check(
            "限定前缀后只返回本用户结果",
            all("smokeB" not in r.get("uri", "") for r in narrow.get("results", [])),
            f"{len(narrow.get('results', []))} 条",
        )

        # 阈值过滤生效
        strict = await store.query(
            "林昭答应过什么", "viking://resources/u/smokeA/w/W1/", limit=10, min_score=0.99
        )
        check("阈值高于全部得分时无结果", len(strict.get("results", [])) == 0)

        # --- 覆盖写 ---
        r4 = await store.index(user_a, "林昭最终还清了债，与父亲和解。")
        check("同 URI 覆盖写成功", r4.get("ok") is True, str(r4))
        again = await store.query(
            "林昭答应过什么", "viking://resources/u/smokeA/w/W1/", limit=10, min_score=0.0
        )
        texts = [r.get("text", "") for r in again.get("results", [])]
        check(
            "覆盖后旧正文消失、新正文在",
            not any("期限三年" in t for t in texts) and any("还清了债" in t for t in texts),
            str(texts),
        )

        # --- 删除 ---
        d = await store.delete(user_a)
        check("删除成功", d.get("ok") is True, str(d))
        after = await store.query(
            "林昭答应过什么", "viking://resources/u/smokeA/w/W1/", limit=10, min_score=0.0
        )
        check(
            "删除后召回不到该块",
            all(r.get("uri") != user_a for r in after.get("results", [])),
            f"{len(after.get('results', []))} 条",
        )

        d2 = await store.delete("viking://resources/u/smokeA/w/W1/chapter/does-not-exist/9")
        check("删除不存在的块也算成功", d2.get("ok") is True, str(d2))

        # --- 非法 URI ---
        try:
            await store.index("viking://resources/public/shared/0", "越权写入")
            check("拒绝非用户命名空间的 URI", False)
        except Exception as exc:  # noqa: BLE001
            check("拒绝非用户命名空间的 URI", True, type(exc).__name__)
    finally:
        await store.stop()

    print()
    if FAILED:
        print(f"{len(FAILED)} 项未通过：{'、'.join(FAILED)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
