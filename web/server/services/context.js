'use strict';

/**
 * 上下文装配器。
 *
 * 平台的核心。AI 只有在"知道这部小说是什么、当前写到哪里、涉及哪些人物和设定"
 * 的前提下才能给出有用的输出。全量塞入所有设定会撑爆上下文也稀释重点，
 * 因此这里是**按需注入**。
 *
 * 装配顺序：
 *   1. 系统提示词（角色提示词）
 *   2. 作品层（标题、题材、简介、大纲）
 *   3. 章节层（当前章节标题、卷、状态）
 *   4. 人物层（正文出现的人物名/别名命中才纳入；scope='work' 时全量）
 *   5. 设定层（importance>=3 全量；否则正文命中设定名才纳入）
 *   6. 内容层（行内：选区 + 前后各一块；侧边栏：当前章全文）
 *   7. 衔接层（上一场景结尾片段，供续写衔接）
 *   7.5 记忆层（自动召回的长期记忆片段，由调用方注入）
 *   8. 检索层（材料片段，由调用方注入）
 */

const { all, get } = require('../database');
const { getRole } = require('./roles');
const skills = require('./skills');
const style = require('./style');
const { isPipelineEnabled } = require('./pipeline/gate');
const { knowledgeAt } = require('./pipeline/knowledge');

/** 大纲最多注入的字符数 */
const OUTLINE_LIMIT = 4000;
/** 上一场景结尾最多注入的字符数 */
const CONTINUITY_LIMIT = 500;
/** 单章正文全文注入的字符上限 */
const CONTENT_LIMIT = 12000;
/** 灵感速记最多注入多少条 */
const INSPIRATION_LIMIT = 10;
/** 历史锚点分区上限：整段（含标题、脚注、省略提示）不超过 800 字 */
const ANCHOR_LIMIT = 800;
/** 历史锚点最多展示 12 条 */
const ANCHOR_MAX_ITEMS = 12;
/** 知情边界分区上限：整段（含标题、规则、脚注）不超过 700 字 */
const KNOWLEDGE_LIMIT = 700;
/** 知情边界最多注入 8 个角色 */
const KNOWLEDGE_MAX_CHARACTERS = 8;
/** system 上下文总字符预算：约 2.4 万字，超了按优先级让位，给回复留出空间 */
const CONTEXT_BUDGET = 24000;
/** 侧边栏历史消息的字符预算（只保留最近的部分，更早的省略） */
const HISTORY_BUDGET = 12000;

/**
 * 各分区的优先级：数字越小越不可牺牲。
 *
 * 超预算时从数字大的开始截断/丢弃——灵感速记可以整段不要，
 * 角色提示词和当前章节正文不行。
 */
const PRIORITY = {
  ROLE: 1,        // 角色提示词、本次任务要求
  CONTENT: 2,     // 作品/章节信息、当前正文、段落索引、衔接
  FACT: 3,        // 人物卡、设定卡、历史锚点
  MEMORY: 4,      // 长期记忆
  RETRIEVAL: 5,   // 检索资料
  INSPIRATION: 6, // 灵感速记
};

/**
 * 按优先级把分区裁进预算。
 *
 * 不改变分区顺序（顺序决定了模型读到的先后），只把低优先级分区
 * 整段丢弃或截断。返回新数组，不修改入参。
 *
 * `fixed` 的分区例外：它不计入总量、也不参与截断。
 * 技能清单与文风要求都用这个机制——它们是「模型怎么调技能」「写成什么样」
 * 的唯一说明，被裁掉模型就只能瞎猜。
 *
 * @param {Array<{text: string, priority: number, fixed?: boolean}>} parts
 * @param {number} budget 字符预算
 * @returns {Array<{text: string, priority: number}>}
 */
function applyBudget(parts, budget) {
  const fitted = parts.map((p) => ({ ...p }));
  let total = fitted.reduce((sum, p) => (p.fixed ? sum : sum + p.text.length), 0);
  if (total <= budget) return fitted;

  // 低优先级先让位（priority 数字越大越先牺牲）；同优先级保持原始顺序
  const order = fitted
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => !p.fixed)
    .sort((a, b) => b.p.priority - a.p.priority || a.index - b.index);

  for (const { p } of order) {
    if (total <= budget) break;

    const overflow = total - budget;
    if (p.text.length <= overflow) {
      total -= p.text.length;
      p.text = '';
      continue;
    }

    const tail = '\n…（篇幅过长，已截断）';
    const keep = Math.max(0, p.text.length - overflow - tail.length);
    const next = keep > 0 ? p.text.slice(0, keep) + tail : '';
    total -= p.text.length - next.length;
    p.text = next;
  }

  return fitted;
}

/**
 * 裁剪历史消息：只保留最近的一段，且从 user 消息开始。
 *
 * 从 assistant 消息开头截断的话，模型会看到"没有提问的回答"，
 * 反而会顺着答下去，把历史里的旧答案当成这一轮的内容。
 *
 * @param {Array<{role: string, content: string}>} history
 * @param {number} [budget]
 * @returns {{rows: Array, omitted: number}} omitted = 被省略的条数
 */
function trimHistory(history, budget = HISTORY_BUDGET) {
  if (!Array.isArray(history) || !history.length) return { rows: [], omitted: 0 };

  let total = 0;
  let start = history.length;

  while (start > 0) {
    const len = String(history[start - 1].content || '').length;
    if (total + len > budget) break;
    total += len;
    start -= 1;
  }

  // 从 user 边界开始：缺了提问的回答没有意义
  while (start < history.length && history[start].role !== 'user') start += 1;

  return { rows: history.slice(start), omitted: start };
}


/**
 * 能写散文的块类型。
 *
 * 与前端 applyPlan.js 的 PROSE_TYPES 保持一致：只有这三类块的 content
 * 是正文。插图是图注、设定引用是引用内容、分场是分隔符，
 * 都不能被当作改写目标。
 */
const PROSE_BLOCK_TYPES = new Set(['paragraph', 'dialogue', 'inner']);

/**
 * 解析章节的 blocks JSON。
 * @param {string} blocksJson
 * @returns {Array}
 */
