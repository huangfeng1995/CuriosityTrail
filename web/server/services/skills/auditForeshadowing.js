'use strict';

/**
 * 伏笔盘点技能。
 *
 * 回答作者两类问题：
 *   1. 「第三章那个铜钥匙，最后收了吗」→ 点名的那张卡
 *   2. 「还有哪些伏笔没收」            → 全书盘点
 *
 * 两层：
 *   规则层（本地、免费、立刻出结果）——按关键词召回候选章节
 *   模型层（花钱，只喂候选片段）    ——对片段做三态判定
 *
 * 关键设计：**「没搜到」不等于「没回收」**。
 * 关键词一个都没命中的卡单独立档，绝不断言成「未回收」——
 * 那是会直接损害正文的错误结论（作者会跑去补写已经交代过的情节）。
 */

const { all } = require('../../database');
const { parseModelJson } = require('../agent/parse');

/** 判定状态的三个取值。这三个是结论，只可能来自模型的判定。 */
const STATUS = {
  RECOVERED: '已回收',
  UNRECOVERED: '未回收',
  NOT_FOUND: '未定位到原文',
};

/**
 * 模型层没给出有效判定时的状态。
 *
 * 刻意不并进 STATUS 三态里：
 *   「未定位到原文」是结论——正文里确实没有相关段落；
 *   「未能判定」是故障——模型这次没答上来。
 * 两者混为一谈，作者会以为全书真没有相关段落，
 * 跑去补写已经交代过的情节。所以这里单独标一个能识别的失败态。
 */
const JUDGE_FAILED = '未能判定';

/** 一批喂给模型的卡片上限 */
const BATCH_SIZE = 8;

/** 一次从库里读多少章。分批读，读完一批扫一批，不把全书正文一次塞进内存 */
const CHAPTER_BATCH = 20;

/**
 * 从卡片里抽关键词。
 *
 * 标题整串 + 备注里切出来的短语。
 *
 * 为什么不能只匹配标题：卡片标题是作者写的短标签（「铜钥匙」），
 * 而正文常用变体指代（「那把钥匙」「铁盒里的东西」）。
 * 只做标题子串匹配，这类伏笔会被判成"没找到"，
 * 而作者据此去补写已经交代过的情节，直接损害正文质量。
 *
 * @param {Object} card
 * @returns {Array<string>}
 */
