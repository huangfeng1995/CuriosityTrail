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
 *   8. 检索层（材料片段，由调用方注入）
 */

const { all, get } = require('../database');
const { getRole } = require('./roles');

/** 大纲最多注入的字符数 */
const OUTLINE_LIMIT = 4000;
/** 上一场景结尾最多注入的字符数 */
const CONTINUITY_LIMIT = 500;
/** 单章正文全文注入的字符上限 */
const CONTENT_LIMIT = 12000;

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
 */
function selectCharacters(characters, text, includeAll) {
  if (includeAll) return characters;

  return characters.filter((c) =>
    nameVariants(c).some((variant) => mentions(text, variant))
  );
}

/**
 * 挑出与正文相关的设定。
 *
 * @param {Array} settings 全部设定
 * @param {string} text
 * @param {boolean} includeAll
 */
function selectSettings(settings, text, includeAll) {
  return settings.filter((s) => {
    if (includeAll) return true;
    if ((s.importance ?? 3) >= 3) return true;
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
 * @param {string} [params.extraInstruction] 用户在本次请求里附加的指令
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
    extraInstruction,
  } = params;

  const role = await getRole(roleKey);
  const systemParts = [];

  if (role) {
    systemParts.push(role.systemPrompt);
  }

  const meta = {
    work: null,
    chapter: null,
    characters: [],
    settings: [],
    retrievalCount: retrieval.length,
  };

  // ---- 1. 作品层 ----
  let work = null;
  if (workId) {
    work = await get('SELECT * FROM works WHERE id = ?', [workId]);
    meta.work = work;
  }

  if (work) {
    const workLines = ['## 作品信息'];
    workLines.push(`标题：${work.title}`);
    if (work.genre) workLines.push(`题材：${work.genre}`);
    if (work.synopsis) workLines.push(`简介：${work.synopsis}`);
    if (work.outline) {
      workLines.push(`大纲：\n${truncate(work.outline, OUTLINE_LIMIT)}`);
    }
    systemParts.push(workLines.join('\n'));
  }

  // ---- 2. 章节层 ----
  let chapter = null;
  let chapterBlocks = [];
  if (chapterId) {
    chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
    meta.chapter = chapter;
    if (chapter) {
      chapterBlocks = parseBlocks(chapter.blocks);
      const lines = ['## 当前章节'];
      lines.push(`标题：${chapter.title}`);
      if (chapter.volume) lines.push(`卷：${chapter.volume}`);
      lines.push(`状态：${statusLabel(chapter.status)}`);
      systemParts.push(lines.join('\n'));
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

  // ---- 4. 人物层 ----
  if (workId) {
    const characters = await all(
      'SELECT * FROM characters WHERE work_id = ? ORDER BY name',
      [workId]
    );
    const includeAll = scope === 'work';
    const selected = selectCharacters(characters, contentText, includeAll);
    meta.characters = selected.map((c) => c.name);

    if (selected.length) {
      systemParts.push(
        `## 人物设定\n${selected.map(formatCharacter).join('\n\n')}`
      );
    }
  }

  // ---- 5. 设定层 ----
  if (workId) {
    const settings = await all(
      'SELECT * FROM settings WHERE work_id = ? ORDER BY importance DESC, category, name',
      [workId]
    );
    const includeAll = scope === 'work';
    const selected = selectSettings(settings, contentText, includeAll);
    meta.settings = selected.map((s) => s.name);

    if (selected.length) {
      systemParts.push(
        `## 世界观设定\n${selected.map(formatSetting).join('\n\n')}`
      );
    }
  }

  // ---- 6. 正文内容层 ----
  if (scope === 'inline' && selection) {
    const context = buildInlineContext(chapterBlocks, blockId);
    systemParts.push(
      [
        '## 待修改内容',
        context.before ? `【前文】\n${context.before}` : '',
        `【选区】\n${selection}`,
        context.after ? `【后文】\n${context.after}` : '',
        context.continuity ? `【上一场景结尾】\n${context.continuity}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    );
  } else if (chapter) {
    const full = chapterBlocks
      .filter((b) => b.content)
      .map((b) => b.content)
      .join('\n\n');
    const body = full || chapter.content || '';
    if (body) {
      systemParts.push(
        `## 当前章节正文\n${truncate(body, CONTENT_LIMIT)}`
      );
    }
  }

  // ---- 6.5 块索引 ----
  // 让 AI 能把结构化输出的 target 指向具体某个块，否则回写无从下手。
  if (scope !== 'inline' && chapterBlocks.length) {
    const index = chapterBlocks
      .map((b, i) => {
        const preview = (b.content || '').replace(/\s+/g, ' ').slice(0, 30);
        const speaker = b.type === 'dialogue' && b.speaker ? `${b.speaker}：` : '';
        return `[${b.id}] ${speaker}${preview}`;
      })
      .join('\n');
    systemParts.push(
      `## 段落索引\n每个 [块ID] 对应正文中的一段。当你要续写某段时，target 填该段的块ID；要在某段后插入新段时，target 也填该段块ID。\n${index}`
    );
  }

  // ---- 7. 衔接层（侧边栏续写场景） ----
  if (scope !== 'inline' && chapterBlocks.length) {
    const continuity = extractContinuity(chapterBlocks);
    if (continuity) {
      systemParts.push(`## 上一场景结尾（用于衔接）\n${continuity}`);
    }
  }

  // ---- 8. 检索层 ----
  if (retrieval.length) {
    const items = retrieval
      .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet || ''}`)
      .join('\n\n');
    systemParts.push(`## 检索到的参考资料\n${items}`);
  }

  // ---- 附加指令 ----
  if (extraInstruction) {
    systemParts.push(`## 本次任务要求\n${extraInstruction}`);
  }

  const messages = [{ role: 'system', content: systemParts.join('\n\n---\n\n') }];

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
};
