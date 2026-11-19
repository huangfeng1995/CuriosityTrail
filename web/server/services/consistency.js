'use strict';

/**
 * 全书一致性检查。
 *
 * 分两层：
 *   规则层（本地、免费、立刻出结果）—— 靠数据库里的结构化数据交叉比对
 *     · 人物卡里的角色，正文里从没出现过（写废了的人物）
 *     · 正文里出现了但没有人物卡的角色（漏建卡）
 *     · 设定卡写了但正文从没提到（没落地的设定）
 *     · 章节标题重复、章节状态异常
 *     · 人物别名与其它人物重名（一个人两个名字，AI 会当成两个人）
 *   AI 层（需要模型）—— 只做规则层看不到的跨章总检：
 *     把每章压成「大纲 + 开头/结尾关键段」，按字数分组，多组时再做一次
 *     跨组汇总，找时间线、人物状态、伏笔回收等跨章矛盾。
 *     不逐批精读全文——那是审稿人的活，重复且昂贵。
 *
 * 规则层先跑：它不花钱、结果确定，能立刻指出最刺眼的问题。
 */

const config = require('../config');
const { all, get } = require('../database');
const { isPipelineEnabled } = require('./pipeline/gate');
const { checkAnchors } = require('./pipeline/anchorCheck');

/**
 * 取人物的所有可识别名称。
 *
 * 这里延迟 require：context.js 装配上下文时会加载技能注册表，
 * 技能注册表又加载本模块（checkConsistency 技能）——形成循环依赖。
 * 在顶层解构 nameVariants 会拿到尚未填充的 exports，运行时就是 undefined。
 *
 * @param {Object} character
 * @returns {Array<string>}
 */
function nameVariants(character) {
  return require('./context').nameVariants(character);
}

/**
 * 章节状态白名单
 */
const VALID_STATUS = new Set(['draft', 'revising', 'done']);

/**
 * 把人物名归一化，用于跨人物查重。
 */
function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

/**
 * 规则层检查。
 *
 * @param {string} workId
 * @returns {Promise<Array<Object>>} 问题列表
 */
async function runRuleChecks(workId) {
  const issues = [];

  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return issues;

  const chapters = await all(
    'SELECT id, title, seq, status, content, blocks FROM chapters WHERE work_id = ? ORDER BY seq',
    [workId]
  );
  const characters = await all(
    'SELECT * FROM characters WHERE work_id = ?',
    [workId]
  );
  const settings = await all(
    'SELECT * FROM settings WHERE work_id = ?',
    [workId]
  );

  const fullText = chapters.map((c) => c.content || '').join('\n');

  // ---- 人物：卡里有、正文里没出现 ----
  for (const character of characters) {
    const variants = nameVariants(character);
    const appeared = variants.some((v) => v && fullText.includes(v));
    if (!appeared && fullText.length > 0) {
      issues.push({
        type: 'unused_character',
        severity: 'low',
        title: `人物「${character.name}」从未在正文中出现`,
        detail:
          '人物卡已建好，但全书正文里找不到这个名字。要么是没写进去，要么是这个角色已经不需要了。',
        target: character.name,
      });
    }
  }

  // ---- 人物：别名与他人重名 ----
  const nameOwner = new Map();
  for (const character of characters) {
    for (const variant of nameVariants(character)) {
      const key = normalizeName(variant);
      if (!key) continue;
      if (nameOwner.has(key) && nameOwner.get(key) !== character.id) {
        issues.push({
          type: 'duplicate_name',
          severity: 'medium',
          title: `「${variant}」同时属于两个不同的人物`,
          detail: `「${character.name}」和「${
            characters.find((c) => c.id === nameOwner.get(key))?.name || '另一人物'
          }」共用同一个名字。AI 会把两个人当成同一个，检索和一致性判断都会出错。`,
          target: variant,
        });
      } else {
        nameOwner.set(key, character.id);
      }
    }
  }

  // ---- 设定：卡里写了、正文没提 ----
  for (const setting of settings) {
    if (!setting.name) continue;
    if (!fullText.includes(setting.name)) {
      issues.push({
        type: 'unused_setting',
        severity: 'low',
        title: `设定「${setting.name}」尚未在正文中落地`,
        detail: '设定卡存在但正文没提到。要么还没写到，要么这个设定用不上了。',
        target: setting.name,
      });
    }
  }

  // ---- 章节：状态异常 ----
  for (const chapter of chapters) {
    if (chapter.status && !VALID_STATUS.has(chapter.status)) {
      issues.push({
        type: 'invalid_status',
        severity: 'low',
        title: `章节「${chapter.title}」的状态值异常`,
        detail: `状态是「${chapter.status}」，不在草稿/修订中/已完成之内。`,
        target: chapter.title,
      });
    }
  }

  // ---- 章节：标题重复 ----
  const titleCount = new Map();
  for (const chapter of chapters) {
    const key = normalizeName(chapter.title);
    titleCount.set(key, (titleCount.get(key) || 0) + 1);
  }
  for (const [title, count] of titleCount) {
    if (count > 1) {
      issues.push({
        type: 'duplicate_chapter_title',
        severity: 'low',
        title: `有 ${count} 章都叫「${title}」`,
        detail: '章节重名会让目录和导出时难以分辨，建议改掉。',
        target: title,
      });
    }
  }

  // ---- 锚点：史实断言与正文冲突（模板启用时的第 6 类规则） ----
  // 走既有报告出口，不另造接口：作者在「一致性检查」页看到的
  // 违锚点和人物未登场、设定未落地是同一份清单。
  if (isPipelineEnabled(work)) {
    try {
      const anchors = await all(
        `SELECT * FROM work_anchors
         WHERE work_id = ? AND status = 'active'
         ORDER BY created_at ASC, id ASC`,
        [workId]
      );
      if (anchors.length) {
        const anchorById = new Map(anchors.map((a) => [a.id, a]));
        for (const chapter of chapters) {
          const body = chapterText(chapter);
          if (!body) continue;
          const hits = checkAnchors(anchors, chapter.seq, [
            { id: chapter.id, content: body },
          ]);
          for (const hit of hits) {
            const anchor = anchorById.get(hit.anchorId) || {};
            issues.push({
              type: 'anchor_violation',
              severity: 'high',
              title: `锚点冲突：第 ${chapter.seq} 章「${hit.quote.slice(0, 30)}」`,
              detail: `${
                anchor.subject ? `「${anchor.subject}」：` : ''
              }${anchor.claim || '锚点断言'}。正文命中「${hit.quote}」（${hit.ruleType}）。`,
              target: anchor.subject || '',
            });
          }
        }
      }
    } catch (err) {
      // 一条新规则坏掉，不能让整份一致性报告失败
      console.error('[consistency] 锚点检查失败（已跳过）:', err.message);
    }
  }

  return issues;
}