function parseBlocks(blocksJson) {
  if (!blocksJson) return [];
  try {
    const parsed = JSON.parse(blocksJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 判断文本里是否出现某个名字（含别名）。
 * @param {string} text
 * @param {string} name
 */
function mentions(text, name) {
  if (!text || !name) return false;
  return text.includes(name);
}

/**
 * 取人物的所有可识别名称。
 */
function nameVariants(character) {
  const variants = [character.name];
  if (character.aliases) {
    for (const alias of character.aliases.split(/[,，、]/).map((s) => s.trim())) {
      if (alias) variants.push(alias);
    }
  }
  return variants.filter(Boolean);
}

/**
 * 挑出与正文相关的人物卡。
 *
 * @param {Array} characters 全部人物卡
 * @param {string} text 用于匹配的正文
 * @param {boolean} includeAll scope='work' 时为 true
 * @param {string} [chapterId] 当前章节 id
 */
function selectCharacters(characters, text, includeAll, chapterId) {
  if (includeAll) return characters;

  return characters.filter(
    (c) =>
      nameVariants(c).some((variant) => mentions(text, variant)) ||
      // 作者在本章刚确认过的卡，无论名字有没有写进正文都纳入：
      // 确认动作本身就是「这是本章的事实了」。
      (chapterId && c.source_chapter_id === chapterId)
  );
}

/**
 * 挑出与正文相关的设定。
 *
 * @param {Array} settings 全部设定
 * @param {string} text
 * @param {boolean} includeAll
 * @param {string} [chapterId] 当前章节 id
 */
function selectSettings(settings, text, includeAll, chapterId) {
  return settings.filter((s) => {
    if (includeAll) return true;
    if ((s.importance ?? 3) >= 3) return true;
    if (chapterId && s.source_chapter_id === chapterId) return true;
    return mentions(text, s.name);
  });
}

/**
 * 格式化人物卡为提示词片段。
 */
function formatCharacter(c) {
  const lines = [`【${c.name}】`];
  if (c.role) lines.push(`身份：${c.role}`);
  if (c.identity) lines.push(`背景：${c.identity}`);
  if (c.personality) lines.push(`性格：${c.personality}`);
  if (c.speech) lines.push(`说话风格：${c.speech}`);
  if (c.goal) lines.push(`核心目标：${c.goal}`);
  if (c.arc) lines.push(`成长弧：${c.arc}`);
  if (c.aliases) lines.push(`别名：${c.aliases}`);
  if (c.relations) {
    try {
      const relations = JSON.parse(c.relations);
      if (Array.isArray(relations) && relations.length) {
        lines.push(
          `关系：${relations.map((r) => `${r.characterName || r.name || ''}${r.relation ? `(${r.relation})` : ''}`).join('、')}`
        );
      }
    } catch (e) {
      // relations 不是合法 JSON 就跳过
    }
  }
  if (c.notes) lines.push(`备注：${c.notes}`);
  return lines.join('\n');
}

/**
 * 格式化设定为提示词片段。
 */
function formatSetting(s) {
  return `【${s.name}·${s.category}】\n${s.content}`;
}

/**
 * 从 blocks 中找到上一场景的结尾。
 *
 * 场景分隔符（scene_break）标记场景边界，取上一个 scene_break 之后的内容末尾。
 * 若没有分隔符，则取倒数第二个块的结尾。
 */
function extractContinuity(blocks) {
  if (!blocks.length) return '';

  let sceneStart = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === 'scene_break') {
      sceneStart = i + 1;
    }
  }

  const sceneBlocks = blocks.slice(sceneStart).filter((b) => b.content);
  if (!sceneBlocks.length) {
    // 当前场景为空，用上一个场景的结尾
    const prevScene = blocks.slice(0, sceneStart).filter((b) => b.content);
    if (!prevScene.length) return '';
    return truncate(prevScene[prevScene.length - 1].content, CONTINUITY_LIMIT);
  }

  const last = sceneBlocks[sceneBlocks.length - 1].content;
  return truncate(last, CONTINUITY_LIMIT);
}

function truncate(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return '…' + text.slice(-limit);
}

/**
 * 收集用于"人物/设定是否相关"判定的文本信号。
 *
 * 比章节正文更宽：包含对白块的说话人、设定引用块引用的设定名。
 * 人物出现在对白里但名字没写进正文时，靠 speaker 命中。
 */
function collectMatchText(chapter, blocks) {
  const parts = [];

  if (chapter) {
    if (chapter.title) parts.push(chapter.title);
    if (chapter.content) parts.push(chapter.content);
  }

  for (const block of blocks || []) {
    if (!block) continue;
    if (block.content) parts.push(block.content);
    if (block.speaker) parts.push(block.speaker);
  }

  return parts.join('\n');
}

/**
 * 一章的纯正文（blocks 优先，content 兜底）。
 *
 * 空章判定与「上一章出场了谁」都只需要正文，
 * 不需要标题、卷名这些元信息。
 */
function chapterBody(chapter) {
  if (!chapter) return '';
  const body = parseBlocks(chapter.blocks)
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
  return body || String(chapter.content || '');
}

/**
 * 装配上下文消息数组。
 *
 * @param {Object} params
 * @param {string} [params.workId]
 * @param {string} [params.chapterId]
 * @param {string} [params.roleKey] 角色 key，默认 'writer'
 * @param {string} [params.selection] 行内选中的原文
 * @param {Array}  [params.blocks] 行内操作的块数组（用于找前后文）
 * @param {string} [params.blockId] 行内操作的当前块 id
 * @param {string} [params.scope] 'work' | 'chapter' | 'inline'
 * @param {Array}  [params.retrieval] 检索片段 [{title, snippet, source}]
 * @param {Array}  [params.memoryRefs] 自动召回的长期记忆片段 [{label, preview}]
 * @param {string} [params.extraInstruction] 用户在本次请求里附加的指令
 * @param {string} params.userId 当前用户，用于数据归属校验与私有素材注入
 * @param {boolean} [params.includeChapterBody] 是否注入整章正文，默认 true。
 *   规划步不需要整章正文，关掉可省 12000 字预算，也避免模型把原文改写一遍。
 * @param {Object} [params.beatPlan] 本章节拍表（validateBeatPlan 的返回或 plan 本身）。
 *   只有传了它，「本章允许揭示」才有内容；不传就是空——这是刻意的保守设定：
 *   没有节拍表时，模型只能写已知范围内的事。
 * @returns {Promise<{messages: Array, meta: Object}>}
 */
async function assembleContext(params = {}) {
  const {
    workId,
    chapterId,
    roleKey = 'writer',
    selection,
    blocks,
    blockId,
    scope = 'chapter',
    retrieval = [],
    memoryRefs = [],
    extraInstruction,
    userId,
    includeChapterBody = true,
    beatPlan,
  } = params;

  const role = await getRole(roleKey, userId);
  // 带优先级的分区表。最终超预算时按优先级让位，见 applyBudget。
  const parts = [];
  const addPart = (text, priority, fixed) => {
    if (text) parts.push({ text, priority, fixed });
  };

  if (role) {
    addPart(role.systemPrompt, PRIORITY.ROLE);
  }

  // ---- 0. 文风要求 ----
  // 紧跟在角色提示词之后：模型先知道「你是谁」，再知道「写成什么样」。
  //
  // fixed：作者定的硬约束，被裁掉模型就只能瞎猜。
  // 与技能清单同一套做法。
  const styleText = userId ? await style.getStylePrompt(userId, workId) : '';

  const meta = {
    work: null,
    chapter: null,
    characters: [],
    settings: [],
    inspirations: 0,
    retrievalCount: retrieval.length,
    styleRules: Boolean(styleText),
    emptyChapter: false,
    previousChapter: '',
    pipeline: false,
    // 本轮实际注入的锚点条数。关闭模板、库为空、或一条都没放进来时都是 0。
    // 「开了模板但注入 0 条」必须是一个能被看见的事实，而不是沉默。
    anchorCount: 0,
    // 本轮知情边界实际注入的角色数。关闭模板、矩阵为空、或没有可注入的角色时都是 0。
    knowledgeCount: 0,
  };

  if (styleText) {
    addPart(styleText, PRIORITY.ROLE, true);
  }

  // ---- 1. 作品层 ----
  // 必须按 user_id 取：workId 是客户端传的，换个 id 不能读到别人的作品。
  let work = null;
  if (workId && userId) {
    work = await get('SELECT * FROM works WHERE id = ? AND user_id = ?', [workId, userId]);
    meta.work = work;
  }

  if (work) {
    meta.pipeline = isPipelineEnabled(work);
    const workLines = ['## 作品信息'];
    workLines.push(`标题：${work.title}`);
    if (work.genre) workLines.push(`题材：${work.genre}`);
    if (work.synopsis) workLines.push(`简介：${work.synopsis}`);
    if (work.outline) {
      workLines.push(`大纲：\n${truncate(work.outline, OUTLINE_LIMIT)}`);
    }
    addPart(workLines.join('\n'), PRIORITY.CONTENT);
  }

  // ---- 2. 章节层 ----
  let chapter = null;
  let chapterBlocks = [];
  if (chapterId && userId) {
    chapter = await get(
      `SELECT c.* FROM chapters c
       JOIN works w ON w.id = c.work_id
       WHERE c.id = ? AND w.user_id = ?`,
      [chapterId, userId]
    );
    meta.chapter = chapter;
    if (chapter) {
      chapterBlocks = parseBlocks(chapter.blocks);
      const lines = ['## 当前章节'];
      lines.push(`标题：${chapter.title}`);
      if (chapter.volume) lines.push(`卷：${chapter.volume}`);
      lines.push(`状态：${statusLabel(chapter.status)}`);
      // 本章大纲是作者对"这一章要发生什么"的原始意图。
      // 不注入的话，规划和写作都只能从标题猜，很容易写偏。
      if (chapter.outline) lines.push(`大纲：\n${truncate(chapter.outline, OUTLINE_LIMIT)}`);
      addPart(lines.join('\n'), PRIORITY.CONTENT);
    }
  }

  // 行内操作传入的 blocks 优先（可能是未保存的编辑中状态）
  if (Array.isArray(blocks) && blocks.length) {
    chapterBlocks = blocks;
  }

  // ---- 3. 内容层：确定用于"命中判定"的正文 ----
  // 命中判定用的是"章节全文信号"，比纯正文更宽：
  // 对白块的说话人、设定引用块的引用名也要算进去，
  // 否则"这段是陈默说的"这种只有 speaker 记录的人物会被漏掉。
  let contentText = collectMatchText(chapter, chapterBlocks);
  if (selection) {
    contentText = `${contentText}\n${selection}`;
  }

  // 空章时正文里没有名字可供匹配，人物卡会被全数过滤掉，模型只能凭空造人。
  // 改用「大纲 + 上一章正文」作为相关性信号：下一章该写谁，
  // 答案在作者自己的大纲和前文里，而不是在空白页上。
  let relevanceText = contentText;
  let chapterBodyText = '';
  if (chapter) {
    chapterBodyText =
      chapterBlocks
        .filter((b) => b && b.content)
        .map((b) => b.content)
        .join('\n\n') || String(chapter.content || '');

    if (!chapterBodyText.trim()) {
      meta.emptyChapter = true;
      const prevChapter = await get(
        `SELECT * FROM chapters
         WHERE work_id = ? AND seq < ?
         ORDER BY seq DESC LIMIT 1`,
        [workId, chapter.seq]
      );
      if (prevChapter) {
        meta.previousChapter = prevChapter.id;
        relevanceText = [
          chapter.title,
          work && work.outline,
          chapter.outline,
          chapterBody(prevChapter),
        ]
          .filter(Boolean)
          .join('\n');
      }
    }
  }

  // ---- 4. 人物层 ----
  if (workId) {
    const characters = await all(
      'SELECT * FROM characters WHERE work_id = ? ORDER BY name',
      [workId]
    );
    const includeAll = scope === 'work';
    const selected = selectCharacters(
      characters,
      relevanceText,
      includeAll,
      chapter ? chapter.id : ''
    );
    meta.characters = selected.map((c) => c.name);

    if (selected.length) {
      addPart(
        `## 人物设定\n${selected.map(formatCharacter).join('\n\n')}`,
        PRIORITY.FACT
      );
    }
  }

  // ---- 3.5 历史锚点层 ----
  // 位置：人物之后、知情边界（HP6）之前。
  //
  // 只在模板启用时查库；关闭态不新增任何查询，也不产生任何段落，
  // 保证 system 内容与改动前逐字节相同。
  //
  // 这一段是 fixed：它要么完整出现在上下文里，要么不出现。
  // 因此它的长度会从总预算里预扣（见下方 applyBudget 调用），
  // 不能让它去和正文抢同一份额度。
  let anchorText = '';
  if (meta.pipeline && work) {
    try {
      const signalParts = [
        chapter ? chapter.title : '',
        chapter ? chapter.outline : '',
      ];
      if (chapter && chapter.seq > 1) {
        const prev = await get(
          `SELECT * FROM chapters
           WHERE work_id = ? AND seq < ?
           ORDER BY seq DESC LIMIT 1`,
          [workId, chapter.seq]
        );
        if (prev) signalParts.push(chapterBody(prev).slice(-CONTINUITY_LIMIT));
      }
      const rows = await all(
        `SELECT * FROM work_anchors
         WHERE work_id = ? AND status = 'active'
         ORDER BY created_at ASC, id ASC`,
        [workId]
      );
      const built = buildAnchorSection(rows, signalParts.filter(Boolean).join('\n'));
      anchorText = built.text;
      meta.anchorCount = built.count;
      if (anchorText) addPart(anchorText, PRIORITY.FACT, true);
    } catch (e) {
      // 取锚点失败只跳过该分区，不能让整轮写作失败。
      console.error('[context] 历史锚点加载失败:', e.message);
    }
  }

  // ---- 3.6 本章知情边界层 ----
  // 位置：历史锚点之后、设定层之前（P.6.4）。
  //
  // 与锚点一样，只在模板启用时查库；关闭态不新增查询、不产生段落，
  // 保证 system 内容与改动前逐字节相同。
  //
  // 这里是 fixed 分区：长度从总预算里预扣，不跟正文/大纲抢额度。
  // 数据为空（knowledge_matrix 一行都没有）时不产生空标题段落，
  // knowledgeCount 保持 0——与锚点空库同一原则。
  let knowledgeText = '';
  if (meta.pipeline && work && chapter) {
    try {
      const visible = await knowledgeAt(workId, chapter.seq);
      const hasMatrix = await get(
        'SELECT id FROM knowledge_matrix WHERE work_id = ? LIMIT 1',
        [workId]
      );
      if (hasMatrix) {
        const built = await buildKnowledgeSection({
          workId,
          chapter,
          visible,
          beatPlan,
        });
        knowledgeText = built.text;
        meta.knowledgeCount = built.count;
        if (knowledgeText) addPart(knowledgeText, PRIORITY.FACT, true);
      }
    } catch (e) {
      // 取知情边界失败只跳过该分区，不能让整轮写作失败。
      console.error('[context] 知情边界加载失败:', e.message);
    }
  }

  // ---- 5. 设定层 ----
  if (workId) {
    const settings = await all(
      'SELECT * FROM settings WHERE work_id = ? ORDER BY importance DESC, category, name',
      [workId]
    );
    const includeAll = scope === 'work';
    const selected = selectSettings(
      settings,
      relevanceText,
      includeAll,
      chapter ? chapter.id : ''
    );
    meta.settings = selected.map((s) => s.name);

    if (selected.length) {
      addPart(
        `## 世界观设定\n${selected.map(formatSetting).join('\n\n')}`,
        PRIORITY.FACT
      );
    }
  }

  // ---- 5.5 灵感层 ----
  // 作者随手记下的念头，是最"私人"的素材：不会被通用检索命中，
  // 但恰恰是灵感师该先看的。仅注入未消费的。
  if (work) {
    const inspirations = await all(
      `SELECT * FROM inspirations
       WHERE user_id = ? AND consumed = 0
       ORDER BY created_at DESC
       LIMIT ?`,
      [userId, INSPIRATION_LIMIT]
    );
    meta.inspirations = inspirations.length;

    if (inspirations.length) {
      const lines = inspirations.map(
        (i, idx) => `[灵${idx + 1}] ${i.text}${i.tags ? `（${i.tags}）` : ''}`
      );
      addPart(`## 作者的灵感速记\n${lines.join('\n')}`, PRIORITY.INSPIRATION);
    }
  }

  // ---- 6. 正文内容层 ----
  if (scope === 'inline' && selection) {
    const context = buildInlineContext(chapterBlocks, blockId);
    addPart(
      [
        '## 待修改内容',
        context.before ? `【前文】\n${context.before}` : '',
        `【选区】\n${selection}`,
        context.after ? `【后文】\n${context.after}` : '',
        context.continuity ? `【上一场景结尾】\n${context.continuity}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      PRIORITY.CONTENT
    );
  } else if (chapter) {
    if (!includeChapterBody) {
      // 规划步：不塞整章正文（省预算，也避免模型把原文复述一遍）。
      // 只给上一章结尾作前情摘要——下一章该接什么，答案在那里。
      if (chapter.seq > 1) {
        const prev = await get(
          `SELECT * FROM chapters
           WHERE work_id = ? AND seq < ?
           ORDER BY seq DESC LIMIT 1`,
          [workId, chapter.seq]
        );
        const tail = prev ? chapterBody(prev) : '';
        if (tail.trim()) {
          addPart(
            `## 上一章结尾（前情摘要）\n${truncate(tail, CONTINUITY_LIMIT)}`,
            PRIORITY.CONTENT
          );
        }
      }
    } else {
      const body = chapterBodyText;
      if (body) {
        addPart(
          `## 当前章节正文\n${truncate(body, CONTENT_LIMIT)}`,
          PRIORITY.CONTENT
        );
      } else {
        // 本章还没有正文。
        //
        // 不说清楚的话，模型只能靠猜：它会给出 action="append" 加一个
        // 指向不存在段落的 target，前端回写时找不到落点，作者看到的是
        // "当前章节还没有正文"，AI 写的内容就这么丢了。
        // 这里直接告诉它该怎么写：正文会作为本章第一段插入进去。
        addPart(
          '## 当前章节正文\n（本章还没有正文。）\n\n' +
            '你要写的正文会作为本章的第一段插入进去，所以：' +
            'action 填 "insert"（或 "append"），target 留空字符串，不要编造块ID。',
          PRIORITY.CONTENT
        );
      }
    }
  }

  // ---- 6.5 块索引 ----
  // 让 AI 能把结构化输出的 target 指向具体某个块，否则回写无从下手。
  //
  // 只列能写散文的块（正文/对白/独白）。插图、设定引用、分场也在 blocks 里，
  // 但它们的 content 是图注 / 引用内容 / 空串。把它们的 ID 也给出去，
  // 模型就会拿这些 ID 当 target，回写时把图注变成一段小说正文。
  if (scope !== 'inline' && includeChapterBody && chapterBlocks.length) {
    const index = chapterBlocks
      .filter((b) => PROSE_BLOCK_TYPES.has((b && b.type) || 'paragraph'))
      .map((b) => {
        const preview = (b.content || '').replace(/\s+/g, ' ').slice(0, 30);
        const speaker = b.type === 'dialogue' && b.speaker ? `${b.speaker}：` : '';
        return `[${b.id}] ${speaker}${preview}`;
      })
      .join('\n');
    if (index) {
      addPart(
        `## 段落索引\n每个 [块ID] 对应正文中的一段。当你要续写某段时，target 填该段的块ID；要在某段后插入新段时，target 也填该段块ID。\n${index}`,
        PRIORITY.CONTENT
      );
    }
  }

  // ---- 7. 衔接层（侧边栏续写场景） ----
  // 规划步同样要跳过：衔接片段就是本章正文的结尾，
  // 一边说「不塞整章正文」，一边从结尾漏 500 字，等于没关。
  if (scope !== 'inline' && includeChapterBody && chapterBlocks.length) {
    const continuity = extractContinuity(chapterBlocks);
    if (continuity) {
      addPart(`## 上一场景结尾（用于衔接）\n${continuity}`, PRIORITY.CONTENT);
    }
  }

  // ---- 7.5 记忆层 ----
  // 自动召回的长期记忆。放在检索资料之前——
  // 记忆是"这部作品自己的历史"，素材是"外部参考"，
  // 模型的注意力应该先落在作品自身的前情上。
  if (memoryRefs.length) {
    const items = memoryRefs
      .map((ref, i) => `${i + 1}. 〔${ref.label}〕${ref.preview || ''}`)
      .join('\n');
    addPart(`## 长期记忆（自动召回）\n${items}`, PRIORITY.MEMORY);
  }

  // ---- 8. 检索层 ----
  if (retrieval.length) {
    const items = retrieval
      .map((r, i) => {
        // 来源要写清：站内素材（带页码）还是外部网页
        const bits = [r.source];
        if (r.page) bits.push(`第 ${r.page} 页`);
        const label = bits.filter(Boolean).join(' · ');
        const head = label ? `[${i + 1}] ${r.title}（${label}）` : `[${i + 1}] ${r.title}`;
        return `${head}\n${r.snippet || ''}`;
      })
      .join('\n\n');
    addPart(`## 检索到的参考资料\n${items}`, PRIORITY.RETRIEVAL);
  }

  // ---- 附加指令 ----
  if (extraInstruction) {
    addPart(`## 本次任务要求\n${extraInstruction}`, PRIORITY.ROLE);
  }

  // ---- 技能清单 ----
  // 放在 system prompt 末尾：角色提示词已经规定了 action 的取值范围，
  // 追加段必须在其之后才能被模型看见。
  //
  // 只对侧边栏对话注入：行内操作（inline）不做跨章查询，
  // 给它塞技能清单只会让模型多想。
  //
  // 技能清单不参与预算竞争：它是模型"怎么调技能"的唯一说明，
  // 被裁掉模型就只能瞎猜。所以先从总预算里预留它的长度。
  let skillsText = '';
  if (scope !== 'inline') {
    const list = skills.listSkills();
    if (list.length) {
      const lines = ['## 可用技能'];
      lines.push('当你需要当前上下文之外的信息时，可以调用下面的技能。');
      lines.push('');
      lines.push('调用方式和上面不同：action 填 "call_tool"——这是上面 action 取值之外的额外取值。');
      lines.push('tool 填技能名，params 填技能参数，target / content / reason 这几个字段不用填。');
      lines.push('调用之后你会收到工具结果，再据此给出最终回答。');
      for (const s of list) {
        lines.push('');
        lines.push(`### ${s.label}（${s.name}）`);
        lines.push(`说明：${s.description}`);
        lines.push(`参数：${JSON.stringify(s.parameters)}`);
      }
      lines.push('');
      lines.push('示例：');
      const first = list[0];
      const firstKeys = Object.keys((first.parameters && first.parameters.properties) || {});
      lines.push(JSON.stringify({
        action: 'call_tool',
        tool: first.name,
        params: firstKeys.length ? { [firstKeys[0]]: '示例' } : {},
      }));
      skillsText = lines.join('\n');
    }
  }

  const fitted = applyBudget(
    parts,
    Math.max(
      2000,
      CONTEXT_BUDGET - skillsText.length - styleText.length - anchorText.length - knowledgeText.length
    )
  );
  const segments = fitted.map((p) => p.text).filter(Boolean);
  if (skillsText) segments.push(skillsText);

  const messages = [{ role: 'system', content: segments.join('\n\n---\n\n') }];

  return { messages, meta };
}

