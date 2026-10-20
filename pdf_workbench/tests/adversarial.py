# -*- coding: utf-8 -*-
"""对抗测试：用真实 HTTP 请求模拟浏览器，覆盖 unhappy path，并捕获服务端异常。"""
import json, os, sys, io, base64, urllib.parse, urllib.request, traceback, time

BASE = "http://127.0.0.1:8765"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.dirname(os.path.abspath(__file__))

fails = []


def req(path, method="GET", data=None, headers=None):
    body = data if isinstance(data, (bytes, bytearray)) else (
        json.dumps(data).encode("utf-8") if data is not None else None)
    r = urllib.request.Request(BASE + path, data=body, method=method, headers=headers or {})
    if body is not None and not isinstance(data, (bytes, bytearray)):
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def jreq(path, method="GET", data=None, headers=None):
    code, b = req(path, method, data, headers)
    try:
        return code, json.loads(b.decode("utf-8"))
    except Exception:
        return code, {"_raw": b[:200]}


def check(label, cond, detail=""):
    print(("  [通过] " if cond else "  [失败] ") + label + ((" -> " + str(detail)) if detail else ""))
    if not cond:
        fails.append(label)


def make_realistic_pdf(path):
    """接近真实政务材料的 PDF：表单域 + 链接 + 图片 + 多材料 + 同页多标题 + 尾部无标题。"""
    import fitz
    doc = fitz.open()
    # 1) 封面 + 表单域
    p = doc.new_page(width=595, height=842)
    p.insert_text((72, 90), "项目材料汇编（封面）", fontname="china-s", fontsize=20)
    p.insert_text((72, 140), "申请单位：", fontname="china-s", fontsize=12)
    w = fitz.Widget(); w.rect = fitz.Rect(150, 130, 360, 150)
    w.field_name = "org"; w.field_type = fitz.PDF_WIDGET_TYPE_TEXT; w.text_fontsize = 11
    p.add_widget(w)
    p.insert_text((72, 230), "正文内容示例 第1页", fontname="china-s", fontsize=12)
    # 2) 费用签审单（含链接批注）
    p2 = doc.new_page(width=595, height=842)
    p2.insert_text((72, 90), "费用签审单", fontname="china-s", fontsize=20)
    p2.insert_text((72, 150), "费用签审正文 第2页", fontname="china-s", fontsize=12)
    p2.insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(72, 200, 300, 220),
                    "uri": "https://example.com"})
    # 3) 同页双材料（页内切分场景）：服务通知单 + 人员考勤
    p3 = doc.new_page(width=595, height=842)
    p3.insert_text((72, 80), "服务通知单", fontname="china-s", fontsize=20)
    p3.insert_text((72, 130), "服务通知单正文 第3页", fontname="china-s", fontsize=12)
    p3.insert_text((72, 300), "人员考勤", fontname="china-s", fontsize=20)
    p3.insert_text((72, 350), "人员考勤正文 第3页", fontname="china-s", fontsize=12)
    # 4) 尾部无标题补充说明页
    p4 = doc.new_page(width=595, height=842)
    p4.insert_text((72, 90), "补充说明页 第4页", fontname="china-s", fontsize=12)
    doc.save(path); doc.close()


def make_encrypted_pdf(path, pwd="1234"):
    import fitz
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 90), "机密材料", fontname="china-s", fontsize=20)
    doc.save(path, encryption=fitz.PDF_ENCRYPT_AES_256,
             owner_pw=pwd, user_pw=pwd)
    doc.close()


