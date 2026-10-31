'use strict';

/**
 * 写作洞察。
 *
 * 三块内容：
 *   1. 聚合统计 —— 跨全部作品的日/周/月/年写作量（progress.js 只管单部作品）
 *   2. 写作指纹 —— 从正文里统计出的风格特征（句长、对白比、标点偏好、感官词）
 *   3. 荣誉徽章 —— 里程碑类成就
 *
 * 指纹必须是**可复算的统计量**，不是模型评价。
 * 理由：模型评价每次跑出来不一样，作者看到"你的文风是克制的"
 * 下次变成"你的文风偏细腻"，这东西就没人信了。
 * 统计量每次算出来都一样，能进指纹卡、能当文风基线。
 */

const { all, get } = require('../database');
const { countWords } = require('./wordCount');

/**
 * 本地日期（YYYY-MM-DD）。
 *
 * 与 progress.js 的口径一致：作者晚上写完一章，UTC 日期可能还是昨天。
 */
function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
  );
}

/**
 * 取某个日期往前推 n 天的日期对象。
 */
function shiftDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * ISO 周编号与年份（周一为一周之始）。
 *
 * 用本地日期算，不走 UTC：跨时区会把周数算错一天。
 */
function isoWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // 把日期挪到本周四：ISO 周以包含周四的那一周为准
  const dayNum = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dayNum + 3);
  const isoYear = d.getFullYear();
  const firstThursday = new Date(isoYear, 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
  return { year: isoYear, week };
}

/**
 * 聚合用户的写作量。
 *
 * @param {string} userId
 * @param {Object} [options]
 * @param {'day'|'week'|'month'|'year'} [options.period] 统计粒度，默认 week
 * @param {number} [options.buckets] 保留多少个时间桶，默认 12
 * @returns {Promise<Object>}
 */
async function getAggregateStats(userId, options = {}) {
  if (!userId) return emptyStats(options.period);

  const period = ['day', 'week', 'month', 'year'].includes(options.period)
    ? options.period
    : 'week';
  const buckets = Math.min(Math.max(Number(options.buckets) || 12, 2), 60);

  const events = await all(
    `SELECT e.day AS day, SUM(e.words_added) AS words, COUNT(*) AS edits
     FROM writing_events e
     JOIN works w ON w.id = e.work_id
     WHERE w.user_id = ?
     GROUP BY e.day
     ORDER BY e.day`,
    [userId]
  );

  const works = await all(
    `SELECT id, title, target_words FROM works WHERE user_id = ? ORDER BY modified_at DESC`,
    [userId]
  );
  const chapters = await all(
    `SELECT c.id, c.work_id, c.word_count, c.content, c.status
     FROM chapters c JOIN works w ON w.id = c.work_id
     WHERE w.user_id = ?`,
    [userId]
  );

  // 总字数取章节实况，不取 writing_events 的累计增量：
  // 增量会因为回滚出现负数，累计起来跟"现在有多少字"对不上。
  let totalWords = 0;
  let doneChapters = 0;
  for (const c of chapters) {
    totalWords += c.word_count || (c.content ? countWords(c.content) : 0);
    if (c.status === 'done') doneChapters += 1;
  }

  const targetWords = works.reduce((sum, w) => sum + (Number(w.target_words) || 0), 0);

  const dayMap = new Map(events.map((e) => [e.day, e]));
  const activeDays = events.filter((e) => (e.words || 0) > 0).length;
  const totalAdded = events.reduce((sum, e) => sum + (e.words || 0), 0);
  const totalEdits = events.reduce((sum, e) => sum + (e.edits || 0), 0);

  // 连续写作天数：往回数，连续有产出的天数。
  // 只认"当天有净增字"的日子——打开又关掉不算写了字。
  let streak = 0;
  const cursor = new Date();
  for (;;) {
    const key = localDay(cursor);
    const row = dayMap.get(key);
    if (row && (row.words || 0) > 0) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      // 今天还没写不算断：从昨天继续往前数。
      if (streak === 0 && key === localDay()) {
        cursor.setDate(cursor.getDate() - 1);
        continue;
      }
      break;
    }
  }

  const longestStreak = computeLongestStreak(events);

  return {
    period,
    totalWords,
    targetWords,
    percent:
      targetWords > 0
        ? Math.min(100, Math.round((totalWords / targetWords) * 100))
        : 0,
    workCount: works.length,
    chapterCount: chapters.length,
    doneChapters,
    activeDays,
    totalAdded,
    totalEdits,
    streak,
    longestStreak,
    avgWordsPerActiveDay: activeDays > 0 ? Math.round(totalAdded / activeDays) : 0,
    avgWordsPerEdit: totalEdits > 0 ? Math.round(totalAdded / totalEdits) : 0,
    timeline: buildTimeline(period, buckets, dayMap),
    works: works.map((w) => {
      const chs = chapters.filter((c) => c.work_id === w.id);
      const words = chs.reduce(
        (sum, c) => sum + (c.word_count || (c.content ? countWords(c.content) : 0)),
        0
      );
      return {
        id: w.id,
        title: w.title,
        words,
        chapterCount: chs.length,
        targetWords: Number(w.target_words) || 0,
      };
    }),
  };
}

