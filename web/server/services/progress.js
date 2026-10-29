'use strict';

/**
 * 写作进度。
 *
 * 两个维度：
 *   1. 结构进度 —— 多少章写完了、多少字、离目标还差多少
 *   2. 时间进度 —— 每天写了多少字（近 N 天曲线）
 *
 * 每日字数来自 writing_events 表：每次保存章节时记录一次增量。
 * 不从版本历史反推——版本历史记的是"保存时刻的快照"，
 * 一次回滚会产生负增量，作者看到"今天写了 -800 字"会以为程序出错了。
 */

const crypto = require('crypto');
const { all, get, run } = require('../database');
const { countWords } = require('./wordCount');

/**
 * 本地日期（YYYY-MM-DD）。
 *
 * 用本地时区而不是 UTC：作者晚上写完一章，UTC 日期可能还是"昨天"，
 * 进度曲线会莫名其妙少一格。
 */
function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  );
}

/**
 * 记录一次写作。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} [params.chapterId]
 * @param {number} params.addedWords 增量字数，可为负（删字）
 * @returns {Promise<void>}
 */
async function recordWrite({ workId, chapterId, addedWords }) {
  const delta = Number(addedWords) || 0;
  // 增量为 0 不记：作者点开又点保存不构成"写作"
  if (!delta) return;

  await run(
    `INSERT INTO writing_events (id, work_id, chapter_id, day, words_added, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      workId,
      chapterId || null,
      localDay(),
      delta,
      new Date().toISOString(),
    ]
  );
}

/**
 * 统计一部作品的写作进度。
 *
 * @param {string} workId
 * @param {Object} [options]
 * @param {number} [options.days] 曲线覆盖最近多少天，默认 30
 * @returns {Promise<Object>}
 */
async function getWorkProgress(workId, options = {}) {
  const days = Math.min(Math.max(Number(options.days) || 30, 7), 365);

  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return null;

  const chapters = await all(
    `SELECT id, title, seq, volume, status, content, word_count, outline, modified_at
     FROM chapters WHERE work_id = ? ORDER BY seq, created_at`,
    [workId]
  );

  // 老数据 word_count 是 0，按正文重算一次，保证统计数字与实际篇幅一致
  const chapterStats = chapters.map((c) => {
    const words = c.word_count || (c.content ? countWords(c.content) : 0);
    return {
      id: c.id,
      title: c.title,
      seq: c.seq,
      volume: c.volume,
      status: c.status,
      words,
      hasOutline: Boolean(c.outline && c.outline.trim()),
      modifiedAt: c.modified_at,
    };
  });

  const totalWords = chapterStats.reduce((sum, c) => sum + c.words, 0);
  const targetWords = Number(work.target_words) || 0;

  const byStatus = { draft: 0, revising: 0, done: 0, other: 0 };
  for (const c of chapterStats) {
    if (byStatus[c.status] === undefined) byStatus.other += 1;
    else byStatus[c.status] += 1;
  }

  const doneCount = byStatus.done;

  // 每日写作量曲线。
  // 起始日用 JS 算而不是 SQL 的 date('now')：后者是 UTC，
  // 与 localDay 的本地时区差 8 小时，边界上会多带/少带一天。
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startDay = localDay(startDate);

  const daily = await all(
    `SELECT day, SUM(words_added) AS words
     FROM writing_events
     WHERE work_id = ? AND day >= ?
     GROUP BY day
     ORDER BY day`,
    [workId, startDay]
  );

  const dailyMap = new Map(daily.map((d) => [d.day, d.words || 0]));

  // 补齐没有写作的日子，否则折线图会跳过空白日期，看起来像连着写
  const timeline = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = localDay(d);
    timeline.push({ day: key, words: dailyMap.get(key) || 0 });
  }

  const activeDays = timeline.filter((d) => d.words > 0).length;
  const recentWords = timeline.reduce((sum, d) => sum + d.words, 0);

  return {
    workId,
    targetWords,
    totalWords,
    remainingWords: targetWords > 0 ? Math.max(0, targetWords - totalWords) : 0,
    percent: targetWords > 0
      ? Math.min(100, Math.round((totalWords / targetWords) * 100))
      : 0,
    chapterCount: chapterStats.length,
    doneCount,
    byStatus,
    chapters: chapterStats,
    timeline,
    recentWords,
    activeDays,
    avgWordsPerActiveDay: activeDays > 0 ? Math.round(recentWords / activeDays) : 0,
  };
}

/**
 * 汇总某个用户所有作品的进度（作品列表页用）。
 *
 * 没有 userId 就返回空数组：这是失败安全策略，
 * 宁可让列表空白，也不能把别人的作品统计混进来。
 *
 * @param {string} userId
 * @returns {Promise<Array>}
 */
async function listAllProgress(userId) {
  if (!userId) return [];

  const works = await all(
    'SELECT * FROM works WHERE user_id = ? ORDER BY modified_at DESC',
    [userId]
  );
  const result = [];

  for (const work of works) {
    const chapters = await all(
      'SELECT status, content, word_count FROM chapters WHERE work_id = ?',
      [work.id]
    );

    let totalWords = 0;
    let doneCount = 0;
    for (const c of chapters) {
      totalWords += c.word_count || (c.content ? countWords(c.content) : 0);
      if (c.status === 'done') doneCount += 1;
    }

    const targetWords = Number(work.target_words) || 0;
    result.push({
      id: work.id,
      title: work.title,
      totalWords,
      targetWords,
      percent: targetWords > 0
        ? Math.min(100, Math.round((totalWords / targetWords) * 100))
        : 0,
      chapterCount: chapters.length,
      doneCount,
    });
  }

  return result;
}

module.exports = { recordWrite, getWorkProgress, listAllProgress, localDay };