def main():
    print("1. 打开“真实感”PDF（表单域+链接+同页双材料）")
    rp = os.path.join(HERE, "adv_real.pdf")
    make_realistic_pdf(rp)
    raw = open(rp, "rb").read()
    code, info = jreq("/api/open", "POST", raw,
                      {"X-File-Name": urllib.parse.quote("项目材料_测试#1（终）.pdf")})
    check("打开成功", code == 200 and "doc_id" in info, code)
    if code != 200:
        print("    服务端返回:", info); return
    doc_id = info["doc_id"]; N = info["page_count"]
    check("页数=4", N == 4, N)

    print("2. 缩略图（含带表单域/链接页）")
    for pg in range(1, N + 1):
        code, png = req(f"/api/thumb?doc={doc_id}&page={pg}&w=200")
        check(f"第{pg}页缩略图PNG", code == 200 and png[:8] == b"\x89PNG\r\n\x1a\n", code)

    print("3. 识别（默认规则）+ 页内切分开启后重新识别")
    cfg = jreq("/api/rules")[1]["config"]
    det = jreq("/api/detect", "POST", {"doc_id": doc_id, "config": cfg})[1]
    check("识别到分界点", len(det["boundaries"]) > 0, len(det["boundaries"]))
    check("默认规则校验通过", det["checks"]["consistent"], det["checks"].get("problems"))
    # 关键：开启页内切分后必须【重新识别】，才能得到带 offset 的分界点
    icfg = json.loads(json.dumps(cfg)); icfg["options"]["inline_split"] = True
    det_in = jreq("/api/detect", "POST", {"doc_id": doc_id, "config": icfg})[1]
    has_inline_b = any(b.get("offset", 0) > 0 for b in det_in["boundaries"])
    check("页内切分识别出了带 offset 的分界点", has_inline_b,
          [b for b in det_in["boundaries"] if b.get("offset", 0) > 0])
    check("页内场景校验通过", det_in["checks"]["consistent"], det_in["checks"].get("problems"))

    print("4. 导出（含页内切分页）并下载校验")
    exp = jreq("/api/export", "POST",
               {"doc_id": doc_id, "config": icfg, "boundaries": det_in["boundaries"]})[1]
    check("导出返回文件", len(exp["files"]) > 0, len(exp["files"]))
    check("返回 ZIP", bool(exp.get("zip")))
    total = 0
    for f in exp["files"]:
        code, data = req("/api/file?p=" + urllib.parse.quote(f["path"]))
        check(f"下载 {f['name']} 是PDF", code == 200 and data[:4] == b"%PDF", code)
        total += f["pages"]
    check("输出页数>原页数(页内切分)", exp["checks"]["output_pages"] > N,
          exp["checks"]["output_pages"])

    print("5. 0 分界点（无法识别的PDF）导出兜底")
    # 构造一个没有任何命中关键字的 PDF
    import fitz
    blank_pdf = os.path.join(HERE, "adv_plain.pdf")
    d = fitz.open(); pp = d.new_page(); pp.insert_text((72, 90), "杂项说明文字没有任何标题", fontname="china-s", fontsize=12)
    d.save(blank_pdf); d.close()
    raw2 = open(blank_pdf, "rb").read()
    code, info2 = jreq("/api/open", "POST", raw2, {"X-File-Name": "plain.pdf"})
    did = info2["doc_id"]
    det2 = jreq("/api/detect", "POST", {"doc_id": did, "config": cfg})[1]
    check("0分界点也能得到1个整份段", len(det2["segments"]) == 1, len(det2["segments"]))
    exp2 = jreq("/api/export", "POST", {"doc_id": did, "config": cfg, "boundaries": det2["boundaries"]})[1]
    check("整份导出成功", len(exp2["files"]) == 1 and exp2["checks"]["consistent"])

    print("6. 加密 PDF 优雅报错（不崩溃）")
    ep = os.path.join(HERE, "adv_enc.pdf")
    make_encrypted_pdf(ep)
    code, er = jreq("/api/open", "POST", open(ep, "rb").read(), {"X-File-Name": "enc.pdf"})
    check("加密文件返回错误而非200", code != 200 and "error" in er, (code, er))
    check("错误信息含‘加密’", "加密" in str(er.get("error", "")), er.get("error"))

    print("7. 批量（含加密文件，应单独标记失败不影响其他）")
    items = [
        {"filename": "adv_real.pdf", "b64": base64.b64encode(raw).decode()},
        {"filename": "enc.pdf", "b64": base64.b64encode(open(ep, "rb").read()).decode()},
    ]
    bj = jreq("/api/batch", "POST", {"items": items, "config": cfg})[1]
    check("批量总数=2", bj["count"] == 2, bj["count"])
    check("成功数=1", bj["done"] == 1, bj["done"])
    check("存在失败项(加密)", any("error" in r for r in bj["results"]))
    check("成功项有 ZIP", any("error" not in r and r.get("zip") for r in bj["results"]))

    print()
    print("结果：", "全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}")


if __name__ == "__main__":
    main()
