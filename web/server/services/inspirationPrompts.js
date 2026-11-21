'use strict';

/**
 * 灵感方向生成。
 *
 * 与「灵感师」对话角色不同：这里不写会话、不写消息表，只根据当前作品 /
 * 章节的资料生成一组**候选提示**，由作者决定留不留、转不转卡。
 *
 * 六个维度是固定的，彼此不重叠。每条提示必须绑定上下文里的具体实体
 * （人物、设定、情节卡），否则直接丢弃——这是「不是一套对所有书都一样的
 * 模板」的硬保障。
 */

const crypto = require('crypto');
const { all, get } = require('../database');
const { parseBlocks } = require('./context');
const aiConfig = require('./aiConfig');
const { resolveProvider } = require('./providers');
const { parseModelJson } = require('./agent/parse');

/** 单个维度最少/最多给几条 */
const MIN_COUNT = 1;
const MAX_COUNT = 3;
const DEFAULT_COUNT = 2;
/** 综合模式一次最多给几个维度 */
const MAX_GROUPS = 3;
/** 单次生成超时。灵感不是关键路径，超时就放弃，让作者重试。 */
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_EXCLUDE = 30;
const MIN_PROMPT_LENGTH = 30;
const MAX_PROMPT_LENGTH = 260;
const MAX_REASON_LENGTH = 40;
const MAX_ANCHOR_LENGTH = 24;
/** 上下文里最多出现多少人 / 设定 / 情节卡 / 灵感 */
const MAX_CHARACTERS = 12;
const MAX_SETTINGS = 10;
const MAX_PLOT_CARDS = 10;
const MAX_ANCHORS = 8;
const MAX_RELATED_INSPIRATIONS = 5;

const DIMENSIONS = [
  {
    key: 'motivation',
    label: '动机与代价',
    description: '把人物推到「两个都想要、只能选一个」的位置，写选择的代价。',
    rule: '人物此刻最想要什么、愿意为它失去什么；让两个目标互相排斥，写出选择的那一下。',
    example:
      '让林砚在仓库里同时拿到两条路：沈书白能销掉通缉令，条件是交出记着父亲死因的账册。写他翻开又合上的那一下，手比脑子先做决定。',
  },
  {
    key: 'conflict',
    label: '冲突升级',
    description: '让现有分歧跨过不可撤回的一步，逼双方当场表态。',
    rule: '把已有的分歧推到不可撤回的一步；谁先动手、哪条底线被踩、在场者被迫选边。',
    example:
      '把林砚和沈书白关于「谁先动手」的争执推到不可撤回：沈书白当众撕掉林砚的船票，林砚要么动手，要么低头去捡。只写周围人的反应。',
  },
  {
    key: 'suspense',
    label: '悬念钩子',
    description: '控制读者与角色的信息差，制造本场结尾的追问。',
    rule: '读者知道而角色不知道，或角色知道而读者不知道；本场结尾留下一个具体、不解释的追问。',
    example:
      '本场结尾让读者看见铜钥匙挂在沈书白腰上，而林砚刚从旁边走过没看见。只给特写，不解释钥匙开哪扇门。',
  },
  {
    key: 'image',
    label: '意象与画面',
    description: '用一个具体物件、动作或天气的重复与变形承载情绪。',
    rule: '选一个已在作品中出现过的具体意象，让它在同一场里重复并改变含义；不靠形容词解释情绪。',
    example:
      '让雾出现三次：第一次遮住来人的脸，第二次让林砚认错人，第三次散开时露出他不想看见的东西。三次都不解释，只写呼吸变化。',
  },
  {
    key: 'world',
    label: '世界细节',
    description: '用制度、流程、器物或时代限制真实地卡住人物。',
    rule: '在普通流程里加入一个具体限制，让主角因为必须遵守它而错过某件事；细节要改变这一场的结果。',
    example:
      '验尸房加一道流程：仵作必须先报尸格、等巡捕房画押才能翻动尸体。让林砚因为等手续，错过指甲缝里的石灰被冲掉之前。',
  },
  {
    key: 'payoff',
    label: '伏笔与回收',
    description: '把已有的线头重新提起、兑现或反用，保证长篇因果闭环。',
    rule: '从已有情节卡或前文里挑一条尚未解释的线，在本场重新提起；只重提或兑现，不额外揭晓新秘密。',
    example:
      '从情节卡「沈书白袖口的墨迹」里挑一条没解释的线：本场让林砚第二次看见同样的墨迹，这次在死者手上。只重提，不揭晓。',
  },
];

const BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d]));
const ALL_KEYS = DIMENSIONS.map((d) => d.key);

const DIMENSION_BLOCK = DIMENSIONS.map(
  (d) => `- ${d.key}｜${d.label}：${d.rule}`
).join('\n');

const SYSTEM_PROMPT = `你是小说创作的方向设计师。作者不缺形容词，缺的是能立刻落笔的具体方向。

## 六个固定维度
${DIMENSION_BLOCK}

## 硬要求
1. 每条提示必须绑定上下文里的具体人物、设定、情节卡或大纲细节，并在 anchor 字段写出所绑定实体的原名。
2. 每条提示要包含一个可执行的动作或选择，以及它带来的不可逆后果。不要写「加强冲突」「多写细节」这类空话。
3. 每条 30-260 字，2-4 句。只给方向，不写正文，不替作者决定结局。
4. reason 用 20 字以内说明「为什么此刻可用」，要指向具体前情，不要复述提示。
5. 历史细节只能使用上下文给出的锚点或设定；没有依据就不要写具体史实。
6. 不要与「已出现过的提示」重复。
7. 严格输出 JSON，不要 markdown 代码块，不要任何额外文字。

## 输出格式
{"groups":[{"dimension":"motivation","prompts":[{"text":"具体方向","anchor":"上下文里的实体原名","reason":"接哪条前情"}]}]}

- 综合模式：从六个维度里挑 3 个与当前章节最相关的，每个维度给指定条数。
- 指定维度：只输出该维度，给指定条数。
- 每个 prompt 的 anchor 必须是上下文里出现过的实体原名。`;

function clip(text, limit) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function oneLine(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(text) {
  return String(text || '')
    .replace(/[\s\u3000。，、；：！？,.!?;:'"“”‘’—…（）()【】\[\]《》<>·]/g, '')
    .slice(0, 80);
}

function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(n)));
}

function normalizeDimension(value) {
  const key = String(value || '').trim();
  return BY_KEY.has(key) ? key : '';
}

function normalizeDimensions(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const item of value) {
    const key = normalizeDimension(item);
    if (key && !seen.has(key)) seen.add(key);
  }
  return Array.from(seen);
}

function nameVariants(character) {
  const variants = [character.name];
  if (character.aliases) {
    for (const alias of String(character.aliases).split(/[,，、]/)) {
      const value = alias.trim();
      if (value) variants.push(value);
    }
  }
  return variants.filter(Boolean);
}

function chapterBody(chapter) {
  if (!chapter) return '';
  const blocks = parseBlocks(chapter.blocks);
  const body = blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
  return body || String(chapter.content || '');
}

function tail(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `…${value.slice(-limit)}`;
}

function parseRelations(character) {
  if (!character.relations) return [];
  try {
    const parsed = JSON.parse(character.relations);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((r) => `${r.characterName || r.name || ''}${r.relation ? `（${r.relation}）` : ''}`)
      .filter((s) => s.trim());
  } catch (e) {
    return [];
  }
}

function formatCharacterBrief(character) {
  const lines = [`【${character.name}】`];
  if (character.role) lines.push(`身份：${clip(character.role, 40)}`);
  if (character.goal) lines.push(`目标：${clip(character.goal, 80)}`);
  if (character.personality) lines.push(`性格：${clip(character.personality, 60)}`);
  if (character.arc) lines.push(`弧线：${clip(character.arc, 80)}`);
  const relations = parseRelations(character);
  if (relations.length) lines.push(`关系：${relations.slice(0, 5).join('、')}`);
  return lines.join('');
}

function formatSettingBrief(setting) {
  return `【${setting.name}·${setting.category || '其他'}】${clip(setting.content, 120)}`;
}

function formatPlotCard(card, chapterTitle) {
  const where = card.chapter_id ? `（${chapterTitle || '某章'}）` : '';
  return `【${card.title}】${where}${clip(card.content, 120)}`;
}

/**
 * 拼装生成用的上下文。
 *
 * 只查本作品的数据。灵感速记是用户级的，这里用「是否提到本作人物/设定/
 * 情节卡」做一次过滤，避免把别的作品的念头串进来。
 *
 * @param {{work: Object, chapter?: Object|null, userId?: string}} params
 * @returns {Promise<{text: string, knownAnchors: string[]}>}
 */
