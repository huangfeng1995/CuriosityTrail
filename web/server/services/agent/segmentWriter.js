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

/** 每组最多写的节拍数（设计上允许 2–4，取 3 让 8 拍的章也有 3 次推进） */
const MAX_BEATS_PER_GROUP = 3;

/**
 * 全章目标字数与每段目标。
 *
 * 用户锚定全章 4800–5200 字、40–55 段、段均 100–130。按计划段数反推
 * 每段目标（5100 / 段数），让各组目标相加落在 5100 附近；再夹在 90–130，
 * 避免低段数时把单段目标推到 130 以上。注意 countWords 含标点，
 * 指令里必须写明「含标点」，否则模型按纯汉字算，实际会超 15–30%。
 */
const TARGET_CHAPTER_CHARS = 5100;
const MIN_CHARS_PER_PARAGRAPH = 90;
const MAX_CHARS_PER_PARAGRAPH = 130;

/** 总调用上限：3 组起稿 + 3 次续写 + 2 次分组重写，留一点余量 */
const MAX_SEGMENT_CALLS = 8;

/** 一组写到目标的这个比例以下，就认为提前收尾。实测 70% 会放过 72% 的短组，提到 80%。 */
const MIN_TARGET_RATIO = 0.8;

/**
 * 段落形态硬约束。
 *
 * 基线范文 45 段 / 5047 字 / 均 112，最短段 23 字。上一版实测 52 段 /
 * 均 88.9，问题不在总量而在段落形态：一句话的对话被拆成独立自然段，
 * 把段均长拉了下来。这里把约束写进每一次组指令，要求写作时直接落实，
 * 不做事后合并——合并会改动作者的正文切分。
 */
const PARAGRAPH_SHAPE_RULES = [
  '## 全章形态（硬约束，跨组共同遵守）',
  '- 全章 40–55 段、4800–5200 字（含标点）。每段按「本组篇幅」给出的平均字数写，不要写成 130 字以上的长段；全章段均不要往 130 推。',
  '- 每个自然段不少于 25 字（含标点），不足就并入相邻的动作或反应段；单段也不要超过 130 字（含标点）。',
  '- 禁止单句对话独立成段：对话要和动作、神态、说话人的反应合并成一段；只有两句以内的极短问答、且前后有动作句承接时才可独立。',
  '- 本组达到目标字数就停笔，余下内容留给后面的拍；不要靠拉长单段来凑总字数。',
  '- 这些约束在写作时直接落实，不要靠事后合并段落来凑数。',
].join('\n');

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
  const avgCharsPerParagraph = Math.max(
    MIN_CHARS_PER_PARAGRAPH,
    Math.min(
      MAX_CHARS_PER_PARAGRAPH,
      Math.floor(TARGET_CHAPTER_CHARS / Math.max(1, plannedParagraphs))
    )
  );

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
      targetChars: targetParagraphs * avgCharsPerParagraph,
      avgCharsPerParagraph,
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
        `收在小钩子：${b.endHook}`
    )
    .join('\n');
}

/**
 * 交稿前自检清单。
 *
 * 把篇幅与段落形态写成可逐条核对的清单，比散在正文里的规则更容易被执行。
 * 上次实测（三份 7.5k/7.1k/6.6k）说明模型会把「100–130」当成上限来写，
 * 所以这里给出明确字数上限，并再次强调单段下限与末组钩子。
 */
function buildSelfCheck(group) {
  const min = Math.round(group.targetChars * 0.95);
  const max = Math.round(group.targetChars * 1.05);
  return [
    '## 交稿前自检（逐条核对，不合格就改）',
    `- 本组字数控制在 ${min}–${max} 字（含标点）；低于 ${min} 要补，高于 ${max} 要删。`,
    `- 本组段数控制在 ${group.targetParagraphs - 1}–${group.targetParagraphs + 1} 段。`,
    '- 每个自然段不少于 25 字（含标点）；出现单句对话就并进相邻动作段。',
    '- 单段不超过 130 字（含标点），超过就压短或拆开。',
    group.isLast
      ? '- 只在最后一段留一个章末钩子，不要展开后续情节。'
      : '- 不准出现收尾语气，不准埋章末钩子。',
  ].join('\n');
}

