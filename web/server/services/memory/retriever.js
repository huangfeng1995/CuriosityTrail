'use strict';

/**
 * 记忆召回与重排。
 *
 * sidecar 只负责"找出语义上最像的 N 块"，剩下的判断全在这里：
 *
 *  1. **粗筛**：sidecar 按一个很低的原始分下限过滤，省下传输与排序开销。
 *     它不决定什么该被召回——原始分在加权之前，卡片类的高权重根本没机会生效。
 *  2. **加权**：人物卡/设定卡比章节正文更"权威"，
 *     章节越老越可能已经过时，对话原文基本是噪声。
 *  3. **准入**：拿**加权分**跟**该类型的门槛**比，过线才留下。
 *     门槛分类型定，因为不同长度的文本相似度尺度不同（见 TYPE_THRESHOLD_FACTORS）。
 *  4. **去重**：同一个来源只留最相关的那块；同一章最多留两块，
 *     否则整章内容会把上下文挤满。
 *  5. **预算**：聊天最多 8 条 / 3000 字，行内最多 4 条 / 1200 字。
 *     超预算的按加权分从高到低砍。
 *
 * 权重与阈值都做成可调的常量，取值来自标定脚本的实测
 * （`web/server/scripts/calibrate-memory.js`）。
 */

const config = require('../../config');
const { all, get } = require('../../database');
const client = require('./client');
const uris = require('./uris');

/**
 * 来源类型权重。
 *
 * 人物卡与设定卡是"作者明确写下的规则"，比章节正文更值得优先参考；
 * 旧章节容易与后来的设定冲突，降权；
 * 对话原文是噪声大户，压到最低。
 *
 * 权重同时决定了该类型的**实际召回门槛**：准入比的是加权分，
 * 所以低权重类型的原始门槛会被抬高（门槛 ÷ 权重）。
 * 这一点由 `TYPE_THRESHOLD_FACTORS` 的系数补回来——
 * 每个类型的系数按它自己的标定区间算，不是一律 1.0。
 */
const TYPE_WEIGHTS = {
  character: 1.15,
  setting: 1.15,
  conv_manual: 1.2,
  conv_fact: 1.0,
  chapter: 0.95,
  conv_raw: 0.8,
};

/**
 * 各来源类型的召回门槛系数（相对 `MEMORY_MIN_SCORE`）。
 *
 * 为什么每种类型要单独定门槛：**不同长度的文本，向量相似度的尺度不一样。**
 *
 * 标定数据（`scripts/calibrate-memory.js`，2026-10-28，**加权分**）：
 *
 * | 类型 | 权重 | 真命中最低 | 真命中最高 | 噪音最高 | 折算原始分区间 |
 * | --- | --- | --- | --- | --- | --- |
 * | 人物卡 | 1.15 | 0.591 | 0.591 | 0.192 | 0.167 ~ 0.514 |
 * | 设定卡 | 1.15 | 0.566 | 0.822 | 0.246 | 0.214 ~ 0.492 |
 * | 章节 | 0.95 | 0.260 | 0.261 | 0.153 | 0.161 ~ 0.274 |
 * | 对话原文 | 0.80 | 0.149 | 0.367 | 0.127 | 0.159 ~ 0.186 |
 *
 * 卡片只有十几个字，它的向量跟**任何**查询都有 0.2 上下的余弦相似度——
 * 这不是它相关，是短文本向量的固有性质。同一根阈值卡不住所有类型：
 * 卡片的噪音（0.246）比对话原层的真命中（0.149）还高。
 *
 * 但**分类型看，每一种都有干净的安全区间**（真命中最低 > 噪音最高）。
 * 所以门槛按类型分开定，系数取各自区间的位置：
 *
 * - 人物卡 / 设定卡：噪音上沿 0.246、真命中下沿 0.566，
 *   取中间 0.408 → 系数 1.7。
 * - 章节：噪音上沿 0.153、真命中下沿 0.260，基准 0.24 正落在中间 → 系数 1.0。
 * - 对话原文：噪音上沿 0.127、真命中下沿 0.149，基准 0.24 **高于真命中下沿**，
 *   会把真命中整段误杀；它权重又最低（0.8），原始门槛被抬到 0.24/0.8 = 0.30，
 *   比章节还严。取区间中点 0.138 → 系数 0.575。
 *
 * 最后一条是实测出来的：18 条探针有 4 条漏召，全是对话原文
 * （原始分 0.184~0.291，折算加权分 0.147~0.233，全在 0.24 之下）。
 */
const TYPE_THRESHOLD_FACTORS = {
  character: 1.7,
  setting: 1.7,
  conv_manual: 1.0,
  conv_fact: 1.0,
  chapter: 1.0,
  conv_raw: 0.575,
};

