# -*- coding: utf-8 -*-
"""
splitter.py —— PDF 按内容规则拆分的核心引擎（依赖 PyMuPDF）。

支持两级分界：
  - 页级：命中页整体作为新段首页。页数守恒，输出页数之和 == 原页数。
  - 页内：命中位置落在页面中部时，从该处纵向裁开，一页拆成两块。
          此时输出页数会多于原页数，但页面内容不重不漏。

导出时按 block 复制：整页 block 用 insert_pdf（保真度最高，保留批注与链接），
页内 block 用 show_pdf_page + clip（真正裁掉区域外内容，文字仍可检索）。
"""
import argparse
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, asdict, field
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

try:
    import fitz
except ImportError:
    sys.exit("缺少依赖 PyMuPDF，请先安装：pip install pymupdf")

VERSION = "2.0"

DEFAULT_RULES: Dict[str, Any] = {
    "version": 2,
    "use_outline": True,
    "outline_levels": [1, 2],
    "rules": [
        {
            "name": "中文章节",
            "type": "regex",
            "pattern": r"^\s*第[一二三四五六七八九十百零\d]+[章节篇部]",
            "scope": "top",
            "top_chars": 200,
            "name_from": "line",
        },
        {
            "name": "编号标题",
            "type": "regex",
            "pattern": r"^\s*\d{1,2}(\.\d{1,2}){0,2}\s+\S",
            "scope": "top",
            "top_chars": 200,
            "name_from": "line",
        },
    ],
    "options": {
        "case_sensitive": False,
        "strip_whitespace": True,
        "exclude": "(续\\s*\\d*|第\\s*\\d+\\s*页|（续）|\\(续)",
        "orphan_pages": "prepend",
        "orphan_name": "前言",
        "inline_split": False,
        "head_ratio": 0.15,
        "min_tail": 30,
        "inline_padding": 2,
        "merge_blank_runs": True,
        "filename": "{index:02d}_{name}.pdf",
        "name_max_len": 60,
    },
}

ILLEGAL_CHARS = r'[\\/:*?"<>|\r\n\t]'


# ============================ 数据结构 ============================

@dataclass
class PageInfo:
    index: int
    text: str
    is_blank: bool
    height: float
    width: float


@dataclass
class Boundary:
    """分界点。offset=0 表示整页起点，offset>0 表示页内 y 坐标处切开。"""
    page: int
    offset: float
    name: str
    source: str
    matched: str


@dataclass
class Block:
    """导出时的最小复制单元。y1 <= 0 表示到页底；full=True 表示整页。"""
    page: int
    y0: float
    y1: float
    full: bool


@dataclass
class Segment:
    index: int
    name: str
    blocks: List[Block] = field(default_factory=list)
    source: str = ""
    matched: str = ""
    file: str = ""
    note: str = ""
    bi: int = -1          # 对应 boundaries 的下标，-1 表示无（前言段/整份段）

    @property
    def pages(self) -> int:
        return len(self.blocks)

    @property
    def start_page(self) -> int:
        return self.blocks[0].page + 1 if self.blocks else 0

    @property
    def end_page(self) -> int:
        return self.blocks[-1].page + 1 if self.blocks else 0

    @property
    def has_inline(self) -> bool:
        return any(not b.full for b in self.blocks)


# ============================ 数据层 ============================

