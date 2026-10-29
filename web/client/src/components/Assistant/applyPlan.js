/**
 * AI 结构化输出落到正文的规则。
 *
 * 抽成纯函数有两个理由：
 *   1. 规则本身比调用点复杂——target 可能是块 ID，也可能是原文片段，
 *      还得区分"章节有没有正文"——写在组件里既改不动也测不了。
 *   2. 这套规则错了，作者看到的现象是"AI 写的内容进不去"或"写到了别的段落"，
 *      手点很难覆盖住每种组合，单测能兜住。
 *
 * 落笔方式只有四种：
 *   replace —— 覆盖某个块的正文
 *   append  —— 接到某个块的正文后面
 *   insert  —— 插一个新段落块
 *   error   —— 落不进去，给作者一句能照着做的话
 */

/** 能被追加文字的块类型。分场/插图/设定引用不该被写进散文。 */
const PROSE_TYPES = new Set(['paragraph', 'dialogue', 'inner']);

/**
 * 短片段的歧义阈值。
 *
 * 短于这个长度的片段（比如"雨"）在章节里往往能匹配上一堆段，
 * 命中谁全靠运气，反而比不匹配更糟。
 * 但短片段只在一处出现时是明确的，这时照样认——
 * 所以真正起作用的不是长度本身，而是"命中几处"。
 */
const MIN_SNIPPET_LEN = 6;

/**
 * 空白归一化。
 *
 * 模型给的原文片段可能带着换行、全角空格、首尾空白，
 * 直接拿去和块内容比会明明是同一段却匹配不上。
 */
export function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * 归一化，同时记住每个字符对应原文的哪个位置。
 *
 * 有了这个映射，才能在空白被压掉之后还知道该切原文的哪一刀。
 */
function normalizeWithMap(text) {
  const source = text || '';
  let out = '';
  const map = [];
  let pendingSpace = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      map.push(i);
      pendingSpace = false;
    }
    out += ch;
    map.push(i);
  }

  return { text: out, map };
}

/**
 * 在原文里定位片段的位置。
 *
 * 先按原样找（最准），找不到再按空白归一化后找。
 *
 * @returns {{start:number, end:number}|null}
 */
function locateSnippet(haystack, needle) {
  if (!haystack || !needle) return null;

  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    return { start: direct, end: direct + needle.length };
  }

  const norm = normalizeWithMap(haystack);
  const target = normalizeText(needle);
  if (!target) return null;

  const pos = norm.text.indexOf(target);
  if (pos < 0) return null;

  const start = norm.map[pos];
  const last = norm.map[pos + target.length - 1];
  return { start, end: last + 1 };
}

/**
 * 块是不是能写散文进去。
 *
 * 老数据可能没有 type，按正文处理。
 */
function isProseBlock(block) {
  if (!block) return false;
  const type = block.type || 'paragraph';
  return PROSE_TYPES.has(type);
}

/**
 * 找出 target 指向哪个块。
 *
 * target 有两种可能，角色提示词里写的是"被操作内容的标识或原文片段"：
 *   1. 块 ID —— 上下文里的段落索引给的就是它
 *   2. 原文片段 —— 模型自己复述了一遍要改的那段
 *
 * 两种都要认。模型给原文片段时如果只按 ID 找，作者就会看到
 * "AI 给出的 target 与当前正文不匹配"，内容白生成。
 *
 * @param {Array} blocks 当前章节的块
 * @param {string} target AI 给的 target
 * @returns {number} 命中下标，-1 表示没命中
 */
export function resolveTargetIndex(blocks, target) {
  const list = Array.isArray(blocks) ? blocks : [];
  const raw = (target || '').trim();
  if (!raw) return -1;

  // 1. 块 ID 精确匹配
  const byId = list.findIndex((b) => b && b.id === raw);
  if (byId >= 0) return byId;

  // 2. target 里嵌着块 ID —— 模型常把索引里的 "[块ID] 预览" 整段抄回来
  const byIdInText = list.findIndex((b) => b && b.id && raw.includes(b.id));
  if (byIdInText >= 0) return byIdInText;

  // 3. 原文片段匹配
  const needle = normalizeText(raw);
  if (!needle) return -1;

  let bestIndex = -1;
  let bestRank = 0;
  let bestLength = 0;
  let hitCount = 0;

  list.forEach((block, index) => {
    const content = normalizeText(block && block.content);
    if (!content) return;

    let rank = 0;
    if (content === needle) rank = 4;
    else if (content.startsWith(needle)) rank = 3;
    else if (content.includes(needle)) rank = 2;
    else if (needle.includes(content)) rank = 1;

    if (rank === 0) return;

    hitCount += 1;

    // 同等匹配度下取内容更长的那个：更具体的段落才是模型指着的那段
    if (rank > bestRank || (rank === bestRank && content.length > bestLength)) {
      bestIndex = index;
      bestRank = rank;
      bestLength = content.length;
    }
  });

  if (bestIndex < 0) return -1;

  // 太短的片段只在唯一命中时才认。
  //
  // "雨"这种片段在章节里能匹配上一堆段，命中谁全靠运气，
  // 反而比不匹配更糟。而"雨落下来"这种片段只在一段里出现时，
  // 认它就是对的，不该因为短就放过。
  if (needle.length < MIN_SNIPPET_LEN && hitCount > 1) return -1;

  return bestIndex;
}

