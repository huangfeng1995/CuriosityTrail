'use strict';

/**
 * 章节摘要。
 *
 * 每章写出一段正文后，用**一次**模型调用把它压成一份给后续章节看的摘要：
 * 推进了什么、留下什么未解、时间地点、在场人物。
 *
 * 为什么值得花这次调用：
 *   · 后续章节只能看到上一章结尾 500 字，看不到三五章之前发生过什么；
 *   · 摘要只有两三百字，却能让模型知道「前面已经走到哪」，
 *     比把整章正文重读一遍便宜得多。
 *
 * 成本控制（宁可摘要旧一点，也不要每次保存都调模型）：
 *   · 正文不足 MIN_SUMMARY_WORDS 不生成——太短的段落没有前情价值；
 *   · 已有摘要时，只有篇幅变化超过阈值才重算；
 *   · 保存触发的任务按章去抖（DEBOUNCE_MS），连续敲键盘只会在停笔后跑一次；
 *   · 失败静默，保留上一版摘要，不影响保存与写作。
 */

const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');
const { all, get, run } = require('../../database');
const { countWords } = require('../wordCount');

/** 低于这个字数不生成摘要：过渡段、残章没有前情价值，调用纯属浪费。 */
const MIN_SUMMARY_WORDS = 500;
/** 草稿阶段重新生成的门槛：篇幅至少多一半，且不少于 500 字。 */
const MIN_WORD_DELTA = 500;
const GROWTH_RATIO = 0.5;
/** 章节标成 done 时，篇幅变化超过这个数就重算一次，确保完结章摘要是最新的。 */
const DONE_WORD_DELTA = 20;
/** 保存触发的去抖窗口：连续保存只跑最后一次。 */
const DEBOUNCE_MS = 60000;
/** 送模型的正文上限：取头尾各 3000 字，中间省略。 */
const MAX_SOURCE_CHARS = 6000;
/** 注入上下文的摘要条数：最近 4 章（需求区间是 3–5）。 */
const RECENT_LIMIT = 4;
/** 单条摘要注入时的字段裁剪，避免历史摘要挤占正文预算。 */
const FIELD_LIMITS = { progress: 140, open_threads: 90, setting: 50, characters: 60 };

const SYSTEM_PROMPT = `你是长篇小说的章节摘要员。只根据这一章正文，写一份给后续章节写作参考的摘要。

只输出 JSON，不要任何解释：
{
  "progress": "本章推进了什么：谁做了什么、局面发生了什么变化（2–3 句）",
  "open_threads": "留下的未解或悬念，用分号分隔；没有就填空字符串",
  "setting": "时间与地点（一句话）",
  "characters": ["在场并起作用的人物名"]
}

规则：
1. 只写正文里确实发生的事，不推测后续，不评价文笔。
2. progress 要写出因果关系，不要写成「本章讲述了……」这种空话。
3. characters 只列有行动或台词的人，最多 8 个，用正文里的写法。
4. 全文控制在 220 字以内（人物名不计）。
5. 正文信息不足就少写，不要编。`;

/** 正在跑的后台任务：测试用它等待，也避免进程提前退出。 */
const pending = new Set();
/** 每章一个去抖计时器。 */
const timers = new Map();

const now = () => new Date().toISOString();

/** 剥掉 markdown 代码块围栏。 */
function stripFence(text) {
  const fence = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? fence[1].trim() : String(text || '').trim();
}

/** 从正文或 blocks 里取纯文本。blocks 是权威数据，content 只是快照。 */
function chapterBody(chapter) {
  if (!chapter) return '';
  let blocks = [];
  try {
    blocks = JSON.parse(chapter.blocks || '[]');
  } catch (e) {
    blocks = [];
  }
  if (Array.isArray(blocks) && blocks.length) {
    const text = blocks
      .filter((b) => b && b.content)
      .map((b) => String(b.content))
      .join('\n\n');
    if (text.trim()) return text;
  }
  return String(chapter.content || '');
}

