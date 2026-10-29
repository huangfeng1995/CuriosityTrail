'use strict';

/**
 * 记忆切块。
 *
 * 切块的粒度直接决定召回质量：
 *  - 太大 → 一块里混了好几件事，向量语义被稀释，召回不准
 *  - 太小 → 上下文断裂，AI 看到的是碎片，剧情接不上
 *
 * 所以目标定在 600–1000 字，块间留 100 字重叠。
 *
 * 切分点优先选在**语义边界**上，而不是机械地按字数砍：
 *  1. 场景分隔（scene_break）——一定是硬边界
 *  2. 段落边界
 *  3. 对话整句——绝不把一句台词从中间劈开
 *
 * 人物卡/设定这类短文本走同一条路径，只是它们通常只有一块。
 */

/** 目标块大小（字符）。 */
const TARGET_SIZE = 800;
/** 硬上限：超过就必须切，否则 embedding 上下文会被撑爆。 */
const MAX_SIZE = 1000;
/** 最小块：太短的块没有检索价值，直接并到相邻块。 */
const MIN_SIZE = 200;
/** 相邻块的重叠字数。 */
const OVERLAP = 100;

/**
 * 规范化正文：去掉零宽字符、多余空行、统一的换行。
 *
 * 不规范化的话，作者敲一下保存就会让整章哈希变化，白白重建一遍索引。
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .replace(/[-‍﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 把 blocks 拆成"不可再分的段落单元"。
 *
 * 每个单元带上类型，供切块时判断边界：
 *  - scene_break：硬边界，一块到此为止
 *  - dialogue：整句不可拆
 *
 * @param {Array} blocks
 * @returns {Array<{text: string, type: string, hard: boolean}>}
 */
function toUnits(blocks) {
  const units = [];
  for (const block of blocks || []) {
    if (!block) continue;
    const content = typeof block.content === 'string' ? block.content.trim() : '';
    if (!content) continue;

    if (block.type === 'scene_break') {
      units.push({ text: '', type: 'scene_break', hard: true });
      continue;
    }

    const speaker = block.type === 'dialogue' && block.speaker ? `${block.speaker}：` : '';
    units.push({
      text: `${speaker}${content}`,
      type: block.type || 'paragraph',
      hard: false,
    });
  }
  return units;
}

/**
 * 把纯文本拆成段落单元（按空行或单换行）。
 *
 * @param {string} text
 * @returns {Array<{text: string, type: string, hard: boolean}>}
 */
function textToUnits(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  return normalized
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => ({ text: line, type: 'paragraph', hard: false }));
}

/**
 * 把一个超长段落切开。
 *
 * 只有当单个段落本身就超过上限时才用——优先在句号处断，
 * 实在没有句号才按字数硬切。
 *
 * @param {string} text
 * @param {number} maxSize
 * @returns {string[]}
 */
function splitLongParagraph(text, maxSize) {
  if (text.length <= maxSize) return [text];

  const sentences = text.match(/[^。！？!?；;…\n]+[。！？!?；;…\n]*/g) || [text];
  const pieces = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > maxSize) {
      pieces.push(buffer);
      buffer = '';
    }
    if (sentence.length > maxSize) {
      // 一个句子就超长：按字数硬切
      for (let i = 0; i < sentence.length; i += maxSize) {
        pieces.push(sentence.slice(i, i + maxSize));
      }
      continue;
    }
    buffer += sentence;
  }
  if (buffer) pieces.push(buffer);
  return pieces;
}

/**
 * 切块主流程。
 *
 * 切点只落在段落边界上，绝不把一句话劈成两半。
 * 重叠也在单元级别做：新块开头带上上一块末尾的几个单元，
 * 这样"这句话的前因"在下一块里也能被检索到，
 * 而且块大小始终可控（不会因为叠加重叠而突破上限）。
 *
 * @param {Array<{text: string, type: string, hard: boolean}>} units
 * @param {object} [options]
 * @param {number} [options.targetSize]
 * @param {number} [options.maxSize]
 * @param {number} [options.minSize]
 * @param {number} [options.overlap]
 * @returns {string[]}
 */
