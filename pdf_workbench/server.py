# -*- coding: utf-8 -*-
"""
本地服务：为网页工作台提供 PDF 打开、缩略图、识别、导出、下载能力。

只监听 127.0.0.1，PDF 不上传到任何外部地址，全部在本机处理。
接口：
    POST /api/open            body=PDF字节，header X-File-Name=文件名 → 打开文档
    GET  /api/thumb           ?doc=&page=&w= → 单页缩略图 PNG
    GET  /api/rules           → 默认规则配置
    POST /api/detect          {doc_id, config} → 识别分界点并返回分段建议
    POST /api/export          {doc_id, config, boundaries} → 按（校正后的）分界点导出
    GET  /api/file            ?p=<相对输出目录的路径> → 下载 PDF
"""
import json
import os
import sys
import base64
import threading
import zipfile
import uuid
import webbrowser
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote, urlparse, parse_qs

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "core"))
import splitter  # noqa: E402

UPLOAD_DIR = os.path.join(HERE, "uploads")
OUTPUT_ROOT = os.path.join(HERE, "output")
WEB_DIR = os.path.join(HERE, "web")
DEFAULT_RULES_FILE = os.path.join(HERE, "rules.example.json")
PORT_RANGE = range(8765, 8786)
SERVER_LOG = os.path.join(HERE, "server.log")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_ROOT, exist_ok=True)

DOCS: dict = {}
LOCK = threading.Lock()


# ============================ 业务 ============================

def open_document(data: bytes, filename: str) -> dict:
    doc_id = uuid.uuid4().hex[:12]
    safe = splitter.sanitize(os.path.splitext(filename)[0], 80) or "document"
    path = os.path.join(UPLOAD_DIR, f"{doc_id}_{safe}.pdf")
    with open(path, "wb") as f:
        f.write(data)
    doc = fitz.open(path)
    if doc.needs_pass:
        doc.close()
        raise ValueError("PDF 已加密，暂不支持带密码的文件")
    with LOCK:
        DOCS[doc_id] = {"path": path, "doc": doc, "name": safe, "thumbs": {}}
    return {
        "doc_id": doc_id,
        "name": safe,
        "page_count": doc.page_count,
        "has_outline": bool(doc.get_toc()),
        "pages": [{"index": i + 1, "width": round(float(doc.load_page(i).rect.width)),
                   "height": round(float(doc.load_page(i).rect.height)),
                   "blank": not (doc.load_page(i).get_text("text") or "").strip()}
                  for i in range(doc.page_count)],
    }


def get_doc(doc_id: str):
    with LOCK:
        item = DOCS.get(doc_id)
    if not item:
        raise KeyError("文档不存在或已释放，请重新打开")
    return item