function extractKeywords(card) {
  const keywords = new Set();

  const title = String(card.title || '').trim();
  if (title.length >= 2) keywords.add(title);

  // 备注按常见分隔符切短语
  const content = String(card.content || '');
  const parts = content
    .split(/[\s，。、；：？！,.;:?!（）()【】\[\]「」『』"'"''|—…\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 20);

  for (const p of parts) keywords.add(p);

  return Array.from(keywords);
}

/**
 * 把关键词按卡片归组。
 *
 * 同一个关键词可能同时属于好几张卡（「铜钥匙」既是标题也是备注里的词）。
 * 建一张 keyword -> 卡片 id 的索引，扫描正文时每个关键词只查一次，
 * 命中后再分发给所有用它的卡。
 *
 * @param {Array} cards
 * @returns {{index: Map<string, Array<string>>, cardKeywords: Map<string, Array<string>>}}
 */
function buildKeywordIndex(cards) {
  const index = new Map();
  const cardKeywords = new Map();

  for (const card of cards) {
    const keywords = extractKeywords(card);
    cardKeywords.set(card.id, keywords);
    for (const kw of keywords) {
      if (!index.has(kw)) index.set(kw, []);
      const owners = index.get(kw);
      if (!owners.includes(card.id)) owners.push(card.id);
    }
  }

  return { index, cardKeywords };
}

/**
 * 章节正文。blocks 里存的是结构化块，content 是纯文本快照——
 * 两者都在，取 blocks 拼出来的纯文本（更准），没有就用 content。
 *
 * 结果会缓存在章节对象上：取片段时会反复用到同一章的正文，
 * 每次都重新 JSON.parse 一遍 blocks 纯属浪费。
 *
 * @param {Object} ch
 * @returns {string}
 */
function chapterText(ch) {
  if (typeof ch.plain === 'string') return ch.plain;

  let text = '';
  if (ch.blocks) {
    try {
      const blocks = JSON.parse(ch.blocks);
      if (Array.isArray(blocks) && blocks.length) {
        const joined = blocks
          .map((b) => (b && b.content ? b.content : ''))
          .filter(Boolean)
          .join('\n');
        if (joined) text = joined;
      }
    } catch (e) {
      // blocks 不是合法 JSON 就退回 content
    }
  }
  if (!text) text = ch.content || '';

  ch.plain = text;
  return text;
}

/**
 * 规则层：扫描一章，记下这一章命中了哪些卡。
 *
 * 每章只扫一遍关键词表，命中后分发给用这个词的卡——
 * 原来的写法是"每张卡 × 每一章 × 每个关键词"三层循环，
 * 同一章正文被反复扫很多遍。
 *
 * @param {Map} acc 累积器，见 createAccumulator
 * @param {Map} index keyword -> 卡片 id 列表
 * @param {Map} cardKeywords 卡片 id -> 关键词列表
 * @param {Object} chapter 已带纯文本的章节
 * @returns {Array<string>} 这一章命中的卡片 id
 */
function scanChapter(acc, index, cardKeywords, chapter) {
  const text = chapter.content || '';
  if (!text) return [];

  const hitCardIds = [];
  // 卡片 id -> 这一章里命中的它的哪些关键词
  const perCard = new Map();

  for (const [kw, cardIds] of index) {
    if (!text.includes(kw)) continue;
    for (const cardId of cardIds) {
      if (!perCard.has(cardId)) {
        perCard.set(cardId, new Set());
        hitCardIds.push(cardId);
      }
      perCard.get(cardId).add(kw);
    }
  }

  for (const [cardId, kwSet] of perCard) {
    const rec = acc.get(cardId);
    if (!rec) continue;
    // 关键词顺序保持卡片自己的顺序（标题在前，备注短语在后）
    const keywords = cardKeywords.get(cardId) || [];
    rec.hits.push({
      chapter,
      hitWords: keywords.filter((k) => kwSet.has(k)),
    });
  }

  return hitCardIds;
}

/**
 * 建一个空的召回累积器。
 *
 * @param {Array} cards
 * @param {Map} cardKeywords
 * @returns {Map<string, {card: Object, hits: Array, keywords: Array}>}
 */
function createAccumulator(cards, cardKeywords) {
  const acc = new Map();
  for (const card of cards) {
    acc.set(card.id, { card, hits: [], keywords: cardKeywords.get(card.id) || [] });
  }
  return acc;
}

/**
 * 排序召回结果：命中关键词多的章在前，同数量按章节顺序。
 *
 * @param {Map} acc
 * @returns {Map}
 */
function finalizeRecall(acc) {
  for (const rec of acc.values()) {
    rec.hits.sort(
      (a, b) => b.hitWords.length - a.hitWords.length || (a.chapter.seq || 0) - (b.chapter.seq || 0)
    );
  }
  return acc;
}

/**
 * 规则层：按关键词召回候选章节。
 *
 * chapters 表没有 FTS 索引（只有 materials 表有），
 * 所以走内存匹配：一部长篇几十章、几十万字，分批读入做 includes 完全够用。
 *
 * @param {Array} cards 伏笔卡片
 * @param {Array} chapters 全书章节 [{ id, title, seq, content }]
 * @returns {Map<string, {card: Object, hits: Array}>} 按卡片 id 索引
 */
function recallChapters(cards, chapters) {
  const { index, cardKeywords } = buildKeywordIndex(cards);
  const acc = createAccumulator(cards, cardKeywords);

  for (const ch of chapters) {
    scanChapter(acc, index, cardKeywords, ch);
  }

  return finalizeRecall(acc);
}

/**
 * 找一张卡「埋在哪一章」。
 *
 * 伏笔的价值在于"埋下的地方"与"回收的地方"这一对，
 * 只看有没有出现是不够的。所以要同时记录首次出场章与后续再次出场章。
 *
 * 注意：hits 是按命中关键词数排的，不是按章节顺序。
 * 「时间上最早的一章」必须自己按 seq 找，不能拿 hits 的末位充数。
 *
 * @param {Object} card
 * @param {Array} hits 召回结果（按命中数降序）
 * @returns {{first: Object|null, later: Array}}
 */
function splitByFirstAppearance(card, hits) {
  if (!hits.length) return { first: null, later: [] };

  // 卡片本身挂在某一章上时，那一章就是作者自己认定的"埋下点"
  const pinned = card.chapter_id
    ? hits.find((h) => h.chapter.id === card.chapter_id)
    : null;

  // 没有 pinned 就按章节序号取最早的一章。
  // hits 的排序主键是命中关键词数，末位是命中最少的章，跟"最早"没关系。
  const earliest = hits.reduce((min, h) =>
    (h.chapter.seq || 0) < (min.chapter.seq || 0) ? h : min
  );

  const first = pinned || earliest;
  // 「后续再次出场」按章节顺序排：模型要按时间线读，
  // 才知道回收发生在哪一章。
  const later = hits
    .filter((h) => h.chapter.id !== first.chapter.id)
    .sort((a, b) => (a.chapter.seq || 0) - (b.chapter.seq || 0));

  return { first, later };
}

/**
 * 取关键词命中位置前后的一段文字。
 */
function snippetAround(chapter, keyword) {
  const text = chapterText(chapter);
  const idx = text.indexOf(keyword);
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + keyword.length + 90);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/**
 * 模型层：判定一批卡片的三态。
 *
 * 每次只喂候选片段，不喂全书。每批最多 8 张卡。
 *
 * @param {Object} params
 * @returns {Promise<Array>} findings
 */
async function judgeWithModel({ provider, items, workTitle }) {
  const prompt = [
    '你是小说校对。下面每条是一个伏笔线索和它可能出现的章节片段。',
    '请判断每条伏笔的状态，三选一：',
    `  ${STATUS.RECOVERED}：片段里能看出作者对这条伏笔做了回收或呼应`,
    `  ${STATUS.UNRECOVERED}：片段里有这条线索，但看不出任何回收动作`,
    `  ${STATUS.NOT_FOUND}：片段与这条线索无关，读不出任何关联`,
    '每条必须给出 status 和 evidence（片段里的原句或摘要）。',
    '',
    '片段分两类：「首次出场」是这条伏笔最早出现的章（埋下的地方），',
    '「再次出场」是它后来又出现的章。回收通常发生在「再次出场」里——',
    '只有埋下、没有再现的，就是没回收。',
    '',
    '只输出一个 JSON 对象：{"results":[{"id":"卡片id","status":"...","evidence":"..."}]}',
  ].join('\n');

  const itemsText = items
    .map((it) => {
      // 按出场顺序排：先看埋下点，再看后面有没有再现。
      // 原来按命中关键词数排，埋下点经常被挤到后面去，模型看不到"埋在哪"。
      const { first, later } = splitByFirstAppearance(it.card, it.hits);
      const ordered = first ? [first, ...later] : later;

      const snippets = ordered
        .slice(0, 4)
        .map((h) => {
          const tag = first && h.chapter.id === first.chapter.id ? '首次出场' : '再次出场';
          return `  【第 ${h.chapter.seq} 章 ${h.chapter.title}｜${tag}】${snippetAround(h.chapter, h.hitWords[0])}`;
        })
        .join('\n');
      return `卡片 id=${it.card.id}\n标题：${it.card.title}\n备注：${it.card.content || '（无）'}\n候选片段：\n${snippets || '（没有召回到任何片段）'}`;
    })
    .join('\n\n');

  const result = await provider.chat({
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `作品：${workTitle || '（未命名）'}\n\n${itemsText}` },
    ],
    temperature: 0.2,
    // 这次内部调用必须显式限定参数，不能跟随角色或全局设置：
    // 任务只是对少量片段做三态归类，不需要长链推理。
    // 开启思考会让每一批判定多付一份思考 token 并多等数秒，
    // 叠加在多步循环上作者会明显感到卡顿。
    // 这个做法在项目里已有先例：memory/extractor.js 的 extractFacts。
    thinking: 'disabled',
    jsonOutput: true,
    maxTokens: 1200,
  });

  const parsed = parseModelJson(result && result.content);
  const rows = parsed && Array.isArray(parsed.results) ? parsed.results : [];

  const byId = new Map(rows.map((r) => [String(r.id), r]));

  // 模型没答上来，和模型判定"与这条伏笔无关"，是两件完全不同的事。
  // 前者是故障，后者是结论。混为一谈会让作者拿着错误结论去补写已经交代过的情节。
  //
  // 拿不到有效判定的几种情况：
  //   - 整批没解析出来（输出不是 JSON，或 results 不是数组）
  //   - 输出被长度上限截断（finishReason=length），JSON 残缺
  //   - 少了某张卡的条目
  //   - status 不在三态白名单里
  const finishReason = (result && result.finishReason) || '';
  const truncated = finishReason === 'length';
  const wholeBatchBroken = rows.length === 0;

  return items.map((it) => {
    const row = byId.get(it.card.id);
    const status = row && Object.values(STATUS).includes(row.status) ? row.status : null;

    if (!status) {
      let reason;
      if (wholeBatchBroken) {
        reason = truncated
          ? '模型这次输出被长度上限截断，没能完成判定'
          : '模型这次没有给出可解析的判定结果';
      } else if (!row) {
        reason = '模型这次漏掉了这一张卡，没有给出判定';
      } else {
        reason = `模型给出的状态「${row.status}」不是三态之一，没能采信`;
      }
      return {
        id: it.card.id,
        card: it.card.title,
        status: JUDGE_FAILED,
        evidence: reason,
        chapter: it.hits.length ? `第 ${it.hits[0].chapter.seq} 章` : '',
        degraded: false,
      };
    }

    return {
      id: it.card.id,
      card: it.card.title,
      status,
      evidence: (row && row.evidence) || '',
      chapter: it.hits.length ? `第 ${it.hits[0].chapter.seq} 章` : '',
    };
  });
}