async function buildContext({ work, chapter = null, userId = '' } = {}) {
  if (!work) return { text: '', knownAnchors: [] };

  const [characters, settings, plotCards] = await Promise.all([
    all('SELECT * FROM characters WHERE work_id = ? ORDER BY name', [work.id]),
    all(
      'SELECT * FROM settings WHERE work_id = ? ORDER BY importance DESC, name',
      [work.id]
    ),
    all(
      "SELECT * FROM plot_cards WHERE work_id = ? AND status <> 'done' ORDER BY seq ASC",
      [work.id]
    ),
  ]);

  let anchors = [];
  if (work.template) {
    anchors = await all(
      `SELECT claim, confidence, usable_for, kind
       FROM work_anchors
       WHERE work_id = ? AND status = 'active'
       ORDER BY immutable DESC, created_at ASC
       LIMIT ?`,
      [work.id, MAX_ANCHORS]
    );
  }

  const body = chapterBody(chapter);
  let previousBody = '';
  if (chapter && chapter.seq > 1) {
    const previous = await get(
      `SELECT * FROM chapters
       WHERE work_id = ? AND seq < ?
       ORDER BY seq DESC LIMIT 1`,
      [work.id, chapter.seq]
    );
    previousBody = previous ? chapterBody(previous) : '';
  }

  const signal = [
    work.title,
    work.genre,
    work.synopsis,
    work.outline,
    chapter?.title,
    chapter?.outline,
    body,
    previousBody,
  ]
    .filter(Boolean)
    .join('\n');

  const namedCharacters = characters.filter((c) =>
    nameVariants(c).some((name) => signal.includes(name))
  );
  const chosenCharacters = (namedCharacters.length ? namedCharacters : characters).slice(
    0,
    MAX_CHARACTERS
  );

  const highSettings = settings.filter((s) => (s.importance ?? 3) >= 3);
  const chosenSettings = (highSettings.length ? highSettings : settings.slice(0, 5)).slice(
    0,
    MAX_SETTINGS
  );

  const relevantCards = plotCards
    .filter((c) => !chapter || !c.chapter_id || c.chapter_id === chapter.id)
    .slice(0, MAX_PLOT_CARDS);
  const chosenCards = relevantCards.length
    ? relevantCards
    : plotCards.slice(0, MAX_PLOT_CARDS);

  const entityNames = [
    ...chosenCharacters.flatMap(nameVariants),
    ...chosenSettings.map((s) => s.name),
    ...chosenCards.map((c) => c.title),
  ].filter(Boolean);
  const entitySet = new Set(entityNames);

  let relatedInspirations = [];
  if (userId && entityNames.length) {
    const rows = await all(
      `SELECT text, tags FROM inspirations
       WHERE user_id = ? AND consumed = 0
       ORDER BY created_at DESC
       LIMIT 40`,
      [userId]
    );
    relatedInspirations = rows
      .filter((row) => entityNames.some((name) => String(row.text || '').includes(name)))
      .slice(0, MAX_RELATED_INSPIRATIONS);
  }

  const lines = ['## 作品'];
  lines.push(`标题：${work.title}`);
  if (work.genre) lines.push(`题材：${work.genre}`);
  if (work.synopsis) lines.push(`简介：${clip(work.synopsis, 500)}`);
  if (work.outline) lines.push(`大纲：\n${clip(work.outline, 1600)}`);

  lines.push('', '## 当前章节');
  if (chapter) {
    lines.push(`标题：${chapter.title}`);
    if (chapter.volume) lines.push(`卷：${chapter.volume}`);
    if (chapter.outline) lines.push(`大纲：\n${clip(chapter.outline, 1000)}`);
    if (body) lines.push(`前文结尾：\n${tail(body, 900)}`);
    else lines.push('（本章还没有正文。）');
  } else {
    lines.push('（未指定章节，按整部作品当前阶段生成。）');
  }
  if (previousBody) {
    lines.push('', '## 上一章结尾', tail(previousBody, 500));
  }

  if (chosenCharacters.length) {
    lines.push('', '## 人物（优先本章相关）');
    lines.push(chosenCharacters.map(formatCharacterBrief).join('\n'));
  }

  if (chosenSettings.length) {
    lines.push('', '## 世界观设定');
    lines.push(chosenSettings.map(formatSettingBrief).join('\n'));
  }

  if (chosenCards.length) {
    lines.push('', '## 情节卡（未完成）');
    lines.push(chosenCards.map((card) => formatPlotCard(card)).join('\n'));
  }

  if (anchors.length) {
    lines.push('', '## 历史锚点（只能作为史实依据）');
    lines.push(
      anchors
        .map((a) => {
          const tag =
            a.confidence === 'sourced'
              ? '有出处'
              : a.confidence === 'blank'
                ? '空白·可虚构'
                : '可推定';
          return `[${tag}] ${clip(a.claim, 160)}${a.usable_for ? `——${clip(a.usable_for, 60)}` : ''}`;
        })
        .join('\n')
    );
  }

  if (relatedInspirations.length) {
    lines.push('', '## 作者此前记下的相关灵感');
    lines.push(
      relatedInspirations
        .map((row, index) => `[灵${index + 1}] ${clip(row.text, 160)}${row.tags ? `（${row.tags}）` : ''}`)
        .join('\n')
    );
  }

  // work.title 也放进锚点集合，但阈值判断会保证只有资料足够时才严格校验。
  const knownAnchors = Array.from(new Set([work.title, ...entitySet])).filter(Boolean);

  return { text: lines.join('\n'), knownAnchors };
}

