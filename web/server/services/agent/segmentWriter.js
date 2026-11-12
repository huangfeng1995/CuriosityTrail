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

/** 总调用上限：成本闸门，不随阶段需要临时抬高。 */
const MAX_SEGMENT_CALLS = 8;

/**
 * 显式调用预算表（四类之和 = MAX_SEGMENT_CALLS）。
 *
 * 旧的分配是「先到先得」：起稿每组最多两次（初稿 + 续写），3 组就用掉 6 次，
 * 剩下的 2 次被形态重写吃光，扩写一次都轮不到。线上实测正是这样交付的。
 *
 * 现在按类别切死配额：
 *   - draft 4：3 组初稿 + 最多 1 次续写。续写和扩写做的是同一件事（补字数），
 *     但扩写能按拍点名、能验 80–140 字，所以续写是四类里最低优先级。
 *   - rewrite 2：形态/禁写/缺拍按拍重写，只保最要紧的两组。
 *   - expand 2：内容量扩写，含同拍内部再收敛一次。
 *
 * 固定优先级：起稿初稿（必写）> 扩写（内容量）> 重写（合规）> 续写（补字数）。
 * 续写在起稿阶段就让位；扩写的 2 次在重写阶段被保留，不允许被重写借走。
 */
const SEGMENT_CALL_BUDGET = Object.freeze({
  draft: 4,
  rewrite: 2,
  expand: 2,
});

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
  '## 全章形态（分布校验）',
  '- 全章按长章体量写，总量大致在 4800–5600 字（含标点）；不要为凑数拉长段落，也不要写到 7000 字以上。',
  '- 每拍段数按节拍表给的段数为准，允许 ±2 段；不要把一拍压成提纲，也不要把一个动作拆成好几段。',
  '- 段长按范文分布写，不逐段卡 80–140：<40 约 4%、40–79 约 29%、80–140 约 47%、141–200 约 9%、>200 约 11%（全部含标点）。单段不得超过 320 字。',
  '- 40–79 字段不超过全章 39%；短段要有节奏作用，不能把一个小场景拆成几截。',
  '- 连续 3 段都 <40 字才算「碎」；短促反应、单句对白最多连续 2 段，且前后必须有动作或叙述句承接。',
  '- 段均向范文 112 字看齐（95–129）；不要为凑 80 字把短段拉长，也不要为压 320 字把长段砍成两段。',
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

/**
 * 段落形态口径，数值全部来自 docs/superpowers/baseline/sample.md 实测，
 * 不要手调，也不要别处另立一套：
 *   - 段长 = countWords，含标点；拍字数目标 = targetChars，纯汉字（不含标点）。
 *   - 交付判定用「分布校验」，不再逐段卡 80–140：范文 45 段里只有 21 段在
 *     80–140，15 段 40–79、9 段超 140（最长 314）。逐段硬拦会把范文判 24/45
 *     违规，模型只能收敛成均匀 112，反而丢掉短句/长段的节奏。
 *
 * 范文实测（含标点）：45 段 / 5047 字 / 段均 112.16 / 中位 105 / 最短 23 / 最长 314。
 * 五区间：<40 2 段 4.4%、40–79 13 段 28.9%、80–140 21 段 46.7%、
 * 141–200 4 段 8.9%、>200 5 段 11.1%。
 */
const SHAPE_PARAGRAPH_MIN = 80; // 仅作扩写内部目标，不再作为交付硬拦
const SHAPE_PARAGRAPH_MAX = 140; // 同上
const SHAPE_BEAT_TOLERANCE = 2;
const SHAPE_SHORT_RUN = 3;

/** 范文实测基线：分布校验的数值必须从这里取，不许手调。 */
const SAMPLE_TOTAL_PARAGRAPHS = 45;
const SAMPLE_MEAN_CHARS = 112.16;
const SAMPLE_MEDIAN_CHARS = 105;
const SAMPLE_MIN_CHARS = 23;
const SAMPLE_MAX_CHARS = 314;
const SAMPLE_BUCKET_COUNTS = Object.freeze({
  under40: 2,
  '40to79': 13,
  '80to140': 21,
  '141to200': 4,
  over200: 5,
});

/** 五区间：<40、40–79、80–140、141–200、>200。 */
const SHAPE_BUCKETS = Object.freeze([
  { key: 'under40', label: '<40', max: 40 },
  { key: '40to79', label: '40–79', max: 80 },
  { key: '80to140', label: '80–140', max: 141 },
  { key: '141to200', label: '141–200', max: 201 },
  { key: 'over200', label: '>200', max: Infinity },
]);

/** 硬拦只有一条：单段 >320（范文最长 314，留 6 字余量）。 */
const SHAPE_HARD_MAX = 320;
/** 段均允许偏离范文 ±15%。 */
const SHAPE_MEAN_TOLERANCE = 0.15;
/** 40–79 段占比允许比范文高 10pp。 */
const SHAPE_FRAGMENT_SLACK = 0.10;
/** 连续 3 段都 <40 才算「碎」。 */
const SHAPE_SHORT_FRAGMENT_MAX = 40;
const SAMPLE_40_79_RATIO = SAMPLE_BUCKET_COUNTS['40to79'] / SAMPLE_TOTAL_PARAGRAPHS;
const SHAPE_40_79_MAX_RATIO = SAMPLE_40_79_RATIO + SHAPE_FRAGMENT_SLACK;
const SHAPE_MEAN_MIN = SAMPLE_MEAN_CHARS * (1 - SHAPE_MEAN_TOLERANCE);
const SHAPE_MEAN_MAX = SAMPLE_MEAN_CHARS * (1 + SHAPE_MEAN_TOLERANCE);

/** 交付与日志里显式写出的口径，避免「目标」和「段长」以后又被混用。 */
const SHAPE_MEASURE = Object.freeze({
  paragraphLength: 'countWords（含标点）',
  shotTarget: '纯汉字（不含标点）',
  judge: '分布校验（非逐段 80–140）',
  summary: '目标=纯汉字、段长=含标点、判定=分布',
});

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

/**
 * 篇幅未完成线：该拍纯汉字不足计划目标的 85%，视为写手没把分到的份额写足。
 *
 * 判定必须用「目标汉字数」，不能用 wordShare（那是份额百分比）：
 * B3 的 30 是 30%，不是 30 字；拿它乘 0.85 得到的 25.5 永远小于实际字数，
 * 扩写会一直判不触发。
 */
const SHOT_FILL_RATIO = 0.85;

/** 某拍的计划目标汉字数：优先取计划里的 targetChars，老计划按份额折算。 */
function beatTargetChars(beat) {
  const explicit = Number(beat && beat.targetChars);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const share = Number(beat && beat.wordShare);
  if (Number.isFinite(share) && share > 0) {
    return Math.round((share / 100) * TARGET_CHAPTER_CHARS);
  }
  return 0;
}

/**
 * 按拍对齐「实际纯汉字数 / 计划目标汉字数」。
 *
 * report 来自 beatPlan.checkWordShares，chars 已是纯汉字计数（不含标点），
 * 与 groupQuotaBlock 给写手的目标口径一致。
 *
 * @param {Object} plan 节拍表
 * @param {Object} report checkWordShares 的输出
 * @returns {Array<{id: string, chars: number, target: number}>}
 */
function shotCharStats(plan, report) {
  const targets = new Map(
    (plan && Array.isArray(plan.beats) ? plan.beats : []).map((beat) => [
      beat.id,
      beatTargetChars(beat),
    ])
  );
  return (report && Array.isArray(report.beats) ? report.beats : []).map((row) => ({
    id: row.id,
    chars: Number(row.chars) || 0,
    target: targets.get(row.id) || 0,
  }));
}

/** 不足目标 ratio（默认 85%）的拍，返回实际/目标汉字数，供扩写指令与自检共用。 */
function findShortShots(plan, report, ratio = SHOT_FILL_RATIO) {
  return shotCharStats(plan, report).filter(
    (shot) => shot.target > 0 && shot.chars < Math.round(shot.target * ratio)
  );
}

/**
 * 交付时的篇幅自检。
 *
 * 扩写过的拍：低于目标 95% 才记（95%–100% 的尾差不再打扰作者）；
 * 没扩写（预算不够/未触发）的拍：低于 85% 才记。
 *
 * @param {Object} plan
 * @param {Object} report
 * @param {Array<string>} expandedIds 本次实际扩写过的拍号
 * @returns {Array<{beatId: string, chars: number, target: number, note: string}>}
 */
function underFilledShots(plan, report, expandedIds = []) {
  const expanded = new Set(expandedIds || []);
  return shotCharStats(plan, report)
    .filter((shot) => {
      if (shot.target <= 0 || shot.chars >= shot.target) return false;
      const line = expanded.has(shot.id) ? SHOT_RECORD_RATIO : SHOT_FILL_RATIO;
      return shot.chars < Math.round(shot.target * line);
    })
    .map((shot) => ({
      beatId: shot.id,
      chars: shot.chars,
      target: shot.target,
      note: `【篇幅自检：第${shot.id}拍 ${shot.chars}/${shot.target}】`,
    }));
}

