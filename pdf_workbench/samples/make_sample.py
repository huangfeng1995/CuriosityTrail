# -*- coding: utf-8 -*-
"""生成测试用 PDF：中文标题页、书签、纯图片扫描页、页内双材料、头部孤立页、尾部无标题页。"""
import os
import fitz

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# (标题, 页数, 末页是否为无文字的纯图片页)
PLAN = [
    ("项目材料汇编（封面）", 1, False),
    ("费用签审单", 2, False),
    ("费用结算明细", 2, False),
    ("工作确认单", 3, False),
    ("完工报告", 2, True),      # 第2页扫描图，无任何文字
    ("INLINE", 1, False),       # 一页内上下两个材料，用于验证页内切分
    ("验收申请", 1, False),
    (None, 2, False),           # 尾部无标题页
]


def build(with_toc: bool, filename: str) -> str:
    doc = fitz.open()
    toc = []
    page_no = 1
    for title, count, tail_image_only in PLAN:
        for k in range(count):
            page = doc.new_page(width=595, height=842)
            image_only = tail_image_only and k == count - 1
            if image_only:
                pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 120, 80))
                pix.set_rect(pix.irect, (210, 130, 70))
                page.insert_image(fitz.Rect(72, 200, 492, 560), pixmap=pix)
            elif title == "INLINE":
                page.insert_text((72, 100), "服务通知单", fontname="china-s", fontsize=20)
                page.insert_text((72, 150), f"服务通知单正文 第{page_no}页", fontname="china-s", fontsize=12)
                page.insert_text((72, 300), "这里是服务通知单的详细内容，用于拉长正文。",
                                 fontname="china-s", fontsize=11)
                page.insert_text((72, 480), "人员考勤", fontname="china-s", fontsize=20)
                page.insert_text((72, 530), f"人员考勤正文 第{page_no}页", fontname="china-s", fontsize=12)
            elif title:
                head = title if k == 0 else f"{title}（续{k}）"
                page.insert_text((72, 100), head, fontname="china-s", fontsize=20)
                page.insert_text((72, 160), f"正文内容示例 第{page_no}页", fontname="china-s", fontsize=12)
            else:
                page.insert_text((72, 100), f"补充说明页 第{page_no}页", fontname="china-s", fontsize=12)
            page_no += 1
        if title and with_toc and title != "INLINE":
            toc.append([1, title, page_no - count])
    if with_toc:
        doc.set_toc(toc)
    path = os.path.join(OUT_DIR, filename)
    doc.save(path)
    doc.close()
    print(f"生成 {filename}：{page_no - 1} 页，书签 {len(toc)} 条")
    return path


if __name__ == "__main__":
    build(with_toc=False, filename="sample_keyword.pdf")
    build(with_toc=True, filename="sample_outline.pdf")