/**
 * 行内操作时，取当前块的前后文。
 */
function buildInlineContext(blocks, blockId) {
  if (!blocks.length) return { before: '', after: '', continuity: '' };

  const index = blocks.findIndex((b) => b.id === blockId);
  const target = index >= 0 ? index : blocks.length - 1;

  const beforeBlock = blocks[target - 1];
  const afterBlock = blocks[target + 1];

  return {
    before: beforeBlock && beforeBlock.content ? beforeBlock.content : '',
    after: afterBlock && afterBlock.content ? afterBlock.content : '',
    continuity: extractContinuity(blocks.slice(0, target)),
  };
}

function statusLabel(status) {
  const map = {
    draft: '草稿',
    revising: '修订中',
    done: '已完成',
  };
  return map[status] || status || '草稿';
}

// ---------------------------------------------------------------------------
// 历史锚点分区
// ---------------------------------------------------------------------------

const ANCHOR_CONFIDENCE_RANK = { sourced: 0, inferable: 1, blank: 2 };

/** 零命中兜底时置顶的说明行：让模型和作者都知道这些锚点不是按本章主体挑的 */
const ANCHOR_FALLBACK_NOTICE = '以下锚点未命中本章主体，作为全局约束带入';

/**
 * 锚点的 subject 是否命中本章的信号（标题 / 大纲 / 上一章结尾）。
 *
 * 这是 P.5.5 的「按主体挑选」部分，不含不可变 time/office 的通用条目——
 * 后者是「每章都该带上」，不是「这一章讲到了它」。
 */
