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
 *   AI 层（需要模型）—— 把全书正文按字数分批交给审稿人逐段精读，
 *     再把各章摘要与已发现问题汇总做一次跨章总检，
 *     找规则层找不到的语义矛盾（前后时间线、性格突变、设定打架）
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
// AI 层：逐批精读 + 跨章总检
// ---------------------------------------------------------------------------

/** 单批送进模型的字数上限：太大模型容易漏读、输出也容易被截断。 */
const CHUNK_CHARS = Math.max(2000, Number(config.consistencyChunkChars) || 12000);
/** 一次检查最多读多少字；超出按章序截断，并在结果里说明，不静默少读。 */
const MAX_CHARS = Math.max(CHUNK_CHARS, Number(config.consistencyMaxChars) || 300000);
/** quote 至少多少字才参与定位（与前端审稿意见的 6 字规则一致）。 */
const MIN_QUOTE_LENGTH = 6;

const BATCH_TASK_PROMPT = `## 本次任务：全书精读（第 {index} / {total} 批）
你拿到的是全书中的一段连续章节。请逐段细读，只报这些章节里确实存在的问题。
- 每条问题必须能落到某一章的某一段原文上：给出 chapterSeq 和逐字抄录的 quote。
- 不要写"整体不错，但……"这类客套，也不要提无法执行的建议。
- 最多 8 条；确实没问题就返回 {"issues": []}。
- 只输出一个 JSON 对象，不要 markdown 代码块，不要额外文字。

{
  "issues": [
    {
      "chapterSeq": 3,
      "severity": "high | medium | low",
      "title": "10–20 字的问题概括",
      "detail": "问题是什么、读者会怎么误解、建议怎么改",
      "quote": "该章正文里逐字抄录的片段（6–80 字）"
    }
  ]
}`;