/**
 * 章节块：blocks 坏掉时返回空数组，由调用方退回 content。
 */
function blocksOf(chapter) {
  if (!chapter.blocks) return [];
  try {
    const parsed = JSON.parse(chapter.blocks);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 章节正文：blocks 优先，content 兜底。
 *
 * 编辑器以 blocks 为准，纯文本 content 可能还没同步；
 * 只看 content 会漏掉实际写进块里的句子。
 */
function chapterText(chapter) {
  const body = blocksOf(chapter)
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
  return body || String(chapter.content || '');
}

// ---------------------------------------------------------------------------
// AI 层：跨章总检（只看摘要，不逐批精读全文）
// ---------------------------------------------------------------------------

/** 一组摘要的字数上限：超过就分组，多组时再做一次跨组汇总。 */
const DIGEST_CHUNK_CHARS = Math.max(500, Number(config.consistencyDigestChars) || 24000);
/** 每章送进摘要的开头 / 结尾字数。只给关键段，不是全文。 */
const OPENING_CHARS = 220;
const ENDING_CHARS = 180;
/** 大纲只取前这么长：它是结构信息里信息密度最高的一段。 */
const OUTLINE_CHARS = 200;
/** quote 至少多少字才参与定位（与前端审稿意见的 6 字规则一致）。 */
const MIN_QUOTE_LENGTH = 6;

const CROSS_CHAPTER_RULES = `只找**跨章层面**的问题：
- 同一事件在不同章里的时间、地点、因果冲突；
- 人物关系、性格、能力前后不一致；
- 前文埋下的因，后文没有结果（或结果对不上）；
- 人物卡/设定卡与所给章节内容打架。

不要报这些（它们要么不属于本次范围，要么规则层已经单独报过）：
- 单章的节奏、措辞、对白质量、错别字；
- 人物卡里的人物从未在正文出现、设定未落地、别名/章节重名、
  章节状态异常、史实锚点冲突。`;

const GROUP_TASK_PROMPT = `## 本次任务：跨章一致性总检（第 {index} / {total} 组）
你拿到的是若干章的**开头/结尾关键段与大纲**，不是全文。
${CROSS_CHAPTER_RULES}
每条问题必须给 chapterSeq（问题最明显的那一章）；quote 只能从所给
开头/结尾原文里逐字抄录，抄不到就留空，不要自己编。
最多 6 条；没有就返回 {"issues": []}。只输出 JSON，不要 markdown 代码块。`;

const REDUCE_TASK_PROMPT = `## 本次任务：全书跨章总检（汇总）
下面给出全书各章的摘要行，以及分组总检已经发现的问题。
${CROSS_CHAPTER_RULES}
请补上**跨组之间**才看得出的矛盾，并去掉与下面已知问题重复的条目。
每条必须给 chapterSeq；quote 尽量逐字抄自所给章节摘要，抄不到就留空。
最多 6 条；没有就返回 {"issues": []}。只输出 JSON。`;

/** 人物卡的一行摘要，和单章上下文里的写法保持一致。 */
function characterLine(c) {
  const bits = [`【${c.name}】`];
  if (c.role) bits.push(`身份：${c.role}`);
  if (c.identity) bits.push(`背景：${c.identity}`);
  if (c.personality) bits.push(`性格：${c.personality}`);
  if (c.goal) bits.push(`目标：${c.goal}`);
  if (c.arc) bits.push(`弧光：${c.arc}`);
  if (c.aliases) bits.push(`别名：${c.aliases}`);
  return bits.join('；');
}

/**
 * 作品级上下文：每批、以及最后的跨章总检都要带。
 */
function buildSharedContext(plan) {
  const { work, characters, settings } = plan;
  const parts = ['## 作品'];
  parts.push(`标题：${work.title}`);
  if (work.genre) parts.push(`题材：${work.genre}`);
  if (work.synopsis) parts.push(`简介：${work.synopsis}`);
  if (work.outline) parts.push(`大纲：\n${work.outline}`);

  parts.push('\n## 人物卡');
  parts.push(characters.length ? characters.map(characterLine).join('\n') : '（还没有人物卡）');

  parts.push('\n## 设定卡');
  parts.push(
    settings.length
      ? settings.map((s) => `【${s.name}·${s.category || ''}】${s.content || ''}`).join('\n')
      : '（还没有设定卡）'
  );
  return parts.join('\n');
}

/**
 * 一章节的摘要：开头关键段 + 结尾关键段 + 大纲。
 *
 * 为什么不喂全文：跨章矛盾看的是「同一件事在不同章是否对齐」，
 * 结构信息比细节更有用；而 30 万字全文要 25 次以上调用，
 * 与审稿人逐章精读高度重合。这里只取信息密度最高的部分。
 *
 * @param {Object} chapter 章节行
 * @returns {{opening: string, ending: string}}
 */
function chapterDigest(chapter) {
  const blocks = blocksOf(chapter).filter(
    (b) => b && String(b.content || '').trim()
  );

  if (blocks.length) {
    const opening = blocks
      .slice(0, 2)
      .map((b) => String(b.content).trim())
      .join('')
      .slice(0, OPENING_CHARS);
    const ending =
      blocks.length > 2
        ? blocks
            .slice(-2)
            .map((b) => String(b.content).trim())
            .join('')
            .slice(-ENDING_CHARS)
        : '';
    return { opening, ending };
  }

  const text = String(chapter.content || '').trim();
  return {
    opening: text.slice(0, OPENING_CHARS),
    ending: text.length > OPENING_CHARS ? text.slice(-ENDING_CHARS) : '',
  };
}

/**
 * 规划一次跨章总检：把每章压成摘要，按字数分组。
 *
 * 调用次数 = 分组数 + （分组数 > 1 时的一次跨组汇总）。
 * 30 万字约 100 章，每章摘要 400–600 字 → 2–3 组，共 3–4 次调用；
 * 即使 300 章也能稳定在个位数。
 *
 * 注意：plan.chapters 里仍保留全文与 blocks，但只用于把模型给的 quote
 * 落回章节/块，**不会**发进模型请求。
 *
 * @param {string} workId
 * @returns {Promise<Object|null>}
 */
async function planAiCheck(workId) {
  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return null;

  const rows = await all(
    `SELECT id, title, seq, volume, status, content, blocks, outline
     FROM chapters WHERE work_id = ? ORDER BY seq, created_at`,
    [workId]
  );
  const characters = await all('SELECT * FROM characters WHERE work_id = ? ORDER BY name', [
    workId,
  ]);
  const settings = await all('SELECT * FROM settings WHERE work_id = ? ORDER BY name', [workId]);

  const chapters = [];
  for (const row of rows) {
    const { opening, ending } = chapterDigest(row);
    if (!opening && !ending) continue;
    chapters.push({
      id: row.id,
      seq: row.seq,
      title: row.title,
      volume: row.volume,
      outline: String(row.outline || '').slice(0, OUTLINE_CHARS),
      opening,
      ending,
      // 仅用于 quote → 章节/块 的定位，不进入提示词
      text: chapterText(row),
      blocks: blocksOf(row),
    });
  }

  const digests = [];
  let current = null;

  for (const chapter of chapters) {
    const size = digestText(chapter).length;
    if (!current || (current.chapters.length && current.chars + size > DIGEST_CHUNK_CHARS)) {
      current = { chapters: [], chars: 0 };
      digests.push(current);
    }
    current.chapters.push(chapter);
    current.chars += size;
  }

  return {
    work,
    characters,
    settings,
    chapters,
    digests,
    // 前端进度条和报告都可以直接用这个数
    calls: digests.length + (digests.length > 1 ? 1 : 0),
    notices: [],
  };
}

/** 一章在提示词里的实际文本。 */
function digestText(chapter) {
  const lines = [`## 第 ${chapter.seq} 章 ${chapter.title}`];
  if (chapter.outline) lines.push(`大纲：${chapter.outline}`);
  if (chapter.opening) lines.push(`开头：${chapter.opening}`);
  if (chapter.ending) lines.push(`结尾：${chapter.ending}`);
  return lines.join('\n');
}

/** 归一化：去空白、全角标点转半角，便于 quote 匹配。 */
function normalizeForMatch(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[…⋯]{2,}/g, '…')
    .replace(/\.{3,}/g, '…');
}

function needleOf(quote) {
  const normalized = normalizeForMatch(quote);
  return normalized.endsWith('…') ? normalized.slice(0, -1) : normalized;
}

/**
 * 把 quote 落回某一章：全书必须唯一命中，否则宁可不定章，也不乱挂。
 */
function findChapterByQuote(chapters, quote) {
  const needle = needleOf(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return null;

  const hits = chapters.filter((c) => normalizeForMatch(c.text).includes(needle));
  return hits.length === 1 ? hits[0] : null;
}

/** 在章内找唯一的块；多处命中就只留 quote，不指定块。 */
function findBlockId(chapter, quote) {
  const needle = needleOf(quote);
  if (!chapter || needle.length < MIN_QUOTE_LENGTH) return '';
  const hits = chapter.blocks.filter(
    (b) => b && b.content && normalizeForMatch(b.content).includes(needle)
  );
  return hits.length === 1 ? hits[0].id : '';
}

/** 模型输出的宽松解析：JSON 优先，分条文本兜底。 */
function parseAiIssues(text, fallbackSeq = 0) {
  if (!text || !text.trim()) return [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;

  try {
    const parsed = JSON.parse(candidate);
    const items = Array.isArray(parsed) ? parsed : parsed?.issues;
    if (Array.isArray(items)) {
      return items
        .map((item) => {
          const rawItem = item && typeof item === 'object' ? item : {};
          const seq = Number(rawItem.chapterSeq ?? rawItem.chapter ?? rawItem.seq);
          const severity = ['high', 'medium', 'low'].includes(rawItem.severity)
            ? rawItem.severity
            : 'medium';
          return {
            chapterSeq: Number.isFinite(seq) && seq > 0 ? seq : fallbackSeq,
            severity,
            title: String(rawItem.title || '').trim(),
            detail: String(rawItem.detail || rawItem.content || '').trim(),
            quote: String(rawItem.quote || '').trim(),
          };
        })
        .filter((issue) => issue.title || issue.detail);
    }
  } catch (e) {
    // 不是 JSON，走文本分条
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 2);

  const issues = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*·•\d]+[.、)]?\s*/, '').trim();
    if (!cleaned) continue;
    if (/^(未发现|没有发现|未发现跨章矛盾)[。.]?$/.test(cleaned)) continue;
    issues.push({
      chapterSeq: fallbackSeq,
      severity: 'medium',
      title: cleaned.slice(0, 40),
      detail: cleaned,
      quote: '',
    });
  }
  return issues;
}

