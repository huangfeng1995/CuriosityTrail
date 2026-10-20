# -*- coding: utf-8 -*-
"""独立校验：逐 block 比对输出页与原件对应区域的文字和图片，并核对覆盖率。

用法：python check_output.py <原PDF> <输出目录>
"""
import json
import os
import sys
import fitz


def check(src_pdf: str, out_dir: str) -> int:
    src = fitz.open(src_pdf)
    manifest = json.load(open(os.path.join(out_dir, "_manifest.json"), encoding="utf-8"))
    checks = manifest["checks"]
    errors = []
    out_pages = 0
    inline_blocks = 0

    for seg in manifest["segments"]:
        path = os.path.join(out_dir, seg["file"])
        if not os.path.isfile(path):
            errors.append(f"缺少输出文件 {seg['file']}")
            continue
        doc = fitz.open(path)
        if doc.page_count != len(seg["blocks"]):
            errors.append(f"{seg['file']} 页数 {doc.page_count} != 记录块数 {len(seg['blocks'])}")
        for i, b in enumerate(seg["blocks"]):
            if i >= doc.page_count:
                break
            out_pages += 1
            src_page = src[b["page"] - 1]
            if b["full"]:
                clip, pos = None, ""
            else:
                inline_blocks += 1
                y1 = b["y1"] if b["y1"] is not None else float(src_page.rect.height)
                clip = fitz.Rect(0, b["y0"], float(src_page.rect.width), y1)
                pos = "[y %d~%d]" % (round(b["y0"]), round(y1))
            want = (src_page.get_text("text", clip=clip) if clip
                    else src_page.get_text("text")).strip()
            got = doc.load_page(i).get_text("text").strip()
            if got != want:
                errors.append(f"{seg['file']} 第{i + 1}页 文字 != 原件第{b['page']}页{pos}")
            if b["full"]:
                n_want = len(src_page.get_images(full=False))
                n_got = len(doc.load_page(i).get_images(full=False))
                if n_got != n_want:
                    errors.append(f"{seg['file']} 第{i + 1}页 图片数 {n_got} != 原件 {n_want}")
        doc.close()

    print(f"原文件页数：{src.page_count}")
    print(f"输出段数：{len(manifest['segments'])} ｜ 输出页数：{out_pages} ｜ 页内块：{inline_blocks}")
    print(f"manifest 校验：consistent={checks['consistent']} "
          f"page_level_only={checks['page_level_only']} problems={checks['problems']}")
    print(f"逐块内容比对：{'全部一致' if not errors else str(len(errors)) + ' 处不一致'}")
    for e in errors[:8]:
        print("  -", e)

    ok = (not errors) and checks["consistent"]
    if checks["page_level_only"]:
        ok = ok and (out_pages == src.page_count)
    print("结论：", "通过" if ok else "不通过")
    src.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(check(sys.argv[1], sys.argv[2]))