def load_config(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return json.loads(json.dumps(DEFAULT_RULES))
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if "rules" not in cfg:
        raise ValueError("配置文件缺少 rules 字段")
    merged = json.loads(json.dumps(DEFAULT_RULES))
    merged.update({k: v for k, v in cfg.items() if k in ("use_outline", "outline_levels", "rules")})
    merged["options"] = {**DEFAULT_RULES["options"], **cfg.get("options", {})}
    return merged


def load_pages(doc: "fitz.Document") -> List[PageInfo]:
    pages: List[PageInfo] = []
    for i in range(doc.page_count):
        page = doc.load_page(i)
        text = page.get_text("text") or ""
        r = page.rect
        pages.append(PageInfo(i, text, not text.strip(), float(r.height), float(r.width)))
    return pages


# ============================ 计算层 ============================

def _norm(s: str, options: Dict[str, Any]) -> str:
    if options.get("strip_whitespace", True):
        s = re.sub(r"\s+", "", s)
    if not options.get("case_sensitive", False):
        s = s.lower()
    return s


def _scope_text(page: PageInfo, rule: Dict[str, Any]) -> str:
    if rule.get("scope", "page") == "top":
        return page.text[: int(rule.get("top_chars", 200))]
    return page.text


def _excluded(raw: str, rule: Dict[str, Any], options: Dict[str, Any]) -> bool:
    for pat in (rule.get("exclude"), options.get("exclude")):
        if pat and re.search(pat, raw):
            return True
    return False


def _resolve_offset(fitz_page, raw: str, page_h: float, rule: Dict[str, Any],
                    options: Dict[str, Any]) -> Optional[float]:
    """决定分界点位置：0=整页起点，>0=页内 y 坐标，None=该命中无效不作为分界。

    仅当规则或全局开启 inline 时才做页内定位；定位不到（扫描件/文本重排）退化为整页。
    """
    if not (rule.get("inline") or options.get("inline_split")):
        return 0.0
    try:
        rects = fitz_page.search_for(raw)
    except Exception:
        return 0.0
    if not rects:
        return 0.0
    y = min(r.y0 for r in rects)
    head = page_h * float(options.get("head_ratio", 0.15))
    if y <= head:
        return 0.0
    if y > page_h - float(options.get("min_tail", 30)):
        return None                      # 太靠页底，切开会产生几乎空白的块
    return max(0.0, y - float(options.get("inline_padding", 2)))


def match_rule(fitz_page, page: PageInfo, rule: Dict[str, Any],
               options: Dict[str, Any]) -> Optional[Tuple[str, str, Optional[float]]]:
    """返回 (段落名, 命中文本, 分界位置)。位置为 None 表示该命中无效。"""
    rtype = rule.get("type", "keyword")
    if rtype == "blank_page":
        return (rule["name"], "<空白页>", 0.0) if page.is_blank else None

    pattern = rule.get("pattern", "")
    if not pattern:
        return None

    m = None
    raw = ""
    if rtype == "regex":
        m = re.search(pattern, _scope_text(page, rule), re.MULTILINE)
        if not m:
            return None
        raw = m.group(0).strip()
    else:
        target = _norm(pattern, options)
        if not target:
            return None
        for line in _scope_text(page, rule).splitlines():
            if target in _norm(line, options):
                raw = line.strip()
                break
        else:
            return None

    if _excluded(raw, rule, options):
        return None
    name = _derive_name(rule, raw, m)
    return name, raw, _resolve_offset(fitz_page, raw, page.height, rule, options)


def _derive_name(rule: Dict[str, Any], raw: str, m) -> str:
    how = rule.get("name_from", "rule")
    if how == "line":
        name = re.sub(r"\s+", " ", raw).strip()
    elif how == "group" and m is not None and m.groups():
        name = m.group(1).strip()
    else:
        name = rule["name"]
    return name or rule["name"]


def collect_outline(doc: "fitz.Document", levels: List[int]) -> List[Boundary]:
    out: List[Boundary] = []
    try:
        toc = doc.get_toc()
    except Exception:
        return out
    for level, title, page in toc:
        if levels and level not in levels:
            continue
        idx = max(0, int(page) - 1)
        out.append(Boundary(idx, 0.0, (title or "").strip() or f"第{page}节", "outline", title))
    return out


def collect_boundaries(doc, pages: List[PageInfo], cfg: Dict[str, Any]) -> List[Boundary]:
    """书签优先，再逐页逐规则匹配。

    同一页允许存在多个分界点（页内切分的前提）：位置相同（相差 <2pt）的只保留先命中的那条，
    因此不开 inline 时一页仍只会产生一个分界点，行为与页级模式一致。
    """
    options = cfg["options"]
    marks: List[Boundary] = []

    def add(b: Boundary) -> None:
        for m in marks:
            if m.page == b.page and abs(m.offset - b.offset) < 2:
                return
        marks.append(b)

    if cfg.get("use_outline", True):
        for b in collect_outline(doc, cfg.get("outline_levels") or []):
            add(b)

    merge_blank = options.get("merge_blank_runs", True)
    prev_blank = False
    for page in pages:
        fitz_page = doc.load_page(page.index)
        for rule in cfg["rules"]:
            if rule.get("type") == "blank_page" and merge_blank and prev_blank:
                continue                          # 连续空白页只在第一页分界
            hit = match_rule(fitz_page, page, rule, options)
            if not hit:
                continue
            name, matched, offset = hit
            if offset is None:
                continue
            add(Boundary(page.index, offset, name, rule.get("type", "keyword"), matched))
        prev_blank = page.is_blank

    return sorted(marks, key=lambda b: (b.page, b.offset))


def _blocks_between(start: Boundary, end: Optional[Boundary], last_page: int,
                    heights: List[float]) -> List[Block]:
    """把 [start, end) 区间展开成 block 列表。"""
    blocks: List[Block] = []
    sp, sy = start.page, start.offset
    if end is None:
        ep, ey = last_page, -1.0                    # 末段一路延伸到最后一页页底
    else:
        ep, ey = end.page, end.offset

    if ep > sp:
        if sy > 0:
            blocks.append(Block(sp, sy, heights[sp], full=False))
        else:
            blocks.append(Block(sp, 0.0, -1.0, full=True))
        for p in range(sp + 1, ep):
            blocks.append(Block(p, 0.0, -1.0, full=True))
        if end is None:
            blocks.append(Block(ep, 0.0, -1.0, full=True))
        elif ey > 0:                                # 结束页的头部属于本段
            blocks.append(Block(ep, 0.0, ey, full=False))
    else:
        y1 = ey if ey > 0 else heights[sp]
        if sy > 0 or ey > 0:
            blocks.append(Block(sp, sy, y1, full=False))
        else:
            blocks.append(Block(sp, 0.0, -1.0, full=True))
    return blocks


def build_segments(total_pages: int, heights: List[float], boundaries: List[Boundary],
                   cfg: Dict[str, Any], base_name: str) -> List[Segment]:
    if total_pages <= 0:
        return []
    if not boundaries:
        return [Segment(1, base_name,
                        [Block(p, 0.0, -1.0, True) for p in range(total_pages)],
                        "whole_file", "", note="未识别到任何分界点，整份作为单文件输出")]

    options = cfg["options"]
    segs: List[Segment] = []
    prepend = options.get("orphan_pages", "prepend") == "prepend"
    head_orphan = boundaries[0].page > 0 or boundaries[0].offset > 0

    if head_orphan and not prepend:
        segs.append(Segment(0, options.get("orphan_name", "前言"),
                            _blocks_between(Boundary(0, 0.0, "", "orphan", ""),
                                            boundaries[0], total_pages - 1, heights),
                            "orphan", "", note="未识别的头部页"))

    for i, b in enumerate(boundaries):
        start = Boundary(0, 0.0, b.name, b.source, b.matched) if (i == 0 and prepend) else b
        end = boundaries[i + 1] if i + 1 < len(boundaries) else None
        blocks = _blocks_between(start, end, total_pages - 1, heights)
        if not blocks:
            continue
        note = "含未识别的头部页" if (i == 0 and prepend and head_orphan) else ""
        if any(not blk.full for blk in blocks):
            note = (note + "；" if note else "") + "含页内切分"
        segs.append(Segment(0, b.name, blocks, b.source, b.matched, note=note, bi=i))

    for i, s in enumerate(segs, start=1):
        s.index = i
    return segs


def sanitize(name: str, max_len: int) -> str:
    name = re.sub(ILLEGAL_CHARS, "_", name or "")
    name = re.sub(r"\s+", " ", name).strip().strip(".")
    return name[:max_len] or "untitled"


def assign_filenames(segs: List[Segment], cfg: Dict[str, Any]) -> None:
    options = cfg["options"]
    tpl = options.get("filename", "{index:02d}_{name}.pdf")
    max_len = int(options.get("name_max_len", 60))
    used: Dict[str, int] = {}
    for s in segs:
        safe = sanitize(s.name, max_len)
        fname = tpl.format(index=s.index, name=safe, start=s.start_page,
                           end=s.end_page, pages=s.pages, source=s.source)
        if not fname.lower().endswith(".pdf"):
            fname += ".pdf"
        cand, n = fname, 0
        while cand in used:
            n += 1
            stem, ext = os.path.splitext(fname)
            cand = f"{stem}_{n}{ext}"
        used[cand] = 0
        s.file = cand


def verify(segs: List[Segment], heights: List[float]) -> Dict[str, Any]:
    """校验每页内容被完整覆盖：不重叠、不留缝。"""
    cover: Dict[int, List[Tuple[float, float]]] = defaultdict(list)
    out_pages = 0
    inline_blocks = 0
    for s in segs:
        for b in s.blocks:
            y1 = b.y1 if b.y1 > 0 else heights[b.page]
            cover[b.page].append((b.y0, y1))
            out_pages += 1
            if not b.full:
                inline_blocks += 1

    problems: List[str] = []
    for p in range(len(heights)):
        ivs = sorted(cover.get(p, []))
        if not ivs:
            problems.append(f"第{p + 1}页 完全未覆盖")
            continue
        cursor = 0.0
        for y0, y1 in ivs:
            if y0 > cursor + 0.5:
                problems.append(f"第{p + 1}页 {cursor:.0f}~{y0:.0f} 未覆盖")
            elif y0 < cursor - 0.5:
                problems.append(f"第{p + 1}页 在 {y0:.0f} 处重叠")
            cursor = max(cursor, y1)
        if cursor < heights[p] - 0.5:
            problems.append(f"第{p + 1}页 尾部 {cursor:.0f}~{heights[p]:.0f} 未覆盖")

    page_level_only = inline_blocks == 0
    return {
        "total_pages": len(heights),
        "output_pages": out_pages,
        "segment_count": len(segs),
        "inline_blocks": inline_blocks,
        "page_level_only": page_level_only,
        "conserved_pages": out_pages == len(heights),
        "problems": problems,
        "consistent": not problems,
    }


# ============================ 输出层 ============================

def write_segment(src: "fitz.Document", seg: Segment, path: str) -> None:
    out = fitz.open()
    try:
        meta = src.metadata or {}
        out.set_metadata({k: v for k, v in meta.items() if v})
        for b in seg.blocks:
            if b.full:
                _insert_full(out, src, b.page)
            else:
                _insert_inline(out, src, b)
        out.save(path, garbage=3, deflate=True)
    finally:
        out.close()


def _insert_full(out: "fitz.Document", src: "fitz.Document", page: int) -> None:
    """整页复制，带注释/链接；遇到个别 PDF 注释结构异常时逐级降级，避免一整份导出失败。"""
    last_err = None
    for annot, links in ((True, True), (True, False), (False, False)):
        try:
            out.insert_pdf(src, from_page=page, to_page=page, annots=annot, links=links)
            return
        except Exception as e:  # 继续降级重试
            last_err = e
    # 三级都失败，抛出方便上层捕获
    raise RuntimeError("整页复制失败（注释/链接结构异常）: %s" % last_err)


def _insert_inline(out: "fitz.Document", src: "fitz.Document", b: Block) -> None:
    """页内块：用 show_pdf_page + clip 真正裁切区域。失败则退化为整页复制，保证不丢内容。"""
    w = float(src[b.page].rect.width)
    h = b.y1 - b.y0
    try:
        np_ = out.new_page(width=w, height=h)
        np_.show_pdf_page(fitz.Rect(0, 0, w, h), src, b.page,
                          clip=fitz.Rect(0, b.y0, w, b.y1))
    except Exception:
        # 兜底：清掉刚建的空页，改为整页复制（退化为不切分，但内容完整）
        try:
            out.delete_page(-1)
        except Exception:
            pass
        _insert_full(out, src, b.page)


def write_segments(src: "fitz.Document", segs: List[Segment], out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    for s in segs:
        write_segment(src, s, os.path.join(out_dir, s.file))


def segment_to_dict(s: Segment) -> Dict[str, Any]:
    return {
        "index": s.index,
        "name": s.name,
        "file": s.file,
        "source": s.source,
        "matched": s.matched,
        "note": s.note,
        "start_page": s.start_page,
        "end_page": s.end_page,
        "blocks": [{"page": b.page + 1, "y0": round(b.y0, 1),
                    "y1": round(b.y1, 1) if b.y1 > 0 else None,
                    "full": b.full} for b in s.blocks],
        "has_inline": s.has_inline,
        "bi": s.bi,
    }


def write_manifest(path: str, src_path: str, doc, segs: List[Segment],
                   cfg: Dict[str, Any], checks: Dict[str, Any]) -> None:
    data = {
        "version": VERSION,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "source": {"file": os.path.abspath(src_path), "pages": doc.page_count,
                   "sha1": _sha1(src_path)},
        "options": cfg["options"],
        "checks": checks,
        "segments": [segment_to_dict(s) for s in segs],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _sha1(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ============================ 编排（供 CLI 与服务共用） ============================

def analyze(doc, cfg: Dict[str, Any], base_name: str) -> Dict[str, Any]:
    """识别分界点并生成分段，不做任何写盘操作。"""
    pages = load_pages(doc)
    heights = [p.height for p in pages]
    boundaries = collect_boundaries(doc, pages, cfg)
    segs = build_segments(doc.page_count, heights, boundaries, cfg, base_name)
    assign_filenames(segs, cfg)
    checks = verify(segs, heights)
    return {
        "segments": [segment_to_dict(s) for s in segs],
        "checks": checks,
        "boundaries": [{"page": b.page + 1, "offset": round(b.offset, 1), "name": b.name,
                        "source": b.source, "matched": b.matched} for b in boundaries],
        "pages": [{"index": i + 1, "height": round(h, 1), "blank": pages[i].is_blank}
                  for i, h in enumerate(heights)],
        "_segments": segs,
    }


def segments_from_boundaries(doc, boundary_dicts: List[Dict[str, Any]], cfg: Dict[str, Any],
                             base_name: str) -> Tuple[List[Segment], Dict[str, Any]]:
    """由外部（工作台人工校正后）提供的分界点重建分段。页码为 1-based。"""
    heights = [float(doc.load_page(i).rect.height) for i in range(doc.page_count)]
    boundaries = []
    for b in boundary_dicts:
        pg = int(b["page"]) - 1
        if pg < 0 or pg >= doc.page_count:
            raise ValueError(
                "分界点页码 %s 超出文档范围（共 %d 页），请检查后重试" % (b.get("page"), doc.page_count))
        boundaries.append(
            Boundary(pg, float(b.get("offset") or 0.0),
                     b.get("name") or "未命名", b.get("source") or "manual", b.get("matched") or ""))
    boundaries.sort(key=lambda b: (b.page, b.offset))
    segs = build_segments(doc.page_count, heights, boundaries, cfg, base_name)
    assign_filenames(segs, cfg)
    return segs, verify(segs, heights)


# ============================ CLI ============================

def print_plan(result: Dict[str, Any]) -> None:
    segs, checks = result["segments"], result["checks"]
    print(f"{'序号':<4}{'文件名':<40}{'页码':<12}{'块数':<6}{'来源':<10}标记")
    print("-" * 88)
    for s in segs:
        mark = "页内切分" if s["has_inline"] else "整页"
        rng = "%d-%d" % (s["start_page"], s["end_page"])
        print(f"{s['index']:<6}{s['file']:<40}{rng:<14}"
              f"{len(s['blocks']):<8}{s['source']:<12}{mark}")
    print("-" * 88)
    print(f"原文件 {checks['total_pages']} 页 ｜ 输出 {checks['output_pages']} 页 "
          f"｜ 页内块 {checks['inline_blocks']} ｜ 覆盖校验：{'通过' if checks['consistent'] else '不通过'}")
    if checks["inline_blocks"]:
        print("提示：含页内切分，输出页数多于原页数（一页被拆成多块），但页面内容不重不漏")


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    p = argparse.ArgumentParser(description="按内容规则拆分 PDF")
    p.add_argument("pdf", nargs="?", help="输入 PDF 路径")
    p.add_argument("-c", "--config", help="拆分规则 JSON（缺省用内置规则）")
    p.add_argument("-o", "--out", help="输出目录（缺省：<PDF目录>/<文件名>_拆分结果）")
    p.add_argument("--password", help="PDF 打开密码")
    p.add_argument("--dry-run", action="store_true", help="只预览分段结果，不写文件")
    p.add_argument("--dump-default-rules", metavar="PATH", help="导出内置规则模板后退出")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)

    if args.dump_default_rules:
        with open(args.dump_default_rules, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_RULES, f, ensure_ascii=False, indent=2)
        print(f"已导出内置规则模板：{args.dump_default_rules}")
        return 0
    if not args.pdf:
        print("请指定输入 PDF 路径；用 --help 查看用法")
        return 1

    src = os.path.abspath(args.pdf)
    if not os.path.isfile(src):
        print(f"文件不存在：{src}")
        return 1

    cfg = load_config(args.config)
    base_name = os.path.splitext(os.path.basename(src))[0]
    out_dir = args.out or os.path.join(os.path.dirname(src), f"{base_name}_拆分结果")

    doc = fitz.open(src)
    try:
        if doc.needs_pass:
            if not args.password or not doc.authenticate(args.password):
                print("PDF 已加密，请通过 --password 提供正确密码")
                return 1
        if doc.page_count == 0:
            print("PDF 没有任何页面")
            return 1

        result = analyze(doc, cfg, base_name)
        if not args.quiet:
            print(f"输入：{src}")
            print(f"页数：{doc.page_count} ｜ 分界点：{len(result['boundaries'])} "
                  f"｜ 输出目录：{out_dir}\n")
            print_plan(result)

        if not result["checks"]["consistent"]:
            print("\n[错误] 覆盖校验未通过，已终止输出：")
            for msg in result["checks"]["problems"][:10]:
                print("  -", msg)
            return 2

        if args.dry_run:
            print("\n[dry-run] 未写入任何文件")
            return 0

        segs = result["_segments"]
        write_segments(doc, segs, out_dir)
        write_manifest(os.path.join(out_dir, "_manifest.json"), src, doc, segs, cfg,
                       result["checks"])
        if not args.quiet:
            print(f"\n已输出 {len(segs)} 个文件 -> {out_dir}")
        return 0
    finally:
        doc.close()


if __name__ == "__main__":
    sys.exit(main())