/**
 * 本组各拍的篇幅配额（纯汉字）。
 *
 * 组级总字数会被写手平均摊开：身世拍分到 30%，落到正文就变成 19%。
 * 这里把目标汉字数与段数区间逐拍写死，并给出 85% 的未完成线。
 *
 * @param {Array<Object>} beats
 * @returns {string}
 */
function groupQuotaBlock(beats) {
  const rows = (beats || [])
    .filter((beat) => beat && beat.id)
    .map((beat) => {
      const share = Number(beat.wordShare);
      const target = Number(beat.targetChars) || (share ? Math.round(share * 50) : 0);
      const paras = Number(beat.paragraphs) || 0;
      const low = target ? Math.round(target * 0.85) : 0;
      const range = paras ? `段数 ${Math.max(1, paras - 2)}–${paras + 2} 段` : '按计划段数';
      const floor = low ? `不足 ${low} 字视为未完成` : '写到目标就停';
      return (
        `- ${beat.id}（${beat.function || beat.type}）：目标 ${target || '未定'} 个汉字（纯汉字不含标点），` +
        `${range}，每段按范文分布（多数 80–140，允许 40–79 与 141–320，单段不超 320），${floor}。`
      );
    });
  return rows.length ? `## 本组各拍目标（纯汉字，不含标点）\n${rows.join('\n')}` : '';
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
    `- 本组总量大致在 ${softMin}–${softMax} 个汉字（纯汉字，不含标点）就够了，不要为凑字数拉长段落。`,
    '- 每一拍都要有变量变化、信息增量和代价；关键决定要写决定本身和它的代价。',
    `- 段数按本组各拍计划（±2 段）；段长按范文分布（多数 80–140，允许 40–79 与 141–320），不要连续 3 段不足 40 字，单段不超 320 字。`,
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
    `本组大致写 ${group.targetChars} 个汉字（纯汉字，不含标点）：按各拍计划段数（±2 段）落段，段长按范文分布（多数 80–140，允许 40–79 与 141–320），不要连续 3 段不足 40 字，单段不超 320 字。写到大致够用就停；全章大致 4800–5600 字（含标点）即可，7000 字以上会被截断。`,
    '',
    groupQuotaBlock(group.beats),
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
    `本组目标约 ${group.targetChars} 个汉字（纯汉字，不含标点），已经写了 ${written} 字，再补约 ${remainingChars} 个汉字就够；按各拍计划段数（±2 段）落段，段长按范文分布（多数 80–140，允许 40–79 与 141–320），不要连续 3 段不足 40 字，单段不超 320 字。补到目标就停，不要为凑数拉长段落，也不要继续往下写。`,
    '',
    groupQuotaBlock(group.beats),
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

/**
 * 单拍重写指令：只把违规拍送回模型，其余拍由代码原样拼回。
 *
 * 整组重写会把同组的合格拍一起洗一遍——实测初稿 6,679 字，一次重写后只剩 4,128。
 * 这里只点名违规拍；同一拍同时有形态与禁写问题时合并成一份说明，避免重写两遍。
 */
function buildBeatRewriteInstruction({
  plan,
  group,
  groups,
  problemIds,
  weakIds = [],
  handoverDupIds = [],
  mustWithholdIds = [],
  invariantConflicts = [],
  shapeViolations = [],
  expandShots = [],
  tail,
  nextHead,
  brief = null,
  mustReveal = [],
}) {
  const wanted = new Set(problemIds || []);
  // 篇幅扩写：只补细节，不让模型推进情节。映射 beatId -> {chars,target}。
  const expand = new Map(
    (expandShots || [])
      .filter((shot) => shot && shot.id)
      .map((shot) => [shot.id, { chars: Number(shot.chars) || 0, target: Number(shot.target) || 0 }])
  );
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
  const flagged = (beat) =>
    wanted.has(beat.id) ||
    weak.has(beat.id) ||
    dup.has(beat.id) ||
    withhold.has(beat.id) ||
    conflicts.has(beat.id) ||
    shape.has(beat.id) ||
    expand.has(beat.id);
  const beats = group.beats.filter(flagged);
  const ids = beats.map((beat) => beat.id);
  // 同一拍的所有问题合并成一行：形态 + 禁写 + 交付重复只发一次请求。
  const problems = beats.map((b) => {
    const clauses = [];
    if (conflicts.has(b.id)) {
      clauses.push(
        `本拍数值与全章不变项冲突（${conflicts.get(b.id).join('；')}）；` +
          '同一事实只保留一个数，改成 brief 不变项里的值，删掉其余矛盾表述。'
      );
    }
    if (withhold.has(b.id)) {
      clauses.push(
        '本拍只写形制细节与人物反应，不写制度结论，不替读者解释；' +
          '删掉所有关于私辟/传诏/符传/逾制/该不该的判断句。'
      );
    }
    if (dup.has(b.id)) {
      clauses.push(
        `本章交付只发生一次，已在第 ${handoverBeat || '指定'} 拍完成；` +
          '本拍删掉完整托付/交割和托付话，只保留递、接、握住手这类预备动作。'
      );
    }
    if (wanted.has(b.id) || weak.has(b.id)) {
      clauses.push(
        `必须写出目标「${b.goal}」、阻碍「${b.obstacle}」、代价「${b.cost}」，` +
          `以及「${b.delta.variable}」从「${b.delta.from}」到「${b.delta.to}」的变化，` +
          `收在「${b.endHook}」。` +
          (weak.has(b.id) ? '写到了事件但没写出变化，这一遍要把变化写实。' : '')
      );
    }
    if (shape.has(b.id)) {
      const planned = Number(b.paragraphs) || 3;
      clauses.push(
        `本拍段落形态不合规（${describeShapeViolations(shape.get(b.id))}）：` +
          `按 ${planned}±${SHAPE_BEAT_TOLERANCE} 段落段，段长按范文分布（多数 80–140，允许 40–79 与 141–320，单段不超 320）；` +
          '40–79 的短段不要硬拉长，超过 320 的长段才压缩（删冗余修饰、同段内拆句安排节奏），不得整段拆成两段；' +
          '对白与动作合并在同一段，引号统一用全角 “”、禁止「」。' +
          ` 先保本拍纯汉字目标，再调形状；重写后本拍段数优先落在 ${Math.max(1, planned - SHAPE_BEAT_TOLERANCE)}–${planned + SHAPE_BEAT_TOLERANCE} 段。`
      );
    }
    const shot = expand.get(b.id);
    if (shot) {
      clauses.push(
        `当前 ${shot.chars} 个汉字 → 目标 ${shot.target} 个汉字；` +
          '本次只补细节、环境、动作、对话与人物心理，不推进情节、不新增事件、不提前揭示。'
      );
    }
    return `- ${b.id}：${clauses.join(' ')}`;
  });

  const hasCoverageGap = wanted.size || weak.size || dup.size || withhold.size || conflicts.size || shape.size;
  return [
    `## 重写第 ${group.index + 1}/${groups.length} 组中的 ${ids.join('、')}（其他拍原样保留）`,
    hasCoverageGap
      ? '覆盖自检发现这些拍没有落地。只重写这一组里的指定拍，其他拍与其他组保持原样，不要整章重来。'
      : '这些拍节拍齐全，只是篇幅不足。只补指定拍的细节，其他拍与其他组保持原样。',
    `完整节拍表见 system 中的「本章节拍表」，全章共 ${plan.beats.length} 拍。`,
    '',
    expand.size ? '## 扩写（只补不推进）' : null,
    expand.size
      ? Array.from(expand.entries())
          .map(
            ([id, shot]) =>
              `- ${id}：当前 ${shot.chars} 个汉字 → 目标 ${shot.target} 个汉字；` +
              '只补细节、环境、动作、对话与人物心理，不推进情节、不新增事件、不提前揭示。'
          )
          .join('\n')
      : null,
    expand.size ? '' : null,
    '## 必须补足',
    problems.length ? problems.join('\n') : '把点名的拍写完整。',
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
    `本组大致写 ${group.targetChars} 个汉字（纯汉字，不含标点）：按各拍计划段数（±2 段）落段，段长按范文分布（多数 80–140，允许 40–79 与 141–320），不要连续 3 段不足 40 字，单段不超 320 字。` +
      `段数优先落在 ${Math.max(1, group.targetParagraphs - 2)}–${group.targetParagraphs + 2} 段；若为压掉超长段而多出一段，允许超出计划 ±2，只记数、不判失败。` +
      '重写先保本组纯汉字目标，再调形状；重写后本组不得低于原稿 85%，低于就整组作废。' +
      '修形态不许删内容：只许调段落切分与句间顺序，删除整句须同时补等量叙述。' +
      '扩写也不许用加空段、拆句、加标点凑字数。',
    '',
    '## 每拍硬约束',
    beats
      .map(
        (b) =>
          `- ${b.id}：本拍 ${Number(b.paragraphs) || 0} 段（容差 ±${SHAPE_BEAT_TOLERANCE}），` +
          '段长按范文分布（多数 80–140，允许 40–79 与 141–320，单段不超 320），每段至少 2 句。'
      )
      .join('\n'),
    '',
    groupQuotaBlock(group.beats),
    '',
    PARAGRAPH_SHAPE_RULES,
    '',
    group.isLast
      ? '这是最后一组：可以收束本章，并把唯一一个章末钩子放在最后。'
      : '本章尚未结束：不要收尾，不要埋全章钩子。',
    '',
    buildSelfCheck(group),
    '',
    '输出 JSON：{"action":"rewrite","beats":[{"id":"B4","paragraphs":["第一段","第二段"]}]}。',
    'beats 只放上面点名的拍，按拍号顺序；paragraphs 只放这一拍的正文，其余拍一个字都不要返回。',
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

function shapeBucketOf(chars) {
  for (const bucket of SHAPE_BUCKETS) {
    if (chars < bucket.max) return bucket.key;
  }
  return 'over200';
}

function shapePercent(count, total) {
  return total ? Math.round((count / total) * 1000) / 10 : 0;
}

function shapeMedian(sorted) {
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : Math.round(((sorted[n / 2 - 1] + sorted[n / 2]) / 2) * 10) / 10;
}

/** 分布违规是章级指标，挂到贡献最大的那一拍，重写才有明确落点。 */
function worstBeatFor(indices, ranges, beats) {
  const counts = new Map();
  for (const index of indices) {
    const hit = ranges.findIndex(([from, to]) => index >= from && index < to);
    const id = hit >= 0 ? beats[hit].id : beats[beats.length - 1].id;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  let best = beats[0] ? beats[0].id : '';
  let max = -1;
  for (const beat of beats) {
    const count = counts.get(beat.id) || 0;
    if (count > max) {
      max = count;
      best = beat.id;
    }
  }
  return best;
}

/**
 * 写手执行层的段落形态自检。
 *
 * 判定改成分布校验，数值全部来自范文实测（见文件头 SHAPE_* 常量）：
 *   1. 硬拦只有一条：单段 >320 字；
 *   2. 40–79 段占比 ≤ 范文 28.9% + 10pp（38.9%）；
 *   3. 连续 3 段都 <40 才判「碎」；
 *   4. 段均落在范文 112.16 ±15%（95.3–129.0）；
 *   5. 每拍段数在计划 ±2；
 *   6. 对白连续独立成段、引号使用「」（保留原有质量规则）。
 *
 * 不再逐段卡 80–140：范文自己就有一半段落在这个区间外。
 * 返回的 beatId 直接用于分组重写；没有节拍表时不做判定。
 */
function checkParagraphShape(plan, body) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const paragraphs = splitParagraphs(body);
  if (!beats.length || !paragraphs.length) {
    return {
      applicable: false,
      totalParagraphs: 0,
      avgChars: 0,
      beatIds: [],
      violations: [],
      summary: summarizeShapeViolations([]),
      buckets: {},
      stats: null,
      distribution: null,
    };
  }

  const ranges = beatParagraphRanges(beats, paragraphs.length);
  const lengths = paragraphs.map((paragraph) => countWords(paragraph));
  const beatIdAt = (index) => {
    const hit = ranges.findIndex(([from, to]) => index >= from && index < to);
    return hit >= 0 ? beats[hit].id : beats[beats.length - 1].id;
  };
  const violations = [];

  // 0. 五区间分布与基础统计：全部按含标点口径。
  const buckets = {};
  for (const bucket of SHAPE_BUCKETS) {
    buckets[bucket.key] = { label: bucket.label, count: 0, ratio: 0 };
  }
  for (const chars of lengths) buckets[shapeBucketOf(chars)].count += 1;
  for (const key of Object.keys(buckets)) {
    buckets[key].ratio = shapePercent(buckets[key].count, lengths.length);
  }
  const sorted = [...lengths].sort((a, b) => a - b);
  const mean = Math.round((lengths.reduce((sum, chars) => sum + chars, 0) / lengths.length) * 100) / 100;
  const stats = {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: shapeMedian(sorted),
    mean,
    meanRange: [Math.round(SHAPE_MEAN_MIN * 10) / 10, Math.round(SHAPE_MEAN_MAX * 10) / 10],
  };

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

  // 2. 硬拦只有一条：单段 >320。
  lengths.forEach((chars, index) => {
    if (chars <= SHAPE_HARD_MAX) return;
    violations.push({
      beatId: beatIdAt(index),
      kind: 'too_long',
      index,
      chars,
      limit: SHAPE_HARD_MAX,
      sample: paragraphSample(paragraphs[index]),
    });
  });

  // 3. 40–79 段占比不得超过范文 28.9% + 10pp。
  const midShortIndices = lengths
    .map((chars, index) => (chars >= 40 && chars < 80 ? index : -1))
    .filter((index) => index >= 0);
  if (buckets['40to79'].ratio > Math.round(SHAPE_40_79_MAX_RATIO * 1000) / 10) {
    violations.push({
      beatId: worstBeatFor(midShortIndices, ranges, beats),
      kind: 'fragment_ratio',
      ratio: buckets['40to79'].ratio,
      limit: Math.round(SHAPE_40_79_MAX_RATIO * 1000) / 10,
      count: buckets['40to79'].count,
      total: lengths.length,
    });
  }

  // 4. 连续 3 段都 <40 才判「碎」。
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
    if (i < lengths.length && lengths[i] < SHAPE_SHORT_FRAGMENT_MAX) {
      if (!shortRun) shortStart = i;
      shortRun += 1;
      continue;
    }
    flushShortRun();
    shortRun = 0;
  }

  // 5. 段均偏离范文 ±15%。
  if (mean < SHAPE_MEAN_MIN || mean > SHAPE_MEAN_MAX) {
    const side = mean < SHAPE_MEAN_MIN ? 'low' : 'high';
    const indices = lengths
      .map((chars, index) => {
        if (side === 'low' ? chars < 80 : chars > 140) return index;
        return -1;
      })
      .filter((index) => index >= 0);
    violations.push({
      beatId: worstBeatFor(indices, ranges, beats),
      kind: 'avg',
      mean,
      range: stats.meanRange,
      side,
    });
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
    summary: summarizeShapeViolations(violations),
    buckets,
    stats,
    distribution: {
      hardMax: SHAPE_HARD_MAX,
      fragmentRatio: buckets['40to79'].ratio,
      fragmentLimit: Math.round(SHAPE_40_79_MAX_RATIO * 1000) / 10,
      mean,
      meanRange: stats.meanRange,
      countWithinPlan: !violations.some((row) => row.kind === 'count'),
      passed: violations.length === 0,
    },
  };
}

/** 违规按类型计数：分布校验下只保留这七类。 */
const SHAPE_KINDS = [
  'count',
  'too_long',
  'fragment_ratio',
  'short_run',
  'avg',
  'dialogue_stack',
  'corner_quote',
];

function summarizeShapeViolations(violations) {
  const summary = { total: 0 };
  for (const kind of SHAPE_KINDS) summary[kind] = 0;
  for (const row of violations || []) {
    const kind = String(row && row.kind ? row.kind : '');
    if (!kind) continue;
    summary[kind] = (summary[kind] || 0) + 1;
    summary.total += 1;
  }
  return summary;
}

/**
 * 交付判定：分布校验。
 *
 * 与 checkParagraphShape 同一口径，不再有「逐段 80–140」的土办法：
 *   - hardBlocked：单段 >320；
 *   - distributionOk：40–79 占比、段均、每拍段数、连续短段都在范文范围内；
 *   - styleOk：对白堆叠、直角引号；
 *   - passed：以上全部通过。
 *
 * @param {Object} shape checkParagraphShape 的返回值
 */
function evaluateShapeDelivery(shape) {
  const summary = shape && shape.summary
    ? shape.summary
    : summarizeShapeViolations(shape && shape.violations);
  const blocking = shape && Array.isArray(shape.violations) ? shape.violations : [];
  const hardBlocked = blocking.some((row) => row.kind === 'too_long');
  const distributionOk = !blocking.some((row) =>
    ['count', 'fragment_ratio', 'short_run', 'avg'].includes(row.kind)
  );
  const styleOk = !blocking.some((row) =>
    ['dialogue_stack', 'corner_quote'].includes(row.kind)
  );
  return {
    hardBlocked,
    distributionOk,
    styleOk,
    passed: shape && shape.applicable && blocking.length === 0,
    blocking,
    summary,
    buckets: (shape && shape.buckets) || {},
    stats: (shape && shape.stats) || null,
    distribution: (shape && shape.distribution) || null,
  };
}

/**
 * 扩写与重写共用的验收口径。
 *
 * 尺子与交付完全一致（同一个 evaluateShapeDelivery）：40–79 字段本身不算
 * 问题，只有单段 >320、连续 3 段 <40、40–79 占比超 38.9% 才拦。
 *
 * 与交付唯一的差别是比法：交付判「全章现状」，这里判「这次改动新造出来的
 * 违规」。全章本来就有 40–79 超额时，不能因此把一次有效的扩写整组拒掉——
 * 那正是线上扩写一次都不生效的原因（模型给出 41–85 字段就被判不合格）。
 *
 * @param {Object} before 改动前的交付判定
 * @param {Object} after 改动后的交付判定
 * @param {string[]} ownedBeatIds 本次改动涉及的拍
 * @returns {string[]} 新造出来的违规（空数组表示通过）
 */
function shapeAcceptProblems(before, after, ownedBeatIds) {
  const problems = [];
  const owned = new Set(ownedBeatIds || []);
  const beforeBlocking = (before && before.blocking) || [];
  const afterBlocking = (after && after.blocking) || [];

  const countKind = (rows, kind) => rows.filter((row) => row.kind === kind).length;

  const longBefore = countKind(beforeBlocking, 'too_long');
  const longAfter = countKind(afterBlocking, 'too_long');
  if (longAfter > longBefore) {
    problems.push(`新增 ${longAfter - longBefore} 段超过 ${SHAPE_HARD_MAX} 字`);
  }

  const runBefore = countKind(beforeBlocking, 'short_run');
  const runAfter = countKind(afterBlocking, 'short_run');
  if (runAfter > runBefore) {
    problems.push(
      `新增 ${runAfter - runBefore} 处连续 ${SHAPE_SHORT_RUN} 段不足 ${SHAPE_SHORT_FRAGMENT_MAX} 字`
    );
  }

  // 段数按拍 ±2 是排布约束，在新增段验收（filterAppendParagraphs）与重写指令里判，
  // 这里不重复：整章区间是按权重反推的，同一次改动会让别的拍跟着漂。

  const limit = (after && after.distribution && after.distribution.fragmentLimit) || 0;
  const ratioBefore = (before && before.distribution && before.distribution.fragmentRatio) || 0;
  const ratioAfter = (after && after.distribution && after.distribution.fragmentRatio) || 0;
  if (ratioBefore <= limit && ratioAfter > limit) {
    problems.push(`40–79 字段占比 ${ratioAfter}%（上限 ${limit}%）`);
  }

  return problems;
}

/**
 * 把一组形态违规压缩成给写手看的一句话，同类只报数量，不逐段罗列。
 */
function describeShapeViolations(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const count = list.find((row) => row.kind === 'count');
  const parts = [];
  if (count) parts.push(`实际 ${count.actual} 段，目标是 ${count.expected}±${count.tolerance} 段`);
  const ratio = list.find((row) => row.kind === 'fragment_ratio');
  if (ratio) parts.push(`40–79 字段占 ${ratio.ratio}%（上限 ${ratio.limit}%）`);
  const avg = list.find((row) => row.kind === 'avg');
  if (avg) parts.push(`段均 ${avg.mean}，范文区间 ${avg.range[0]}–${avg.range[1]}`);
  const tooLong = list.filter((row) => row.kind === 'too_long').length;
  if (tooLong) parts.push(`有 ${tooLong} 段超过 320 字`);
  const shortRun = list.find((row) => row.kind === 'short_run');
  if (shortRun) parts.push(`有连续 ${shortRun.run} 段不足 40 字`);
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
  let budgetExhaustedBy = '';
  let continuationSkipped = 0;
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
      budgetExhaustedBy = 'draft';
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
    //
    // 续写是四类调用里最低优先级：必须给后面尚未起稿的组留出初稿调用。
    // 旧逻辑只看 callCount < maxCalls，3 组时前两组各续写一次就把 8 次预算
    // 吃掉了 6 次，轮到形态重写只剩 2 次，扩写直接为 0。
    const remainingInitials = groups.length - 1 - groups.indexOf(group);
    const needsMore =
      needsContinuation(group, closingHit) && countWords(group.content) < group.targetChars;
    const canContinue = callCount + 1 + remainingInitials <= maxCalls;
    if (needsMore && !canContinue) {
      continuationSkipped += 1;
    }
    if (needsMore && canContinue) {
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
    budgetExhaustedBy,
    continuationSkipped,
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
 * 重写后本组字数低于原稿的这个比例，就整组回滚。
 *
 * 取舍写死在这里：内容不缩水优先于段落形态。宁可有几段超长，
 * 也不许一次「修形状」把本组砍掉 15% 以上——实测重写能把全章从 4,608 压到 2,823。
 */
const REWRITE_SHRINK_RATIO = 0.85;

/**
 * 只重写缺拍/写得弱/违规的拍。
 *
 * 其他拍与其他组按快照原样拼回——整组重写会把合格部分一起洗一遍，
 * 实测一次能把全章从 6,679 字压到 4,128；调用次数也会直接顶到上限。
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
  expandShots = [],
  log = () => {},
  progress = () => {},
}) {
  const calls = [];
  let count = callCount;
  let degraded = '';
  let budgetExhaustedBy = '';
  const skippedGroups = [];
  let finishReason = 'stop';
  let rewroteGroups = 0;
  let boundaryTrimmed = 0;
  const failedGroups = [];
  // 按组记账：重写后本组低于原稿 85% 就回滚，逐组留痕（组/拍/前后/差值/原因）。
  const groupDeltas = [];
  const rewriteReverted = [];

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
    ...(expandShots || []).map((shot) => shot && shot.id).filter(Boolean),
  ];
  const wanted = new Set(missingIds);
  const factsOnly = !groupsForIds(groups, missingIds).length && (mustReveal || []).length > 0;
  const affected = factsOnly ? groups.slice(0, 1) : groupsForIds(groups, missingIds);

  for (const group of affected) {
    const beats = factsOnly ? group.beats : group.beats.filter((beat) => wanted.has(beat.id));
    if (!beats.length) continue;

    // 预算表切死的重写配额：到顶只交付已改的组，剩余组必须记名，
    // 不能只写一句「到上限」——线上就是这样把「重写吃光预算」藏起来的。
    if (count >= maxCalls) {
      degraded = 'call_limit';
      budgetExhaustedBy = 'rewrite';
      skippedGroups.push(group.index);
      continue;
    }

    progress({ phase: 'rewrite', index: group.index, total: groups.length, beatIds: beats.map((b) => b.id) });
    const before = groups
      .filter((g) => g.index < group.index)
      .map((g) => g.content)
      .filter(Boolean)
      .join('\n\n');
    const afterGroup = groups.find((g) => g.index === group.index + 1);
    const nextHead = afterGroup ? splitParagraphs(afterGroup.content).slice(0, 2).join('\n\n') : '';

    // 替换前的本组原稿：回滚时原样放回。
    const snapshot = group.content;

    const instruction = buildBeatRewriteInstruction({
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
      expandShots: factsOnly ? [] : (expandShots || []),
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
    // 重写按原因记账：形态 / 缺拍（含弱拍、重复、补事实）/ 禁写。
    // 同一组同时有多类问题时仍只发一次请求，所以这里记的是「这次请求覆盖了哪些原因」。
    const shapeSet = new Set(shapeIds);
    const reasons = [];
    if (beats.some((beat) => shapeSet.has(beat.id))) reasons.push('shape');
    if (!factsOnly && beats.some((beat) => (coverage?.missing || []).includes(beat.id) || weakIds.includes(beat.id) || dupIds.includes(beat.id))) reasons.push('missing');
    if (!factsOnly && beats.some((beat) => (mustWithholdIds || []).includes(beat.id) || conflictIds.includes(beat.id))) reasons.push('forbidden');
    const entry = {
      call: count,
      kind: 'rewrite',
      group: group.index,
      beatIds: beats.map((beat) => beat.id),
      reasons,
      durationMs,
      finishReason: out?.finishReason || '',
      chars: countWords(content),
      usage: out?.usage || null,
    };
    calls.push(entry);
    log(entry);
    if (out?.finishReason) finishReason = out.finishReason;

    const rows = expandedBeatsFrom(out, beats.map((beat) => ({ id: beat.id })));
    if (!rows.length) {
      failedGroups.push(group.index);
      continue;
    }

    // 只清洗点名拍的正文；同组其他拍连一个字都不碰。
    const cleaned = rows
      .map((row) => {
        const joined = row.paragraphs.join('\n\n');
        const safe = group.isLast ? joined : stripClosingTail(joined);
        const bounded = enforceGroupBoundary({ content: safe, group, groups });
        if (bounded.boundaryTrimmed) boundaryTrimmed += 1;
        return { id: row.id, paragraphs: splitParagraphs(bounded.content) };
      })
      .filter((row) => row.paragraphs.length);

    // 写回前的全章交付判定：作为「这次重写新造了哪些违规」的对照基线。
    const beforeDelivery = evaluateShapeDelivery(
      checkParagraphShape(plan, composeChapterContent({ groups, existingBody, mergeScenes }).content)
    );
    group.content = snapshot;
    if (!cleaned.length) {
      failedGroups.push(group.index);
      continue;
    }
    // 先按真实拍边界切出各拍段落，再把点名拍换成模型新写的段。
    // 用真实边界而不是拼接后按权重反推：反推会把段数摊到没重写的拍上，
    // 瘦身看起来达标、扩写按真实拍算名额时依然没有位置。
    const baseParagraphs = splitParagraphs(snapshot);
    const baseRanges = beatParagraphRanges(group.beats, baseParagraphs.length);
    const byId = new Map(cleaned.map((row) => [row.id, row.paragraphs]));
    const chunks = group.beats.map((beat, index) => {
      const next = byId.get(beat.id);
      if (next && next.length) return next.slice();
      const [from, to] = baseRanges[index] || [0, 0];
      return baseParagraphs.slice(from, to);
    });
    // 先按拍瘦身，再判净增：把重写拆碎的段合回去，别让「段数超」白触发整组回滚。
    // 合并只减不删，形态改好的部分保住；合不动才在下面按段数回滚。
    // 瘦身收到「计划段数」而不是「计划 +2」：那 ±2 正是扩写要用的追加名额。
    const trim = trimBeatParagraphs(group, plan, beats.map((beat) => beat.id), { chunks });

    const afterDelivery = evaluateShapeDelivery(
      checkParagraphShape(plan, composeChapterContent({ groups, existingBody, mergeScenes }).content)
    );
    // 形态验收与交付同一把尺子：只拦这次重写新造出来的 >320、连续 3 段 <40、
    // 40–79 超配额。全章本来就有的问题不该由一次重写背锅。
    const shapeProblems = shapeAcceptProblems(
      beforeDelivery,
      afterDelivery,
      beats.map((beat) => beat.id)
    );
    // 内容不缩水优先于段落形态：本组被砍掉 15% 以上就整组回滚。
    // 形态/禁写问题保留原状，由交付自检如实报出——不因为回滚就把违规报成通过。
    const groupBeforeChars = countWords(snapshot);
    const groupAfterChars = countWords(group.content);
    const groupRatio = groupBeforeChars
      ? Math.round((groupAfterChars / groupBeforeChars) * 1000) / 1000
      : 1;
    const groupDelta = groupAfterChars - groupBeforeChars;
    const beatIdsOfGroup = beats.map((beat) => beat.id);
    const shrinkReason = groupRatio < REWRITE_SHRINK_RATIO
      ? `重写后 ${groupAfterChars}/${groupBeforeChars} 字（${Math.round(groupRatio * 100)}%），低于原稿 85%`
      : '';
    // 瘦身之后仍超容差：说明同拍里找不到能合的一对（每对合并都会超 140 字），
    // 这时才回滚，并在原因里写明是段数问题而不是缩水。
    const countReason = trim.overflow > 0
      ? `重写后段数仍超出计划 ±${SHAPE_BEAT_TOLERANCE}（多 ${trim.overflow} 段，无法再合并）`
      : '';
    if (groupBeforeChars > 0 && (shrinkReason || shapeProblems.length || countReason)) {
      group.content = snapshot;
      rewriteReverted.push({
        group: group.index,
        beatIds: beatIdsOfGroup,
        before: groupBeforeChars,
        after: groupAfterChars,
        delta: groupDelta,
        ratio: groupRatio,
        reason: [shrinkReason, countReason, ...shapeProblems].filter(Boolean).join('；'),
        shapeProblems,
        trimmed: trim.merged,
      });
      groupDeltas.push({
        group: group.index,
        beatIds: beatIdsOfGroup,
        before: groupBeforeChars,
        after: groupAfterChars,
        delta: groupDelta,
        ratio: groupRatio,
        trimmed: trim.merged,
        reverted: true,
      });
      continue;
    }
    groupDeltas.push({
      group: group.index,
      beatIds: beatIdsOfGroup,
      before: groupBeforeChars,
      after: groupAfterChars,
      delta: groupDelta,
      ratio: groupRatio,
      trimmed: trim.merged,
      reverted: false,
    });
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
    budgetExhaustedBy,
    skippedGroups,
    rewroteGroups,
    failedGroups,
    boundaryTrimmed,
    groupDeltas,
    rewriteReverted,
    truncated: normalized.truncated,
    originalChars: normalized.originalChars,
    chars: normalized.chars,
    charsBeforeMerge: beforeNormalized.chars,
    finishReason,
    usage: usageSum(calls),
  };
}


/** 扩写过的拍：交付时低于目标 95% 才记 underFilledShots（95%–100% 不打扰作者）。 */
const SHOT_RECORD_RATIO = 0.95;

/**
 * 扩写有效性的最低净增比例。
 *
 * 目标缺口 700 字、模型只补了 100 字，这种「换了个说法」的扩写既没把拍写长，
 * 又占掉一次调用预算——判为无效，不写回、不计入已扩写。
 */
const EXPAND_MIN_NET_RATIO = 0.5;

/**
 * 扩写指令：只点名不足的拍，只让它返回新增段落。
 *
 * 扩写不能走整拍重写——模型一旦「重写」就会顺手删句子，实测两次扩写
 * 分别少了 148 与 228 字。这里把任务改成「只追加」，拼接交给代码，
 * 并写清本次最多还能加几段（计划 ±2）。
 */
function buildExpandInstruction({ group, groups, beats, shots, feedback = '' }) {
  const shotById = new Map((shots || []).map((shot) => [shot.id, shot]));
  // 每拍现有段数：段数上限按计划 ±2，超了先丢新增段，不丢原稿。
  const paragraphs = splitParagraphs(group.content);
  const ranges = beatParagraphRanges(group.beats, paragraphs.length);
  const haveById = new Map();
  group.beats.forEach((beat, index) => {
    const [from, to] = ranges[index] || [0, 0];
    haveById.set(beat.id, Math.max(0, to - from));
  });
  const rows = (beats || []).map((beat) => {
    const shot = shotById.get(beat.id);
    const planned = Number(beat.paragraphs) || 0;
    const have = haveById.get(beat.id) || 0;
    const room = planned ? Math.max(0, planned + SHAPE_BEAT_TOLERANCE - have) : planned;
    const target = Number(shot && shot.target) || 0;
    const current = Number(shot && shot.chars) || 0;
    const gap = Math.max(0, target - current);
    return (
      `- ${beat.id}：目标 ${target || '?'} 字，现在 ${shot ? current : '?'} 字，还差 ${gap} 字；` +
      `本拍现有 ${have} 段、计划 ${planned} 段，本次最多再加 ${room} 段。`
    );
  });
  return [
    `## 只给第 ${group.index + 1}/${groups.length} 组的 ${(beats || []).map((b) => b.id).join('、')} 追加正文`,
    '',
    '## 只追加，不重写',
    '你只返回**新增的段落**，不要返回这一拍已有的段落，也不要改写已有段落。',
    '系统会把新增段落按顺序接在该拍末尾；原有正文一个字都不会被替换。',
    '',
    '## 本次目标',
    '按上面的差额补足，补到目标即可，不要超目标 10% 以上。',
    '',
    '## 写法',
    '1. 每段 80–140 字（含标点），只写环境、动作、器物、人物心理、对白往复。',
    '2. 本次最多再加的段数写在上面；宁可按上限少给，也不要超出。',
    '3. 不要重复已有段落里写过的话，不要写总结句，不要用空段、拆句或加标点凑字数。',
    '4. 只补细节，不推进情节、不新增事件、不提前揭示本章悬念。',
    '',
    '## 每拍余量',
    ...rows,
    feedback ? `\n## 上一次的问题（必须改掉）\n${feedback}` : null,
    '',
    '输出 JSON：{"action":"append","beats":[{"id":"B3","paragraphs":["新增段一","新增段二"]}]}',
    'beats 只放上面点名的拍；paragraphs 只放这一次新增的段落，不要复制该拍原有正文。',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * 新增段落逐段验收：不合格的只丢那一段，其余照常拼接。
 *
 * 只做两件与交付一致的检查：单段含标点不超过 140 字；不制造连续 3 段 <40 字。
 * 段数按计划 ±2 收口——超了就丢新增段，绝不回头删原稿。
 *
 * @param {Object} opts
 * @param {string[]} opts.tail 该拍已有段落（只看末尾两段就够判断连续短段）
 * @param {string[]} opts.additions 模型返回的新增段落
 * @param {number} opts.capacity 本次最多还能加几段
 */
function filterAppendParagraphs({ tail = [], additions = [], capacity = Infinity }) {
  const kept = [];
  const dropped = [];
  const shortChars = () => {
    const history = [...tail.map((p) => countWords(p)), ...kept.map((p) => countWords(p))];
    let run = 0;
    for (let i = history.length - 1; i >= 0 && history[i] < SHAPE_SHORT_FRAGMENT_MAX; i -= 1) {
      run += 1;
    }
    return run;
  };

  (additions || []).forEach((paragraph, index) => {
    const text = String(paragraph || '').trim();
    const chars = countWords(text);
    if (!chars) {
      dropped.push({ index, chars, reason: '是空段' });
      return;
    }
    if (chars > SHAPE_PARAGRAPH_MAX) {
      dropped.push({ index, chars, reason: `${chars} 字超过 ${SHAPE_PARAGRAPH_MAX}` });
      return;
    }
    if (kept.length >= capacity) {
      dropped.push({ index, chars, reason: '超出本拍段数上限' });
      return;
    }
    if (chars < SHAPE_SHORT_FRAGMENT_MAX && shortChars() + 1 >= SHAPE_SHORT_RUN) {
      dropped.push({ index, chars, reason: `会形成连续 ${SHAPE_SHORT_RUN} 段不足 ${SHAPE_SHORT_FRAGMENT_MAX} 字` });
      return;
    }
    kept.push(text);
  });

  return { kept, dropped };
}

/** 从模型返回里取出逐拍正文；没按 JSON 返回时，单拍整段正文就是该拍。 */
function expandedBeatsFrom(out, shots) {
  const rows = out && out.parsed && Array.isArray(out.parsed.beats) ? out.parsed.beats : [];
  const parsed = rows
    .map((row) => {
      const id = String((row && row.id) || '').trim();
      const paragraphs = Array.isArray(row && row.paragraphs)
        ? row.paragraphs.map((p) => String(p || '').trim()).filter(Boolean)
        : splitParagraphs(String((row && row.content) || ''));
      return { id, paragraphs };
    })
    .filter((row) => row.id && row.paragraphs.length);
  if (parsed.length) return parsed;
  if ((shots || []).length === 1) {
    return [{ id: shots[0].id, paragraphs: splitParagraphs(String((out && out.content) || '')) }];
  }
  return [];
}

/** 扩写段落只差 1–4 字到 80 时，就地补一句，不整次回滚。 */
const MICRO_PATCH_MAX_SHORTFALL = 4;

function microPatchNearMiss(paragraphs) {
  const patches = [];
  paragraphs.forEach((paragraph, index) => {
    const before = countWords(paragraph);
    const shortfall = SHAPE_PARAGRAPH_MIN - before;
    if (shortfall < 1 || shortfall > MICRO_PATCH_MAX_SHORTFALL) return;
    const sentence = paragraph.includes('雪')
      ? '雪还在下。'
      : /[”"]\s*$/.test(paragraph)
        ? '他没有再问。'
        : '屋里静了一瞬。';
    paragraphs[index] = `${paragraph}${sentence}`;
    patches.push({ index, before, after: countWords(paragraphs[index]), patch: sentence });
  });
  return patches;
}

/**
 * 把新增段落接到对应拍末尾，其他拍一字不动。
 *
 * 扩写只走这一条路：模型给的是「新增」，代码负责拼，结构上不可能比原稿短。
 */
function appendExpandedBeats(group, additions) {
  const paragraphs = splitParagraphs(group.content);
  const ranges = beatParagraphRanges(group.beats, paragraphs.length);
  const chunks = ranges.map(([from, to]) => paragraphs.slice(from, to));
  const byId = new Map((additions || []).map((row) => [row.id, row.paragraphs]));
  let appended = 0;
  group.beats.forEach((beat, index) => {
    const extra = byId.get(beat.id);
    if (!extra || !extra.length) return;
    chunks[index] = [...chunks[index], ...extra];
    appended += extra.length;
  });
  if (!appended) return false;
  group.content = chunks.flat().join('\n\n');
  return true;
}

/**
 * 重写后段数超计划 ±2 时，按拍瘦身。
 *
 * 重写常把一段拆成两三段"匀"出来，段数一超，扩写那边就没有追加名额了
 * （扩写规则：段数到顶只丢新增段）。整组回滚又会把已经改好的形态一起丢掉，
 * 所以这里只做合并不做删除：把同拍内相邻的短段、或明显是从一句拆出来的
 * 碎段并回上一段。
 *
 * 三条硬约束：
 *   - 合并不删字，只调段落切分（一个字都不改）。
 *   - 合并只发生在同一拍内部，不跨拍合并（跨拍会串掉节拍边界）。
 *   - 合并后不超过 320 字（交付唯一硬拦），且不低于 40 字（不新造碎段）。
 *
 * 收口目标是「计划段数」而不是「计划 +2」：±2 那点余量正是扩写阶段要用的
 * 追加名额，瘦身停在 +2 等于把名额又吃光，扩写照样被堵死。
 * 段数本来就少于计划的拍不动（不拆段）。
 *
 * 为什么按拍收而不是按整组总数收：整组总数达标时，某一拍仍可能超容差，
 * 而扩写的名额是按**组内拍区间**算的——组内看着够、扩写照样没名额，
 * 这正是「扩写被堵死」的真正来源。
 *
 * @param {Object} options
 * @param {string[][]} [options.chunks] 每拍的真实段落（重写拍是模型新给的，
 *        其余拍是原稿切出来的）。不给就按拍区间反推。
 * @returns {{merged: number, mergedByBeat: Object, overflow: number, overflowBeats: Array}}
 *          merged 是合并次数；overflow 是瘦身后仍超出容差的段数（>0 说明
 *          合不回来了，这组只能回滚）；overflowBeats 记是哪几拍合不动。
 */
function trimBeatParagraphs(group, plan, rewrittenBeatIds, options = {}) {
  const beats = Array.isArray(group.beats) ? group.beats : [];
  const planBeats = Array.isArray(plan?.beats) ? plan.beats : [];
  const plannedById = new Map(planBeats.map((beat) => [beat.id, Number(beat.paragraphs) || 0]));
  const rewritten = new Set(rewrittenBeatIds || []);
  const plannedOf = (beat) => plannedById.get(beat.id) || Number(beat.paragraphs) || 0;

  // 每拍的真实段落：重写拍是模型新给的，其余拍按原稿拍区间切出来。
  let chunks;
  if (Array.isArray(options.chunks) && options.chunks.length === beats.length) {
    chunks = options.chunks.map((chunk) => [...chunk]);
  } else {
    const paragraphs = splitParagraphs(group.content);
    const ranges = beatParagraphRanges(beats, paragraphs.length);
    chunks = beats.map((beat, index) => {
      const [from, to] = ranges[index] || [0, 0];
      return paragraphs.slice(from, to);
    });
  }

  /** 在本拍里挑一对最该合的相邻段。 */
  const pickPair = (paragraphs) => {
    let best = null;
    for (let i = 0; i < paragraphs.length - 1; i += 1) {
      const left = countWords(paragraphs[i]);
      const right = countWords(paragraphs[i + 1]);
      const combined = left + right;
      // 合完不能超 320 字（交付硬拦），也不能还是碎段（<40 字）。
      if (combined > SHAPE_HARD_MAX || combined < SHAPE_SHORT_FRAGMENT_MAX) continue;
      // 优先合出 80–140 字的段（范文主力区间），其次合短的。
      const score = [combined > SHAPE_PARAGRAPH_MAX ? 1 : 0, combined];
      if (
        !best ||
        score[0] < best.score[0] ||
        (score[0] === best.score[0] && score[1] < best.score[1])
      ) {
        best = { i, score };
      }
    }
    return best;
  };

  let merged = 0;
  const mergedByBeat = {};
  beats.forEach((beat, index) => {
    // 只动被重写的拍：没重写的拍一个字都不碰。
    if (!rewritten.has(beat.id)) return;
    const planned = plannedOf(beat);
    const paragraphs = chunks[index];
    if (!planned || !paragraphs.length || paragraphs.length <= planned) return;
    let guard = 0;
    while (paragraphs.length > planned && guard < 200) {
      const pair = pickPair(paragraphs);
      if (!pair) break;
      paragraphs.splice(pair.i, 2, `${paragraphs[pair.i]}${paragraphs[pair.i + 1]}`);
      merged += 1;
      guard += 1;
      mergedByBeat[beat.id] = (mergedByBeat[beat.id] || 0) + 1;
    }
  });

  group.content = chunks.flat().join('\n\n');

  // 瘦身后仍超容差（计划 +2）：这一组合不回来了，交给回滚判断。
  const overflowBeats = beats
    .map((beat, index) => {
      if (!rewritten.has(beat.id)) return null;
      const planned = plannedOf(beat);
      if (!planned) return null;
      const count = chunks[index].length;
      const limit = planned + SHAPE_BEAT_TOLERANCE;
      if (count <= limit) return null;
      return { beatId: beat.id, count, limit, excess: count - limit };
    })
    .filter(Boolean);
  const overflow = overflowBeats.reduce((sum, row) => sum + row.excess, 0);
  return { merged, mergedByBeat, overflow, overflowBeats };
}

/**
 * 篇幅扩写：只对判定不足的拍发起，其他拍原样保留。
 *
 * 模型只返回**新增段落**，代码按拍接在原稿末尾——不再让它重写整拍，
 * 所以结构上不会出现「扩写后反而更短」。新增段逐段验收：单段 >140 字、
 * 会凑成连续 3 段 <40 字、或超出计划段数 ±2 的，只丢那几段，保留合格部分。
 *
 * 拼接后仍按净增判据验收：不足缺口一半就整拍不写回，记 expandIneffective
 * 并退回调用名额（这次调用没产出可用内容，不该占预算）。
 *
 * 追加会改变全章的拍区间：第一遍跑完必须用 measureShots 重算每拍字数，
 * 把新掉到 85% 以下的拍补进第二遍（同一轮只补一次，不无限循环）。
 */
async function expandMissingBeats({
  plan,
  groups,
  expandShots = [],
  runSegment,
  maxCalls = MAX_SEGMENT_CALLS,
  callCount = 0,
  mergeScenes = true,
  measureShots = null,
  log = () => {},
  progress = () => {},
}) {
  const shots = (expandShots || []).filter((shot) => shot && shot.id);
  const allShots = shots.map((shot) => ({ ...shot }));
  const calls = [];
  let count = callCount;
  let degraded = '';
  let budgetExhaustedBy = '';
  const skippedGroups = [];
  let finishReason = 'stop';
  const expanded = [];
  const unconverged = [];
  const expandRejected = [];
  const expandIneffective = [];
  let refundedCalls = 0;
  const supplemented = [];
  const microPatched = [];

  let passShots = shots;
  const acceptedBeatIds = new Set();
  const feedbackHistory = new Map();

  for (let pass = 0; passShots.length && pass < 2; pass += 1) {
    const affected = groupsForIds(groups, passShots.map((shot) => shot.id));

    // 每轮先给每个待补的组各一次机会（广度优先），预算不够时不会让第一组
    // 把两次额度吃光、后面的组一次都轮不到。第二次尝试放在下一轮。
    for (const group of affected) {
      const groupShots = passShots.filter((shot) => group.beatIds.includes(shot.id));
      const beats = group.beats.filter((beat) => groupShots.some((shot) => shot.id === beat.id));
      if (!beats.length) continue;

      const snapshot = group.content;
      let feedback = feedbackHistory.get(group.index) || '';
      let accepted = false;
      let lastProblems = [];
      let ineffectiveOnly = false;

      // 先算名额，再决定要不要发请求。
      //
      // 名额 = 计划段数 ±2 − 现有段数；已经到顶的拍再发请求，模型只会被告知
      // 「最多再加 0 段」，回来多半是空回复——那会被误记成「新增段不合格」，
      // 看不出真正的堵点是「重写把这一拍撑满了、没留位置」。
      const snapshotParagraphs = splitParagraphs(snapshot);
      const snapshotRanges = beatParagraphRanges(group.beats, snapshotParagraphs.length);
      const haveById = new Map();
      group.beats.forEach((beat, index) => {
        const [from, to] = snapshotRanges[index] || [0, 0];
        haveById.set(beat.id, Math.max(0, to - from));
      });
      const capacityOf = (beat) => {
        const planned = Number(beat.paragraphs) || 0;
        const have = haveById.get(beat.id) || 0;
        return planned ? Math.max(0, planned + SHAPE_BEAT_TOLERANCE - have) : Infinity;
      };
      const blockedBeats = beats.filter((beat) => capacityOf(beat) === 0);
      if (blockedBeats.length) {
        const detail = blockedBeats
          .map((beat) => {
            const planned = Number(beat.paragraphs) || 0;
            return `${beat.id}: 本拍已有 ${haveById.get(beat.id) || 0} 段，已到计划 ${planned} ±${SHAPE_BEAT_TOLERANCE} 的上限，没有追加名额`;
          })
          .join('\n');
        for (const beat of blockedBeats) {
          const planned = Number(beat.paragraphs) || 0;
          const have = haveById.get(beat.id) || 0;
          expandRejected.push({
            group: group.index,
            beatId: beat.id,
            attempt: pass + 1,
            call: count,
            paragraphCount: 0,
            paragraphLengths: [],
            capacity: 0,
            blocked: 'no_capacity',
            dropped: [],
            problems: [`本拍已有 ${have} 段，已到计划 ${planned} ±${SHAPE_BEAT_TOLERANCE} 的上限，没有追加名额`],
          });
        }
        lastProblems = detail.split('\n');
        feedbackHistory.set(group.index, detail);
      }
      const openBeats = beats.filter((beat) => capacityOf(beat) !== 0);
      // 这一组一个可追加的拍都没有：不发请求，也不占调用名额。
      if (!openBeats.length) continue;

      if (count >= maxCalls) {
        degraded = 'call_limit';
        budgetExhaustedBy = 'expand';
        skippedGroups.push(group.index);
        break;
      }
      progress({ phase: 'expand', index: group.index, total: groups.length, beatIds: openBeats.map((b) => b.id) });
      const instruction = buildExpandInstruction({ group, groups, beats: openBeats, shots: groupShots, feedback });
      count += 1;
      const startedAt = Date.now();
      let out;
      try {
        out = await runSegment({ instruction, group, kind: 'expand', callIndex: count });
      } catch (err) {
        if (err.name === 'AbortError' || err.code === 'AI_ABORTED') throw err;
        degraded = err.code === 'AI_TIMEOUT' ? 'timeout' : 'error';
        break;
      }

      const entry = {
        call: count,
        kind: 'expand',
        group: group.index,
        beatIds: openBeats.map((b) => b.id),
        durationMs: Date.now() - startedAt,
        finishReason: out?.finishReason || '',
        chars: countWords(String(out?.content || '')),
        attempt: pass + 1,
        usage: out?.usage || null,
      };
      calls.push(entry);
      log(entry);
      if (out?.finishReason) finishReason = out.finishReason;

      const rows = expandedBeatsFrom(out, groupShots);

      // Y3：新增段只差 1–4 字到 80 时就地补一句，再验收。
      const patches = [];
      for (const row of rows) {
        for (const patch of microPatchNearMiss(row.paragraphs)) {
          patches.push({ beatId: row.id, ...patch });
          microPatched.push({ group: group.index, beatId: row.id, call: count, ...patch });
        }
      }
      if (patches.length) entry.microPatched = patches;

      /**
       * 追加式扩写：模型只给新增段落，代码按拍接在原稿末尾。
       *
       * 这样结构上不可能出现「比原稿短」——旧实现是让模型重写整拍，
       * 实测两次扩写分别少 148 与 228 字，整次白跑又把名额占掉。
       * 新增段逐段验收，不合格的只丢那几段，保留合格部分。
       */
      const beforeParagraphs = splitParagraphs(snapshot);
      const beforeRanges = beatParagraphRanges(group.beats, beforeParagraphs.length);
      const beforeChars = new Map();
      const beforeSlices = new Map();
      group.beats.forEach((beat, index) => {
        const [from, to] = beforeRanges[index] || [0, 0];
        const slice = beforeParagraphs.slice(from, to);
        beforeChars.set(beat.id, countWords(slice.join('')));
        beforeSlices.set(beat.id, slice);
      });
      const shotTargets = new Map((shots || []).map((shot) => [shot.id, Number(shot.target) || 0]));

      const problems = [];
      const additions = [];
      const ineffective = [];
      for (const beat of openBeats) {
        const row = rows.find((item) => item.id === beat.id);
        if (!row) {
          problems.push(`${beat.id}: 没有返回新增段落`);
          expandRejected.push({
            group: group.index,
            beatId: beat.id,
            attempt: pass + 1,
            call: count,
            paragraphCount: 0,
            paragraphLengths: [],
            blocked: 'invalid',
            dropped: [],
            problems: ['没有返回新增段落'],
          });
          continue;
        }
        // 名额在调用前就算好了：能进这个循环的拍至少还有 1 段位置。
        const capacity = capacityOf(beat) === Infinity ? row.paragraphs.length : capacityOf(beat);
        const verdict = filterAppendParagraphs({
          tail: beforeSlices.get(beat.id) || [],
          additions: row.paragraphs,
          capacity,
        });
        if (verdict.dropped.length) {
          const detail = verdict.dropped.map((item) => `第 ${item.index + 1} 段${item.reason}`);
          problems.push(...detail.map((text) => `${beat.id}: ${text}`));
          expandRejected.push({
            group: group.index,
            beatId: beat.id,
            attempt: pass + 1,
            call: count,
            paragraphCount: row.paragraphs.length,
            paragraphLengths: row.paragraphs.map((paragraph) => countWords(paragraph)),
            capacity,
            // 名额本来有、只是被不合格段吃光 → 算「新增段不合格」；
            // 段落本身没问题只是名额不够 → 算段数上限。
            blocked: verdict.dropped.every((item) => /段数上限/.test(item.reason))
              ? 'capacity_exhausted'
              : 'invalid',
            dropped: verdict.dropped,
            problems: detail,
          });
        }
        if (!verdict.kept.length) continue;

        const before = beforeChars.get(beat.id) || 0;
        const net = countWords(verdict.kept.join(''));
        const target = shotTargets.get(beat.id) || 0;
        const gap = Math.max(0, target - before);
        if (gap > 0 && net < gap * EXPAND_MIN_NET_RATIO) {
          ineffective.push({ beatId: beat.id, before, after: before + net, net, gap, target });
        } else {
          additions.push({ id: beat.id, paragraphs: verdict.kept });
        }
      }

      if (problems.length) {
        lastProblems = problems;
        feedback = problems.join('\n');
        feedbackHistory.set(group.index, feedback);
      }

      if (ineffective.length) {
        expandIneffective.push({
          group: group.index,
          call: count,
          attempt: pass + 1,
          beats: ineffective,
          net: ineffective.reduce((sum, item) => sum + item.net, 0),
          gap: ineffective.reduce((sum, item) => sum + item.gap, 0),
        });
        feedback = ineffective
          .map(
            (item) =>
              `${item.beatId}: 净增 ${item.net} 字，缺口 ${item.gap} 字，至少要补 ${Math.ceil(item.gap * EXPAND_MIN_NET_RATIO)} 字`
          )
          .join('\n');
        feedbackHistory.set(group.index, feedback);
        lastProblems = feedback.split('\n');
        if (pass === 1) {
          unconverged.push({
            group: group.index,
            beatIds: ineffective.map((item) => item.beatId),
            problems: lastProblems,
          });
        }
        // 没有一段写够：这次调用不算数，把预算名额退回去，
        // 让还没轮到的组拿到机会（否则第一组能把预算吃光）。
        if (!additions.length) {
          count -= 1;
          refundedCalls += 1;
          ineffectiveOnly = true;
        }
      }

      if (additions.length) {
        appendExpandedBeats(group, additions);
        accepted = true;
        expanded.push({
          group: group.index,
          beatIds: additions.map((row) => row.id),
          attempt: pass + 1,
        });
        for (const row of additions) acceptedBeatIds.add(row.id);
      }

      if (!accepted && !ineffectiveOnly && !lastProblems.length) {
        group.content = snapshot;
        for (const beat of openBeats) {
          expandRejected.push({
            group: group.index,
            beatId: beat.id,
            attempt: pass + 1,
            call: count,
            paragraphCount: 0,
            paragraphLengths: [],
            blocked: 'invalid',
            dropped: [],
            problems: ['没有可用的新增段落'],
          });
        }
      }
      if (degraded) break;
    }

    if (degraded || pass === 1) break;

    // 第二轮：先保留仍被拒的拍（补一次），再加上扩写后重算发现的新欠额拍。
    // 同一轮内允许补一次，不无限循环。
    const stillShots = passShots.filter((shot) => !acceptedBeatIds.has(shot.id));
    let nextShots = stillShots;
    if (typeof measureShots === 'function') {
      const report = measureShots(composeChapterContent({ groups, mergeScenes }).content);
      if (report && report.applicable !== false) {
        const newly = findShortShots(plan, report).filter(
          (shot) => !allShots.some((item) => item.id === shot.id)
        );
        if (newly.length) {
          allShots.push(...newly);
          supplemented.push(...newly);
        }
        const byId = new Map();
        for (const shot of [...stillShots, ...newly]) byId.set(shot.id, shot);
        nextShots = [...byId.values()];
      }
    }
    if (!nextShots.length) break;
    passShots = nextShots;
  }

  const composed = composeChapterContent({ groups, mergeScenes });
  const normalized = normalizeChapterShape(composed.content);
  return {
    groups,
    content: normalized.content,
    contentBeforeMerge: composed.contentBeforeMerge,
    mergeScenes,
    mergedParagraphs: composed.mergedParagraphs,
    calls,
    callCount: count,
    degraded,
    budgetExhaustedBy,
    skippedGroups,
    finishReason,
    expanded,
    supplement: supplemented,
    unconverged,
    expandRejected,
    expandIneffective,
    refundedCalls,
    microPatched,
    truncated: normalized.truncated,
    originalChars: normalized.originalChars,
    chars: normalized.chars,
    usage: usageSum(calls),
  };
}

/**
 * 调用预算记账：按调用类别统计实际消耗，并把「哪一类把预算用掉」带出来。
 *
 * 交付时写进 beatCheck.callBudget。只写「达到上限」不够——线上那次
 * 看到的是 6 次起稿调用，真正把剩余预算用光的是形态重写，扩写一次没跑。
 */
function summarizeCallBudget(calls, options = {}) {
  const limit = Number(options.limit) || MAX_SEGMENT_CALLS;
  const byKind = { initial: 0, continuation: 0, rewrite: 0, expand: 0 };
  const rewriteReasons = {};
  for (const call of calls || []) {
    const kind = String(call && call.kind ? call.kind : 'unknown');
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (kind === 'rewrite' && Array.isArray(call.reasons)) {
      for (const reason of call.reasons) {
        rewriteReasons[reason] = (rewriteReasons[reason] || 0) + 1;
      }
    }
  }
  return {
    limit,
    used: (calls || []).length,
    remaining: Math.max(0, limit - (calls || []).length),
    quotas: { ...SEGMENT_CALL_BUDGET },
    byKind,
    rewriteReasons,
    exhaustedBy: options.exhaustedBy || '',
    skippedGroups: options.skippedGroups || [],
    continuationSkipped: Number(options.continuationSkipped) || 0,
    priority: ['initial', 'expand', 'rewrite', 'continuation'],
  };
}

/** 分段起稿降级时给作者看的徽标。 */
function segmentBadge(degraded, exhaustedBy = '') {
  if (!degraded) return '';
  if (degraded === 'call_limit') {
    const stage = { draft: '起稿', rewrite: '重写', expand: '扩写' }[exhaustedBy] || '';
    return stage
      ? `【分段起稿：${stage}的调用预算用尽，已交付已写部分】`
      : '【分段起稿：调用次数达到上限，已交付已写部分】';
  }
  if (degraded === 'timeout') return '【分段起稿：有分组超时，已交付已写部分】';
  if (degraded === 'empty') return '【分段起稿：有分组没有返回正文，已交付已写部分】';
  return '【分段起稿：有分组失败，已交付已写部分】';
}

module.exports = {
  MAX_BEATS_PER_GROUP,
  TARGET_CHAPTER_CHARS,
  MAX_CHAPTER_CHARS,
  MAX_SEGMENT_CALLS,
  SEGMENT_CALL_BUDGET,
  summarizeCallBudget,
  MIN_TARGET_RATIO,
  SHOT_FILL_RATIO,
  SHOT_RECORD_RATIO,
  beatTargetChars,
  shotCharStats,
  findShortShots,
  underFilledShots,
  buildExpandInstruction,
  expandedBeatsFrom,
  filterAppendParagraphs,
  appendExpandedBeats,
  trimBeatParagraphs,
  expandMissingBeats,
  RESTATEMENT_SIMILARITY,
  MERGE_MAX_PARAGRAPH_CHARS,
  SCENE_SHIFT_RE,
  PARAGRAPH_SHAPE_RULES,
  SHAPE_PARAGRAPH_MIN,
  SHAPE_PARAGRAPH_MAX,
  SHAPE_BEAT_TOLERANCE,
  SHAPE_SHORT_RUN,
  SHAPE_SHORT_FRAGMENT_MAX,
  SHAPE_BUCKETS,
  SHAPE_HARD_MAX,
  SHAPE_40_79_MAX_RATIO,
  SHAPE_MEAN_MIN,
  SHAPE_MEAN_MAX,
  SAMPLE_TOTAL_PARAGRAPHS,
  SAMPLE_MEAN_CHARS,
  SAMPLE_MEDIAN_CHARS,
  SAMPLE_MIN_CHARS,
  SAMPLE_MAX_CHARS,
  SAMPLE_BUCKET_COUNTS,
  MICRO_PATCH_MAX_SHORTFALL,
  microPatchNearMiss,
  SHAPE_MEASURE,
  SHAPE_KINDS,
  CLOSING_RE,
  splitParagraphs,
  tailParagraphs,
  paragraphSimilarity,
  isRestatement,
  continuationAnchor,
  mergeSceneParagraphs,
  beatParagraphRanges,
  checkParagraphShape,
  summarizeShapeViolations,
  evaluateShapeDelivery,
  shapeAcceptProblems,
  describeShapeViolations,
  composeChapterContent,
  beatMarkers,
  enforceGroupBoundary,
  buildBoundaryBlock,
  buildHandoffRules,
  planSegments,
  buildSegmentInstruction,
  buildContinuationInstruction,
  buildBeatRewriteInstruction,
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
