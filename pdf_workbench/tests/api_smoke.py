# -*- coding: utf-8 -*-
"""本地服务接口冒烟测试：打开 → 缩略图 → 识别 → 校正重算 → 导出 → 下载。

用法：先启动 server.py，再执行 python tests/api_smoke.py
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8765"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PDF = os.path.join(ROOT, "samples", "sample_keyword.pdf")

fails = []


def req(path, method="GET", data=None, headers=None):
    body = data if isinstance(data, (bytes, bytearray)) else (
        json.dumps(data).encode("utf-8") if data is not None else None)
    r = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    if body is not None and not isinstance(data, (bytes, bytearray)):
        r.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(r, timeout=120) as resp:
        return resp.read()


def jreq(path, method="GET", data=None, headers=None):
    return json.loads(req(path, method, data, headers).decode("utf-8"))


def check(label, cond, detail=""):
    print(("  [通过] " if cond else "  [失败] ") + label + ((" -> " + str(detail)) if detail else ""))
    if not cond:
        fails.append(label)


def main():
    print("1. 获取默认规则")
    cfg = jreq("/api/rules")["config"]
    check("返回规则条数 > 0", len(cfg["rules"]) > 0, len(cfg["rules"]))

    print("2. 打开 PDF")
    raw = open(PDF, "rb").read()
    info = jreq("/api/open", "POST", raw,
                {"X-File-Name": urllib.parse.quote("测试材料.pdf")})
    doc_id = info["doc_id"]
    N = info["page_count"]
    check("页数正确", N >= 1, N)
    check("页面尺寸已返回", len(info["pages"]) == N)

    print("3. 渲染缩略图")
    png = req(f"/api/thumb?doc={doc_id}&page=1&w=200")
    check("PNG 数据非空", png[:8] == b"\x89PNG\r\n\x1a\n", len(png))

    print("4. 识别分界点")
    det = jreq("/api/detect", "POST", {"doc_id": doc_id, "config": cfg})
    check("分界点 > 0", len(det["boundaries"]) > 0, len(det["boundaries"]))
    check("覆盖校验通过", det["checks"]["consistent"], det["checks"].get("problems"))
    check("分段数 > 0", len(det["segments"]) > 0, len(det["segments"]))
    check("段带分界点索引", all("bi" in s for s in det["segments"]))

    print("5. 人工校正后重算（删除最后一个分界点）")
    b = det["boundaries"][:-1]
    rb = jreq("/api/rebuild", "POST", {"doc_id": doc_id, "config": cfg, "boundaries": b})
    check("分段数减少 1", len(rb["segments"]) == len(det["segments"]) - 1,
          f'{len(det["segments"])} -> {len(rb["segments"])}')
    check("重算后校验仍通过", rb["checks"]["consistent"], rb["checks"].get("problems"))

    print("6. 插入页内分界点后重算")
    inline_cfg = json.loads(json.dumps(cfg))
    inline_cfg["options"]["inline_split"] = True
    b2 = json.loads(json.dumps(b))
    b2.append({"page": 11, "offset": 470, "name": "人员考勤", "source": "manual", "matched": ""})
    b2.sort(key=lambda x: (x["page"], x["offset"]))
    rb2 = jreq("/api/rebuild", "POST", {"doc_id": doc_id, "config": inline_cfg, "boundaries": b2})
    check("产生页内块", rb2["checks"]["inline_blocks"] >= 2, rb2["checks"]["inline_blocks"])
    check("输出页数多于原页数", rb2["checks"]["output_pages"] > N, rb2["checks"]["output_pages"])
    check("页内场景校验通过", rb2["checks"]["consistent"], rb2["checks"].get("problems"))

    print("7. 导出")
    exp = jreq("/api/export", "POST", {"doc_id": doc_id, "config": cfg, "boundaries": b})
    check("导出文件数正确", len(exp["files"]) == len(rb["segments"]), len(exp["files"]))
    check("输出目录存在", os.path.isdir(exp["out_dir"]), exp["out_dir"])
    check("返回 ZIP 路径", bool(exp.get("zip")), exp.get("zip"))
    if exp.get("zip"):
        zdata = req("/api/file?p=" + urllib.parse.quote(exp["zip"]))
        check("ZIP 可下载且格式正确", zdata[:2] == b"PK", len(zdata))

    total_pages = 0
    for f in exp["files"]:
        p = os.path.join(exp["out_dir"], f["name"])
        check(f"文件已生成 {f['name']}", os.path.isfile(p))
        data = req("/api/file?p=" + urllib.parse.quote(f["path"]))
        check(f"可下载 {f['name']}", data[:4] == b"%PDF", len(data))
        total_pages += f["pages"]
    check("页数之和 == " + str(N), total_pages == N, total_pages)

    print("8. 安全：拒绝越权路径")
    try:
        req("/api/file?p=" + urllib.parse.quote("../../server.py"))
        check("越权路径被拒绝", False, "未被拦截")
    except Exception as e:
        check("越权路径被拒绝", True, type(e).__name__)

    print("9. 批量拆分")
    import base64
    batch_pdfs = ["sample_keyword.pdf", "sample_outline.pdf"]
    items = []
    for name in batch_pdfs:
        p = os.path.join(ROOT, "samples", name)
        with open(p, "rb") as f:
            items.append({"filename": name, "b64": base64.b64encode(f.read()).decode("ascii")})
    bj = jreq("/api/batch", "POST", {"items": items, "config": cfg})
    check("批量文件数=2", bj["count"] == 2, bj["count"])
    check("成功处理数=2", bj["done"] == 2, bj["done"])
    check("总段数>0", bj["total_segments"] > 0, bj["total_segments"])
    check("每个文件都有分段结果", all(r.get("segments", 0) > 0 for r in bj["results"]),
          [r.get("name") for r in bj["results"]])
    check("无失败文件", all("error" not in r for r in bj["results"]),
          [r.get("error") for r in bj["results"] if "error" in r])
    check("返回总包 ZIP 路径", bool(bj.get("zip")), bj.get("zip"))
    if bj.get("zip"):
        zdata = req("/api/file?p=" + urllib.parse.quote(bj["zip"]))
        check("总包 ZIP 可下载且格式正确", zdata[:2] == b"PK", len(zdata))
        # 校验每个子文件 ZIP 也可下载
        ok = True
        for r in bj["results"]:
            if "error" in r:
                continue
            d = req("/api/file?p=" + urllib.parse.quote(r["zip"]))
            if d[:2] != b"PK":
                ok = False
        check("每个子文件 ZIP 均可下载", ok)

    print()
    print("结果：", "全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
