'use strict';

/**
 * DOCX 导出。
 *
 * 块结构（正文/对白/独白/分场/插图/设定）要还原成读者能看的排版：
 *   正文      首行缩进两字，两端对齐
 *   对白      带说话人，缩进加宽
 *   独白      斜体，缩进
 *   分场      居中的分隔符
 *   插图      图片本体 + 图注
 *   设定      浅色小字，标注是设定引用
 */

const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  convertMillimetersToTwip,
} = require('docx');
const config = require('../config');

// 中文字体。eastAsia 必须显式给，Word 不会自动套用 theme 字体。
const FONT = '宋体';
const HEADING_FONT = '黑体';

// 一英寸 = 1440 twip。段前段后用半磅（240 twip = 12pt）做节奏。
const LINE_SPACING = 360; // 1.5 倍行距
const FIRST_LINE_INDENT = convertMillimetersToTwip(8.64); // 两字 ≈ 2 × 4.32mm

const IMAGE_TYPES = {
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpg',
  '.gif': 'gif',
  '.bmp': 'bmp',
};

/**
 * 解析章节的 blocks。兼容旧数据：没有 blocks 时退回 content 按空行切段。
 */
function parseBlocks(chapter) {
  if (chapter.blocks) {
    try {
      const parsed = JSON.parse(chapter.blocks);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // 解析失败就退回纯文本
    }
  }
  return (chapter.content || '')
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((text) => ({ id: 'p' + text.length, type: 'paragraph', content: text }));
}

/**
 * 读取插图文件。插图 url 形如 /uploads/xxx.png。
 * 读不到就返回 null——导出不能因为一张图挂了就整体失败。
 */
function readImage(block) {
  if (!block.url) return null;
  const filename = path.basename(block.url);
  const ext = path.extname(filename).toLowerCase();
  const type = IMAGE_TYPES[ext];
  if (!type) return null;

  const filePath = path.join(config.uploadsDir, filename);
  try {
    if (!fs.existsSync(filePath)) return null;
    return { data: fs.readFileSync(filePath), type, filename };
  } catch (e) {
    return null;
  }
}

/**
 * 一个块 → 一个或多个 docx 段落。
 */
function blockToParagraphs(block) {
  const content = (block.content || '').trim();

  if (block.type === 'scene_break') {
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 240, after: 240 },
        children: [new TextRun({ text: '＊　＊　＊', font: FONT, size: 24 })],
      }),
    ];
  }

  if (block.type === 'image') {
    const caption = block.content || block.fileName || '插图';
    const image = readImage(block);
    const out = [];

    if (image) {
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 240, after: 120 },
          children: [
            new ImageRun({
              type: image.type,
              data: image.data,
              transformation: { width: 400, height: 300 },
            }),
          ],
        })
      );
    }
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: caption,
            font: FONT,
            size: 20,
            color: '666666',
          }),
        ],
      })
    );
    return out;
  }

  if (block.type === 'setting_ref') {
    return [
      new Paragraph({
        spacing: { before: 120, after: 120, line: LINE_SPACING },
        indent: { left: convertMillimetersToTwip(8) },
        children: [
          new TextRun({
            text: `〔设定：${content}〕`,
            font: FONT,
            size: 21,
            color: '888888',
          }),
        ],
      }),
    ];
  }

  if (block.type === 'dialogue') {
    const speaker = (block.speaker || '').trim();
    return [
      new Paragraph({
        spacing: { before: 60, after: 60, line: LINE_SPACING },
        indent: { left: convertMillimetersToTwip(10) },
        children: [
          new TextRun({
            text: speaker ? `${speaker}：` : '',
            font: FONT,
            size: 24,
            bold: true,
          }),
          new TextRun({ text: content, font: FONT, size: 24 }),
        ],
      }),
    ];
  }

  if (block.type === 'inner') {
    return [
      new Paragraph({
        spacing: { before: 60, after: 60, line: LINE_SPACING },
        indent: { left: convertMillimetersToTwip(10) },
        children: [
          new TextRun({ text: content, font: FONT, size: 24, italics: true }),
        ],
      }),
    ];
  }

  // 正文
  return [
    new Paragraph({
      spacing: { before: 60, after: 60, line: LINE_SPACING },
      indent: { firstLine: FIRST_LINE_INDENT },
      alignment: AlignmentType.JUSTIFIED,
      children: [new TextRun({ text: content, font: FONT, size: 24 })],
    }),
  ];
}

/**
 * 章节 → 段落数组。
 */
function chapterToParagraphs(chapter, headingLevel) {
  const out = [
    new Paragraph({
      heading: headingLevel,
      alignment: AlignmentType.CENTER,
      spacing: { before: 480, after: 360 },
      children: [
        new TextRun({ text: chapter.title || '未命名章节', font: HEADING_FONT, size: 36, bold: true }),
      ],
    }),
  ];
  for (const block of parseBlocks(chapter)) {
    if (!block) continue;
    out.push(...blockToParagraphs(block));
  }
  return out;
}

/**
 * 文档通用设置：A4、页边距、中文字体。
 */
function documentOptions(children, title) {
  return new Document({
    creator: 'Curiosity Trail',
    title,
    description: 'Curiosity Trail 导出',
    styles: {
      default: {
        document: {
          run: { font: FONT, size: 24 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: convertMillimetersToTwip(210), height: convertMillimetersToTwip(297) },
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(28),
              right: convertMillimetersToTwip(28),
            },
          },
        },
        children,
      },
    ],
  });
}

/**
 * 单章 DOCX。
 */
async function buildChapterDocx(chapter) {
  const doc = documentOptions(
    chapterToParagraphs(chapter, HeadingLevel.HEADING_1),
    chapter.title || '章节'
  );
  return Packer.toBuffer(doc);
}

/**
 * 整部作品 DOCX：封面页 + 目录说明 + 各章。
 */
async function buildWorkDocx(work, chapters) {
  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 2400, after: 480 },
      children: [
        new TextRun({ text: work.title || '未命名作品', font: HEADING_FONT, size: 56, bold: true }),
      ],
    }),
  ];

  if (work.genre) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [new TextRun({ text: work.genre, font: FONT, size: 28 })],
      })
    );
  }

  if (work.synopsis) {
    children.push(
      new Paragraph({
        spacing: { before: 960, after: 120 },
        indent: { left: convertMillimetersToTwip(10), right: convertMillimetersToTwip(10) },
        children: [new TextRun({ text: '简介', font: HEADING_FONT, size: 26, bold: true })],
      })
    );
    children.push(
      new Paragraph({
        spacing: { after: 240, line: LINE_SPACING },
        alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun({ text: work.synopsis, font: FONT, size: 24 })],
      })
    );
  }

  for (const chapter of chapters) {
    children.push(...chapterToParagraphs(chapter, HeadingLevel.HEADING_1));
  }

  const doc = documentOptions(children, work.title || '作品');
  return Packer.toBuffer(doc);
}

module.exports = { buildChapterDocx, buildWorkDocx, parseBlocks };