/** 正文过长时取头尾，中间省略：开头交代场景、结尾留下钩子，两头最有用。 */
function clipBody(text) {
  const body = String(text || '').trim();
  if (body.length <= MAX_SOURCE_CHARS) return body;
  const half = Math.floor((MAX_SOURCE_CHARS - 12) / 2);
  return `${body.slice(0, half)}\n\n……（中间省略）……\n\n${body.slice(-half)}`;
}

/** 归一化一个字符串字段。 */
function clipText(value, limit) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 校验并清洗模型输出。
 *
 * 解析失败返回 null（保留上一版摘要），不做半拉子覆盖。
 *
 * @param {string} raw 模型原文
 * @returns {{progress: string, open_threads: string, setting: string, characters: string[]}|null}
 */
function parseSummary(raw) {
  const text = stripFence(raw);
  if (!text) return null;

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch (e2) {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const progress = clipText(data.progress || data.summary || '', 200);
  if (!progress) return null;

  const rawCharacters = Array.isArray(data.characters)
    ? data.characters
    : String(data.characters || '').split(/[、,，;；]/);

  return {
    progress,
    open_threads: clipText(data.open_threads || data.openThreads || '', 160),
    setting: clipText(data.setting || data.time_place || data.timePlace || '', 80),
    characters: rawCharacters
      .map((name) => clipText(name, 20))
      .filter(Boolean)
      .slice(0, 8),
  };
}

/**
 * 这次保存要不要重新生成摘要。
 *
 * @param {Object} chapter 章节行（含 summary / summary_words / status）
 * @param {number} words 当前字数
 * @param {{force?: boolean}} [options]
 */
function needsRegeneration(chapter, words, options = {}) {
  if (!chapter) return false;

  const current = Number(words) || 0;
  // 手动触发跳过篇幅阈值，但空章仍然没有可总结的内容。
  if (options.force) return current > 0;
  if (current < MIN_SUMMARY_WORDS) return false;

  const hasSummary = Boolean(chapter.summary);
  if (!hasSummary) return true;

  const prev = Number(chapter.summary_words) || 0;
  const delta = Math.abs(current - prev);

  // 完结章：只要实质改过就重算一次，保证这一章留给后文的摘要是最终版。
  if (String(chapter.status) === 'done') return delta >= DONE_WORD_DELTA;

  // 草稿：篇幅多出 50%（至少 500 字）才重算。
  // 3000 字的章大约在 500 / 1000 / 1500 / 2250 字各算一次，
  // 加上完结时一次，全章约 5 次调用——远低于每次保存都调用。
  return delta >= Math.max(MIN_WORD_DELTA, Math.round(prev * GROWTH_RATIO));
}

/**
 * 生成并保存一章摘要。
 *
 * 失败/太短/未到阈值都返回 { skipped: true }，绝不抛错给保存链路。
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.chapterId
 * @param {boolean} [params.force] 作者手动触发：跳过阈值判断
 * @param {Object} [params.provider] 测试注入；不传时用当前配置的 provider
 * @returns {Promise<{summary?: Object, words?: number, usage?: Object, skipped?: boolean, reason?: string}>}
 */
async function summarizeChapter({ userId, workId, chapterId, force = false, provider, log = () => {} }) {
  if (!workId || !chapterId) return { skipped: true, reason: 'missing' };

  // 带作品归属校验：后台任务拿到的 id 来自保存请求，这里再确认一次不越权。
  const chapter = await get(
    `SELECT c.* FROM chapters c
     JOIN works w ON w.id = c.work_id
     WHERE c.id = ? AND c.work_id = ? AND w.user_id = ?`,
    [chapterId, workId, userId]
  );
  if (!chapter) return { skipped: true, reason: 'chapter' };

  const body = chapterBody(chapter);
  const words = Number(chapter.word_count) || countWords(body);
  if (!needsRegeneration(chapter, words, { force })) {
    return { skipped: true, reason: 'threshold' };
  }

  let active = provider;
  if (!active) {
    try {
      active = resolveProvider(aiConfig.getConfig()).provider;
    } catch (e) {
      return { skipped: true, reason: 'provider' };
    }
  }

  const prompts = [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `章节：第 ${chapter.seq} 章《${chapter.title}》${chapter.volume ? `（${chapter.volume}）` : ''}`,
        chapter.outline ? `本章大纲：\n${clipText(chapter.outline, 600)}` : '',
        `正文：\n${clipBody(body)}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  ];

  let result = null;
  try {
    result = await active.chat({
      messages: prompts,
      temperature: 0.2,
      thinking: 'disabled',
      jsonOutput: true,
      maxTokens: 600,
    });
  } catch (e) {
    return { skipped: true, reason: 'request' };
  }

  const parsed = parseSummary(result && result.content);
  if (!parsed) return { skipped: true, reason: 'parse' };

  const ts = now();
  await run(
    `UPDATE chapters
     SET summary = ?, summary_words = ?, summary_updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(parsed), words, ts, chapterId]
  );

  log({ chapterId, words, usage: result.usage || null });
  return { summary: parsed, words, usage: result.usage || null, generatedAt: ts };
}

