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
 *   AI 层（需要模型）—— 把全书摘要 + 人物卡 + 设定卡一起给审稿人，
 *     让它找规则层找不到的语义矛盾（前后时间线、性格突变、设定打架）
 *
 * 规则层先跑：它不花钱、结果确定，能立刻指出最刺眼的问题。
 */

const { all, get } = require('../database');
const { nameVariants } = require('./context');

/**
 * 章节状态白名单
 */
const VALID_STATUS = new Set(['draft', 'revising', 'done']);

/**
 * 取全书正文摘要（每章开头截断，避免上下文爆掉）。
 *
 * @param {string} workId
 * @param {number} [perChapterLimit] 每章最多取多少字
 * @returns {Promise<Array<{id,title,seq,status,words,excerpt}>>}
 */
async function getChapterSummaries(workId, perChapterLimit = 600) {
  const chapters = await all(
    `SELECT id, title, seq, volume, status, content, blocks, outline, word_count
     FROM chapters WHERE work_id = ? ORDER BY seq, created_at`,
    [workId]
  );

  return chapters.map((c) => ({
    id: c.id,
    title: c.title,
    seq: c.seq,
    volume: c.volume,
    status: c.status,
    words: c.word_count || 0,
    outline: c.outline || '',
    excerpt: (c.content || '').slice(0, perChapterLimit),
  }));
}

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
    'SELECT id, title, seq, status, content FROM chapters WHERE work_id = ? ORDER BY seq',
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

  return issues;
}

/**
 * AI 层检查：把全书摘要交给审稿人角色，找语义矛盾。
 *
 * 需要模型可用。没配 key 时由调用方跳过。
 *
 * @param {string} workId
 * @param {Object} params
 * @param {Function} params.provider 已解析的 provider
 * @param {string} [params.providerName]
 * @param {Object} [params.role] 审稿人角色定义
 * @returns {Promise<Array<Object>>}
 */
async function runAiCheck(workId, params) {
  const { provider, providerName, role } = params;

  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return [];

  const chapters = await getChapterSummaries(workId, 500);
  const characters = await all('SELECT * FROM characters WHERE work_id = ?', [workId]);
  const settings = await all('SELECT * FROM settings WHERE work_id = ?', [workId]);

  if (!chapters.length) return [];

  const parts = [];

  parts.push('## 全书结构');
  parts.push(`标题：${work.title}`);
  if (work.genre) parts.push(`题材：${work.genre}`);
  if (work.synopsis) parts.push(`简介：${work.synopsis}`);
  if (work.outline) parts.push(`大纲：\n${work.outline}`);

  parts.push('\n## 人物卡');
  if (characters.length) {
    parts.push(
      characters
        .map((c) => {
          const bits = [`【${c.name}】`];
          if (c.role) bits.push(`身份：${c.role}`);
          if (c.identity) bits.push(`背景：${c.identity}`);
          if (c.personality) bits.push(`性格：${c.personality}`);
          if (c.goal) bits.push(`目标：${c.goal}`);
          if (c.arc) bits.push(`弧光：${c.arc}`);
          if (c.aliases) bits.push(`别名：${c.aliases}`);
          return bits.join('；');
        })
        .join('\n')
    );
  } else {
    parts.push('（还没有人物卡）');
  }

  parts.push('\n## 设定卡');
  if (settings.length) {
    parts.push(
      settings.map((s) => `【${s.name}·${s.category}】${s.content}`).join('\n')
    );
  } else {
    parts.push('（还没有设定卡）');
  }

  parts.push('\n## 各章摘要');
  parts.push(
    chapters
      .map(
        (c) =>
          `### 第 ${c.seq} 章 ${c.title}${c.outline ? `\n本章大纲：${c.outline}` : ''}\n${
            c.excerpt || '（本章暂无正文）'
          }`
      )
      .join('\n\n')
  );

  const systemPrompt =
    (role?.systemPrompt || '') +
    `

## 本次任务
这是一次**全书一致性检查**，不是单章审稿。请重点找出：
1. 跨章的时间线矛盾（同一事件在不同章里的时间说法冲突）
2. 人物性格/说话方式前后突变，且没有转折铺垫
3. 设定卡与正文冲突（能力边界、地理距离、称呼、关键物件的状态）
4. 情节逻辑断裂（A 章埋的因，B 章没有对应的果）
5. 视角人物的错位（前文是 A 视角，后文突然写了 B 的内心）

只报**确实存在的矛盾**，不要为了凑数把正常的伏笔或留白当成问题。
每条问题要指明**具体章节**。`;

  const result = await provider.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          '请检查上面这本小说的全书一致性，列出发现的问题。' +
          '如果确实没有矛盾，就明确说"未发现跨章矛盾"。',
      },
    ],
    temperature: role?.temperature ?? 0.4,
    model: role?.model && providerName === 'deepseek' ? role.model : undefined,
    thinking:
      role?.thinking === null || role?.thinking === undefined
        ? undefined
        : (role.thinking ? 'enabled' : 'disabled'),
  });

  const text = result?.content || '';
  return parseIssues(text);
}

/**
 * 把模型的自由文本解析成问题列表。
 *
 * 模型可能返回 JSON，也可能返回分条文本——两种都支持。
 * 解析失败时整段作为一条问题返回，不能因为格式不对就丢掉全部内容。
 *
 * @param {string} text
 * @returns {Array<Object>}
 */
function parseIssues(text) {
  if (!text || !text.trim()) return [];

  // 先试 JSON
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fence ? fence[1] : text).trim();
  try {
    const parsed = JSON.parse(candidate);
    const items = Array.isArray(parsed) ? parsed : parsed?.issues;
    if (Array.isArray(items)) {
      return items
        .filter((i) => i && (i.title || i.content))
        .map((i) => ({
          type: i.type || 'ai',
          severity: i.severity || 'medium',
          title: String(i.title || '').trim(),
          detail: String(i.content || i.detail || '').trim(),
          target: i.target ? String(i.target) : '',
        }));
    }
  } catch (e) {
    // 不是 JSON，走文本分条
  }

  // 文本分条：按换行分，每行去掉列表符号
  const lines = candidate
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 2);

  const issues = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*·•\d]+[.、)]?\s*/, '').trim();
    if (!cleaned) continue;
    // 跳过纯结论行
    if (/^(未发现|没有发现|未发现跨章矛盾)[。.]?$/.test(cleaned)) continue;
    issues.push({
      type: 'ai',
      severity: 'medium',
      title: cleaned.slice(0, 40),
      detail: cleaned,
      target: '',
    });
  }
  return issues;
}

module.exports = {
  getChapterSummaries,
  runRuleChecks,
  runAiCheck,
  parseIssues,
};