/**
 * 空统计（没有用户时返回的兜底结构）。
 */
function emptyStats(period = 'week') {
  return {
    period,
    totalWords: 0,
    targetWords: 0,
    percent: 0,
    workCount: 0,
    chapterCount: 0,
    doneChapters: 0,
    activeDays: 0,
    totalAdded: 0,
    totalEdits: 0,
    streak: 0,
    longestStreak: 0,
    avgWordsPerActiveDay: 0,
    avgWordsPerEdit: 0,
    timeline: [],
    works: [],
  };
}

/**
 * 最长连续写作天数。
 */
function computeLongestStreak(events) {
  const days = events
    .filter((e) => (e.words || 0) > 0)
    .map((e) => e.day)
    .sort();
  if (!days.length) return 0;

  let best = 1;
  let current = 1;
  for (let i = 1; i < days.length; i += 1) {
    const prev = new Date(`${days[i - 1]}T00:00:00`);
    const next = new Date(`${days[i]}T00:00:00`);
    const gap = Math.round((next - prev) / (24 * 3600 * 1000));
    if (gap === 1) {
      current += 1;
    } else {
      current = 1;
    }
    if (current > best) best = current;
  }
  return best;
}

/**
 * 按粒度切时间桶。
 *
 * 每个桶补零：不补的话折线图会跳过空白日期，看起来像连着写。
 */
function buildTimeline(period, buckets, dayMap) {
  const out = [];
  const today = new Date();

  if (period === 'day') {
    for (let i = buckets - 1; i >= 0; i -= 1) {
      const d = shiftDays(today, -i);
      const key = localDay(d);
      const row = dayMap.get(key);
      out.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        words: row ? row.words || 0 : 0,
        edits: row ? row.edits || 0 : 0,
      });
    }
    return out;
  }

  if (period === 'week') {
    // 桶必须对齐自然周（周一起），不能用"今天往前推 7 天"的滚动窗口：
    // 滚动窗口的起点每天在变，同一份数据今天看和明天看分到不同的桶里，
    // 柱子会来回跳，作者会以为数字在变。
    const monday = shiftDays(today, -((today.getDay() + 6) % 7));
    for (let i = buckets - 1; i >= 0; i -= 1) {
      const weekStart = shiftDays(monday, -i * 7);
      const { year, week } = isoWeek(weekStart);
      const key = `${year}-W${String(week).padStart(2, '0')}`;
      let words = 0;
      let edits = 0;
      for (let k = 0; k < 7; k += 1) {
        const row = dayMap.get(localDay(shiftDays(weekStart, k)));
        if (row) {
          words += row.words || 0;
          edits += row.edits || 0;
        }
      }
      out.push({ key, label: `第 ${week} 周`, words, edits });
    }
    return out;
  }

  if (period === 'month') {
    for (let i = buckets - 1; i >= 0; i -= 1) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      let words = 0;
      let edits = 0;
      for (const [day, row] of dayMap) {
        if (day.startsWith(key)) {
          words += row.words || 0;
          edits += row.edits || 0;
        }
      }
      out.push({
        key,
        label: `${d.getMonth() + 1} 月`,
        words,
        edits,
      });
    }
    return out;
  }

  // year
  for (let i = buckets - 1; i >= 0; i -= 1) {
    const y = today.getFullYear() - i;
    const key = String(y);
    let words = 0;
    let edits = 0;
    for (const [day, row] of dayMap) {
      if (day.startsWith(key)) {
        words += row.words || 0;
        edits += row.edits || 0;
      }
    }
    out.push({ key, label: `${y}`, words, edits });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 写作指纹
// ---------------------------------------------------------------------------

/** 停用词：这些词进不了指纹。 */
const STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '就', '都', '而', '及', '与', '着', '或',
  '一个', '没有', '我们', '他们', '自己', '这个', '那个', '什么', '这样',
  '因为', '所以', '但是', '如果', '可以', '不是', '还是', '已经', '一直',
  '于是', '然后', '不过', '只是', '已经', '现在', '知道', '看着', '起来',
]);

