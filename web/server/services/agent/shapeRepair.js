'use strict';

/**
 * 形态后台修补（先交付、后台再修、作者对照替换）。
 *
 * 触发条件只有一个：形态不合格，且针对形态的重写被 85% 守卫回滚。
 * 交付不再被拦，正文照常落库；这里负责在后台按「不砍字」策略修一版：
 *   - 先做无损的本地修补（合并短句、匿名姓氏换具名）；
 *   - 需要模型时只给「点名的几乎不达标段落」，逐段替换，段数不变；
 *   - 任一段修订后低于原段 85%，该段修订作废；整章低于原稿 85%，整版丢弃；
 *   - 最多 4 轮模型调用、总时长 180s、单次 90s，失败不再重试。
 *
 * 这里全是纯逻辑：不碰数据库、不发 HTTP。模型调用由调用方以 chat 注入，
 * 测试可以拿假 chat 跑完整流程。
 */

const { countWords } = require('../wordCount');
const { measureSentenceLength } = require('../style/metrics');
const { parseModelJson } = require('./parse');
const {
  checkParagraphShape,
  evaluateShapeDelivery,
  splitParagraphs,
  formatShapeShortfall,
  repairShortSentences,
  SHORT_SENTENCE_RATIO_LIMIT,
} = require('./segmentWriter');

/** 后台修补的硬上限：与 ai.js 的整轮预算相互独立。 */
const MAX_REPAIR_ROUNDS = 4;
const MAX_REPAIR_CALLS = 4;
const REPAIR_TOTAL_MS = 180000;
const REPAIR_CALL_MS = 90000;
/** 不砍字策略的底线：任何一次修订都不得低于原稿（或原段）的 85%。 */
const REPAIR_MIN_KEEP = 0.85;
/** 单轮最多交给模型几段：给多了它会整章重写，必然砍字；4 轮 × 10 段足够覆盖一章的多数段落。 */
const MAX_PATCH_PARAGRAPHS = 10;
/** 本地无损合并时，合并后的句子可以到 56 字（模型口径 40 字，这里更宽）。 */
const LOCAL_MERGE_MAX = 56;

const KIND_LABELS = {
  count: '每拍段数',
  too_long: '单段超长',
  fragment_ratio: '40–79 字短段占比',
  short_run: '连续短段',
  avg: '段均字数',
  dialogue_stack: '对白连续独立成段',
  corner_quote: '角引号「」',
  short_sentence: '短句占比',
  quote_density: '引号片段密度',
  dialogue_ratio: '对白占比',
  dialogue_low: '对白占比',
  imagery_density: '比喻密度',
  generic_reference: '匿名特征指代',
};

/** 修补优先级：对白下限最影响可读性，其次引号过密、比喻、泛称、短句。 */
const KIND_PRIORITY = [
  'dialogue_low',
  'dialogue_ratio',
  'quote_density',
  'imagery_density',
  'generic_reference',
  'short_sentence',
];

const QUOTE_SPAN_RE = /“[^“”]*”/g;
const IMAGERY_RE = /像|如同|仿佛|宛如|好似|犹如/;
const GENERIC_REF_RE =
  /姓[^，。！？\s]{1,2}的|那(?:个)?(?:瘦高|穿|年轻|年长|灰袍|高个|矮个|中年|年老|站在)[^，。！？\s]{0,6}的|其中一个|另一个人/;
const SHORT_SENTENCE_MAX_CHARS = 12;

/** 交付时的缺口描述：哪项、实测值、上限/下限、差多少。 */
function shortfallRows(delivery) {
  const blocking = delivery && Array.isArray(delivery.blocking) ? delivery.blocking : [];
  return blocking
    .filter((row) => row && row.kind !== 'count')
    .map((row) => ({
      kind: row.kind,
      label: KIND_LABELS[row.kind] || row.kind,
      text: formatShapeShortfall([row]) || KIND_LABELS[row.kind] || row.kind,
      ratio: row.ratio,
      perKilo: row.perKilo,
      limit: row.limit,
      deficitChars: row.deficitChars,
    }));
}