/** 同一来源最多保留几块（章节除外，章节按 MAX_CHUNKS_PER_CHAPTER 算）。 */
const MAX_CHUNKS_PER_SOURCE = 1;

/** 同一章节最多保留几块。 */
const MAX_CHUNKS_PER_CHAPTER = 2;

/**
 * 候选池放大倍数。
 *
 * sidecar 只做粗筛（门槛低），所以要往回多取一些候选，
 * 否则等 Node 侧按类型过滤完，候选池可能已经空了。
 *
 * 实测（30 章 / 92 块，本机）：limit=32 时的召回延迟与 limit=16 相当
 * （中位 247ms vs 237ms，p95 450ms vs 551ms）——多取几条不花钱，
 * 因为瓶颈在 embedding 调用与向量检索，不在结果条数。
 */
const CANDIDATE_MULTIPLIER = 2;

/**
 * 计算加权分。
 *
 * 只用于排序。
 *
 * @param {number} score 原始相似度
 * @param {string} sourceType
 * @returns {number}
 */
function weightedScore(score, sourceType) {
  return score * (TYPE_WEIGHTS[sourceType] ?? 1);
}

/**
 * 某来源类型的召回门槛（作用在**加权分**上）。
 *
 * @param {string} sourceType
 * @param {number} base 基准门槛（`MEMORY_MIN_SCORE`）
 * @returns {number}
 */
function thresholdFor(sourceType, base) {
  return base * (TYPE_THRESHOLD_FACTORS[sourceType] ?? 1);
}

/**
 * 传给 sidecar 的粗筛下限。
 *
 * 粗筛只负责「把明显不相关的扔掉」，省下网络传输与后续排序的开销；
 * **真正的准入判断在 Node 侧、拿加权分做**（见设计文档 §6.2）。
 *
 * 所以这个下限必须低到「任何可能通过分类型门槛的候选都不会被提前砍掉」：
 * 候选的加权分要达到门槛，原始分至少得是门槛除以权重。取所有类型里的最小值，
 * 再留一成余量，避免卡在边界上的候选被误杀。
 *
 * @param {number} base 基准门槛
 * @returns {number}
 */
function coarseFloor(base) {
  let floor = Infinity;
  for (const [type, weight] of Object.entries(TYPE_WEIGHTS)) {
    const factor = TYPE_THRESHOLD_FACTORS[type] ?? 1;
    floor = Math.min(floor, (base * factor) / (weight || 1));
  }
  if (!Number.isFinite(floor)) return base;
  return Math.max(0, floor * 0.9);
}

/**
 * 构造查询文本。
 *
 * 用"当前章末尾 + 本次指令"作为查询——作者正在写的地方，
 * 决定了需要回忆什么。只用指令会太窄（"继续"这种指令没有任何语义）。
 *
 * 指令**优先保留**：作者写的要求（"不要让林昭知道真相"这类）被截掉，
 * 召回方向就整个跑偏了；而章末尾少几百字影响没那么大。
 * 所以先把指令放进去，剩下的额度才留给章末尾。
 *
 * @param {object} params
 * @param {string} [params.chapterTail] 当前章末尾正文
 * @param {string} params.instruction 本次指令
 * @returns {string}
 */
function buildQueryText({ chapterTail = '', instruction = '' }) {
  const MAX_QUERY_CHARS = 2000;
  const MAX_TAIL_CHARS = 1500;

  const instr = String(instruction || '').trim();
  // 指令超长时保留尾部：作者的要求通常写在后面。
  const keptInstr = instr.length > MAX_QUERY_CHARS ? instr.slice(-MAX_QUERY_CHARS) : instr;

  const remaining = MAX_QUERY_CHARS - keptInstr.length - 1;
  if (remaining <= 0) return keptInstr;

  const tail = String(chapterTail).slice(-Math.min(MAX_TAIL_CHARS, remaining));
  return `${tail}\n${keptInstr}`.trim();
}

/**
 * 给召回结果配来源标签。
 *
 * 作者要能一眼看出"这条记忆是从哪来的"——
 * 不然召回再准也没用，他没法判断可不可信。
 *
 * @param {string} userId
 * @param {Array} refs
 * @returns {Promise<Array>}
 */