/** 感官词表：用来算"细节密度"。 */
const SENSORY = {
  视觉: ['看', '望', '瞧', '盯', '扫', '颜色', '光', '影', '亮', '暗', '色', '眼'],
  听觉: ['听', '声', '响', '静', '吵', '喊', '叫', '耳', '喧', '静得'],
  嗅觉: ['闻', '味道', '气味', '香', '臭', '腥'],
  味觉: ['尝', '甜', '苦', '咸', '酸', '辣', '涩'],
  触觉: ['摸', '触', '冷', '热', '烫', '凉', '粗糙', '柔软', '硬', '疼', '麻'],
};

/** 情绪词表：算"情绪浓度"。 */
const EMOTION = {
  正向: ['笑', '高兴', '喜欢', '温柔', '安心', '温暖', '希望', '轻松', '安心', '暖'],
  负向: ['难过', '怕', '愤怒', '孤独', '绝望', '疼', '痛', '恨', '冷', '沉默', '疲惫'],
};

/**
 * 算写作指纹。
 *
 * 维度（全部是可复算的统计量）：
 *   句长、段长、对白占比、标点偏好、感官词密度、情绪词密度、高频词
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getFingerprint(userId) {
  if (!userId) return emptyFingerprint();

  const chapters = await all(
    `SELECT c.content FROM chapters c
     JOIN works w ON w.id = c.work_id
     WHERE w.user_id = ? AND c.content IS NOT NULL AND c.content != ''`,
    [userId]
  );

  const texts = chapters.map((c) => c.content).filter(Boolean);
  if (!texts.length) return emptyFingerprint();

  const full = texts.join('\n');
  const totalWords = countWords(full);

  // 句子：按中文句末标点切。
  const sentences = full
    .split(/[。！？!?…]+/)
    .map((s) => s.trim())
    .filter((s) => countWords(s) > 0);

  // 段落：按换行切。
  const paragraphs = full
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => countWords(p) > 0);

  const sentenceLengths = sentences.map((s) => countWords(s));
  const paragraphLengths = paragraphs.map((p) => countWords(p));

  // 对白：引号内的部分。
  const dialogueChars = (full.match(/[“"][^”"]*[”"]/g) || []).join('').length;
  const dialogueRatio = full.length > 0 ? dialogueChars / full.length : 0;

  // 标点偏好：每千字出现次数。
  const perKilo = (n) =>
    totalWords > 0 ? Math.round((n / totalWords) * 1000 * 10) / 10 : 0;
  const punctuation = {
    逗号: perKilo((full.match(/[，,]/g) || []).length),
    句号: perKilo((full.match(/[。]/g) || []).length),
    问号: perKilo((full.match(/[？?]/g) || []).length),
    叹号: perKilo((full.match(/[！!]/g) || []).length),
    省略号: perKilo((full.match(/…{1,}|\.{3,}/g) || []).length),
    破折号: perKilo((full.match(/—{1,}|--/g) || []).length),
    分号: perKilo((full.match(/[；;]/g) || []).length),
  };

  // 感官词与情绪词密度。
  const sensory = {};
  for (const [name, words] of Object.entries(SENSORY)) {
    let count = 0;
    for (const w of words) {
      const hits = full.split(w).length - 1;
      count += hits;
    }
    sensory[name] = perKilo(count);
  }
  const emotion = {};
  for (const [name, words] of Object.entries(EMOTION)) {
    let count = 0;
    for (const w of words) {
      count += full.split(w).length - 1;
    }
    emotion[name] = perKilo(count);
  }

  // 高频词：中文没有空格分词，用二元组近似。
  // 精度有限，但同一份稿子每次算出来一样，能当基线用。
  const bigrams = new Map();
  const cjkOnly = full.replace(/[^一-鿿]/g, '');
  for (let i = 0; i < cjkOnly.length - 1; i += 1) {
    const gram = cjkOnly.slice(i, i + 2);
    if (STOPWORDS.has(gram)) continue;
    bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
  }
  // 出现次数门槛随样本量调整：样本少时要求 2 次就列出来，
  // 否则刚写两千字的人打开指纹页看到一片空白。
  const minCount = totalWords >= 5000 ? 3 : 2;
  const topWords = [...bigrams.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, count }));

  const avgSentence = average(sentenceLengths);
  const avgParagraph = average(paragraphLengths);
  const shortSentenceRatio =
    sentenceLengths.length > 0
      ? sentenceLengths.filter((n) => n <= 12).length / sentenceLengths.length
      : 0;
  const dialoguePercent = Math.round(dialogueRatio * 100);

  return {
    sampleWords: totalWords,
    sampleChapters: texts.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    avgSentenceLength: Math.round(avgSentence),
    avgParagraphLength: Math.round(avgParagraph),
    longestSentence: sentenceLengths.length ? Math.max(...sentenceLengths) : 0,
    longestParagraph: paragraphLengths.length ? Math.max(...paragraphLengths) : 0,
    shortSentenceRatio: Math.round(shortSentenceRatio * 100),
    dialogueRatio: dialoguePercent,
    punctuation,
    sensory,
    emotion,
    topWords,
    // 标签：给作者一句人话，说明这组数字意味着什么
    labels: buildLabels({
      avgSentence,
      avgParagraph,
      dialogueRatio: dialoguePercent,
      shortSentenceRatio: Math.round(shortSentenceRatio * 100),
      punctuation,
      sensory,
      emotion,
    }),
  };
}

/**
 * 空指纹。
 */