function buildMessages({ contextText, dimension, count, dimensions, exclude }) {
  const dimensionText = dimension
    ? `指定维度：${dimension}｜${BY_KEY.get(dimension).label}`
    : `综合模式：从可用维度中挑 ${MAX_GROUPS} 个与当前章节最相关的维度`;
  const enabledText = dimensions.length
    ? `可用维度：${dimensions.map((key) => `${key}｜${BY_KEY.get(key).label}`).join('；')}`
    : `可用维度：全部六个`;
  const excludeText = exclude.length
    ? `## 已出现过的提示（不要重复）\n${exclude
        .slice(0, MAX_EXCLUDE)
        .map((item, index) => `${index + 1}. ${clip(item, 160)}`)
        .join('\n')}`
    : '';

  const user = [
    contextText,
    '',
    '## 本次生成',
    dimensionText,
    enabledText,
    `每个维度 ${count} 条。`,
    excludeText,
    '只输出 JSON。',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

function isKnownAnchor(value, knownAnchors) {
  const anchor = String(value || '').trim();
  if (!anchor) return false;
  return knownAnchors.some((name) => {
    if (!name) return false;
    if (name === anchor) return true;
    if (name.length < 2 || anchor.length < 2) return false;
    return anchor.includes(name) || name.includes(anchor);
  });
}

function mentionsKnownEntity(text, knownAnchors) {
  return knownAnchors.some((name) => name && name.length >= 2 && text.includes(name));
}

/**
 * 校验并清洗模型输出。
 *
 * 资料足够（人物/设定/情节卡合计 >= 4 个实体）时，anchor 必须命中已知实体，
 * 且正文必须提到至少一个实体——这是「与当前作品相关」的硬校验。
 * 资料很少（新作品）时放宽 anchor，但仍要求具体文本，避免整组直接为空。
 *
 * @param {string} raw 模型原文
 * @param {Object} options
 * @returns {Array<{dimension: string, label: string, prompts: Array}>}
 */
function parseSuggestions(raw, options = {}) {
  const {
    dimension = '',
    count = DEFAULT_COUNT,
    exclude = [],
    dimensions = [],
    knownAnchors = [],
  } = options;

  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.groups)) return [];

  const requested = normalizeDimension(dimension);
  const allowed = new Set(dimensions.length ? dimensions : ALL_KEYS);
  const maxCount = clampCount(count);
  const excluded = new Set(
    (Array.isArray(exclude) ? exclude : [])
      .map((item) => normalizeForCompare(item))
      .filter(Boolean)
  );
  const strict = knownAnchors.length >= 4;
  const seen = new Set();
  const groups = [];

  for (const group of parsed.groups) {
    if (!group || typeof group !== 'object') continue;
    const key = normalizeDimension(group.dimension);
    if (!key || !allowed.has(key)) continue;
    if (requested && key !== requested) continue;
    if (groups.some((g) => g.dimension === key)) continue;

    const prompts = [];
    for (const item of Array.isArray(group.prompts) ? group.prompts : []) {
      if (!item || typeof item !== 'object') continue;

      const text = oneLine(item.text);
      if (text.length < MIN_PROMPT_LENGTH || text.length > MAX_PROMPT_LENGTH) continue;

      const rawAnchor = oneLine(item.anchor);
      if (strict) {
        if (!isKnownAnchor(rawAnchor, knownAnchors)) continue;
        if (!mentionsKnownEntity(text, knownAnchors)) continue;
      }
      const anchor = clip(rawAnchor, MAX_ANCHOR_LENGTH) || clip(knownAnchors[0] || '作品设定', MAX_ANCHOR_LENGTH);

      const reason = clip(oneLine(item.reason), MAX_REASON_LENGTH);
      if (!reason) continue;

      const normalized = normalizeForCompare(text);
      if (!normalized || excluded.has(normalized) || seen.has(normalized)) continue;

      seen.add(normalized);
      prompts.push({ id: crypto.randomUUID(), text, anchor, reason });
      if (prompts.length >= maxCount) break;
    }

    if (prompts.length) {
      groups.push({ dimension: key, label: BY_KEY.get(key).label, prompts });
    }
    if (!requested && groups.length >= MAX_GROUPS) break;
  }

  return groups;
}