function aggregate(shape, delivery, text) {
  const quality = (delivery && delivery.quality) || {};
  const stats = (delivery && delivery.stats) || {};
  return {
    chars: countWords(text),
    paragraphs: (shape && shape.totalParagraphs) || 0,
    shortSentenceRatio: quality.shortSentenceRatio || 0,
    quotePerKilo: quality.quotePerKilo || 0,
    dialogueRatio: quality.dialogueRatio || 0,
    imageryPerKilo: quality.imageryPerKilo || 0,
    genericPerKilo: quality.genericPerKilo || 0,
    mean: stats.mean || 0,
  };
}

/** 用交付判定同一把尺子量一次正文。 */
function measureShape(plan, text) {
  const shape = checkParagraphShape(plan, text);
  const delivery = evaluateShapeDelivery(shape);
  return { shape, delivery, summary: aggregate(shape, delivery, text) };
}

function namedCastNames(namedCast) {
  return (Array.isArray(namedCast) ? namedCast : [])
    .map((row) => (typeof row === 'string' ? row : row && row.name))
    .map((name) => String(name || '').trim())
    .filter(Boolean);
}

/**
 * 无损本地修补。
 *
 * 只做两件事，都不改段落数、不删信息：
 *   1. 短句过多：按句边界把相邻短句用逗号接起来（repairShortSentences）；
 *   2. 匿名指代超限：「姓周的」如果在本章具名人物里只有一个姓周的人，换成姓名。
 *
 * 其余违规（对白过少、引号过密、比喻堆叠）改起来要动表达，交给模型按段修补。
 */
function localRepair({ text, blockers, namedCast }) {
  let current = String(text || '');
  const changes = [];
  const kinds = new Set((blockers || []).map((row) => row && row.kind));

  if (kinds.has('short_sentence')) {
    // 后台修补允许合并「半个引语」碎片：只把句号换成逗号，不删字、不改说话人。
    const repaired = repairShortSentences(current, SHORT_SENTENCE_RATIO_LIMIT, LOCAL_MERGE_MAX, true);
    if (repaired.merged > 0) {
      current = repaired.text;
      changes.push(`合并短句 ${repaired.merged} 处`);
    }
  }

  if (kinds.has('generic_reference')) {
    const bySurname = new Map();
    for (const name of namedCastNames(namedCast)) {
      if (name.length < 2) continue;
      const surname = name[0];
      const list = bySurname.get(surname) || [];
      list.push(name);
      bySurname.set(surname, list);
    }
    let replaced = 0;
    current = current.replace(/姓([^，。！？\s]{1,2})的/g, (whole, surname) => {
      const names = bySurname.get(surname);
      // 同姓不止一人时无法确定指谁，保持原样——猜错人名比留着泛称更糟。
      if (!names || names.length !== 1) return whole;
      replaced += 1;
      return names[0];
    });
    if (replaced > 0) changes.push(`匿名指代替换为具名 ${replaced} 处`);
  }

  return { text: current, changes };
}

/**
 * 按段号替换正文。
 *
 * 段数保持不变；任何一段修订后低于原段 85% 都拒绝该段，其余段照常应用。
 * 模型给出越界段号、空文本或原样复述时直接跳过。
 */