/**
 * 技能主体。
 *
 * @param {Object} params
 * @param {string} [params.target] 作者点名的伏笔名/关键词。留空则盘点全书。
 * @param {Object} ctx
 * @returns {Promise<Object>} { label, summary, detail, findings, degraded }
 */
async function run(params, ctx) {
  const { userId, workId, provider } = ctx;
  const target = String((params && params.target) || '').trim();

  if (!workId) {
    return { label: '伏笔盘点', summary: '没有找到要查的作品', detail: [], findings: [] };
  }

  // 只读当前用户自己的作品
  const cards = (
    await all(
      `SELECT c.*, ch.title AS chapter_title, ch.seq AS chapter_seq
       FROM plot_cards c
       JOIN works w ON w.id = c.work_id
       LEFT JOIN chapters ch ON ch.id = c.chapter_id
       WHERE c.work_id = ? AND w.user_id = ? AND c.kind = 'foreshadow'
       ORDER BY c.seq, c.created_at`,
      [workId, userId]
    )
  ).map((c) => ({
    ...c,
    chapter_title: c.chapter_title,
    chapter_seq: c.chapter_seq,
  }));

  if (!cards.length) {
    return {
      label: '伏笔盘点',
      summary: '这部作品还没有伏笔卡',
      detail: [],
      findings: [],
    };
  }

  // 点名时只处理那一张卡；留空才全书盘点
  const selected = target
    ? cards.filter((c) => String(c.title || '').includes(target) || String(c.content || '').includes(target))
    : cards;

  if (!selected.length) {
    return {
      label: '伏笔盘点',
      summary: `没找到叫「${target}」的伏笔卡`,
      detail: [],
      findings: [],
    };
  }

  // 分批读章节。每批读完立刻扫描，扫描完就把这一批丢掉——
  // 一部长篇几十万字，一次性全读进内存既慢又占地方。
  //
  // 但正文要留到取片段时才用，所以命中的章节要留下，
  // 没命中的当场扔掉。
  const { index, cardKeywords } = buildKeywordIndex(selected);
  const acc = createAccumulator(selected, cardKeywords);
  const hitChapters = new Map();

  let offset = 0;
  for (;;) {
    const batch = await all(
      `SELECT id, title, seq, content, blocks FROM chapters
       WHERE work_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
      [workId, CHAPTER_BATCH, offset]
    );
    if (!batch.length) break;
    offset += batch.length;

    for (const row of batch) {
      // 直接复用这一行作为章节对象：chapterText 会把纯文本缓存在它身上（ch.plain），
      // 后面 snippetAround 取片段时就不会再 JSON.parse 一遍 blocks。
      const ch = row;
      ch.content = chapterText(ch);
      const hitCardIds = scanChapter(acc, index, cardKeywords, ch);
      if (hitCardIds.length) hitChapters.set(ch.id, ch);
    }

    if (batch.length < CHAPTER_BATCH) break;
  }

  const recalled = finalizeRecall(acc);

  // 规则层先分档：一个关键词都没命中的卡不调模型
  const items = [];
  const notFound = [];

  for (const card of selected) {
    const rec = recalled.get(card.id);
    if (!rec || !rec.hits.length) {
      notFound.push({
        id: card.id,
        card: card.title,
        status: STATUS.NOT_FOUND,
        evidence: '全书正文里没有找到与这条伏笔相关的段落',
        chapter: '',
      });
      continue;
    }
    items.push({ card, hits: rec.hits });
  }

  // 模型层：分批判定
  const findings = [...notFound];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const judged = await judgeWithModel({ provider, items: batch, workTitle: ctx.workTitle });
    findings.push(...judged);
  }

  // 汇总：读了多少章
  const chaptersRead = Array.from(hitChapters.values()).sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const chars = chaptersRead.reduce((sum, c) => sum + (c.content || '').length, 0);

  const detail = chaptersRead.map((c) => {
    const related = items.filter((it) => it.hits.some((h) => h.chapter.id === c.id));
    return {
      label: `第 ${c.seq} 章 ${c.title}`,
      text: related.length
        ? related
            .map((it) => `${it.card.title}：${it.hits.find((h) => h.chapter.id === c.id).hitWords.join('、')}`)
            .join('；')
        : '相关章节',
    };
  });

  // provider 降级时要标出来，不能静默降级——
  // 作者会把本地小模型的结论当成云端结论，一次判错就摧毁对整套巡检能力的信任。
  const degraded = Boolean(ctx.degraded);

  // 模型没判出来的卡也要说出来。作者看到"未能判定"会知道这条还没结论，
  // 看到"未定位到原文"却会以为全书真没有——两者不能混。
  const failedCount = findings.filter((f) => f.status === JUDGE_FAILED).length;

  let summary = `读了 ${chaptersRead.length} 章 · ${(chars / 1000).toFixed(1)}k 字`;
  if (failedCount) {
    summary += `（${failedCount} 条未能判定）`;
  }
  if (degraded) {
    summary += '（本地模型，可信度有限）';
  }

  return {
    label: '伏笔盘点',
    summary,
    detail,
    findings,
    degraded,
  };
}

module.exports = {
  name: 'audit_foreshadowing',
  label: '伏笔盘点',
  description:
    '盘点伏笔的回收情况。当作者问某个伏笔/线索是否回收、埋下的东西有没有用上、还有哪些没收时使用。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: '作者问到的具体伏笔名或关键词。留空则盘点全书。',
      },
    },
    required: [],
  },
  run,
  // 导出内部函数供单元测试
  _internal: {
    extractKeywords,
    recallChapters,
    splitByFirstAppearance,
    STATUS,
    JUDGE_FAILED,
  },
};