function chunkUnits(units, options = {}) {
  const targetSize = options.targetSize ?? TARGET_SIZE;
  const maxSize = options.maxSize ?? MAX_SIZE;
  const minSize = options.minSize ?? MIN_SIZE;
  const overlap = options.overlap ?? OVERLAP;

  const chunks = [];
  // 当前块里的单元（文本已按需切碎）
  let current = [];
  let currentLength = 0;
  // 场景分组号。场景分隔会 +1，用来防止跨场景合并。
  let group = 0;

  /**
   * 把当前缓冲区收成一块并清空。
   * @param {boolean} carryOverlap 是否把尾部单元带到下一块
   */
  const flush = (carryOverlap) => {
    if (!current.length) return;

    // 缓冲区里只有重叠内容时不成块。
    //
    // 重叠是从上一块尾部带过来的，内容已经在上一块里了——
    // 单独成块就是一块纯重复的碎片。实测它会顶掉该来源唯一的名额，
    // 把真正有内容的整块正文挤出去。
    const hasFresh = current.some((item) => !item.carried);
    if (hasFresh) {
      const text = current.map((item) => item.text).join('\n').trim();
      if (text) chunks.push({ text, group });
    }

    // 下一个块的开头带上本块末尾的几个单元（总长不超过 overlap）。
    // 场景分隔（hard）之后不带走——跨场景的重叠没有意义。
    const next = [];
    if (carryOverlap && overlap > 0) {
      let tail = 0;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        const size = current[i].text.length;
        if (tail + size > overlap) {
          // 最后一个单元本身就超过重叠预算：只带走它的尾巴。
          // 重叠本来就是片段，不必守住"整段"的规矩。
          if (i === current.length - 1 && size > overlap) {
            next.unshift({
              text: current[i].text.slice(-overlap),
              type: current[i].type,
              hard: false,
              carried: true,
            });
          }
          break;
        }
        tail += size;
        // 标记为「重叠带过来的」：它已经出现在上一块里，
        // 单独成块时不能被当成新内容。
        next.unshift({ ...current[i], carried: true });
      }
    }

    current = next;
    currentLength = next.reduce((sum, item) => sum + item.text.length + 1, 0);
  };

  /** 追加一个单元，必要时先收块。 */
  const push = (item) => {
    if (current.length && currentLength + item.text.length > maxSize) {
      flush(true);
    }
    current.push(item);
    currentLength += item.text.length + 1;
    if (currentLength >= targetSize) {
      flush(true);
    }
  };

  for (const unit of units) {
    if (unit.hard) {
      // 场景分隔：硬边界，收块且不带重叠
      flush(false);
      group += 1;
      continue;
    }

    if (unit.text.length > maxSize) {
      // 段落本身超长：先切开，再逐片处理
      for (const piece of splitLongParagraph(unit.text, maxSize)) {
        push({ text: piece, type: unit.type, hard: false });
      }
      continue;
    }

    push(unit);
  }

  flush(false);

  return mergeShortChunks(chunks, minSize, maxSize).map((item) => item.text);
}

/**
 * 把太短的块并到相邻块里。
 *
 * 碎片没有检索价值：单独建向量既费 embedding，召回时也没多少信息量。
 * 但不能跨场景分隔合并——那是两个场景，混在一起语义就乱了。
 *
 * @param {Array<{text: string, group: number}>} chunks
 * @param {number} minSize
 * @param {number} maxSize
 * @returns {Array<{text: string, group: number}>}
 */
function mergeShortChunks(chunks, minSize, maxSize) {
  const merged = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.group === chunk.group &&
      last.text.length < minSize &&
      last.text.length + chunk.text.length + 1 <= maxSize
    ) {
      merged[merged.length - 1] = { text: `${last.text}\n${chunk.text}`, group: chunk.group };
      continue;
    }
    merged.push(chunk);
  }
  return merged;
}

/**
 * 切章节正文。
 *
 * @param {Array} blocks 章节的 blocks 结构
 * @param {object} [options]
 * @returns {string[]}
 */
function chunkChapterBlocks(blocks, options = {}) {
  return chunkUnits(toUnits(blocks), options);
}

/**
 * 切纯文本（人物卡、设定卡渲染后的文本、对话消息）。
 *
 * @param {string} text
 * @param {object} [options]
 * @returns {string[]}
 */
function chunkText(text, options = {}) {
  return chunkUnits(textToUnits(text), options);
}

/**
 * 算内容哈希。用来判断"这块变了没有"。
 *
 * @param {string} content
 * @returns {string}
 */
function hashContent(content) {
  return require('crypto')
    .createHash('sha256')
    .update(String(content || ''), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

module.exports = {
  TARGET_SIZE,
  MAX_SIZE,
  MIN_SIZE,
  OVERLAP,
  normalizeText,
  toUnits,
  textToUnits,
  splitLongParagraph,
  chunkUnits,
  chunkChapterBlocks,
  chunkText,
  hashContent,
};