function applyParagraphPatches(text, patches) {
  const paragraphs = splitParagraphs(text);
  const applied = [];
  const rejected = [];

  for (const patch of Array.isArray(patches) ? patches : []) {
    const index = Number(patch && patch.index);
    const next = String((patch && patch.text) || '').trim();
    if (!Number.isInteger(index) || index < 0 || index >= paragraphs.length) {
      rejected.push({ index, reason: '段号越界' });
      continue;
    }
    if (!next) {
      rejected.push({ index, reason: '空文本' });
      continue;
    }
    const beforeChars = countWords(paragraphs[index]);
    const afterChars = countWords(next);
    if (afterChars < Math.ceil(beforeChars * REPAIR_MIN_KEEP)) {
      rejected.push({
        index,
        reason: `低于原段 85%（${afterChars}/${beforeChars} 字）`,
      });
      continue;
    }
    if (next === paragraphs[index]) {
      rejected.push({ index, reason: '与原段相同' });
      continue;
    }
    paragraphs[index] = next;
    applied.push({ index, beforeChars, afterChars });
  }

  return { text: paragraphs.join('\n\n'), applied, rejected };
}

function shortSentenceCount(paragraph) {
  const shape = measureSentenceLength(paragraph);
  return shape.sentences.filter((sentence) => sentence.words <= SHORT_SENTENCE_MAX_CHARS).length;
}

/**
 * 挑出该交给模型的段落。
 *
 * 只挑能直接对应某条违规的段落，最多 10 段：
 *   - 对白下限：够长、没有引语的叙述段；
 *   - 对白/引号超限：引号片段最多的段；
 *   - 比喻：含比喻标记最多的段；
 *   - 泛称：命中匿名指代的段；
 *   - 短句：短句数量最多的段。
 *
 * @returns {Array<{index:number,text:string}>}
 */