function subjectAnchorRelevant(anchor, signal) {
  const subject = String(anchor.subject || '').trim();
  return Boolean(subject) && signal.includes(subject);
}

/**
 * 锚点是否该进本章上下文。
 *
 * P.5.5 的选择规则：subject 命中本章标题 / 大纲 / 上一章结尾；
 * 另外 time / office 类的不可变锚点无条件带上——章序、官制错一次，
 * 整段情节就站不住了。
 */
function anchorRelevant(anchor, signal) {
  if (anchor.immutable === 1 && (anchor.kind === 'time' || anchor.kind === 'office')) {
    return true;
  }
  return subjectAnchorRelevant(anchor, signal);
}

function sourceCitation(anchor) {
  const title = String(anchor.source_title || '')
    .trim()
    .replace(/^《/, '')
    .replace(/》$/, '')
    .trim();
  if (!title) return '';
  const locator = String(anchor.source_locator || '').trim();
  return locator ? `《${title}·${locator}》` : `《${title}》`;
}

function formatAnchorLine(anchor) {
  const claim = truncate(String(anchor.claim || '').trim(), 240);
  if (anchor.confidence === 'blank') {
    const usable = String(anchor.usable_for || '').trim();
    return `[空白·可虚构] ${claim}${usable ? `——${usable}` : ''}`;
  }
  const citation = sourceCitation(anchor);
  if (anchor.confidence === 'sourced') {
    return `[有出处] ${claim}${citation ? `（${citation}）` : ''}`;
  }
  return `[可推定] ${claim}${citation ? `（${citation}一般认为）` : '（一般认为）'}`;
}