const REDUCE_TASK_PROMPT = `## 本次任务：全书跨章总检
前面已经逐批读完全书正文，下面给出各章摘要和逐批发现的问题。
请只找**跨章层面**的矛盾：同一事件在不同章里的时间/因果冲突、人物性格或能力前后不一致、
前文埋的因后文没有结果、设定卡与正文打架。
不要重复下面已经列出的问题，也不要报单章的措辞好坏。
每条必须给 chapterSeq；quote 尽量逐字抄自所给章节开头的原文，抄不到就省略。
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
 * 规划一次全书检查：读全章正文、切批、算覆盖范围。
 *
 * 切批只按章边界，不把一章切成两半：quote 要能落回某一章，
 * 半章上下文也容易让模型误判人物状态。
 *
 * @param {string} workId
 * @returns {Promise<Object|null>}
 */
async function planAiCheck(workId) {
  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return null;

  const rows = await all(
    `SELECT id, title, seq, volume, status, content, blocks, outline, word_count
     FROM chapters WHERE work_id = ? ORDER BY seq, created_at`,
    [workId]
  );
  const characters = await all('SELECT * FROM characters WHERE work_id = ? ORDER BY name', [
    workId,
  ]);
  const settings = await all('SELECT * FROM settings WHERE work_id = ? ORDER BY name', [workId]);

  const chapters = [];
  for (const row of rows) {
    const text = chapterText(row);
    if (!text.trim()) continue;
    chapters.push({
      id: row.id,
      seq: row.seq,
      title: row.title,
      volume: row.volume,
      outline: row.outline || '',
      blocks: blocksOf(row),
      text,
    });
  }

  const batches = [];
  let current = null;
  let usedChars = 0;
  let covered = 0;

  for (const chapter of chapters) {
    if (usedChars + chapter.text.length > MAX_CHARS) break;
    if (!current || (current.chapters.length && current.chars + chapter.text.length > CHUNK_CHARS)) {
      current = { chapters: [], chars: 0 };
      batches.push(current);
    }
    current.chapters.push(chapter);
    current.chars += chapter.text.length;
    usedChars += chapter.text.length;
    covered += 1;
  }

  const notices = [];
  if (covered < chapters.length) {
    notices.push(
      `全书共 ${chapters.length} 章，本次只读了前 ${covered} 章（单次上限约 ${MAX_CHARS} 字）。其余章节请再查一次。`
    );
  }

  return { work, characters, settings, chapters, batches, notices };
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

    return {
      type: 'ai',
      severity: raw.severity || 'medium',
      title,
      detail,
      target: chapter ? chapter.title : '',
      chapterId: chapter ? chapter.id : '',
      chapterSeq: chapter ? chapter.seq : 0,
      chapterTitle: chapter ? chapter.title : '',
      quote,
      blockId: chapter ? findBlockId(chapter, quote) : '',
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
 * 执行全书检查。
 *
 * @param {Object} plan planAiCheck 的结果
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} [params.providerName]
 * @param {Object} [params.role]
 * @param {Function} [params.onProgress] (done, total) => void
 * @returns {Promise<{issues: Array<Object>, notices: Array<string>}>}
 */
async function executeAiCheck(plan, params = {}) {
  const { provider, providerName, role, onProgress } = params;
  const shared = buildSharedContext(plan);
  const baseSystem = `${role?.systemPrompt || ''}\n\n${shared}`;
  const total = plan.batches.length + (plan.batches.length > 1 ? 1 : 0);
  const notices = [...plan.notices];
  const rawIssues = [];
  let done = 0;

  for (let i = 0; i < plan.batches.length; i += 1) {
    const batch = plan.batches[i];
    const first = batch.chapters[0];
    const last = batch.chapters[batch.chapters.length - 1];
    const rangeLabel =
      first.seq === last.seq ? `第 ${first.seq} 章` : `第 ${first.seq}–${last.seq} 章`;
    const fallbackSeq = batch.chapters.length === 1 ? first.seq : 0;

    const body = batch.chapters
      .map((c) => `## 第 ${c.seq} 章 ${c.title}\n${c.text}`)
      .join('\n\n');

    try {
      const result = await provider.chat({
        messages: [
          {
            role: 'system',
            content: `${baseSystem}\n\n${BATCH_TASK_PROMPT.replace('{index}', String(i + 1)).replace(
              '{total}',
              String(plan.batches.length)
            )}`,
          },
          {
            role: 'user',
            content: `以下是第 ${first.seq}–${last.seq} 章的正文，请按上面的格式输出问题清单。\n\n${body}`,
          },
        ],
        ...chatOptions(role, providerName, 2000),
      });
      rawIssues.push(...parseAiIssues(result?.content, fallbackSeq));
    } catch (err) {
      notices.push(`${rangeLabel}没有读完（${err.message}），这部分可能漏检。`);
    }

    done += 1;
    if (onProgress) onProgress(done, total);
  }

  if (plan.batches.length > 1) {
    try {
      const summaries = plan.chapters
        .map((c) => {
          const outline = c.outline ? `\n大纲：${c.outline}` : '';
          return `## 第 ${c.seq} 章 ${c.title}${outline}\n开头：${c.text.slice(0, 220)}`;
        })
        .join('\n\n');

      const known = rawIssues.length
        ? rawIssues
            .slice(0, 60)
            .map((issue) => `- 第 ${issue.chapterSeq || '?'} 章：${issue.title || issue.detail}`)
            .join('\n')
        : '（暂无）';

      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${baseSystem}\n\n${REDUCE_TASK_PROMPT}` },
          {
            role: 'user',
            content: `## 各章摘要\n${summaries}\n\n## 已发现的问题\n${known}\n\n请补上跨章层面的矛盾。`,
          },
        ],
        ...chatOptions(role, providerName, 1400),
      });
      rawIssues.push(...parseAiIssues(result?.content, 0));
    } catch (err) {
      notices.push(`跨章总检没有完成（${err.message}），只保留逐批结果。`);
    }

    done += 1;
    if (onProgress) onProgress(done, total);
  }

  return { issues: dedupeIssues(resolveIssues(rawIssues, plan)), notices };
}

/**
 * AI 层检查：整本正文逐批精读，再做一次跨章总检。
 *
 * 作品不存在或全书还没有正文时返回空清单。
 *
 * @param {string} workId
 * @param {Object} params 见 executeAiCheck
 */
async function runAiCheck(workId, params = {}) {
  const plan = await planAiCheck(workId);
  if (!plan) return { issues: [], notices: [] };
  if (!plan.batches.length) {
    return { issues: [], notices: [...plan.notices, '全书还没有正文，没有可检查的内容。'] };
  }
  return executeAiCheck(plan, params);
}

module.exports = {
  planAiCheck,
  executeAiCheck,
  runRuleChecks,
  runAiCheck,
  parseAiIssues,
};
