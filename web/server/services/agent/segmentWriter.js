'use strict';

/**
 * 分段起稿。
 *
 * 一章不再一次写完：按节拍切成 2–4 拍一组，每组一次调用，写完拼进同一份正文。
 * 这样做的原因很实际——模型在单次调用里写到两三千字就会自己收尾，
 * 预算加到一万也推不动它；只有把「这一章」拆成几次「这一组」，
 * 每次都有明确的段数目标，才到得了 5000 字量级的基线。
 *
 * 这里只放纯编排：分组、指令、拼接、收尾检查、调用上限。
 * 真正发请求由 routes/ai.js 注入，测试可以拿假 runSegment 跑完整流程。
 */

const { countWords } = require('../wordCount');
const { briefWriterBlock } = require('./planBrief');

/** 每组最多写的节拍数（设计上允许 2–4，取 3 让 8 拍的章也有 3 次推进） */
const MAX_BEATS_PER_GROUP = 3;

/**
 * 全章目标字数与每段目标。
 *
 * 全章只保留一个软体量：约 5000 字（4800–5600 都算长章量级）。
 * 段落长度不设锚点，随叙事节奏长短交替；组目标只是"这一组大概写多少"，
 * 不再反推每段均值——那个锚点会把模型一路带往上限。
 * 注意 countWords 含标点，字数口径必须写明「含标点」。
 */
const TARGET_CHAPTER_CHARS = 5000;

/** 安全上限：只防跑飞（7000 以上），正常写作不会触发截断。 */
const MAX_CHAPTER_CHARS = 7000;

/** 总调用上限：3 组起稿 + 3 次续写 + 2 次分组重写，留一点余量 */
const MAX_SEGMENT_CALLS = 8;

/** 一组写到目标的这个比例以下，就认为提前收尾。实测 70% 会放过 72% 的短组，提到 80%。 */
const MIN_TARGET_RATIO = 0.8;

/**
 * 段落形态要求。
 *
 * 基线范文 45 段 / 5047 字，段均 112 字：靠「小场景」成段，而不是把动作、
 * 对白各拆一段。这里给出可执行的硬约束：段数按拍、段长 80–140 字、
 * 禁止连续短段、对白与动作合并、引号统一。
 */
const PARAGRAPH_SHAPE_RULES = [
  '## 全章形态（硬约束）',
  '- 全章按长章体量写，总量大致在 4800–5600 字（含标点）；不要为凑数拉长段落，也不要写到 7000 字以上。',
  '- 每拍段数按节拍表给的段数为准，允许 ±2 段；不要把一拍压成提纲，也不要把一个动作拆成好几段。',
  '- 每个自然段 80–140 字（含标点）：一段写一个小场景，段内 3–6 句，把动作、神态、对话、心理中的几样收在同一个节奏里；超过 140 字要拆，不足 80 字要与相邻同场景段合并。',
  '- 禁止连续 3 段不足 20 字；短促反应、单句对白最多连续 2 段，且前后必须有动作或叙述句承接。',
  '- 对白必须与动作/叙述合并在同一段，不得连续独立成段；只有两句以内、且前后有动作句时才允许单独成段。',
  '- 引号统一用全角 “”，禁止使用「」；关键交流必须写成直接引语：用人物原话，带说话人的动作、神态或对方的反应，不要用「他说他问我是否……」这类转述代替关键对话。',
  '- 每次对话都要推动一次变化：关系、立场、决定或信息，至少变一项；不写只为填充的寒暄。',
  '- 每一拍都要有变量变化、信息增量和代价；关键决定要写决定本身和它要付的代价。',
  '- 本组写到大致够用就停，余下内容留给后面的拍；章末只留一个钩子。',
].join('\n');

/** 下一组标志事件的最短匹配长度；太短的名词容易误伤。 */
const BOUNDARY_MIN_MARKER_LENGTH = 6;

/** 整段去重时只处理够长的段落，避免把「陈默没动。」这种有意重复也删掉。 */
const MIN_DEDUPE_PARAGRAPH_CHARS = 12;

/**
 * 续写第一段与已有段落的重合阈值。
 *
 * 续写是从「上一段末尾」往下写的，第一段如果和已有某段高度相似，说明模型
 * 在复述而不是接续；这时整段续写直接丢弃，不再靠后续去重补救。
 */
const RESTATEMENT_SIMILARITY = 0.8;

/** 场景内合并的上限：合并后含标点不超过这个字数。 */
const MERGE_MAX_PARAGRAPH_CHARS = 120;

/** 含直接引语的段落一律不参与合并。 */
const DIRECT_QUOTE_RE = /[「」“”"]/;

/** 段落形态硬约束。字数含标点，与 wordCount 口径一致。 */
const SHAPE_PARAGRAPH_MIN = 80;
const SHAPE_PARAGRAPH_MAX = 140;
const SHAPE_FRAGMENT_MIN = 20;
const SHAPE_BEAT_TOLERANCE = 2;
const SHAPE_SHORT_RUN = 3;

/** 只用于检出，不做替换：作者交稿后由写手改，不静默改作者文字。 */
const CORNER_QUOTE_RE = /[「」]/;
const DIALOGUE_ONLY_RE = /^[“"][^”"]*[”"][。！？!?…]?$/;

/**
 * 场景切换的保守识别：只认开头的时间/地点提示语。
 *
 * 认错方向的代价不对称——漏判最多少合并一处，误判会把两个场景粘在一起。
 * 所以这里只收明确的转场词，不做语义猜测。
 */
const SCENE_SHIFT_RE =
  /^(?:第二天|次日|翌日|隔天|当晚|当天晚上|当天夜里|夜里|半夜|凌晨|清晨|早晨|早上|上午|中午|午后|下午|傍晚|天黑|入夜|半小时后|一小时后|两小时后|几个小时后|几分钟后|过了一会儿|与此同时|同一时间|另一边|镜头一转|回到)/;

/** 中间组禁止的收尾语气。命中就当作提前收尾，续写一次并清掉尾句。 */
const CLOSING_RE = /就这样|从此以后|从此|这一天(?:就)?(?:结束|过去)|日子就这样|一切归于平静/;

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tailParagraphs(text, n = 3) {
  const paragraphs = splitParagraphs(text);
  return paragraphs.slice(-n).join('\n\n');
}

function normalizedParagraph(text) {
  return String(text || '').replace(/\s+/g, '').trim();
}

function bigramCounts(normalized) {
  const counts = new Map();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) || 0) + 1);
  }
  return counts;
}

/**
 * 两段的字符重合度（按二元组、允许重复计数）。
 *
 * 用「重合二元组 / 较短一段的二元组总数」而不是整段是否相等，
 * 这样改几个字、换标点的复述也能被抓住。
 */