function emptyFingerprint() {
  return {
    sampleWords: 0,
    sampleChapters: 0,
    sentenceCount: 0,
    paragraphCount: 0,
    avgSentenceLength: 0,
    avgParagraphLength: 0,
    longestSentence: 0,
    longestParagraph: 0,
    shortSentenceRatio: 0,
    dialogueRatio: 0,
    punctuation: { 逗号: 0, 句号: 0, 问号: 0, 叹号: 0, 省略号: 0, 破折号: 0, 分号: 0 },
    sensory: { 视觉: 0, 听觉: 0, 嗅觉: 0, 味觉: 0, 触觉: 0 },
    emotion: { 正向: 0, 负向: 0 },
    topWords: [],
    labels: [],
  };
}

function average(list) {
  if (!list.length) return 0;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

/**
 * 把统计量翻译成作者看得懂的标签。
 *
 * 阈值是拍的，但结论必须能从数字推出来——
 * 否则作者会问"凭什么说我克制"，标签就废了。
 */
function buildLabels(m) {
  const labels = [];

  if (m.avgSentence > 0) {
    if (m.avgSentence <= 12) {
      labels.push({ key: 'sentence', text: `句子偏短（均长 ${Math.round(m.avgSentence)} 字），节奏快` });
    } else if (m.avgSentence <= 25) {
      labels.push({ key: 'sentence', text: `句长适中（均长 ${Math.round(m.avgSentence)} 字）` });
    } else {
      labels.push({ key: 'sentence', text: `句子偏长（均长 ${Math.round(m.avgSentence)} 字），读起来更连贯` });
    }
  }

  if (m.shortSentenceRatio >= 40) {
    labels.push({ key: 'rhythm', text: `${m.shortSentenceRatio}% 的句子在 12 字以内，短句多` });
  }

  if (m.dialogueRatio >= 15) {
    labels.push({ key: 'dialogue', text: `对白占 ${m.dialogueRatio}%，靠说话推进` });
  } else if (m.dialogueRatio > 0 && m.dialogueRatio < 4) {
    labels.push({ key: 'dialogue', text: `对白只占 ${m.dialogueRatio}%，偏叙述` });
  }

  if (m.avgParagraph > 0) {
    if (m.avgParagraph <= 45) {
      labels.push({ key: 'paragraph', text: `段落短（均长 ${Math.round(m.avgParagraph)} 字），留白多` });
    } else if (m.avgParagraph >= 120) {
      labels.push({ key: 'paragraph', text: `段落长（均长 ${Math.round(m.avgParagraph)} 字），一口气铺陈` });
    }
  }

  // 感官细节：五感密度加起来。
  const sensoryTotal = Object.values(m.sensory).reduce((a, b) => a + b, 0);
  if (sensoryTotal >= 30) {
    const top = Object.entries(m.sensory).sort((a, b) => b[1] - a[1])[0];
    labels.push({ key: 'sensory', text: `感官细节密（每千字 ${Math.round(sensoryTotal)} 处，以${top[0]}为主）` });
  }

  const emoTotal = (m.emotion.正向 || 0) + (m.emotion.负向 || 0);
  if (emoTotal >= 20) {
    const pos = m.emotion.正向 || 0;
    const neg = m.emotion.负向 || 0;
    const lean = pos >= neg ? '偏暖' : '偏冷';
    labels.push({ key: 'emotion', text: `情绪浓度 ${Math.round(emoTotal)}／千字，整体${lean}` });
  }

  if (m.punctuation.叹号 === 0 && m.punctuation.问号 > 0) {
    labels.push({ key: 'tone', text: '几乎不用感叹号' });
  }

  return labels;
}

// ---------------------------------------------------------------------------
// 荣誉徽章
// ---------------------------------------------------------------------------

/**
 * 徽章定义。
 *
 * 门槛全是"作品数量"这种作者自己能核对的事实，
 * 不用模型评价——模型说"你写得很棒"不构成成就。
 */
const BADGE_DEFS = [
  { id: 'first_words', name: '落笔', desc: '累计写下 1000 字', metric: 'totalWords', threshold: 1000 },
  { id: 'ten_k', name: '万字', desc: '累计写下 1 万字', metric: 'totalWords', threshold: 10000 },
  { id: 'hundred_k', name: '十万字', desc: '累计写下 10 万字', metric: 'totalWords', threshold: 100000 },
  { id: 'million', name: '百万字', desc: '累计写下 100 万字', metric: 'totalWords', threshold: 1000000 },
  { id: 'streak_3', name: '三日连更', desc: '连续写作 3 天', metric: 'longestStreak', threshold: 3 },
  { id: 'streak_7', name: '一周连更', desc: '连续写作 7 天', metric: 'longestStreak', threshold: 7 },
  { id: 'streak_30', name: '满月之勤', desc: '连续写作 30 天', metric: 'longestStreak', threshold: 30 },
  { id: 'chapters_10', name: '十章', desc: '完成 10 章', metric: 'doneChapters', threshold: 10 },
  { id: 'chapters_50', name: '五十章', desc: '完成 50 章', metric: 'doneChapters', threshold: 50 },
  { id: 'works_3', name: '三部曲', desc: '同时推进 3 部作品', metric: 'workCount', threshold: 3 },
  { id: 'edits_100', name: '百次落笔', desc: '累计保存修改 100 次', metric: 'totalEdits', threshold: 100 },
  { id: 'edits_1000', name: '千次落笔', desc: '累计保存修改 1000 次', metric: 'totalEdits', threshold: 1000 },
];

/**
 * 计算徽章。
 *
 * @param {string} userId
 * @returns {Promise<Object>}
 */
async function getBadges(userId) {
  if (!userId) return { badges: [], unlockedCount: 0 };

  const stats = await getAggregateStats(userId, { period: 'day' });

  const badges = BADGE_DEFS.map((def) => {
    const current = stats[def.metric] || 0;
    const unlocked = current >= def.threshold;
    return {
      id: def.id,
      name: def.name,
      desc: def.desc,
      unlocked,
      current,
      threshold: def.threshold,
      percent: Math.min(100, Math.round((current / def.threshold) * 100)),
    };
  });

  return {
    badges,
    unlockedCount: badges.filter((b) => b.unlocked).length,
    totalCount: badges.length,
  };
}

module.exports = {
  getAggregateStats,
  getFingerprint,
  getBadges,
  localDay,
  isoWeek,
};