/**
 * 生成「历史锚点」分区。
 *
 * 上限 800 字是**整段**上限：标题、说明行、每行、脚注、省略提示都算在内。
 *
 * 两种模式：
 *   - 正常：subject 命中本章主体 → 按「不可变优先 → sourced > inferable > blank
 *     → 创建时间」排序截断；
 *   - 零命中兜底：一条都没命中但库里有 active 锚点 → 改为按「不可变
 *     time/office 优先 → 不可变 → 出处等级」挑前 N 条，并在段首说明
 *     这些是作为全局约束带入的。宁可只剩说明行，也不返回空段。
 *
 * @param {Array<Object>} rows status='active' 的锚点
 * @param {string} signal 本章标题 / 大纲 / 上一章结尾
 * @returns {{text: string, count: number}} 空 text 表示没有可注入的锚点；
 *   count 是实际写进分区的条数（「已省略」的不算）
 */
function buildAnchorSection(rows, signal) {
  const active = (rows || []).filter((a) => a && a.subject != null);
  if (!active.length) return { text: '', count: 0 };

  // 零命中兜底：subject 一条都没命中时，不能静默什么都不注入——
  // 作者看到的是「开了模板却毫无效果」，和风格参照的老毛病一模一样。
  const subjectHits = active.filter((a) => subjectAnchorRelevant(a, signal));
  const fallback = subjectHits.length === 0;
  const selected = fallback
    ? active
    : active.filter((a) => anchorRelevant(a, signal));

  if (!selected.length) return { text: '', count: 0 };

  const isImmutableTimeOffice = (a) =>
    a.immutable === 1 && (a.kind === 'time' || a.kind === 'office');

  selected.sort((a, b) => {
    // 兜底模式：time/office 的不可变锚点（年号、官制）先上，它们是全局约束
    if (fallback) {
      const global = isImmutableTimeOffice(b) - isImmutableTimeOffice(a);
      if (global) return global;
    }
    const immutable = (b.immutable === 1 ? 1 : 0) - (a.immutable === 1 ? 1 : 0);
    if (immutable) return immutable;
    const rank =
      (ANCHOR_CONFIDENCE_RANK[a.confidence] ?? 99) -
      (ANCHOR_CONFIDENCE_RANK[b.confidence] ?? 99);
    if (rank) return rank;
    return String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
      String(a.id || '').localeCompare(String(b.id || ''));
  });

  const HEADING = '## 历史锚点（本章硬约束）';
  const FOOTER =
    '本章不可改动：上列 [有出处]/[可推定] 条目。空白区可虚构，但不得写成确凿史实。';

  const render = (lines, omitted) => {
    const blocks = [HEADING];
    if (fallback) blocks.push(ANCHOR_FALLBACK_NOTICE);
    blocks.push(...lines);
    // 兜底且一条都放不进时，只留说明行：此时「已省略」只是噪音。
    if (omitted > 0 && lines.length) blocks.push(`…（已省略 ${omitted} 条）`);
    return `${blocks.join('\n')}\n\n${FOOTER}`;
  };

  const lines = [];
  for (const anchor of selected) {
    if (lines.length >= ANCHOR_MAX_ITEMS) break;
    const formatted = formatAnchorLine(anchor);
    const next = lines.concat(formatted);
    const omitted = selected.length - next.length;
    // 用「下一行 + 最坏省略提示」试算，保证最终整段不超 800 字。
    if (render(next, omitted).length > ANCHOR_LIMIT) break;
    lines.push(formatted);
  }

  if (!lines.length) {
    // 兜底模式至少留下说明行；正常模式则返回空段（不产生空标题）。
    return fallback
      ? { text: render([], 0), count: 0 }
      : { text: '', count: 0 };
  }

  const omitted = selected.length - lines.length;
  let text = render(lines, omitted);
  // 兜底：省略提示或脚注导致越界时，继续从尾部让位。
  while (lines.length && text.length > ANCHOR_LIMIT) {
    lines.pop();
    text = render(lines, selected.length - lines.length);
  }
  if (lines.length) return { text, count: lines.length };
  // 让位到一条不剩：兜底模式仍保留说明行（宁可只有这一行，也不返回空段）。
  return fallback
    ? { text: render([], 0), count: 0 }
    : { text: '', count: 0 };
}