/**
 * 某一组的起稿指令。
 *
 * 完整节拍表已经在 system 里（每次调用都会带上），所以这里不再重贴 JSON，
 * 只标清楚「本组写哪几拍、哪些已写完、哪些还没到」。
 */
function buildSegmentInstruction({ plan, group, groups, tail = '' }) {
  const completed = groups
    .filter((g) => g.index < group.index)
    .flatMap((g) => g.beatIds);
  const later = groups
    .filter((g) => g.index > group.index)
    .flatMap((g) => g.beatIds);

  const lines = [
    `## 分段写作任务（第 ${group.index + 1}/${groups.length} 组）`,
    `完整节拍表见 system 中的「本章节拍表」，全章共 ${plan.beats.length} 拍。`,
    `本组只写这几拍：${group.beatIds.join('、')}（${group.beats.map((b) => b.type).join('、')}）。`,
    completed.length
      ? `已经写完：${completed.join('、')}。不要重复它们，也不要用一句话概括它们。`
      : '这是本章的第一组，还没有已写正文。',
    later.length ? `后面才写：${later.join('、')}。不要提前写，更不要把全章收束在这里。` : '',
    '',
    '## 本组篇幅（硬约束）',
    `目标 ${group.targetParagraphs} 段，约 ${group.targetChars} 字（含标点），平均每段约 ${group.avgCharsPerParagraph} 字（约 ${Math.max(80, group.avgCharsPerParagraph - 10)} 个汉字）。写满目标（允许 ±5%）再停，段数最多差 1 段。`,
    '',
    PARAGRAPH_SHAPE_RULES,
    '',
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

/** 续写指令：明确「接着写，不要重开」，并只带上一组的尾部。 */
function buildContinuationInstruction({
  plan,
  group,
  groups,
  tail,
  remainingParagraphs,
  remainingChars,
}) {
  const lines = [
    `## 续写本组（第 ${group.index + 1}/${groups.length} 组）`,
    '上一组提前收尾了，但本组还没写完。接着写，不要重开，不要重复前文，不要重新交代人物和场景。',
    `仍然只写 ${group.beatIds.join('、')} 这几拍，不要提前写后面的节拍。`,
    '',
    '## 上一段结尾（从它后面接着写）',
    tail || '（暂无）',
    '',
    '## 还差多少',
    `再写约 ${remainingParagraphs} 段、约 ${remainingChars} 字（含标点），平均每段约 ${Math.max(90, Math.round(remainingChars / remainingParagraphs))} 字。只补差额，不要重开，达到这个数就停。`,
    '',
    PARAGRAPH_SHAPE_RULES,
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
  tail,
  nextHead,
}) {
  const wanted = new Set(problemIds || []);
  const weak = new Set(weakIds || []);
  const problems = group.beats
    .filter((b) => wanted.has(b.id) || weak.has(b.id))
    .map(
      (b) =>
        `- ${b.id}：必须写出目标「${b.goal}」、阻碍「${b.obstacle}」、代价「${b.cost}」，` +
        `以及「${b.delta.variable}」从「${b.delta.from}」到「${b.delta.to}」的变化，` +
        `收在「${b.endHook}」。` +
        (weak.has(b.id) ? '写到了事件但没写出变化，这一遍要把变化写实。' : '')
    );

  return [
    `## 重写第 ${group.index + 1}/${groups.length} 组（${group.beatIds.join('、')}）`,
    '覆盖自检发现这一组有节拍没落地。只重写这一组，其他组保持原样，不要整章重来。',
    `完整节拍表见 system 中的「本章节拍表」，全章共 ${plan.beats.length} 拍。`,
    '',
    '## 必须补足',
    problems.length ? problems.join('\n') : '把本组几拍写完整。',
    '',
    '## 上一组结尾（仅供衔接，不要重抄）',
    tail || '（本章从这里开始）',
    '',
    '## 下一组开头（仅供衔接，不要续写、不要重抄）',
    nextHead || '（本章到此结束）',
    '',
    '## 篇幅',
    `目标 ${group.targetParagraphs} 段、约 ${group.targetChars} 字（含标点），平均每段约 ${group.avgCharsPerParagraph} 字（约 ${Math.max(80, group.avgCharsPerParagraph - 10)} 个汉字）；写满目标（允许 ±5%），段数最多差 1 段。`,
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

  const fresh = nextParagraphs.slice(overlap);
  if (!fresh.length) return prev;
  return `${prev}\n\n${fresh.join('\n\n')}`;
}

function stitchGroups(groups, existingBody = '') {
  return groups.reduce(
    (text, group) => (group.content ? appendFresh(text, group.content) : text),
    String(existingBody || '').trim()
  );
}

/** 这一组是否明显没写够。末组允许收束，所以只看字数/段数，不看收尾词。 */
function needsContinuation(group, force = false) {
  if (group.continued || !group.content) return false;
  const words = countWords(group.content);
  const paragraphs = splitParagraphs(group.content).length;
  const shortText = words < group.targetChars * MIN_TARGET_RATIO;
  const shortParagraphs = paragraphs < group.targetParagraphs * MIN_TARGET_RATIO;
  if (force) return true;
  if (group.isLast) return shortText || shortParagraphs;
  return shortText || shortParagraphs || hasClosingTone(group.content);
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
  log = () => {},
  progress = () => {},
}) {
  const groups = planSegments(plan);
  const calls = [];
  let callCount = 0;
  let degraded = '';
  let finishReason = 'stop';

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
    const instruction = buildSegmentInstruction({ plan, group, groups, tail });

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
    group.content = group.isLast ? out.content : stripClosingTail(out.content);

    if (needsContinuation(group, closingHit) && callCount < maxCalls) {
      progress({ phase: 'continue', index: group.index, total: groups.length });
      const writtenParagraphs = splitParagraphs(group.content).length;
      // 只补差额的 70%：上一轮实测，按全额补差会让模型再写超 50%（要 567 写 878），
      // 补到 93% 左右即可，续写后不再复检。
      const remainingParagraphs = Math.max(
        2,
        Math.ceil((group.targetParagraphs - writtenParagraphs) * 0.7)
      );
      const remainingChars = Math.max(
        200,
        Math.round((group.targetChars - countWords(group.content)) * 0.7)
      );
      const contInstruction = buildContinuationInstruction({
        plan,
        group,
        groups,
        tail: tailParagraphs(group.content, 3),
        remainingParagraphs,
        remainingChars,
      });

      try {
        const cont = await invoke({ instruction: contInstruction, group, kind: 'continuation' });
        if (cont.content) {
          const cleaned = group.isLast ? cont.content : stripClosingTail(cont.content);
          if (cleaned) {
            group.content = appendFresh(group.content, cleaned);
            group.continued = true;
          }
        }
      } catch (err) {
        if (err.name === 'AbortError' || err.code === 'AI_ABORTED') throw err;
        // 续写失败不推翻已写部分；继续下一组，最终由覆盖自检决定要不要重写。
      }
    }
  }

  const content = stitchGroups(groups, existingBody);
  return {
    groups,
    content,
    action: 'append',
    calls,
    callCount,
    degraded,
    continuations: groups.filter((g) => g.continued).length,
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
  log = () => {},
  progress = () => {},
}) {
  const calls = [];
  let count = callCount;
  let degraded = '';
  let finishReason = 'stop';
  let rewroteGroups = 0;
  const failedGroups = [];

  const weakIds = (coverage?.weak || []).map((w) => w.id);
  const missingIds = [...(coverage?.missing || []), ...weakIds];
  const affected = groupsForIds(groups, missingIds);

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
      problemIds: coverage?.missing || [],
      weakIds,
      tail: tailParagraphs(before || existingBody, 3),
      nextHead,
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

    group.content = group.isLast ? content : stripClosingTail(content);
    rewroteGroups += 1;
  }

  const content = stitchGroups(groups, existingBody);
  return {
    groups,
    content,
    calls,
    callCount: count,
    degraded,
    rewroteGroups,
    failedGroups,
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
  MIN_CHARS_PER_PARAGRAPH,
  MAX_CHARS_PER_PARAGRAPH,
  MAX_SEGMENT_CALLS,
  MIN_TARGET_RATIO,
  PARAGRAPH_SHAPE_RULES,
  CLOSING_RE,
  splitParagraphs,
  tailParagraphs,
  planSegments,
  buildSegmentInstruction,
  buildContinuationInstruction,
  buildGroupRewriteInstruction,
  stripClosingTail,
  hasClosingTone,
  appendFresh,
  stitchGroups,
  needsContinuation,
  usageSum,
  draftInSegments,
  groupsForIds,
  rewriteMissingGroups,
  segmentBadge,
};
