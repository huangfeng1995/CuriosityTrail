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

/** 判定状态的三个取值 */
const STATUS = {
  RECOVERED: '已回收',
  UNRECOVERED: '未回收',
  NOT_FOUND: '未定位到原文',
};

/** 一批喂给模型的卡片上限 */
const BATCH_SIZE = 8;

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
  const result = new Map();

  for (const card of cards) {
    const keywords = extractKeywords(card);
    if (!keywords.length) {
      result.set(card.id, { card, hits: [], keywords: [] });
      continue;
    }

    // 每章记录：命中了哪些关键词
    const perChapter = new Map();
    for (const ch of chapters) {
      const text = ch.content || '';
      if (!text) continue;
      const hitWords = keywords.filter((k) => text.includes(k));
      if (hitWords.length) {
        perChapter.set(ch.id, { chapter: ch, hitWords });
      }
    }

    // 按命中关键词数量降序
    const hits = Array.from(perChapter.values()).sort(
      (a, b) => b.hitWords.length - a.hitWords.length || (a.chapter.seq || 0) - (b.chapter.seq || 0)
    );

    result.set(card.id, { card, hits, keywords });
  }

  return result;
}

/**
 * 章节正文。blocks 里存的是结构化块，content 是纯文本快照——
 * 两者都在，取 blocks 拼出来的纯文本（更准），没有就用 content。
 */
function chapterText(ch) {
  if (ch.blocks) {
    try {
      const blocks = JSON.parse(ch.blocks);
      if (Array.isArray(blocks) && blocks.length) {
        const joined = blocks
          .map((b) => (b && b.content ? b.content : ''))
          .filter(Boolean)
          .join('\n');
        if (joined) return joined;
      }
    } catch (e) {
      // blocks 不是合法 JSON 就退回 content
    }
  }
  return ch.content || '';
}

/**
 * 找一张卡「埋在哪一章」。
 *
 * 伏笔的价值在于"埋下的地方"与"回收的地方"这一对，
 * 只看有没有出现是不够的。所以要同时记录首次出场章与后续再次出场章。
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

  const first = pinned || hits[hits.length - 1]; // 无 pinned 时取最靠后的一章（时间上最早）
  const later = hits.filter((h) => h.chapter.id !== first.chapter.id);

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
    '只输出一个 JSON 对象：{"results":[{"id":"卡片id","status":"...","evidence":"..."}]}',
  ].join('\n');

  const itemsText = items
    .map((it) => {
      const snippets = it.hits
        .slice(0, 4)
        .map((h) => `  【第 ${h.chapter.seq} 章 ${h.chapter.title}】${snippetAround(h.chapter, h.hitWords[0])}`)
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
  return items.map((it) => {
    const row = byId.get(it.card.id);
    const status = row && Object.values(STATUS).includes(row.status) ? row.status : STATUS.NOT_FOUND;
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

  const chapters = (
    await all(
      'SELECT id, title, seq, content, blocks FROM chapters WHERE work_id = ? ORDER BY seq',
      [workId]
    )
  ).map((ch) => ({ ...ch, content: chapterText(ch) }));

  const recalled = recallChapters(selected, chapters);

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
  const touched = new Set();
  for (const it of items) {
    for (const h of it.hits) touched.add(h.chapter.id);
  }
  const chaptersRead = Array.from(touched)
    .map((id) => chapters.find((c) => c.id === id))
    .filter(Boolean)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));

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

  const summary = `读了 ${chaptersRead.length} 章 · ${(chars / 1000).toFixed(1)}k 字`;

  return {
    label: '伏笔盘点',
    summary: degraded ? `${summary}（本地模型，可信度有限）` : summary,
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
  _internal: { extractKeywords, recallChapters, splitByFirstAppearance, STATUS },
};