def log_exc(e: Exception, where: str) -> str:
    """记录完整堆栈到 server.log，返回一段精简信息用于前端提示。"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = "=" * 60 + "\n[%s] %s\n%s" % (ts, where, traceback.format_exc())
    try:
        with open(SERVER_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    return "%s: %s" % (type(e).__name__, e)


def render_thumb(doc_id: str, page_no: int, width: int) -> bytes:
    item = get_doc(doc_id)
    cache = item["thumbs"]
    key = (page_no, width)
    if key in cache:
        return cache[key]
    page = item["doc"].load_page(page_no - 1)
    scale = float(width) / float(page.rect.width)
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    data = pix.tobytes("png")
    if len(cache) > 400:
        cache.clear()
    cache[key] = data
    return data


def detect(doc_id: str, config: dict) -> dict:
    item = get_doc(doc_id)
    cfg = config or splitter.load_config(None)
    result = splitter.analyze(item["doc"], cfg, item["name"])
    result.pop("_segments", None)
    return result


def export(doc_id: str, config: dict, boundaries: list) -> dict:
    item = get_doc(doc_id)
    cfg = config or splitter.load_config(None)
    segs, checks = splitter.segments_from_boundaries(item["doc"], boundaries, cfg, item["name"])
    if not checks["consistent"]:
        raise ValueError("覆盖校验未通过：" + "；".join(checks["problems"][:5]))

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(OUTPUT_ROOT, f"{item['name']}_{stamp}")
    splitter.write_segments(item["doc"], segs, out_dir)
    splitter.write_manifest(os.path.join(out_dir, "_manifest.json"), item["path"],
                            item["doc"], segs, cfg, checks)
    rel = os.path.relpath(out_dir, OUTPUT_ROOT)
    files = [{"name": s.file, "pages": s.pages, "blocks": len(s.blocks),
              "inline": s.has_inline, "path": f"{rel}/{s.file}"} for s in segs]
    zip_name = os.path.basename(out_dir) + ".zip"
    zip_path = os.path.join(out_dir, zip_name)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(os.path.join(out_dir, f["name"]), f["name"])
        zf.write(os.path.join(out_dir, "_manifest.json"), "_manifest.json")
    return {
        "out_dir": out_dir,
        "files": files,
        "checks": checks,
        "zip": f"{rel}/{zip_name}",
    }


def batch_process(items: list, config: dict) -> dict:
    """批量拆分：对每个 PDF 自动识别并导出，汇总到 batch_<时间戳>/<材料名>/，并打总包。

    items: [{"filename": str, "b64": str}, ...]
    """
    cfg = config or splitter.load_config(None)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    root = os.path.join(OUTPUT_ROOT, f"batch_{stamp}")
    os.makedirs(root, exist_ok=True)

    results, total_segments = [], 0
    for it in items:
        fn = (it.get("filename") or "document.pdf")
        try:
            data = base64.b64decode(it.get("b64") or "")
        except Exception:
            results.append({"name": fn, "error": "文件数据无法解码"})
            continue
        base = splitter.sanitize(os.path.splitext(fn)[0], 60) or "document"
        tmp = os.path.join(UPLOAD_DIR, f"batch_{uuid.uuid4().hex[:8]}_{base}.pdf")
        with open(tmp, "wb") as f:
            f.write(data)
        doc = fitz.open(tmp)
        try:
            if doc.needs_pass:
                results.append({"name": fn, "error": "PDF 已加密，已跳过"})
                continue
            r = splitter.analyze(doc, cfg, base)
            segs, checks = splitter.segments_from_boundaries(doc, r["boundaries"], cfg, base)
            if not checks["consistent"]:
                results.append({"name": fn, "error": "覆盖校验未通过：" +
                                "；".join(checks["problems"][:3]), "page_count": doc.page_count})
                continue
            sub = os.path.join(root, base)
            splitter.write_segments(doc, segs, sub)
            splitter.write_manifest(os.path.join(sub, "_manifest.json"), tmp, doc, segs, cfg, checks)
            rel_sub = os.path.relpath(sub, OUTPUT_ROOT)
            zip_sub = f"{base}.zip"
            with zipfile.ZipFile(os.path.join(sub, zip_sub), "w", zipfile.ZIP_DEFLATED) as zf:
                for s in segs:
                    zf.write(os.path.join(sub, s.file), s.file)
                zf.write(os.path.join(sub, "_manifest.json"), "_manifest.json")
            files = [{"name": s.file, "pages": s.pages, "path": f"{rel_sub}/{s.file}"} for s in segs]
            results.append({
                "name": fn, "page_count": doc.page_count,
                "segments": len(segs), "consistent": True,
                "files": files, "zip": f"{rel_sub}/{zip_sub}",
            })
            total_segments += len(segs)
        finally:
            doc.close()
            try:
                os.remove(tmp)
            except OSError:
                pass

    rel_root = os.path.relpath(root, OUTPUT_ROOT)
    zip_all = f"{os.path.basename(root)}.zip"
    with zipfile.ZipFile(os.path.join(root, zip_all), "w", zipfile.ZIP_DEFLATED) as zf:
        for name in sorted(os.listdir(root)):
            fp = os.path.join(root, name)
            if os.path.isfile(fp):
                zf.write(fp, name)
            elif os.path.isdir(fp):
                for f in sorted(os.listdir(fp)):
                    zf.write(os.path.join(fp, f), os.path.join(name, f))
    return {
        "count": len(items),
        "done": sum(1 for r in results if r.get("consistent")),
        "total_segments": total_segments,
        "out_dir": root,
        "results": results,
        "zip": f"{rel_root}/{zip_all}",
    }


# ============================ HTTP ============================

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code: int, body: bytes, ctype: str, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _fail(self, msg: str, code=400):
        self._json({"ok": False, "error": str(msg)}, code)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path in ("/", "/index.html"):
                with open(os.path.join(WEB_DIR, "index.html"), "rb") as f:
                    self._send(200, f.read(), "text/html; charset=utf-8")
            elif u.path == "/api/thumb":
                data = render_thumb(q["doc"][0], int(q["page"][0]), int(q.get("w", [180])[0]))
                self._send(200, data, "image/png")
            elif u.path == "/api/rules":
                cfg = splitter.load_config(DEFAULT_RULES_FILE if os.path.isfile(DEFAULT_RULES_FILE)
                                           else None)
                self._json({"ok": True, "config": cfg})
            elif u.path == "/api/file":
                self._serve_file(unquote(q["p"][0]))
            else:
                self._fail("未知接口", 404)
        except KeyError as e:
            self._fail(f"参数缺失或无效：{e}", 400)
        except Exception as e:
            self._fail(log_exc(e, "GET " + u.path), 400)

    def do_POST(self):
        u = urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            if u.path == "/api/open":
                name = unquote(self.headers.get("X-File-Name", "document.pdf"))
                self._json({"ok": True, **open_document(raw, name)})
            elif u.path == "/api/detect":
                body = json.loads(raw.decode("utf-8"))
                self._json({"ok": True, **detect(body["doc_id"], body.get("config"))})
            elif u.path == "/api/rebuild":
                body = json.loads(raw.decode("utf-8"))
                item = get_doc(body["doc_id"])
                cfg = body.get("config") or splitter.load_config(None)
                segs, checks = splitter.segments_from_boundaries(
                    item["doc"], body.get("boundaries") or [], cfg, item["name"])
                self._json({"ok": True,
                            "segments": [splitter.segment_to_dict(s) for s in segs],
                            "checks": checks})
            elif u.path == "/api/export":
                body = json.loads(raw.decode("utf-8"))
                self._json({"ok": True, **export(body["doc_id"], body.get("config"),
                                                 body.get("boundaries") or [])})
            elif u.path == "/api/batch":
                body = json.loads(raw.decode("utf-8"))
                self._json({"ok": True, **batch_process(body.get("items") or [],
                                                         body.get("config"))})
            else:
                self._fail("未知接口", 404)
        except Exception as e:
            self._fail(log_exc(e, "POST " + u.path), 400)

    def _serve_file(self, rel_path: str):
        abs_path = os.path.abspath(os.path.join(OUTPUT_ROOT, rel_path))
        if not abs_path.startswith(os.path.abspath(OUTPUT_ROOT) + os.sep):
            raise ValueError("非法路径")
        if not os.path.isfile(abs_path):
            raise FileNotFoundError("文件不存在")
        with open(abs_path, "rb") as f:
            data = f.read()
        name = os.path.basename(abs_path)
        self._send(200, data, "application/pdf",
                   {"Content-Disposition": "attachment; filename*=UTF-8''" + quote(name)})


class WorkbenchServer(ThreadingHTTPServer):
    """不启用 SO_REUSEADDR。

    Windows 下 SO_REUSEADDR 允许两个进程同时监听同一个端口，会造成本实例
    与残留的旧实例抢同一个端口、浏览器可能命中旧代码的隐蔽问题。关掉之后
    端口被占用会直接抛错，从而正确落到下一个端口。
    """
    allow_reuse_address = False
    daemon_threads = True


def main() -> int:
    # 控制台编码：跟随系统代码页，避免中文提示在 GBK 控制台里变乱码或抛异常
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(errors="replace")
            except Exception:
                pass
    last_err = None
    for port in PORT_RANGE:
        try:
            httpd = WorkbenchServer(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            last_err = e
            continue
    else:
        print(f"端口全部被占用：{last_err}")
        return 1

    url = f"http://127.0.0.1:{port}"
    print("=" * 56)
    print("  PDF 拆分工作台已启动")
    print(f"  访问地址：{url}")
    print(f"  输出目录：{OUTPUT_ROOT}")
    print("  关闭此窗口即可停止服务")
    print("=" * 56)
    if "--no-browser" not in sys.argv[1:]:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