/**
 * 把模型给的章节号 + quote 解析成前端能用的定位信息。
 *
 * 顺序：先信 chapterSeq；该章里找不到 quote 时，再按全书唯一命中改判；
 * 仍然找不到就只保留文本，前端显示为「全书」。
 */
function resolveIssues(rawIssues, plan) {
  const bySeq = new Map(plan.chapters.map((c) => [c.seq, c]));

  return rawIssues.map((raw) => {
    const quote = String(raw.quote || '').trim();
    const needle = needleOf(quote);
    let chapter = bySeq.get(Number(raw.chapterSeq)) || null;

    if (quote && (!chapter || !normalizeForMatch(chapter.text).includes(needle))) {
      chapter = findChapterByQuote(plan.chapters, quote) || chapter;
    }
    if (!chapter && quote) {
      chapter = findChapterByQuote(plan.chapters, quote);
    }

    const detail = String(raw.detail || '').trim();
    const title = String(raw.title || '').trim() || detail.slice(0, 40);
    const blockId = chapter ? findBlockId(chapter, quote) : '';

    return {
      type: 'ai',
      source: 'cross_chapter',
      severity: raw.severity || 'medium',
      title,
      detail,
      target: chapter ? chapter.title : '',
      chapterId: chapter ? chapter.id : '',
      chapterSeq: chapter ? chapter.seq : 0,
      chapterTitle: chapter ? chapter.title : '',
      quote,
      blockId,
      // 只有章和块都定位到了才能跳正文；否则前端只标注章节
      locatable: Boolean(chapter && blockId),
    };
  });
}