async function labelRefs(userId, refs) {
  const chapterIds = new Set();
  const characterIds = new Set();
  const settingIds = new Set();
  const messageIds = new Set();

  for (const ref of refs) {
    if (ref.sourceType === 'chapter') chapterIds.add(ref.sourceId);
    else if (ref.sourceType === 'character') characterIds.add(ref.sourceId);
    else if (ref.sourceType === 'setting') settingIds.add(ref.sourceId);
    else if (ref.messageId) messageIds.add(ref.messageId);
  }

  const chapterRows = chapterIds.size
    ? await all(
        `SELECT c.id, c.title, c.seq FROM chapters c
         JOIN works w ON w.id = c.work_id
         WHERE c.id IN (${[...chapterIds].map(() => '?').join(',')}) AND w.user_id = ?`,
        [...chapterIds, userId]
      )
    : [];
  const characterRows = characterIds.size
    ? await all(
        `SELECT ch.id, ch.name FROM characters ch
         JOIN works w ON w.id = ch.work_id
         WHERE ch.id IN (${[...characterIds].map(() => '?').join(',')}) AND w.user_id = ?`,
        [...characterIds, userId]
      )
    : [];
  const settingRows = settingIds.size
    ? await all(
        `SELECT s.id, s.name, s.category FROM settings s
         JOIN works w ON w.id = s.work_id
         WHERE s.id IN (${[...settingIds].map(() => '?').join(',')}) AND w.user_id = ?`,
        [...settingIds, userId]
      )
    : [];
  const messageRows = messageIds.size
    ? await all(
        `SELECT m.id, m.created_at, c.title AS conversation_title
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.id IN (${[...messageIds].map(() => '?').join(',')}) AND c.user_id = ?`,
        [...messageIds, userId]
      )
    : [];

  const chapterMap = new Map(chapterRows.map((row) => [row.id, row]));
  const characterMap = new Map(characterRows.map((row) => [row.id, row]));
  const settingMap = new Map(settingRows.map((row) => [row.id, row]));
  const messageMap = new Map(messageRows.map((row) => [row.id, row]));

  return refs.map((ref) => {
    let label = '';
    if (ref.sourceType === 'chapter') {
      const row = chapterMap.get(ref.sourceId);
      label = row ? `第 ${row.seq} 章·${row.title}` : '章节';
    } else if (ref.sourceType === 'character') {
      const row = characterMap.get(ref.sourceId);
      label = row ? `人物卡·${row.name}` : '人物卡';
    } else if (ref.sourceType === 'setting') {
      const row = settingMap.get(ref.sourceId);
      label = row ? `设定卡·${row.name}` : '设定卡';
    } else if (ref.sourceType === 'conv_manual') {
      label = '对话·手动记入';
    } else if (ref.sourceType === 'conv_fact') {
      label = '对话·抽取事实';
    } else {
      label = '对话·原文';
    }

    const message = messageMap.get(ref.messageId);
    if (message && message.created_at) {
      const date = String(message.created_at).slice(0, 10);
      label = `${label}·${date}`;
    }

    return { ...ref, label };
  });
}

/**
 * 去重与限额。
 *
 * 章节按「每章最多 2 块」算，其余来源按「每来源 1 块」算。
 *
 * 章节要单独算：它的 source_id 就是章节 id，
 * 如果先按来源限 1 块，「每章 2 块」这条规则永远走不到——
 * 长章节里两段不相干的关键内容只能留一段。
 *
 * @param {Array} refs
 * @returns {Array}
 */
function dedupe(refs) {
  const perSource = new Map();
  const perChapter = new Map();
  const kept = [];

  // refs 已按加权分降序排列，所以先到先得就是"留最高分的那块"
  for (const ref of refs) {
    if (ref.sourceType === 'chapter') {
      const chapterCount = perChapter.get(ref.sourceId) || 0;
      if (chapterCount >= MAX_CHUNKS_PER_CHAPTER) continue;
      perChapter.set(ref.sourceId, chapterCount + 1);
      kept.push(ref);
      continue;
    }

    const sourceKey = `${ref.sourceType}:${ref.sourceId}`;
    const sourceCount = perSource.get(sourceKey) || 0;
    if (sourceCount >= MAX_CHUNKS_PER_SOURCE) continue;

    perSource.set(sourceKey, sourceCount + 1);
    kept.push(ref);
  }

  return kept;
}

/**
 * 按预算裁剪。
 *
 * @param {Array} refs
 * @param {object} limits
 * @param {number} limits.maxRefs 最多几条
 * @param {number} limits.maxChars 最多多少字
 * @returns {Array}
 */
function applyBudget(refs, { maxRefs, maxChars }) {
  const kept = [];
  let used = 0;

  for (const ref of refs) {
    if (kept.length >= maxRefs) break;
    const length = (ref.preview || '').length;
    if (used + length > maxChars) continue;
    kept.push(ref);
    used += length;
  }

  return kept;
}

/**
 * 召回。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.query 查询文本
 * @param {number} [params.limit] 召回数上限
 * @param {number} [params.minScore] 相似度阈值
 * @param {string} [params.excludeChapterId] 当前章 id——不召回它
 * @param {string[]} [params.excludeRefIds] 作者剔除的条目
 * @param {string[]} [params.excludeSourceKeys] 整来源剔除，格式 `类型:来源id`
 * @param {string} [params.scope] 'chat' | 'inline'
 * @returns {Promise<{refs: Array, degraded: boolean, reason: string}>}
 */