/**
 * 保存后安排一次摘要生成。
 *
 * 按章去抖：作者连续保存时只保留最后一个计时器，停笔 DEBOUNCE_MS 后跑一次。
 * 计时器 unref，不会拖住进程退出。
 */
function scheduleChapterSummary({ userId, workId, chapterId, force = false }) {
  if (!userId || !workId || !chapterId) return;
  if (String(process.env.CHAPTER_SUMMARY_AUTO || '').toLowerCase() === 'off') return;

  const existing = timers.get(chapterId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(chapterId);
    const task = summarizeChapter({ userId, workId, chapterId, force })
      .catch(() => ({ skipped: true, reason: 'error' }));
    pending.add(task);
    task.finally(() => pending.delete(task));
  }, DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(chapterId, timer);
}

/**
 * 最近几章的摘要（按时间正序返回，供上下文注入）。
 *
 * @param {{workId: string, beforeSeq: number, limit?: number}} params
 * @returns {Promise<Array<{seq: number, title: string, summary: Object}>>}
 */
async function recentSummaries({ workId, beforeSeq, limit = RECENT_LIMIT }) {
  if (!workId || !beforeSeq) return [];
  const take = Math.min(Math.max(Number(limit) || RECENT_LIMIT, 1), 5);

  const rows = await all(
    `SELECT seq, title, summary FROM chapters
     WHERE work_id = ? AND seq < ? AND summary IS NOT NULL AND summary != ''
     ORDER BY seq DESC
     LIMIT ?`,
    [workId, beforeSeq, take]
  );

  return rows
    .map((row) => {
      let parsed = null;
      try {
        parsed = JSON.parse(row.summary || '{}');
      } catch (e) {
        parsed = null;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.progress) return null;
      return { seq: row.seq, title: row.title, summary: parsed };
    })
    .filter(Boolean)
    .reverse();
}

/** 把一条摘要压成一行，字段超长按 FIELD_LIMITS 裁剪。 */
function formatSummaryLine(row) {
  const s = row.summary || {};
  const parts = [`推进：${clipText(s.progress, FIELD_LIMITS.progress)}`];
  if (s.open_threads) parts.push(`未解：${clipText(s.open_threads, FIELD_LIMITS.open_threads)}`);
  if (s.setting) parts.push(`时间地点：${clipText(s.setting, FIELD_LIMITS.setting)}`);
  if (Array.isArray(s.characters) && s.characters.length) {
    parts.push(`人物：${clipText(s.characters.join('、'), FIELD_LIMITS.characters)}`);
  }
  return `第 ${row.seq} 章《${row.title}》｜${parts.join('；')}`;
}

/** 等所有后台摘要任务结束（测试与脚本用）。 */
async function allPending() {
  while (pending.size) {
    await Promise.all(Array.from(pending));
  }
}

/** 清掉未触发的去抖计时器（测试收尾用，避免挂住进程）。 */
function clearTimers() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

module.exports = {
  MIN_SUMMARY_WORDS,
  RECENT_LIMIT,
  chapterBody,
  parseSummary,
  needsRegeneration,
  summarizeChapter,
  scheduleChapterSummary,
  recentSummaries,
  formatSummaryLine,
  allPending,
  clearTimers,
};