function paragraphSimilarity(a, b) {
  const left = normalizedParagraph(a);
  const right = normalizedParagraph(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;

  const leftCounts = bigramCounts(left);
  const rightCounts = bigramCounts(right);
  let shared = 0;
  for (const [gram, count] of leftCounts) {
    const other = rightCounts.get(gram) || 0;
    if (other) shared += Math.min(count, other);
  }
  return shared / Math.min(left.length - 1, right.length - 1);
}

/** 续写返回的第一段是不是在复述已有段落。 */
function isRestatement(addedText, existingText) {
  const first = splitParagraphs(addedText)[0] || '';
  if (normalizedParagraph(first).length < MIN_DEDUPE_PARAGRAPH_CHARS) return false;
  return splitParagraphs(existingText).some((paragraph) => {
    if (normalizedParagraph(paragraph).length < MIN_DEDUPE_PARAGRAPH_CHARS) return false;
    return paragraphSimilarity(first, paragraph) >= RESTATEMENT_SIMILARITY;
  });
}

/**
 * 续写锚点：只给最后一个完整场景的最后一段；这段太长时取最后两三句。
 *
 * 续写调用只看这一小段，不看整组正文，避免模型顺着已写内容重讲一遍。
 */
function continuationAnchor(text) {
  const last = splitParagraphs(text).pop() || '';
  if (!last) return '';
  if (countWords(last) <= MERGE_MAX_PARAGRAPH_CHARS) return last;

  const sentences = last.split(/(?<=[。！？!?])/).filter(Boolean);
  return sentences.slice(-2).join('').trim() || last;
}

/**
 * 从节拍字段里提炼下一组的「标志事件」。
 *
 * 只取够长的完整短语，不做分词：短名词（「照片」「庙祝」）可能是本组也要用的，
 * 拿它们做边界会把正常内容误截掉。
 */
function beatMarkers(beat) {
  const markers = new Set();
  for (const field of ['endHook', 'infoGain', 'goal', 'obstacle', 'cost']) {
    const value = String(beat?.[field] || '').trim();
    if (!value) continue;
    if (value.length >= BOUNDARY_MIN_MARKER_LENGTH) markers.add(value);
    for (const piece of value.split(/[，。；：、,.;:!?！？\s]+/)) {
      const trimmed = piece.trim();
      if (trimmed.length >= BOUNDARY_MIN_MARKER_LENGTH) markers.add(trimmed);
    }
  }
  const to = String(beat?.delta?.to || '').trim();
  if (to.length >= BOUNDARY_MIN_MARKER_LENGTH) markers.add(to);
  return [...markers];
}

/** 下一组标志事件在本组正文里第一次出现的位置。 */
function findBoundaryHit(content, group, next) {
  const ownMarkers = new Set(group.beats.flatMap(beatMarkers));
  let hit = null;
  for (const beat of next.beats) {
    for (const marker of beatMarkers(beat)) {
      if (ownMarkers.has(marker)) continue;
      const index = content.indexOf(marker);
      if (index >= 0 && (!hit || index < hit.index)) {
        hit = { index, marker, beatId: beat.id };
      }
    }
  }
  return hit;
}

function paragraphIndexAt(text, charIndex) {
  const paragraphs = splitParagraphs(text);
  let from = 0;
  for (let i = 0; i < paragraphs.length; i += 1) {
    const start = text.indexOf(paragraphs[i], from);
    if (start < 0) continue;
    const end = start + paragraphs[i].length;
    if (charIndex >= start && charIndex < end) return i;
    from = end;
  }
  return -1;
}

/**
 * 组边界的代码侧硬约束：本组正文一旦写到下一组的标志事件，就在标志事件前截断。
 *
 * 提示词里也会写边界，但模型经常为了写顺把下一组的内容提前写掉；只靠提示词
 * 不可靠。这里按完整段落回退，截断后缺的拍交给覆盖自检去重写。
 */
function enforceGroupBoundary({ content, group, groups }) {
  const text = String(content || '').trim();
  const untouched = {
    content: text,
    boundaryTrimmed: false,
    boundaryConflict: false,
    boundaryMarker: '',
    boundaryBeatId: '',
    boundaryDroppedChars: 0,
  };
  if (!text) return untouched;

  const next = groups.find((g) => g.index === group.index + 1);
  if (!next) return untouched;

  const hit = findBoundaryHit(text, group, next);
  if (!hit) return untouched;

  const paragraphs = splitParagraphs(text);
  const index = paragraphIndexAt(text, hit.index);
  if (index > 0) {
    const kept = paragraphs.slice(0, index).join('\n\n');
    return {
      content: kept,
      boundaryTrimmed: true,
      boundaryConflict: false,
      boundaryMarker: hit.marker,
      boundaryBeatId: hit.beatId,
      boundaryDroppedChars: countWords(text) - countWords(kept),
    };
  }

  // 标志事件落在第一段：保留它前面已经写完整的句子；一句都不剩才算冲突。
  const before = text.slice(0, hit.index);
  const cut = Math.max(
    before.lastIndexOf('。'),
    before.lastIndexOf('！'),
    before.lastIndexOf('？'),
    before.lastIndexOf('”'),
    before.lastIndexOf('」')
  );
  const kept = cut >= 0 ? before.slice(0, cut + 1).trim() : '';
  if (kept) {
    return {
      content: kept,
      boundaryTrimmed: true,
      boundaryConflict: false,
      boundaryMarker: hit.marker,
      boundaryBeatId: hit.beatId,
      boundaryDroppedChars: countWords(text) - countWords(kept),
    };
  }

  return {
    ...untouched,
    boundaryConflict: true,
    boundaryMarker: hit.marker,
    boundaryBeatId: hit.beatId,
  };
}

/**
 * 按节拍分组。组数取 ceil(n/3)，余数分给前面的组，
 * 保证每组 2–4 拍（n≥4 时；n<4 时只有一组）。
 */
function planSegments(plan) {
  const beats = Array.isArray(plan?.beats) ? plan.beats : [];
  if (!beats.length) return [];

  const groupCount = Math.max(1, Math.ceil(beats.length / MAX_BEATS_PER_GROUP));
  const base = Math.floor(beats.length / groupCount);
  const remainder = beats.length % groupCount;

  const plannedParagraphs = beats.reduce(
    (sum, beat) => sum + (Number(beat.paragraphs) || 0),
    0
  );
  // 组目标只按"这一组占全章计划段数的比例"分预算，不再反推每段均值。
  const charsPerPlannedParagraph = TARGET_CHAPTER_CHARS / Math.max(1, plannedParagraphs);

  const groups = [];
  let cursor = 0;
  for (let i = 0; i < groupCount; i += 1) {
    const size = base + (i < remainder ? 1 : 0);
    const slice = beats.slice(cursor, cursor + size);
    cursor += size;
    const targetParagraphs = slice.reduce((sum, beat) => sum + (Number(beat.paragraphs) || 0), 0);
    groups.push({
      index: i,
      isLast: i === groupCount - 1,
      beats: slice,
      beatIds: slice.map((b) => b.id),
      targetParagraphs,
      targetChars: Math.round(targetParagraphs * charsPerPlannedParagraph),
      content: '',
      called: false,
      continued: false,
    });
  }
  return groups;
}

function beatSummary(beats) {
  return beats
    .map(
      (b) =>
        `${b.id}【${b.type}】目标：${b.goal}；阻碍：${b.obstacle}；代价：${b.cost}；` +
        `变量：${b.delta.variable}从「${b.delta.from}」到「${b.delta.to}」；` +
        `本拍写 ${b.paragraphs}±2 段、占全章约 ${b.wordShare ?? '未定'}%；` +
        `收在小钩子：${b.endHook}`
    )
    .join('\n');
}

/** 把下一组的标志事件写进指令，明确本组只能写到哪里。 */
function buildBoundaryBlock({ group, groups }) {
  const next = groups.find((g) => g.index === group.index + 1);
  if (!next) return '';

  const lastBeat = group.beats[group.beats.length - 1];
  const firstBeat = next.beats[0];
  const forbidden = [firstBeat.endHook, firstBeat.infoGain]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return [
    '## 本组硬边界',
    `- 本组最后一拍收在：${lastBeat.endHook}`,
    `- 下一组第一拍是：${firstBeat.goal}；它的标志事件是：${firstBeat.endHook}。`,
    forbidden.length
      ? `- 以下内容属于下一组，本组正文里不得出现：${forbidden.join('；')}。`
      : '',
    '- 写完本组最后一拍的收束动作就停，不要为了写顺把下一组的内容提前写掉。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 从上一个场景的最后一个动作接续，禁止复述已经写完的内容。 */
function buildHandoffRules({ from = '上一组' } = {}) {
  return [
    '## 接续硬要求',
    '- 不得复述已完成内容：不要重讲刚才的报告、对话或人物背景，不要用总结句回顾。',
    `- 开头第一句必须接着${from}最后一个完整场景的最后一个动作往下写；不要从「回忆」「找灵感」「重新交代」的角度重开。`,
  ].join('\n');
}

/**
 * 交稿前自检清单。
 *
 * 只核对编排与可读性，不再核对段均、段数、对白占比这类门槛——
 * 那些数字只作为事后诊断，写的时候不追指标。
 */
function buildSelfCheck(group) {
  const softMin = Math.round(group.targetChars * 0.9);
  const softMax = Math.round(group.targetChars * 1.1);
  return [
    '## 交稿前自检（对照这几条，不合格就改）',
    `- 本组总量大致在 ${softMin}–${softMax} 字（含标点）就够了，不要为凑字数拉长段落。`,
    '- 每一拍都要有变量变化、信息增量和代价；关键决定要写决定本身和它的代价。',
    `- 段数按本组各拍计划（±2 段）；每段 80–140 字（含标点），不要连续 3 段不足 20 字。`,
    '- 对白与动作/叙述合并在同一段，不得连续独立成段；引号统一用全角 “”，禁止使用「」。',
    '- 关键交流用带引号的直接引语，有说话人的动作或神态承接；不要转述成「他说他问我是否」。',
    '- 每次对话都要推动一次变化，不写只为填充的寒暄。',
    group.isLast
      ? '- 只在最后一段留一个章末钩子，不要展开后续情节。'
      : '- 不准出现收尾语气，不准埋章末钩子。',
  ].join('\n');
}

/**
 * 交付只发生一次的硬约束。
 *
 * 不写抽象句：直接给拍号。包含该拍的组负责交付一次，其他组只保留预备动作。
 */
function handoverOnceRule(brief, group) {
  const beat = brief && typeof brief.handoverBeat === 'string' ? brief.handoverBeat.trim() : '';
  if (!beat) return '';
  const contains = Boolean(group && (group.beatIds || []).includes(beat));
  if (contains) {
    return `本章交付只发生一次，就落在本组的 ${beat} 拍；本组其他拍和后面各组不得重复托付话或重复交割，最多保留递、接、握住手这类预备动作。`;
  }
  return `本章交付只发生一次，已在第 ${beat} 拍完成；本组不要重复托付或重复交割，最多保留递、接、握住手这类预备动作。`;
}

/**
 * 某一组的起稿指令。
 *
 * 完整节拍表已经在 system 里（每次调用都会带上），所以这里不再重贴 JSON，
 * 只标清楚「本组写哪几拍、哪些已写完、哪些还没到」。
 */
function buildSegmentInstruction({ plan, group, groups, tail = '', brief = null }) {
  const completed = groups
    .filter((g) => g.index < group.index)
    .flatMap((g) => g.beatIds);
  const later = groups
    .filter((g) => g.index > group.index)
    .flatMap((g) => g.beatIds);
  const briefBlock = briefWriterBlock(brief);

  const lines = [
    `## 分段写作任务（第 ${group.index + 1}/${groups.length} 组）`,
    `完整节拍表见 system 中的「本章节拍表」，全章共 ${plan.beats.length} 拍。`,
    `本组只写这几拍：${group.beatIds.join('、')}（${group.beats.map((b) => b.type).join('、')}）。`,
    completed.length
      ? `已经写完：${completed.join('、')}。不要重复它们，也不要用一句话概括它们。`
      : '这是本章的第一组，还没有已写正文。',
    later.length ? `后面才写：${later.join('、')}。不要提前写，更不要把全章收束在这里。` : '',
    '',
    buildBoundaryBlock({ group, groups }),
    '',
    completed.length ? buildHandoffRules({ from: '上一组' }) : '',
    '',
    '## 本组篇幅（硬约束）',
    `本组大致写 ${group.targetChars} 字（含标点）：按各拍计划段数（±2 段）落段，每段 80–140 字（含标点），不要连续 3 段不足 20 字，也不要为凑字数拉长段落。写到大致够用就停；全章大致 4800–5600 字即可，7000 字以上会被截断。`,
    '',
    PARAGRAPH_SHAPE_RULES,
    '',
    briefBlock,
    briefBlock ? '' : null,
    handoverOnceRule(brief, group),
    handoverOnceRule(brief, group) ? '' : null,
    '## 本组节拍',
    beatSummary(group.beats),
    '',
    '## 已写正文结尾（仅供衔接，不要重抄）',
    tail || '（暂无已写正文，这是本章开头）',
    '',
    '## 硬指令',
    '只写本组这几拍，不要提前收尾，不要总结，不要重复前文，不要埋全章钩子。',
  ];

  if (group.isLast) {
    lines.push(
      `这是最后一组：可以收束本章，并把唯一一个章末钩子放在全章最后一段（对应：${plan.hook}）。钩子只能出现在最后，不能提前。`
    );
  } else {
    lines.push(
      '本章尚未结束：禁止出现「就这样」「从此」「这一天结束了」等收尾语气；本组最后一拍结束在一个未解的动作或小问题上，让下一组接得住。'
    );
  }

  lines.push(
    '',
    buildSelfCheck(group),
    '',
    '输出仍按写手契约的 JSON：action 固定为 "append"，content 只放本组正文，reason 用一句话说明本组写了什么。'
  );
  return lines.join('\n');
}

/** 续写上下文隔离：本次只给锚点，不给整组正文，避免模型顺着已写内容重讲。 */
function buildContinuationIsolation() {
  return [
    '## 续写上下文（只给这一段锚点）',
    '- 本次调用只提供下面这一段，作为上一个场景的最后一段；本组其他已写正文不提供。',
    '- 不要凭记忆复述、重讲或概括之前写过的报告、对话和场景，也不要重新交代人物和背景。',
    '- 第一句必须从锚点最后一个动作的下一步开始，直接往下推进。',
  ].join('\n');
}

/**
 * 续写指令。
 *
 * 只带最后一个完整场景的最后一段（太长则最后两三句），不带整组正文；
 * 「不能复述」也由调用后的相似度断言兜底，不指望模型自觉。
 */
function buildContinuationInstruction({ plan, group, groups, tail, remainingChars, brief = null }) {
  const written = countWords(group.content);
  const briefBlock = briefWriterBlock(brief);
  const lines = [
    `## 续写本组（第 ${group.index + 1}/${groups.length} 组）`,
    '本组提前收尾了，但还没写够。接着写，不要重开。',
    `仍然只写 ${group.beatIds.join('、')} 这几拍，不要提前写后面的节拍。`,
    '',
    buildContinuationIsolation(),
    '',
    buildHandoffRules({ from: '上一段的最后一个动作' }),
    '',
    buildBoundaryBlock({ group, groups }),
    '',
    '## 锚点：上一个场景的最后一段（只给这一段，其他正文不提供）',
    tail || '（暂无）',
    '',
    '## 还差多少',
    `本组目标约 ${group.targetChars} 字（含标点），已经写了 ${written} 字，再补约 ${remainingChars} 字就够；按各拍计划段数（±2 段）落段，每段 80–140 字（含标点），不要连续 3 段不足 20 字。补到目标就停，不要为凑数拉长段落，也不要继续往下写。`,
    '',
    PARAGRAPH_SHAPE_RULES,
    '',
    briefBlock,
    briefBlock ? '' : null,
    handoverOnceRule(brief, group),
    handoverOnceRule(brief, group) ? '' : null,
  ];

  if (group.isLast) {
    lines.push(
      `续写到能收束本章为止，并把唯一一个章末钩子放在续写末尾（对应：${plan.hook}）。`
    );
  } else {
    lines.push(
      '不要出现「就这样」「从此」「这一天结束了」这类收尾语气，也不要在续写末尾埋全章钩子。'
    );
  }

  lines.push('', buildSelfCheck(group), '', '输出 JSON：action 固定为 "append"，content 只放续写的正文。');
  return lines.join('\n');
}

/** 分组重写指令：只重写这一组，不整章重来。 */
function buildGroupRewriteInstruction({
  plan,
  group,
  groups,
  problemIds,
  weakIds = [],
  handoverDupIds = [],
  mustWithholdIds = [],
  invariantConflicts = [],
  shapeViolations = [],
  tail,
  nextHead,
  brief = null,
  mustReveal = [],
}) {
  const wanted = new Set(problemIds || []);
  const weak = new Set(weakIds || []);
  const dup = new Set(handoverDupIds || []);
  const withhold = new Set(mustWithholdIds || []);
  const shape = new Map();
  for (const violation of shapeViolations || []) {
    if (!violation || !violation.beatId) continue;
    const rows = shape.get(violation.beatId) || [];
    rows.push(violation);
    shape.set(violation.beatId, rows);
  }
  const conflicts = new Map();
  for (const conflict of invariantConflicts || []) {
    if (!conflict || !conflict.beatId) continue;
    const rows = conflicts.get(conflict.beatId) || [];
    rows.push(`${conflict.label}应写「${conflict.expected}」，正文写成了「${conflict.actual}」`);
    conflicts.set(conflict.beatId, rows);
  }
  const handoverBeat = brief && typeof brief.handoverBeat === 'string' ? brief.handoverBeat.trim() : '';
  const briefBlock = briefWriterBlock(brief);
  const revealLines = (mustReveal || []).map((fact) => `- ${fact}`);
  const problems = group.beats
    .filter(
      (b) =>
        wanted.has(b.id) ||
        weak.has(b.id) ||
        dup.has(b.id) ||
        withhold.has(b.id) ||
        conflicts.has(b.id) ||
        shape.has(b.id)
    )
    .map((b) => {
      if (conflicts.has(b.id)) {
        return (
          `- ${b.id}：本拍数值与全章不变项冲突（${conflicts.get(b.id).join('；')}）；` +
          '同一事实只保留一个数，改成 brief 不变项里的值，删掉其余矛盾表述。'
        );
      }
      if (withhold.has(b.id)) {
        return (
          `- ${b.id}：本拍只写形制细节与人物反应，不写制度结论，不替读者解释；` +
          '删掉所有关于私辟/传诏/符传/逾制/该不该的判断句。'
        );
      }
      if (dup.has(b.id)) {
        return (
          `- ${b.id}：本章交付只发生一次，已在第 ${handoverBeat || '指定'} 拍完成；` +
          '本拍删掉完整托付/交割和托付话，只保留递、接、握住手这类预备动作。'
        );
      }
      return (
        `- ${b.id}：必须写出目标「${b.goal}」、阻碍「${b.obstacle}」、代价「${b.cost}」，` +
        `以及「${b.delta.variable}」从「${b.delta.from}」到「${b.delta.to}」的变化，` +
        `收在「${b.endHook}」。` +
        (weak.has(b.id) ? '写到了事件但没写出变化，这一遍要把变化写实。' : '') +
        (shape.has(b.id)
          ? ` 本拍段落形态不合规（${describeShapeViolations(shape.get(b.id))}）：` +
            `按 ${b.paragraphs}±2 段落段，每段 80–140 字（含标点），合并碎片段、拆开超长段，` +
            '对白与动作合并在同一段，引号统一用全角 “”、禁止「」。'
          : '')
      );
    });

  return [
    `## 重写第 ${group.index + 1}/${groups.length} 组（${group.beatIds.join('、')}）`,
    '覆盖自检发现这一组有节拍没落地。只重写这一组，其他组保持原样，不要整章重来。',
    `完整节拍表见 system 中的「本章节拍表」，全章共 ${plan.beats.length} 拍。`,
    '',
    '## 必须补足',
    problems.length ? problems.join('\n') : '把本组几拍写完整。',
    '',
    revealLines.length
      ? `## 必须交代的背景事实（每项至少一句，写进人物对话或叙述，不得一句话带过）\n${revealLines.join('\n')}`
      : '',
    revealLines.length ? '' : null,
    briefBlock,
    briefBlock ? '' : null,
    handoverOnceRule(brief, group),
    handoverOnceRule(brief, group) ? '' : null,
    '## 上一组结尾（仅供衔接，不要重抄）',
    tail || '（本章从这里开始）',
    '',
    buildHandoffRules({ from: '上一组' }),
    '',
    '## 下一组开头（仅供衔接，不要续写、不要重抄）',
    nextHead || '（本章到此结束）',
    '',
    buildBoundaryBlock({ group, groups }),
    '',
    '## 篇幅（硬约束）',
    `本组大致写 ${group.targetChars} 字（含标点）：按各拍计划段数（±2 段）落段，每段 80–140 字（含标点），不要连续 3 段不足 20 字，也不要为凑字数拉长段落。`,
    '',
    PARAGRAPH_SHAPE_RULES,
    '',
    group.isLast
      ? '这是最后一组：可以收束本章，并把唯一一个章末钩子放在最后。'
      : '本章尚未结束：不要收尾，不要埋全章钩子。',
    '',
    buildSelfCheck(group),
    '',
    '输出 JSON：action 固定为 "append"，content 只放这一组重写后的正文。',
  ].join('\n');
}

/**
 * 去掉中间组末尾的收尾语气。
 *
 * 不整段删除，只处理最后一段：末段整句就是「就这样……」且很短就丢掉，
 * 否则把命中收尾词的那一句删掉。这样能保证中间组不以收尾语气结束。
 */
function stripClosingTail(text) {
  const paragraphs = splitParagraphs(text);
  if (!paragraphs.length) return '';

  const last = paragraphs[paragraphs.length - 1];
  if (!CLOSING_RE.test(last)) return paragraphs.join('\n\n');

  const cleaned = last
    .replace(/[^。！？!?]*?(?:就这样|从此以后|从此|这一天(?:就)?(?:结束|过去)|日子就这样|一切归于平静)[^。！？!?]*[。！？!?]?/g, '')
    .trim();

  if (cleaned) paragraphs[paragraphs.length - 1] = cleaned;
  else paragraphs.pop();

  return paragraphs.join('\n\n');
}

function hasClosingTone(text) {
  return CLOSING_RE.test(String(text || ''));
}

/**
 * 拼接两段正文，去掉新段开头对旧段结尾的重复。
 *
 * 模型被要求「衔接上一段」时经常把上一段最后一段原样重抄一遍，
 * 不处理的话最终稿会出现相邻的重复段落。按段落做最多 3 段的重叠检测。
 */
function appendFresh(existing, next) {
  const prev = String(existing || '').trim();
  const incoming = String(next || '').trim();
  if (!incoming) return prev;
  if (!prev) return incoming;

  const prevParagraphs = splitParagraphs(prev);
  const nextParagraphs = splitParagraphs(incoming);
  let overlap = 0;
  const max = Math.min(3, prevParagraphs.length, nextParagraphs.length);
  for (let k = max; k > 0; k -= 1) {
    if (prevParagraphs.slice(-k).join('\n') === nextParagraphs.slice(0, k).join('\n')) {
      overlap = k;
      break;
    }
  }

  // 除了接缝处的重复，还要挡“续写从中间整段复述”的情况：
  // 已出现过的完整段落不再拼进来；短句（「陈默没动。」）不参与，避免误删有意重复。
  const seen = new Set(
    prevParagraphs
      .map(normalizedParagraph)
      .filter((p) => p.length >= MIN_DEDUPE_PARAGRAPH_CHARS)
  );
  const fresh = [];
  for (const paragraph of nextParagraphs.slice(overlap)) {
    const normalized = normalizedParagraph(paragraph);
    if (normalized.length >= MIN_DEDUPE_PARAGRAPH_CHARS) {
      if (seen.has(normalized)) continue;
      seen.add(normalized);
    }
    fresh.push(paragraph);
  }
  if (!fresh.length) return prev;
  return `${prev}\n\n${fresh.join('\n\n')}`;
}

function stitchGroups(groups, existingBody = '') {
  return groups.reduce(
    (text, group) => (group.content ? appendFresh(text, group.content) : text),
    String(existingBody || '').trim()
  );
}

function canMergeParagraphs(previous, next, maxChars) {
  if (!previous || !next) return false;
  if (!/[。！？!?…]$/.test(previous)) return false;
  if (DIRECT_QUOTE_RE.test(previous) || DIRECT_QUOTE_RE.test(next)) return false;
  if (SCENE_SHIFT_RE.test(next)) return false;
  return countWords(previous) + countWords(next) <= maxChars;
}

/**
 * 受控的段落合并：把同一场景里相邻的无对白短段压成一个小场景。
 *
 * 只做三件事：同一场景内、相邻两段都不含直接引语、合并后不超过 maxChars。
 * 含对白的段落一律不动，场景转场一律不动；不做语义合并，也不为凑段数改阈值。
 *
 * @param {string|string[]} paragraphs
 * @param {{maxChars?: number, enabled?: boolean}} [options]
 * @returns {string[]}
 */
function mergeSceneParagraphs(paragraphs, options = {}) {
  const { maxChars = MERGE_MAX_PARAGRAPH_CHARS, enabled = true } = options;
  const rows = (Array.isArray(paragraphs) ? paragraphs : splitParagraphs(paragraphs))
    .map((paragraph) => String(paragraph || '').trim())
    .filter(Boolean);
  if (!enabled) return rows;

  const merged = [];
  for (const row of rows) {
    const previous = merged[merged.length - 1];
    if (previous && canMergeParagraphs(previous, row, maxChars)) {
      merged[merged.length - 1] = `${previous}${row}`;
      continue;
    }
    merged.push(row);
  }
  return merged;
}

/**
 * 按各拍计划段数的权重，把正文段落切成等比例的拍区间。
 *
 * 正文经过合并后段数会少于计划；这里只用于定位「这一段属于哪一拍」，
 * 不反过来修正计划段数。
 */
function beatParagraphRanges(beats, count) {
  const rows = Array.isArray(beats) ? beats : [];
  if (!rows.length || count <= 0) return [];
  const weights = rows.map((beat) => Math.max(1, Number(beat.paragraphs) || 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const ranges = [];
  let from = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const to =
      i === rows.length - 1
        ? count
        : Math.min(count, Math.max(from, from + Math.round((weights[i] / totalWeight) * count)));
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}

function sentenceCount(paragraph) {
  return String(paragraph || '')
    .split(/[。！？!?；;…]/)
    .map((row) => row.trim())
    .filter(Boolean).length;
}

function paragraphSample(paragraph, max = 24) {
  const value = normalizedParagraph(paragraph);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 写手执行层的段落形态自检。
 *
 * 只判可机械验证的四件事，不靠模型打分：
 *   1. 每拍实际段数与计划段数相差超过 2；
 *   2. 单段 20–79 字（碎片段）或超过 140 字（超长段）；
 *   3. 连续 3 段不足 20 字；
 *   4. 对白连续独立成段（两句以内且前后有动作句的例外）、引号使用「」。
 *
 * 返回的 beatId 直接用于分组重写；没有节拍表时不做判定。
 */
function checkParagraphShape(plan, body) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const paragraphs = splitParagraphs(body);
  if (!beats.length || !paragraphs.length) {
    return { applicable: false, totalParagraphs: 0, avgChars: 0, beatIds: [], violations: [] };
  }

  const ranges = beatParagraphRanges(beats, paragraphs.length);
  const lengths = paragraphs.map((paragraph) => countWords(paragraph));
  const beatIdAt = (index) => {
    const hit = ranges.findIndex(([from, to]) => index >= from && index < to);
    return hit >= 0 ? beats[hit].id : beats[beats.length - 1].id;
  };
  const violations = [];

  // 1. 每拍段数 N±2
  beats.forEach((beat, i) => {
    const [from, to] = ranges[i] || [0, 0];
    const actual = to - from;
    const expected = Number(beat.paragraphs) || 0;
    if (expected && Math.abs(actual - expected) > SHAPE_BEAT_TOLERANCE) {
      violations.push({
        beatId: beat.id,
        kind: 'count',
        expected,
        actual,
        tolerance: SHAPE_BEAT_TOLERANCE,
      });
    }
  });

  // 2. 单段长度：20–79 字算碎片段，>140 字算超长段；<20 字交给第 3 条
  lengths.forEach((chars, index) => {
    if (chars >= SHAPE_FRAGMENT_MIN && chars < SHAPE_PARAGRAPH_MIN) {
      violations.push({
        beatId: beatIdAt(index),
        kind: 'fragment',
        index,
        chars,
        sample: paragraphSample(paragraphs[index]),
      });
    } else if (chars > SHAPE_PARAGRAPH_MAX) {
      violations.push({
        beatId: beatIdAt(index),
        kind: 'too_long',
        index,
        chars,
        sample: paragraphSample(paragraphs[index]),
      });
    }
  });

  // 3. 连续 3 段不足 20 字
  let shortStart = 0;
  let shortRun = 0;
  const flushShortRun = () => {
    if (shortRun < SHAPE_SHORT_RUN) return;
    const ids = new Set();
    for (let i = shortStart; i < shortStart + shortRun; i += 1) ids.add(beatIdAt(i));
    for (const beatId of ids) {
      violations.push({
        beatId,
        kind: 'short_run',
        index: shortStart,
        run: shortRun,
        chars: lengths.slice(shortStart, shortStart + shortRun),
        sample: paragraphSample(paragraphs[shortStart]),
      });
    }
  };
  for (let i = 0; i <= lengths.length; i += 1) {
    if (i < lengths.length && lengths[i] < SHAPE_FRAGMENT_MIN) {
      if (!shortRun) shortStart = i;
      shortRun += 1;
      continue;
    }
    flushShortRun();
    shortRun = 0;
  }

  // 4. 对白连续独立成段
  const dialogueOnly = paragraphs.map((paragraph) =>
    DIALOGUE_ONLY_RE.test(normalizedParagraph(paragraph))
  );
  const pushTalkViolation = (start, length) => {
    const ids = new Set();
    for (let i = start; i < start + length; i += 1) ids.add(beatIdAt(i));
    for (const beatId of ids) {
      violations.push({
        beatId,
        kind: 'dialogue_stack',
        index: start,
        run: length,
        sample: paragraphSample(paragraphs[start]),
      });
    }
  };
  let talkStart = 0;
  let talkRun = 0;
  const flushTalkRun = (endIndex) => {
    if (talkRun >= 3) {
      pushTalkViolation(talkStart, talkRun);
    } else if (talkRun === 2) {
      const shortEnough = paragraphs
        .slice(talkStart, talkStart + 2)
        .every((paragraph) => sentenceCount(paragraph) <= 2);
      const hasActionAround =
        talkStart > 0 &&
        !dialogueOnly[talkStart - 1] &&
        endIndex < paragraphs.length &&
        !dialogueOnly[endIndex];
      if (!shortEnough || !hasActionAround) pushTalkViolation(talkStart, 2);
    }
  };
  for (let i = 0; i <= dialogueOnly.length; i += 1) {
    if (i < dialogueOnly.length && dialogueOnly[i]) {
      if (!talkRun) talkStart = i;
      talkRun += 1;
      continue;
    }
    flushTalkRun(i);
    talkRun = 0;
  }

  // 5. 引号统一为全角 “”，禁止「」
  paragraphs.forEach((paragraph, index) => {
    if (!CORNER_QUOTE_RE.test(paragraph)) return;
    violations.push({
      beatId: beatIdAt(index),
      kind: 'corner_quote',
      index,
      sample: paragraphSample(paragraph),
    });
  });

  const totalChars = lengths.reduce((sum, chars) => sum + chars, 0);
  return {
    applicable: true,
    totalParagraphs: paragraphs.length,
    avgChars: Math.round((totalChars / paragraphs.length) * 10) / 10,
    beatIds: [...new Set(violations.map((row) => row.beatId))],
    violations,
  };
}

/**
 * 把一组形态违规压缩成给写手看的一句话，同类只报数量，不逐段罗列。
 */
function describeShapeViolations(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const count = list.find((row) => row.kind === 'count');
  const parts = [];
  if (count) parts.push(`实际 ${count.actual} 段，目标是 ${count.expected}±${count.tolerance} 段`);
  const fragments = list.filter((row) => row.kind === 'fragment').length;
  if (fragments) parts.push(`有 ${fragments} 段不足 80 字`);
  const tooLong = list.filter((row) => row.kind === 'too_long').length;
  if (tooLong) parts.push(`有 ${tooLong} 段超过 140 字`);
  const shortRun = list.find((row) => row.kind === 'short_run');
  if (shortRun) parts.push(`有连续 ${shortRun.run} 段不足 20 字`);
  const talks = list.filter((row) => row.kind === 'dialogue_stack').length;
  if (talks) parts.push('对白连续独立成段');
  const quotes = list.filter((row) => row.kind === 'corner_quote').length;
  if (quotes) parts.push(`有 ${quotes} 段使用「」`);
  return parts.join('；');
}

/**
 * 拼出全章正文，并按组应用段落合并（不跨组，组边界天然算场景边界）。
 *
 * 返回合并前后的两份正文，方便直接对比同一份稿子的两种形态。
 */
function composeChapterContent({ groups, existingBody = '', mergeScenes = true }) {
  const stitched = stitchGroups(groups, existingBody);
  if (!mergeScenes) {
    return { content: stitched, contentBeforeMerge: stitched, mergedParagraphs: 0 };
  }

  let mergedParagraphs = 0;
  const body = groups.reduce((text, group) => {
    if (!group.content) return text;
    const rows = splitParagraphs(group.content);
    const mergedRows = mergeSceneParagraphs(rows);
    mergedParagraphs += rows.length - mergedRows.length;
    return appendFresh(text, mergedRows.join('\n\n'));
  }, String(existingBody || '').trim());

  return { content: body, contentBeforeMerge: stitched, mergedParagraphs };
}

/**
 * 截到不超过 maxChars 的最后一个完整自然段。只在跑飞（>7000 字）时用，
 * 正常写作不触发；截断只在汇报里说明，不回头改正文切分。
 */
function trimToChars(text, maxChars) {
  const paragraphs = splitParagraphs(text);
  const joined = (rows) => rows.join('\n\n');
  if (countWords(joined(paragraphs)) <= maxChars) {
    return { text: joined(paragraphs), trimmed: false };
  }

  while (paragraphs.length > 1 && countWords(joined(paragraphs)) > maxChars) {
    paragraphs.pop();
  }
  return { text: joined(paragraphs), trimmed: true };
}

/**
 * 交付前的安全兜底：只挡 7000 字以上的跑飞，不做任何段落合并或拆分。
 *
 * @param {string} text
 * @returns {{content: string, truncated: boolean, originalChars: number, chars: number}}
 */
function normalizeChapterShape(text) {
  const original = String(text || '').trim();
  const originalChars = countWords(original);
  const capped = trimToChars(original, MAX_CHAPTER_CHARS);

  return {
    content: capped.text,
    truncated: capped.trimmed,
    originalChars,
    chars: countWords(capped.text),
  };
}

/**
 * 这一组是否明显没写够。
 *
 * 只看字数，不看段数：段落已经交给叙事节奏，强行按计划段数续写会把刚合好的
 * 小场景重新拆碎。末组允许收束，所以不看收尾词。
 */
function needsContinuation(group, force = false) {
  if (group.continued || !group.content) return false;
  const shortText = countWords(group.content) < group.targetChars * MIN_TARGET_RATIO;
  if (force) return true;
  if (group.isLast) return shortText;
  return shortText || hasClosingTone(group.content);
}

function usageSum(calls) {
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let seen = false;
  for (const call of calls) {
    const usage = call.usage;
    if (!usage) continue;
    seen = true;
    prompt += Number(usage.promptTokens ?? usage.prompt_tokens ?? 0) || 0;
    completion += Number(usage.completionTokens ?? usage.completion_tokens ?? 0) || 0;
    total += Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0;
  }
  if (!seen) return null;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total || prompt + completion,
  };
}

/**
 * 依次写完所有组。
 *
 * @param {Object} params
 * @param {Object} params.plan 已校验的节拍表
 * @param {string} [params.existingBody] 章节现有正文（拼接时只取尾部避免重复）
 * @param {Function} params.runSegment 真正执行一次模型调用
 * @param {number} [params.maxCalls] 总调用上限
 * @param {Function} [params.log] 每次调用的结构化日志
 * @param {Function} [params.progress] 给前端的进度事件
 */
async function draftInSegments({
  plan,
  existingBody = '',
  runSegment,
  maxCalls = MAX_SEGMENT_CALLS,
  mergeScenes = true,
  brief = null,
  log = () => {},
  progress = () => {},
}) {
  const groups = planSegments(plan);
  const calls = [];
  let callCount = 0;
  let degraded = '';
  let finishReason = 'stop';
  let boundaryTrimmed = 0;
  let boundaryConflicts = 0;
  let continuationDropped = 0;

  const invoke = async ({ instruction, group, kind }) => {
    callCount += 1;
    const startedAt = Date.now();
    const out = await runSegment({ instruction, group, kind, callIndex: callCount });
    const durationMs = Date.now() - startedAt;
    const content = String(out?.content || '').trim();
    const entry = {
      call: callCount,
      kind,
      group: group.index,
      beatIds: group.beatIds,
      durationMs,
      finishReason: out?.finishReason || '',
      chars: countWords(content),
      usage: out?.usage || null,
    };
    calls.push(entry);
    log(entry);
    if (out?.finishReason) finishReason = out.finishReason;
    return { ...out, content };
  };

  for (const group of groups) {
    if (degraded) break;
    if (callCount >= maxCalls) {
      degraded = 'call_limit';
      break;
    }

    progress({ phase: 'segment', index: group.index, total: groups.length, beatIds: group.beatIds });
    const tail = tailParagraphs(stitchGroups(groups, existingBody), 3);
    const instruction = buildSegmentInstruction({ plan, group, groups, tail, brief });

    let out;
    try {
      out = await invoke({ instruction, group, kind: 'initial' });
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'AI_ABORTED') throw err;
      degraded = err.code === 'AI_TIMEOUT' ? 'timeout' : 'error';
      break;
    }

    if (!out.content) {
      degraded = 'empty';
      break;
    }

    group.called = true;
    // 先记下「原本有没有收尾语气」，再去掉尾句。去掉之后再判断，
    // 中间的收尾信号就丢了，续写永远不会触发。
    const closingHit = !group.isLast && hasClosingTone(out.content);
    const initialContent = group.isLast ? out.content : stripClosingTail(out.content);
    const bounded = enforceGroupBoundary({ content: initialContent, group, groups });
    if (bounded.boundaryTrimmed) boundaryTrimmed += 1;
    if (bounded.boundaryConflict) boundaryConflicts += 1;
    group.content = bounded.content;

    // 续写只补到本组目标的字数；到量即停，不再用段数或 105% 硬线二次裁剪。
    if (
      needsContinuation(group, closingHit) &&
      callCount < maxCalls &&
      countWords(group.content) < group.targetChars
    ) {
      progress({ phase: 'continue', index: group.index, total: groups.length });
      const remainingChars = Math.max(120, group.targetChars - countWords(group.content));
      const contInstruction = buildContinuationInstruction({
        plan,
        group,
        groups,
        tail: continuationAnchor(group.content),
        remainingChars,
        brief,
      });

      try {
        const cont = await invoke({ instruction: contInstruction, group, kind: 'continuation' });
        if (cont.content) {
          const cleaned = group.isLast ? cont.content : stripClosingTail(cont.content);
          const contBounded = enforceGroupBoundary({ content: cleaned, group, groups });
          if (contBounded.boundaryTrimmed) boundaryTrimmed += 1;
          if (contBounded.boundaryConflict) boundaryConflicts += 1;
          if (contBounded.content) {
            // 续写第一段如果在复述已有内容，整段续写直接丢弃；
            // 不把复述拼进来再靠去重补救——那样已经写偏的续写只会污染正文。
            if (isRestatement(contBounded.content, group.content)) {
              continuationDropped += 1;
            } else {
              group.content = appendFresh(group.content, contBounded.content);
              group.continued = true;
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.code === 'AI_ABORTED') throw err;
        // 续写失败不推翻已写部分；继续下一组，最终由覆盖自检决定要不要重写。
      }
    }
  }

  const composed = composeChapterContent({ groups, existingBody, mergeScenes });
  const normalized = normalizeChapterShape(composed.content);
  const beforeNormalized = normalizeChapterShape(composed.contentBeforeMerge);
  return {
    groups,
    content: normalized.content,
    // 同一份稿子的合并前形态，用来对比段落呼吸；默认合并开启。
    contentBeforeMerge: beforeNormalized.content,
    mergeScenes,
    mergedParagraphs: composed.mergedParagraphs,
    action: 'append',
    calls,
    callCount,
    degraded,
    continuations: groups.filter((g) => g.continued).length,
    continuationDropped,
    boundaryTrimmed,
    boundaryConflicts,
    truncated: normalized.truncated,
    originalChars: normalized.originalChars,
    chars: normalized.chars,
    charsBeforeMerge: beforeNormalized.chars,
    finishReason,
    usage: usageSum(calls),
  };
}

/** 覆盖报告里的节拍 id 落在哪些组。 */
function groupsForIds(groups, ids) {
  const wanted = new Set((ids || []).filter(Boolean));
  return groups.filter((g) => g.beatIds.some((id) => wanted.has(id)));
}

/**
 * 只重写缺拍/写得弱的组。
 *
 * 其他组的正文不动——整章重来会把这些已经合格的部分也洗一遍，
 * 而且调用次数会直接顶到上限。
 */
async function rewriteMissingGroups({
  plan,
  groups,
  coverage,
  existingBody = '',
  runSegment,
  maxCalls = MAX_SEGMENT_CALLS,
  callCount = 0,
  mergeScenes = true,
  brief = null,
  mustReveal = [],
  mustWithholdIds = [],
  invariantConflicts = [],
  shapeViolations = [],
  log = () => {},
  progress = () => {},
}) {
  const calls = [];
  let count = callCount;
  let degraded = '';
  let finishReason = 'stop';
  let rewroteGroups = 0;
  let boundaryTrimmed = 0;
  const failedGroups = [];

  const weakIds = (coverage?.weak || []).map((w) => w.id);
  const dupIds = coverage?.handoverDuplicated || [];
  const conflictIds = (invariantConflicts || []).map((conflict) => conflict.beatId);
  const shapeIds = [...new Set((shapeViolations || []).map((row) => row && row.beatId).filter(Boolean))];
  const missingIds = [
    ...(coverage?.missing || []),
    ...weakIds,
    ...dupIds,
    ...(mustWithholdIds || []),
    ...conflictIds,
    ...shapeIds,
  ];
  const factsOnly = !groupsForIds(groups, missingIds).length && (mustReveal || []).length > 0;
  const affected = factsOnly ? groups.slice(0, 1) : groupsForIds(groups, missingIds);

  for (const group of affected) {
    if (count >= maxCalls) {
      degraded = 'call_limit';
      break;
    }

    progress({ phase: 'rewrite', index: group.index, total: groups.length, beatIds: group.beatIds });
    const before = groups
      .filter((g) => g.index < group.index)
      .map((g) => g.content)
      .filter(Boolean)
      .join('\n\n');
    const afterGroup = groups.find((g) => g.index === group.index + 1);
    const nextHead = afterGroup ? splitParagraphs(afterGroup.content).slice(0, 2).join('\n\n') : '';

    const instruction = buildGroupRewriteInstruction({
      plan,
      group,
      groups,
      // 只为补背景事实强制重写时，把本组原有节拍一并列出来，避免补一句身世却丢掉本组动作。
      problemIds: factsOnly ? group.beatIds : (coverage?.missing || []),
      weakIds: factsOnly ? [] : weakIds,
      handoverDupIds: factsOnly ? [] : (coverage?.handoverDuplicated || []),
      mustWithholdIds: factsOnly ? [] : (mustWithholdIds || []),
      invariantConflicts: factsOnly ? [] : (invariantConflicts || []),
      shapeViolations: factsOnly ? [] : (shapeViolations || []),
      tail: tailParagraphs(before || existingBody, 3),
      nextHead,
      brief,
      mustReveal,
    });

    count += 1;
    const startedAt = Date.now();
    let out;
    try {
      out = await runSegment({ instruction, group, kind: 'rewrite', callIndex: count });
    } catch (err) {
      if (err.name === 'AbortError' || err.code === 'AI_ABORTED') throw err;
      degraded = err.code === 'AI_TIMEOUT' ? 'timeout' : 'error';
      failedGroups.push(group.index);
      break;
    }

    const durationMs = Date.now() - startedAt;
    const content = String(out?.content || '').trim();
    const entry = {
      call: count,
      kind: 'rewrite',
      group: group.index,
      beatIds: group.beatIds,
      durationMs,
      finishReason: out?.finishReason || '',
      chars: countWords(content),
      usage: out?.usage || null,
    };
    calls.push(entry);
    log(entry);
    if (out?.finishReason) finishReason = out.finishReason;

    if (!content) {
      failedGroups.push(group.index);
      continue;
    }

    const rewritten = group.isLast ? content : stripClosingTail(content);
    const bounded = enforceGroupBoundary({ content: rewritten, group, groups });
    if (bounded.boundaryTrimmed) boundaryTrimmed += 1;
    group.content = bounded.content;
    rewroteGroups += 1;
  }

  const composed = composeChapterContent({ groups, existingBody, mergeScenes });
  const normalized = normalizeChapterShape(composed.content);
  const beforeNormalized = normalizeChapterShape(composed.contentBeforeMerge);
  return {
    groups,
    content: normalized.content,
    contentBeforeMerge: beforeNormalized.content,
    mergeScenes,
    mergedParagraphs: composed.mergedParagraphs,
    calls,
    callCount: count,
    degraded,
    rewroteGroups,
    failedGroups,
    boundaryTrimmed,
    truncated: normalized.truncated,
    originalChars: normalized.originalChars,
    chars: normalized.chars,
    charsBeforeMerge: beforeNormalized.chars,
    finishReason,
    usage: usageSum(calls),
  };
}

/** 分段起稿降级时给作者看的徽标。 */
function segmentBadge(degraded) {
  if (!degraded) return '';
  if (degraded === 'call_limit') return '【分段起稿：调用次数达到上限，已交付已写部分】';
  if (degraded === 'timeout') return '【分段起稿：有分组超时，已交付已写部分】';
  if (degraded === 'empty') return '【分段起稿：有分组没有返回正文，已交付已写部分】';
  return '【分段起稿：有分组失败，已交付已写部分】';
}

module.exports = {
  MAX_BEATS_PER_GROUP,
  TARGET_CHAPTER_CHARS,
  MAX_CHAPTER_CHARS,
  MAX_SEGMENT_CALLS,
  MIN_TARGET_RATIO,
  RESTATEMENT_SIMILARITY,
  MERGE_MAX_PARAGRAPH_CHARS,
  SCENE_SHIFT_RE,
  PARAGRAPH_SHAPE_RULES,
  SHAPE_PARAGRAPH_MIN,
  SHAPE_PARAGRAPH_MAX,
  SHAPE_FRAGMENT_MIN,
  SHAPE_BEAT_TOLERANCE,
  CLOSING_RE,
  splitParagraphs,
  tailParagraphs,
  paragraphSimilarity,
  isRestatement,
  continuationAnchor,
  mergeSceneParagraphs,
  beatParagraphRanges,
  checkParagraphShape,
  describeShapeViolations,
  composeChapterContent,
  beatMarkers,
  enforceGroupBoundary,
  buildBoundaryBlock,
  buildHandoffRules,
  planSegments,
  buildSegmentInstruction,
  buildContinuationInstruction,
  buildGroupRewriteInstruction,
  stripClosingTail,
  hasClosingTone,
  appendFresh,
  stitchGroups,
  trimToChars,
  normalizeChapterShape,
  needsContinuation,
  usageSum,
  draftInSegments,
  groupsForIds,
  rewriteMissingGroups,
  segmentBadge,
};