// ---------------------------------------------------------------------------
// 知情边界分区
// ---------------------------------------------------------------------------

/** 知情状态 → 注入块的四类标签。exposed 是「已公开」，对本人而言仍是已知。 */
const KNOWLEDGE_STATE_LABEL = {
  knows: '已知',
  exposed: '已知',
  partial: '半知',
  suspects: '怀疑',
};

/** P.6.4 的三条规则，逐字照抄 */
const KNOWLEDGE_RULES = [
  '规则：',
  '1. 角色只能说/用其「已知」与「本章允许揭示」的事实；',
  '2. 「未知」的事实不得被该角色说出、暗示或当作行动依据；',
  '3. 未见过某证据的角色，不得引用该证据的内容或细节。',
].join('\n');

/** 「1 条」是本章总量，不是每个角色各 1 条 */
const KNOWLEDGE_TOTAL_NOTE = '本章总量，不是每角色';

/**
 * 事实的展示用短标题。
 *
 * story_facts 没有独立短标题字段，这里取 content 前 12 个字**仅用于注入展示**，
 * 不改库、不新增字段。未知/怀疑条目必须带上它——只给 F1 编号，
 * 模型不知道 F1 是什么，就无从避开，规则也就不可执行。
 */
function factShortTitle(fact) {
  const content = String(fact.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return '';
  return Array.from(content).slice(0, 12).join('');
}

/**
 * 生成「本章知情边界」分区（P.6.4）。
 *
 * 上限 700 字是**整段**上限：标题、角色行、允许揭示、证据、规则、省略提示都算在内。
 *
 * 裁剪顺序是硬要求：
 *   1. 先砍各角色的「未知」列表（未知比已知更可省略）；
 *   2. 再砍证据行；
 *   3. **绝不砍「本章允许揭示」这一行**。
 * 之后才允许退到「只留事实编号」、再减少角色行。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {Object} params.chapter 当前章节（用 outline 选人）
 * @param {Array}  params.visible knowledgeAt() 返回的可见矩阵行
 * @param {Object} [params.beatPlan] 节拍表；没有时允许揭示为空
 * @returns {Promise<{text: string, count: number}>} count = 实际注入的角色数
 */
async function buildKnowledgeSection({ workId, chapter, visible, beatPlan }) {
  const characters = await all(
    'SELECT * FROM characters WHERE work_id = ? ORDER BY name',
    [workId]
  );
  const facts = await all(
    'SELECT * FROM story_facts WHERE work_id = ? ORDER BY created_at ASC, id ASC',
    [workId]
  );
  if (!characters.length || !facts.length) return { text: '', count: 0 };

  const plan = beatPlan && beatPlan.plan ? beatPlan.plan : beatPlan;
  const planText = plan ? JSON.stringify(plan) : '';
  const signal = [chapter.outline || '', planText].filter(Boolean).join('\n');

  // 上一章出场的人是第二优先级：本章大纲没点名时，他们比从未出场的角色
  // 更可能有知情边界需要约束。
  const previous = await get(
    `SELECT * FROM chapters WHERE work_id = ? AND seq < ?
     ORDER BY seq DESC LIMIT 1`,
    [workId, chapter.seq]
  );
  const previousText = previous ? chapterBody(previous) : '';

  const relevanceRank = (character) => {
    const variants = nameVariants(character);
    if (signal && variants.some((v) => signal.includes(v))) return 0;
    if (previousText && variants.some((v) => previousText.includes(v))) return 1;
    return 2;
  };

  // 按本章大纲/节拍表里出现的人名取角色；一个都没命中时取全部。
  // 排序后取前 8——超限裁剪时从队尾砍，砍掉的永远是最不相关的角色。
  const matched = signal
    ? characters.filter((c) => nameVariants(c).some((v) => signal.includes(v)))
    : [];
  const candidates = matched.length ? matched : characters;
  const chosen = candidates
    .map((c, index) => ({ c, index, rank: relevanceRank(c) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, KNOWLEDGE_MAX_CHARACTERS)
    .map((item) => item.c);
  if (!chosen.length) return { text: '', count: 0 };

  // 事实编号按创建顺序固定，同一个分区里稳定可读。
  const labels = new Map(facts.map((fact, index) => [fact.id, `F${index + 1}`]));

  // knowledgeAt() 每个 (角色, 事实) 只返回最新一条，这里直接落成两层 Map。
  const stateByCharacter = new Map();
  for (const row of visible || []) {
    if (!row || !row.character_id || !row.fact_id) continue;
    if (!stateByCharacter.has(row.character_id)) {
      stateByCharacter.set(row.character_id, new Map());
    }
    stateByCharacter.get(row.character_id).set(row.fact_id, row.state);
  }

  const evidenceRows = await all(
    `SELECT * FROM evidence_items
     WHERE work_id = ? AND status = 'active'
     ORDER BY created_at ASC, id ASC`,
    [workId]
  );
  const characterNames = new Map(characters.map((c) => [c.id, c.name]));

  /**
   * 事实在注入块里的写法。
   *
   * 未知/怀疑：只给「编号 + ≤12 字短标题」，不带正文、不带关键词——
   * 模型能认出大致是什么并避开，但不会拿到秘密的完整内容。
   * 已知/半知：正文 + 关键词；超限压到 compact 时退回短标题，
   * 绝不允许压成纯编号。
   */
  const factBrief = (fact, withContent, compact) => {
    const label = labels.get(fact.id) || '';
    const shortTitle = factShortTitle(fact);
    const brief = shortTitle ? `${label}（${shortTitle}）` : label;
    if (!withContent || compact) return brief;
    const content = truncate(String(fact.content || '').replace(/\s+/g, ' ').trim(), 60);
    const keywords = String(fact.keywords || '').trim();
    const bits = [];
    if (content) bits.push(content);
    if (keywords) bits.push(`关键词：${keywords}`);
    return bits.length ? `${label}（${bits.join('｜')}）` : brief;
  };

  const characterLine = (character, includeUnknown, compact) => {
    const states = stateByCharacter.get(character.id) || new Map();
    const groups = { 已知: [], 半知: [], 怀疑: [], 未知: [] };
    for (const fact of facts) {
      const state = states.get(fact.id);
      const label = KNOWLEDGE_STATE_LABEL[state] || '未知';
      groups[label].push(fact);
    }

    const segments = [];
    for (const label of ['已知', '半知', '怀疑', '未知']) {
      if (label === '未知' && !includeUnknown) continue;
      const list = groups[label];
      if (!list.length) continue;
      // 半知者可以说出「错的部分」，所以半知也要带内容；
      // 怀疑只是起疑，不能拿到事实内容。
      const withContent = label === '已知' || label === '半知';
      segments.push(
        `${label}：${list.map((fact) => factBrief(fact, withContent, compact)).join('、')}`
      );
    }
    if (!segments.length) return '';
    return `【${character.name}】${segments.join('｜')}`;
  };

  // 「本章允许揭示」只从节拍表的 infoGain 与 delta.variable='信息' 中抽取。
  // 没有节拍表时 reveals 为空，注入块会明确写出「本章未规划揭示点」。
  const revealByFact = new Map();
  if (plan && Array.isArray(plan.beats)) {
    for (const beat of plan.beats) {
      if (!beat) continue;
      const hayParts = [];
      if (beat.infoGain) hayParts.push(String(beat.infoGain));
      if (beat.delta && beat.delta.variable === '信息') {
        if (beat.delta.from) hayParts.push(String(beat.delta.from));
        if (beat.delta.to) hayParts.push(String(beat.delta.to));
      }
      if (!hayParts.length) continue;
      const hay = hayParts.join('\n');
      for (const fact of facts) {
        if (revealByFact.has(fact.id)) continue;
        const label = labels.get(fact.id);
        const keys = String(fact.keywords || '')
          .split(/[,，、]/)
          .map((s) => s.trim())
          .filter(Boolean);
        const hit =
          hay.includes(fact.id) ||
          (label && new RegExp(`${label}(?!\\d)`).test(hay)) ||
          keys.some((key) => hay.includes(key));
        if (hit) revealByFact.set(fact.id, beat);
      }
    }
  }
  const reveals = Array.from(revealByFact.entries()).map(([factId, beat]) => ({
    factId,
    beat,
  }));

  const evidenceText = () => {
    if (!evidenceRows.length) return '';
    const items = evidenceRows.map((item, index) => {
      const label = `E${index + 1}`;
      let holder = '无持有者';
      if (item.holder_kind === 'character') {
        holder = `${characterNames.get(item.holder_character_id) || '未知人物'}持有`;
      } else if (item.holder_kind === 'place') {
        holder = '置于某处';
      }
      let seen = [];
      try {
        seen = JSON.parse(item.seen_by || '[]');
      } catch (e) {
        seen = [];
      }
      const seenNames = Array.isArray(seen)
        ? seen.map((id) => characterNames.get(id)).filter(Boolean)
        : [];
      const seenText = seenNames.length ? `仅${seenNames.join('、')}见过` : '无人见过';
      return `${label}（${item.title}：${holder}，${seenText}）`;
    });
    return `证据：${items.join('｜')}`;
  };

  const allowedText = (limit) => {
    if (!reveals.length) {
      // 没有节拍表时不能把故事锁死：允许本章自行推进 1 条，但要求写清契机与代价。
      return (
        '本章允许揭示（未规划模式）：本章未规划揭示点。' +
        `最多允许揭示 1 条新事实（${KNOWLEDGE_TOTAL_NOTE}），且必须写出触发契机与代价；不得本章连开多条。`
      );
    }
    const prefix = '本章允许揭示（来自节拍表）：';
    const max = Math.max(0, Math.min(limit, reveals.length));
    if (!max) {
      return `${prefix}（条目过多，已省略）。规划外新事实本章合计仍限 1 条（${KNOWLEDGE_TOTAL_NOTE}）。`;
    }
    const items = reveals.slice(0, max).map(({ factId, beat }) => {
      const label = labels.get(factId) || '';
      const id = beat && beat.id ? beat.id : '';
      const type = beat && beat.type ? ` ${beat.type}` : '';
      return `${label}（${id}${type}）`;
    });
    const omitted = reveals.length - max;
    return (
      `${prefix}${items.join('、')}${omitted ? `…（另省略 ${omitted} 条）` : ''}。` +
      `规划外新事实本章合计仍限 1 条（${KNOWLEDGE_TOTAL_NOTE}）。`
    );
  };

  const render = ({ includeUnknown, includeEvidence, compact, maxCharacters, revealLimit }) => {
    const lines = chosen
      .slice(0, maxCharacters)
      .map((character) => characterLine(character, includeUnknown, compact))
      .filter(Boolean);
    const omitted = characters.length - lines.length;
    const blocks = ['## 本章知情边界（硬约束）'];
    if (lines.length) blocks.push(...lines);
    blocks.push('', allowedText(revealLimit));
    const evidence = includeEvidence ? evidenceText() : '';
    if (evidence) blocks.push(evidence);
    blocks.push('', KNOWLEDGE_RULES);
    // 被 8 人上限或 700 字上限挡在外面的角色，必须让作者看见，而不是静默。
    if (omitted > 0) blocks.push(`其余 ${omitted} 人本轮未注入边界`);
    return { text: blocks.join('\n'), count: lines.length };
  };

  const full = chosen.length;
  const stages = [
    { includeUnknown: true, includeEvidence: true, compact: false },
    { includeUnknown: false, includeEvidence: true, compact: false },
    { includeUnknown: false, includeEvidence: false, compact: false },
    { includeUnknown: false, includeEvidence: false, compact: true },
  ];
  for (const stage of stages) {
    const built = render({ ...stage, maxCharacters: full, revealLimit: reveals.length });
    if (built.text.length <= KNOWLEDGE_LIMIT) return built;
  }

  // 到这一步「未知」和证据都已经让位，仍然超限就减少角色行。
  for (let count = full - 1; count >= 0; count -= 1) {
    const built = render({
      includeUnknown: false,
      includeEvidence: false,
      compact: true,
      maxCharacters: count,
      revealLimit: reveals.length,
    });
    if (built.text.length <= KNOWLEDGE_LIMIT) return built;
  }

  // 极端情况：允许揭示条目本身就撑破了 700 字。保留这一行，逐条缩减条目数。
  for (let limit = reveals.length - 1; limit >= 1; limit -= 1) {
    const built = render({
      includeUnknown: false,
      includeEvidence: false,
      compact: true,
      maxCharacters: 0,
      revealLimit: limit,
    });
    if (built.text.length <= KNOWLEDGE_LIMIT) return built;
  }

  const minimal = render({
    includeUnknown: false,
    includeEvidence: false,
    compact: true,
    maxCharacters: 0,
    revealLimit: 0,
  });
  return minimal.text.length <= KNOWLEDGE_LIMIT ? minimal : { text: '', count: 0 };
}

module.exports = {
  assembleContext,
  parseBlocks,
  selectCharacters,
  selectSettings,
  extractContinuity,
  collectMatchText,
  formatCharacter,
  formatSetting,
  nameVariants,
  trimHistory,
  applyBudget,
  CONTEXT_BUDGET,
  HISTORY_BUDGET,
};