/** 同一章里标题与片段都相同的，只留一条。 */
function dedupeIssues(issues) {
  const seen = new Set();
  const out = [];
  for (const issue of issues) {
    const key = [
      issue.chapterSeq || 0,
      normalizeForMatch(issue.title),
      normalizeForMatch(issue.quote).slice(0, 60),
    ].join('::');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function chatOptions(role, providerName, maxTokens) {
  return {
    temperature: role?.temperature ?? 0.4,
    model: role?.model && providerName === 'deepseek' ? role.model : undefined,
    thinking:
      role?.thinking === null || role?.thinking === undefined
        ? undefined
        : role.thinking
          ? 'enabled'
          : 'disabled',
    jsonOutput: true,
    maxTokens,
  };
}

/**
 * 规则层已经能确定的问题类型 → 判定关键词。
 *
 * 跨章总检的提示词已经明确要求不要报这些，但模型仍可能换个说法重复。
 * 这里再兜一层：同一类问题只要指向同一个人物/设定/章节，就丢掉，
 * 保证作者不会在同一个面板里看到两遍。
 */
const RULE_OVERLAP_PATTERNS = {
  unused_character: /(从未|没有|未曾).{0,8}(出现|登场|出场)/,
  unused_setting: /(未|没有|尚未).{0,8}(落地|提到|出现|写入)/,
  duplicate_name: /(重名|同名|共用.{0,6}名字|别名冲突)/,
  duplicate_chapter_title: /(章.{0,8}重名|都叫|标题重复)/,
  invalid_status: /状态(值)?异常/,
  anchor_violation: /锚点冲突|史实冲突/,
};

/**
 * 这条 AI 结论是不是规则层已经报过的同一问题。
 *
 * @param {Object} issue 已解析定位的 AI 结论
 * @param {Array<Object>} ruleIssues 本轮规则层结论
 * @returns {boolean}
 */
function isRuleDuplicate(issue, ruleIssues) {
  if (!ruleIssues || !ruleIssues.length) return false;

  const title = normalizeForMatch(issue.title);
  const text = normalizeForMatch(`${issue.title}${issue.detail}`);

  return ruleIssues.some((rule) => {
    const ruleTitle = normalizeForMatch(rule.title);
    if (ruleTitle && title && (title === ruleTitle || title.includes(ruleTitle) || ruleTitle.includes(title))) {
      return true;
    }

    const target = normalizeForMatch(rule.target);
    if (!target || !text.includes(target)) return false;

    const pattern = RULE_OVERLAP_PATTERNS[rule.type];
    return Boolean(pattern && pattern.test(text));
  });
}

/** 规则层结论清单：放进提示词，让模型从一开始就别报。 */
function ruleExclusionBlock(ruleIssues) {
  if (!ruleIssues || !ruleIssues.length) return '规则层已报：暂无。';
  const lines = ruleIssues.slice(0, 40).map((issue) => `- ${issue.title}`);
  return `规则层已报（不要重复）：\n${lines.join('\n')}`;
}

/**
 * 执行跨章总检。
 *
 * 只发摘要：每组若干章的「标题 + 大纲 + 开头/结尾关键段」。
 * 调用次数 = 分组数 + 汇总（分组 > 1 时）。
 *
 * @param {Object} plan planAiCheck 的结果
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} [params.providerName]
 * @param {Object} [params.role]
 * @param {Function} [params.onProgress] (done, total) => void
 * @param {Array<Object>} [params.excludeIssues] 规则层结论，用于去重
 * @returns {Promise<{issues: Array<Object>, notices: Array<string>, calls: number}>}
 */
async function executeAiCheck(plan, params = {}) {
  const { provider, providerName, role, onProgress, excludeIssues = [] } = params;
  const shared = buildSharedContext(plan);
  const baseSystem = `${role?.systemPrompt || ''}\n\n${shared}`;
  const groups = plan.digests || [];
  const total = groups.length + (groups.length > 1 ? 1 : 0);
  const notices = [...(plan.notices || [])];
  const rawIssues = [];
  const exclusion = ruleExclusionBlock(excludeIssues);
  let done = 0;

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const first = group.chapters[0];
    const last = group.chapters[group.chapters.length - 1];
    const rangeLabel =
      first.seq === last.seq ? `第 ${first.seq} 章` : `第 ${first.seq}–${last.seq} 章`;
    const fallbackSeq = group.chapters.length === 1 ? first.seq : 0;
    const body = group.chapters.map(digestText).join('\n\n');

    try {
      const result = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `${baseSystem}\n\n${GROUP_TASK_PROMPT.replace(
              '{index}',
              String(i + 1)
            ).replace('{total}', String(groups.length))}\n\n${exclusion}`,
          },
          {
            role: 'user',
            content: `以下是第 ${first.seq}–${last.seq} 章的结构摘要，请只报跨章矛盾。\n\n${body}`,
          },
        ],
        ...chatOptions(role, providerName, 1600),
      });
      rawIssues.push(...parseAiIssues(result?.content, fallbackSeq));
    } catch (err) {
      notices.push(`${rangeLabel}这组没有检查完（${err.message}），这部分可能漏检。`);
    }

    done += 1;
    if (onProgress) onProgress(done, total);
  }

  if (groups.length > 1) {
    try {
      // 汇总阶段只拿「章名 + 大纲 + 开头一句」，控制在 12000 字以内
      const lines = [];
      let used = 0;
      for (const c of plan.chapters) {
        const line = `第 ${c.seq} 章 ${c.title}｜大纲：${c.outline || '（无）'}｜开头：${
          c.opening.slice(0, 60)
        }`;
        if (used + line.length > 12000) break;
        lines.push(line);
        used += line.length;
      }

      const known = rawIssues.length
        ? rawIssues
            .slice(0, 60)
            .map((issue) => `- 第 ${issue.chapterSeq || '?'} 章：${issue.title || issue.detail}`)
            .join('\n')
        : '（暂无）';

      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${baseSystem}\n\n${REDUCE_TASK_PROMPT}\n\n${exclusion}` },
          {
            role: 'user',
            content: `## 各章摘要\n${lines.join('\n')}\n\n## 分组已发现的问题\n${known}\n\n请补上跨组矛盾。`,
          },
        ],
        ...chatOptions(role, providerName, 1400),
      });
      rawIssues.push(...parseAiIssues(result?.content, 0));
    } catch (err) {
      notices.push(`跨组汇总没有完成（${err.message}），只保留分组结果。`);
    }

    done += 1;
    if (onProgress) onProgress(done, total);
  }

  const resolved = resolveIssues(rawIssues, plan).filter(
    (issue) => !isRuleDuplicate(issue, excludeIssues)
  );

  return { issues: dedupeIssues(resolved), notices, calls: total };
}

/**
 * 跨章总检入口。
 *
 * 作品不存在或全书还没有正文时返回空清单。
 *
 * @param {string} workId
 * @param {Object} params 见 executeAiCheck
 */
async function runAiCheck(workId, params = {}) {
  const plan = await planAiCheck(workId);
  if (!plan) return { issues: [], notices: [], calls: 0 };
  if (!plan.digests.length) {
    return {
      issues: [],
      notices: [...plan.notices, '全书还没有正文，没有可检查的内容。'],
      calls: 0,
    };
  }

  const excludeIssues = params.excludeIssues || (await runRuleChecks(workId));
  return executeAiCheck(plan, { ...params, excludeIssues });
}

module.exports = {
  planAiCheck,
  executeAiCheck,
  runRuleChecks,
  runAiCheck,
  parseAiIssues,
  isRuleDuplicate,
};