/**
 * 带超时的模型调用。返回 { content } 或 { __error } / { __timedOut }。
 */
async function callWithTimeout(provider, messages, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([
      provider
        .chat({
          messages,
          temperature: 0.95,
          maxTokens: 1800,
          jsonOutput: true,
          // 与灵感师一致：思考模式会让 temperature 失效，把惊喜收敛掉。
          thinking: 'disabled',
          signal:
            typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(timeoutMs)
              : undefined,
        })
        .catch((err) => ({ __error: err })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 生成一组候选提示。
 *
 * 只读：不写 inspirations / settings / plot_cards，也不写会话。
 *
 * @param {Object} params
 * @param {Object} params.work 已校验归属的作品行
 * @param {Object|null} [params.chapter] 已校验归属的章节行
 * @param {string} [params.userId]
 * @param {string} [params.dimension] '' 表示综合模式
 * @param {number} [params.count]
 * @param {Array<string>} [params.exclude] 已显示/已忽略的提示，避免重复
 * @param {Array<string>} [params.dimensions] 作者启用的维度
 * @param {Object} [params.provider] 仅供测试注入
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{groups: Array, generatedAt: string, degraded: boolean, reason?: string}>}
 */
async function suggest(params = {}) {
  const {
    work,
    chapter = null,
    userId = '',
    dimension = '',
    count = DEFAULT_COUNT,
    exclude = [],
    dimensions = [],
    provider,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  const generatedAt = new Date().toISOString();
  if (!work) return { groups: [], generatedAt, degraded: true, reason: '缺少作品' };

  const requested = normalizeDimension(dimension);
  const enabled = normalizeDimensions(dimensions);
  const usable = enabled.length ? enabled : ALL_KEYS;
  if (requested && !usable.includes(requested)) {
    return { groups: [], generatedAt, degraded: true, reason: '这个维度当前未启用' };
  }

  let active = provider;
  let providerName = provider ? provider.name || '' : '';
  if (!active) {
    try {
      const resolved = resolveProvider(aiConfig.getConfig());
      active = resolved.provider;
      providerName = resolved.name || '';
    } catch (e) {
      return { groups: [], generatedAt, degraded: true, reason: '还没有可用的 AI 服务' };
    }
  }

  let context;
  try {
    context = await buildContext({ work, chapter, userId });
  } catch (e) {
    return { groups: [], generatedAt, degraded: true, reason: '作品资料读取失败，请重试' };
  }

  const messages = buildMessages({
    contextText: context.text,
    dimension: requested,
    count: clampCount(count),
    dimensions: usable,
    exclude: Array.isArray(exclude)
      ? exclude.filter((item) => typeof item === 'string' && item.trim()).slice(0, MAX_EXCLUDE)
      : [],
  });

  const result = await callWithTimeout(active, messages, timeoutMs);
  if (!result || result.__timedOut) {
    return { groups: [], generatedAt, degraded: true, reason: '生成超时，可以再试一次' };
  }
  if (result.__error) {
    return { groups: [], generatedAt, degraded: true, reason: 'AI 服务暂时不可用，请稍后再试' };
  }

  const groups = parseSuggestions(result.content || '', {
    dimension: requested,
    count,
    exclude,
    dimensions: usable,
    knownAnchors: context.knownAnchors,
  });

  if (!groups.length) {
    return { groups: [], generatedAt, degraded: true, reason: '这次没有生成可用的方向，可以换一组再试' };
  }

  return {
    groups,
    generatedAt,
    degraded: false,
    // 只用于排查，不参与前端展示
    provider: providerName,
  };
}

function listDimensions() {
  return DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    description: d.description,
    example: d.example,
  }));
}

module.exports = {
  suggest,
  buildContext,
  buildMessages,
  parseSuggestions,
  listDimensions,
  clampCount,
  DIMENSIONS,
  DEFAULT_COUNT,
  MIN_COUNT,
  MAX_COUNT,
  MAX_GROUPS,
  MIN_PROMPT_LENGTH,
  MAX_PROMPT_LENGTH,
};