async function retrieve(params) {
  const {
    userId,
    workId,
    query,
    limit,
    minScore,
    excludeChapterId = '',
    excludeRefIds = [],
    excludeSourceKeys = [],
    scope = 'chat',
  } = params;

  if (!client.isEnabled()) {
    return { refs: [], degraded: true, reason: '记忆功能已关闭' };
  }

  const excluded = new Set(excludeRefIds);
  const excludedSources = new Set(excludeSourceKeys);

  // 基准门槛。分类型门槛是它的倍数，见 TYPE_THRESHOLD_FACTORS。
  const base = minScore === undefined ? config.memoryMinScore : minScore;

  // sidecar 那边只做粗筛：门槛放低，多取一些候选回来，
  // 真正的准入判断在 Node 侧拿加权分做。
  //
  // 候选要多取一些，因为粗筛放低了——等下按类型过滤会砍掉一批，
  // 只取 memoryTopK 条的话，过滤完可能什么都不剩。
  const result = await client.query({
    query,
    targetUri: uris.workRoot(userId, workId),
    limit: limit || config.memoryTopK * CANDIDATE_MULTIPLIER,
    minScore: coarseFloor(base),
  });

  if (result.degraded) {
    return { refs: [], degraded: true, reason: result.reason };
  }

  // 解析 URI，过滤掉不认识来源与被作者剔除的条目
  const parsed = [];
  for (const item of result.results) {
    const info = uris.parseUri(item.uri);
    if (!info) continue;
    // 只认当前用户的记忆——sidecar 已经按前缀过滤，这里再兜一次底
    if (info.userId !== userId || info.workId !== workId) continue;

    const refId = `${info.sourceType}:${info.sourceId}:${info.chunkNo}`;
    if (excluded.has(refId)) continue;
    // 整来源剔除：重新生成时，上一版回答的记忆要整条排掉，
    // 不能只排掉作者手动点掉的那几块。
    if (excludedSources.has(`${info.sourceType}:${info.sourceId}`)) continue;
    // 当前章不召回：它的正文已经全量注进上下文了，召回它是白占位置。
    // 不排除的话，它会霸占召回名额——查询文本本来就是它的末尾，
    // 它跟自己几乎必然最像。
    if (excludeChapterId && info.sourceType === 'chapter' && info.sourceId === excludeChapterId) {
      continue;
    }

    const weighted = weightedScore(item.score, info.sourceType);
    // 准入判断：**加权分** vs **该类型的门槛**。
    //
    // 标定表里的"真命中最低/噪音最高"都是加权分，所以门槛也必须作用在加权分上。
    // 分类型系数已经把各类型的实际门槛校准到它自己的安全区间里了
    // （见 TYPE_THRESHOLD_FACTORS）——对话原文的系数 0.575 就是为此：
    // 它权重最低，原始门槛会被抬高，不下调就会把真命中整段误杀。
    if (weighted < thresholdFor(info.sourceType, base)) continue;

    parsed.push({
      id: refId,
      uri: item.uri,
      sourceType: info.sourceType,
      sourceId: info.sourceId,
      messageId: info.messageId,
      chunkNo: info.chunkNo,
      score: item.score,
      weighted,
      preview: (item.text || '').slice(0, 1200),
    });
  }

  // 加权后重新排序
  parsed.sort((a, b) => b.weighted - a.weighted);

  const labeled = await labelRefs(userId, parsed);
  const deduped = dedupe(labeled);

  const maxRefs = scope === 'inline' ? 4 : config.memoryMaxRefs;
  const maxChars = scope === 'inline' ? 1200 : config.memoryMaxChars;
  const refs = applyBudget(deduped, { maxRefs, maxChars });

  return { refs, degraded: false, reason: '' };
}

/**
 * 把召回结果渲染成可注入的上下文段落。
 *
 * 无召回结果时返回空字符串——不写"暂无记忆"之类的占位，
 * 免得模型以为记忆库是空的。
 *
 * @param {Array} refs
 * @returns {string}
 */
function formatRefs(refs) {
  if (!refs.length) return '';
  const lines = refs.map((ref, i) => `${i + 1}. 〔${ref.label}〕${ref.preview}`);
  return `## 长期记忆（自动召回）\n${lines.join('\n')}`;
}

module.exports = {
  TYPE_WEIGHTS,
  TYPE_THRESHOLD_FACTORS,
  MAX_CHUNKS_PER_SOURCE,
  MAX_CHUNKS_PER_CHAPTER,
  CANDIDATE_MULTIPLIER,
  weightedScore,
  thresholdFor,
  coarseFloor,
  buildQueryText,
  labelRefs,
  dedupe,
  applyBudget,
  retrieve,
  formatRefs,
};
