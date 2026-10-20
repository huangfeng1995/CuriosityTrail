'use strict';

/**
 * 文档正文提取。
 *
 * 素材库要能"搜到内容"而不是"搜到文件名"——作者上传一本参考资料，
 * 问"里面怎么写雨夜的巷子"，AI 得能引用到具体段落，
 * 而不是回一句"《参考资料.pdf》里可能有"。
 *
 * 所以上传时就把正文抽出来存进 materials.body，再进 FTS5 索引。
 *
 * PDF 提取时在每页开头插入 [[PAGE n]] 标记：
 * 引用时能说清"出自第 12 页"，作者好核对原文；
 * 检索命中时也能顺带算出页码。
 */

// 直接 require 内部实现：pdf-parse 的入口在 module.parent 为空时
// 会跑自带的调试逻辑去读测试文件，在某些加载顺序下会抛错。
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/** 单个文件最多提取多少字，避免超大 PDF 把内存和索引撑爆 */
const MAX_CHARS = 500000;

/** 页码标记 */
const PAGE_MARK = /\[\[PAGE (\d+)\]\]/g;

/**
 * 归一化正文：统一换行、压缩空白、去掉多余空行。
 */
function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]/g, ' ')
    .replace(/ {2,}/g, ' ')
    // PDF 里常有大量空白文本项，会变成一长串空行，压掉
    .replace(/(\n[ \t]*){3,}/g, '\n\n')
    .trim();
}

/**
 * 构造 PDF 逐页渲染器。每页开头插入 [[PAGE n]] 标记。
 *
 * 标记放在页首而不是页尾：这样"命中位置之前最后一个标记"就是命中内容所在页，
 * 页码才算得准（放在页尾的话，第一页的内容前面没有任何标记）。
 *
 * 不用 pdf-parse 自带的 renderer，因为它拿不到页序号。
 */
function createPageRenderer() {
  let pageNo = 0;

  return async function renderPage(pageData) {
    pageNo += 1;

    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });

    let lastY = null;
    let text = '';
    for (const item of content.items) {
      if (lastY === null || lastY === item.transform[5]) {
        text += item.str;
      } else {
        text += `\n${item.str}`;
      }
      lastY = item.transform[5];
    }

    return `[[PAGE ${pageNo}]]\n${text}`;
  };
}

/**
 * 提取 PDF 正文。
 * @returns {Promise<{text: string, pageCount: number, hasTextLayer: boolean}>}
 */
async function extractPdf(filePath) {
  const fs = require('fs');
  const buffer = await fs.promises.readFile(filePath);
  const data = await pdfParse(buffer, { pagerender: createPageRenderer() });

  const text = normalizeText(data.text).slice(0, MAX_CHARS);
  // 扫描版 PDF 没有文本层，提取出来只有页码标记
  const hasTextLayer = text.replace(PAGE_MARK, '').trim().length > 0;

  return { text, pageCount: data.numpages || 0, hasTextLayer };
}

/**
 * 提取纯文本文件（txt / md）。原样保留内容，只做空白归一化。
 * @returns {Promise<{text: string, pageCount: number, hasTextLayer: boolean}>}
 */
async function extractPlain(filePath) {
  const fs = require('fs');
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return {
    text: normalizeText(raw).slice(0, MAX_CHARS),
    pageCount: 0,
    hasTextLayer: true,
  };
}

/**
 * 按扩展名提取正文。
 * @param {string} filePath
 * @returns {Promise<{text: string, pageCount: number, hasTextLayer: boolean, kind: string}>}
 */
async function extract(filePath) {
  const path = require('path');
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.pdf') {
    const result = await extractPdf(filePath);
    return { ...result, kind: 'pdf' };
  }

  const result = await extractPlain(filePath);
  return { ...result, kind: 'text' };
}

/**
 * 找出正文里某个位置属于第几页。
 *
 * @param {string} body 全文（含 [[PAGE n]] 标记）
 * @param {number} index 命中位置（字符下标）
 * @returns {number} 页码；没有页码标记时返回 0
 */
function pageAt(body, index) {
  if (!body) return 0;
  const before = body.slice(0, Math.max(0, index));
  const marks = before.match(PAGE_MARK);
  if (!marks || !marks.length) return 0;
  const last = marks[marks.length - 1];
  return Number(last.match(/\d+/)[0]) || 0;
}

/**
 * 统计正文里的页数（按页码标记推断）。
 * @param {string} body
 * @returns {number}
 */
function countPages(body) {
  if (!body) return 0;
  const marks = body.match(PAGE_MARK);
  if (!marks || !marks.length) return 0;
  return Number(marks[marks.length - 1].match(/\d+/)[0]) || 0;
}

module.exports = {
  extract,
  extractPdf,
  extractPlain,
  normalizeText,
  pageAt,
  countPages,
  MAX_CHARS,
};