/**
 * 把新内容接到原文后面。
 *
 * 续写是接在同一段里的，但两段文字之间要有换行，
 * 否则"他抬头看天"接上"远处传来钟声"会挤成一句。
 */
export function joinAppend(existing, addition) {
  const add = addition || '';
  if (!existing || !existing.trim()) return add;
  if (!add) return existing;
  if (/\n$/.test(existing) || /^\n/.test(add)) return existing + add;
  return `${existing}\n${add}`;
}

/**
 * 算出一份 AI 输出该怎么写进正文。
 *
 * @param {Array}  blocks  当前章节的块
 * @param {string} action  replace | append | insert
 * @param {string} target  AI 给的 target（块 ID 或原文片段）
 * @param {string} content AI 给的正文
 * @returns {Object} {kind:'replace'|'append'|'insert'|'error', ...}
 */
export function planApply(blocks, action, target, content) {
  const list = Array.isArray(blocks) ? blocks : [];
  const text = content || '';

  // 正文是空的就没法写：作者点了"应用"却什么都没发生，
  // 只会以为按钮坏了。直接告诉他。
  if (!text.trim()) {
    return { kind: 'error', message: '这次没有返回内容，无法写入正文' };
  }

  const index = resolveTargetIndex(list, target);

  // 最后一个有正文的块，以及第一个空着的正文块
  let lastProse = -1;
  let emptyParagraph = -1;
  list.forEach((block, i) => {
    if (!isProseBlock(block)) return;
    if (block.content && block.content.trim()) lastProse = i;
    else if (emptyParagraph < 0 && (block.type || 'paragraph') === 'paragraph') {
      emptyParagraph = i;
    }
  });

  const hasBody = lastProse >= 0;

  if (action === 'replace') {
    if (index >= 0) {
      const block = list[index];
      const spot = locateSnippet(block.content, (target || '').trim());
      const coversWhole = spot && spot.start === 0 && spot.end === block.content.length;

      // AI 给的新内容接近整段长度 → 它写的是整段的改写版，整段换掉。
      //
      // 为什么要看长度而不是只看 target 覆盖范围：
      // 段落索引里给模型的是"块ID + 前 30 字预览"，模型照抄这行时
      // target 只是个片段，但它交回来的正文是整段改写。
      // 这时候按片段去替换，会把作者后半段原文冲掉。
      const isFullRewrite = text.length >= block.content.length * 0.6;
      const wholeBlock = coversWhole || !spot || isFullRewrite;

      return {
        kind: 'replace',
        blockId: block.id,
        text: wholeBlock
          ? text
          : block.content.slice(0, spot.start) + text + block.content.slice(spot.end),
      };
    }
    // 找不到原段落，但整章还没有正文：本来也无处可改，
    // 这份内容就是作者要的第一段。
    if (!hasBody) {
      return { kind: 'insert', index: emptyParagraph >= 0 ? emptyParagraph : list.length, text };
    }
    return {
      kind: 'error',
      message: '找不到要替换的段落，AI 给出的 target 与当前正文不匹配',
    };
  }

  if (action === 'append') {
    // 目标明确就接到它后面
    if (index >= 0 && isProseBlock(list[index])) {
      return {
        kind: 'append',
        blockId: list[index].id,
        text: joinAppend(list[index].content, text),
      };
    }
    // 目标是个分场/插图这类块，或者没给目标：接到最后一段正文后面
    if (hasBody) {
      return {
        kind: 'append',
        blockId: list[lastProse].id,
        text: joinAppend(list[lastProse].content, text),
      };
    }
    // 整章还没有正文：把 AI 写的内容作为本章第一段。
    // 这是最常见的一种——新建章节后让写手起一段，
    // 旧逻辑到这里只会甩一句"当前章节还没有正文"，内容根本落不下去。
    if (emptyParagraph >= 0) {
      return {
        kind: 'append',
        blockId: list[emptyParagraph].id,
        text: joinAppend(list[emptyParagraph].content, text),
      };
    }
    return { kind: 'insert', index: list.length, text };
  }

  if (action === 'insert') {
    const at = index >= 0 ? index + 1 : list.length;
    return { kind: 'insert', index: at, text };
  }

  return { kind: 'error', message: '这条回复没有可写入正文的改动' };
}