function pickParagraphs(text, blockers) {
  const paragraphs = splitParagraphs(text);
  const kinds = new Set((blockers || []).map((row) => row && row.kind));
  const picked = new Map();

  const take = (indices) => {
    for (const index of indices) {
      if (picked.size >= MAX_PATCH_PARAGRAPHS) return;
      if (index < 0 || index >= paragraphs.length || picked.has(index)) continue;
      picked.set(index, { index, text: paragraphs[index] });
    }
  };

  for (const kind of KIND_PRIORITY) {
    if (!kinds.has(kind) || picked.size >= MAX_PATCH_PARAGRAPHS) continue;
    const rows = paragraphs
      .map((paragraph, index) => {
        const chars = countWords(paragraph);
        let score = 0;
        if (kind === 'dialogue_low') {
          if ((paragraph.match(QUOTE_SPAN_RE) || []).length) return null;
          if (chars < 40) return null;
          score = chars;
        } else if (kind === 'dialogue_ratio' || kind === 'quote_density') {
          score = (paragraph.match(QUOTE_SPAN_RE) || []).length;
          if (score < 2) return null;
        } else if (kind === 'imagery_density') {
          score = (paragraph.match(/像|如同|仿佛|宛如|好似|犹如/g) || []).length;
          if (!score) return null;
        } else if (kind === 'generic_reference') {
          score = (paragraph.match(GENERIC_REF_RE) || []).length;
          if (!score) return null;
        } else if (kind === 'short_sentence') {
          score = shortSentenceCount(paragraph);
          if (!score) return null;
        }
        return { index, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.index);
    take(rows);
  }

  return [...picked.values()].sort((a, b) => a.index - b.index);
}

/** 修补提示词：只改给定段落，只做白名单里的操作，段数与信息量都不许少。 */
function buildPrompt({ paragraphs, blockers, namedCast, deficitChars }) {
  const problems = formatShapeShortfall(blockers || []);
  const names = namedCastNames(namedCast);
  const kinds = new Set((blockers || []).map((row) => row && row.kind));
  const tips = [];
  if (kinds.has('short_sentence')) {
    tips.push(
      '短句过多：必须真正合并段内相邻短句（用逗号连接，合并后单句可到 30–45 字），直到该段的 ≤12 字句不超过一半；不要只改标点或复述原句。'
    );
  }
  if (kinds.has('dialogue_low')) {
    tips.push(
      '对白过少：优先把本段已有的转述改成 20–40 字的直接引语（带说话人的动作或神态）；只有没有可转述内容时才新增一句。不要额外堆引号片段，也不许删掉原有叙述。'
    );
  }
  if (kinds.has('dialogue_ratio') || kinds.has('quote_density')) {
    tips.push('对白/引号过密：把一部分直接引语改成间接叙述，保留信息，不要删掉整段对话。');
  }
  if (kinds.has('imagery_density')) {
    tips.push(
      '比喻过多：全章要压到每千字 2.1 处以下，大约每四到五段才留一处明喻。你拿到的段落里多余的「像/仿佛/如同」要全部删掉，改成直白的动作、感官或判断句；不要每段都保留一个。'
    );
  }
  if (kinds.has('generic_reference') && names.length) {
    tips.push(`匿名指代：把「姓X的」这类写法换成具体姓名（本章可用：${names.join('、')}）。`);
  }
  const system = [
    '你是小说的形态修补器，只修句子形态，不改情节、不换场景、不删信息。',
    '允许的操作只有五种：',
    '1) 合并相邻的短句（用逗号或连词接起来，不删字）；',
    '2) 按句边界调整句子长短，把碎句并成完整句；',
    '3) 把概述性的叙述改成直接引语（补一句有说话人动作的对白）；',
    '4) 把「姓X的」「那瘦高的」这类匿名指代替换为具名人物；',
    '5) 删掉重复冗余的比喻（全章每千字不超过 2.1 处，约四到五段才留一处明喻）。',
    '禁止整段重写、禁止压缩段落、禁止改写情节与人物关系、禁止改变段落数量。',
    `每一段修订后的字数不得低于原段的 ${Math.round(REPAIR_MIN_KEEP * 100)}%。`,
    '只输出 JSON：{"paragraphs":[{"index":段号,"text":"修订后的整段"}]}，',
    'index 必须用输入里给出的段号；输出必须包含所有给定段号，每段都要有实际改动。',
  ]
    .concat(tips)
    .join('\n');

  const user = [
    `需要修的问题：${problems || '形态不合规'}。`,
    deficitChars ? `对白还差约 ${deficitChars} 字引语。` : '',
    names.length ? `本章具名人物：${names.join('、')}。` : '',
    '',
    '要修的段落（段号从 0 开始）：',
    ...paragraphs.map((row) => `[${row.index}] ${row.text}`),
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { system, user };
}

function parsePatches(raw) {
  const parsed = parseModelJson(raw);
  const rows = parsed && Array.isArray(parsed.paragraphs) ? parsed.paragraphs : [];
  return rows
    .map((row) => ({
      index: Number(row && row.index),
      text: String((row && row.text) || '').trim(),
    }))
    .filter((row) => Number.isInteger(row.index) && row.text);
}

/**
 * 跑一次后台修补。
 *
 * @param {Object} options
 * @param {string} options.body 交付时的原稿
 * @param {Object} options.plan 节拍表（可为 null，形态判定仍可按整章做）
 * @param {Array} options.blockers 交付时不达标的违规（不含 count）
 * @param {Array} options.namedCast 本章具名人物
 * @param {Function} options.chat 注入的模型调用：({system,user,signal}) => {content}
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {Function} [options.now]
 * @returns {Promise<Object>}
 */
async function runRepair({ body, plan, blockers, namedCast, chat, signal, now = Date.now }) {
  const startedAt = now();
  const original = String(body || '');
  const originalChars = countWords(original);
  const originalShape = checkParagraphShape(plan, original);
  const originalDelivery = evaluateShapeDelivery(originalShape);
  let current = original;
  let rounds = 0;
  let calls = 0;
  const changes = [];
  let lastError = '';

  const local = localRepair({ text: current, blockers, namedCast });
  current = local.text;
  changes.push(...local.changes);

  let measured = measureShape(plan, current);

  while (
    measured.delivery.blocking.some((row) => row.kind !== 'count') &&
    rounds < MAX_REPAIR_ROUNDS &&
    calls < MAX_REPAIR_CALLS &&
    now() - startedAt < REPAIR_TOTAL_MS
  ) {
    if (signal && signal.aborted) break;

    const paragraphs = pickParagraphs(current, measured.delivery.blocking);
    if (!paragraphs.length) {
      // 找不到可点名的段落就停：继续调模型只会整章重写，必然砍字。
      console.log(
        JSON.stringify({
          event: 'ai_shape_repair_no_target',
          chars: countWords(current),
          paragraphs: splitParagraphs(current).length,
          blockers: measured.delivery.blocking.map((row) => row.kind),
        })
      );
      break;
    }

    const prompt = buildPrompt({
      paragraphs,
      blockers: measured.delivery.blocking.filter((row) => row.kind !== 'count'),
      namedCast,
      deficitChars: measured.delivery.blocking.find((row) => row.kind === 'dialogue_low')?.deficitChars,
    });

    rounds += 1;
    calls += 1;
    let output = null;
    try {
      output = await chat({
        system: prompt.system,
        user: prompt.user,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REPAIR_CALL_MS)])
          : AbortSignal.timeout(REPAIR_CALL_MS),
      });
    } catch (err) {
      // 取消不是失败：调用方会把状态写成 cancelled。
      if (signal && signal.aborted) break;
      lastError = err && err.message ? err.message : String(err || '模型调用失败');
      break;
    }

    const patches = parsePatches(output && output.content);
    // 模型给了空 JSON 或改不动的复述，本轮就作废：任务到此为止，
    // 不拿同一批段落反复重试（「失败后不再重试」）。
    if (!patches.length) break;

    const applied = applyParagraphPatches(current, patches);
    if (!applied.applied.length) break;
    current = applied.text;
    changes.push(`按段修补 ${applied.applied.length} 段`);

    // 补对白会带来新的短句碎片，每轮之后再跑一次无损合并，
    // 否则「修好对白、短句又超」来回摆动，两轮预算会被耗光。
    const relocal = localRepair({
      text: current,
      // 短句/泛称是无损项：即使本轮之前已经达标，补对白后也可能重新超限，
      // 所以每轮都允许再检查一次（比例没超时函数会原样返回）。
      blockers: [...measured.delivery.blocking, { kind: 'short_sentence' }, { kind: 'generic_reference' }],
      namedCast,
    });
    if (relocal.text !== current) {
      current = relocal.text;
      changes.push(...relocal.changes);
    }
    measured = measureShape(plan, current);
  }

  const remaining = measured.delivery.blocking.filter((row) => row.kind !== 'count');
  const belowKeep = countWords(current) < Math.ceil(originalChars * REPAIR_MIN_KEEP);
  const ok = remaining.length === 0 && !belowKeep;

  let note = '';
  if (belowKeep) {
    note = `修订版只有原稿的 ${Math.round(
      (countWords(current) / Math.max(1, originalChars)) * 100
    )}%，低于 ${Math.round(REPAIR_MIN_KEEP * 100)}%，已丢弃`;
  } else if (!ok) {
    note = `已尝试修补，仍有 ${remaining.length} 项不达标：${formatShapeShortfall(
      remaining.slice(0, 4)
    )}`;
  } else if (lastError) {
    note = `已修补完成（最后一次模型调用失败：${lastError}）`;
  }

  return {
    ok,
    content: current,
    before: aggregate(originalShape, originalDelivery, original),
    after: measured.summary,
    remaining,
    rounds,
    calls,
    durationMs: Math.max(0, now() - startedAt),
    changes,
    note,
  };
}

module.exports = {
  MAX_REPAIR_ROUNDS,
  MAX_REPAIR_CALLS,
  REPAIR_TOTAL_MS,
  REPAIR_CALL_MS,
  REPAIR_MIN_KEEP,
  MAX_PATCH_PARAGRAPHS,
  LOCAL_MERGE_MAX,
  KIND_LABELS,
  shortfallRows,
  measureShape,
  localRepair,
  applyParagraphPatches,
  pickParagraphs,
  buildPrompt,
  parsePatches,
  runRepair,
};
