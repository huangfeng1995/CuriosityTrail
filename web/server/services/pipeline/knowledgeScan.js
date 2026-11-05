'use strict';

/**
 * 知情扫描（HP7 / P.6.5）。
 *
 * 两层：
 *   规则层（免费、确定性）：先在正文里定位「人名 + 事件动作句」候选。
 *   模型层（只在候选非空时调用）：只判候选是升不升级，不再自由通读全文。
 *
 * 这样同一正文、同一状态快照重复扫描会得到同一结果；候选为空时也不会
 * 让模型臆造一条变化出来。
 *
 * 四条校验仍在：
 *   1. 实体存在：角色名/别名能在本章作品里找到，factId 能对到 story_facts；
 *   2. evidence 必须逐字出现在正文里（不靠语义相似，避免模型自证）；
 *   3. toState 合法且为升级；一次只能升一级，跳级进 pending；
 *   4. chapterSeq 与本章一致（「第 N 章写完后生效」）。
 *
 * 分级落库：
 *   - suspects / partial：四条全过即自动写（低风险，少收紧一点代价小）；
 *   - knows / exposed：即使四条全过，也必须进 pending 等作者确认。
 *
 * 另加「文本越界」粗筛：角色在正文里说出/写出他尚未达 knows 的事实内容，
 * 命中后只进 pending 标 possible_leak，不直接判违规。
 *
 * 失败降级：模型调用/解析失败时零写入，记 knowledge_scan_failed。
 */

const crypto = require('crypto');
const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');
const { parseModelJson } = require('../agent/parse');
const { all, get, transaction } = require('../../database');
const { knowledgeAt } = require('./knowledge');

/** 与 knowledge_matrix.state 的 CHECK 保持一致 */
const STATES = new Set(['suspects', 'partial', 'knows', 'exposed']);

/**
 * 升级层级：未知最低，exposed 最高。
 * 只允许 +1（如 suspects→partial、partial→knows、knows→exposed）；
 * 跨两级以上算跳级，进 pending。
 */
const STATE_RANK = {
  unknown: 0,
  suspects: 1,
  partial: 2,
  knows: 3,
  exposed: 4,
};

const SCAN_TIMEOUT_MS = 20000;
const SCAN_MAX_TOKENS = 600;
/**
 * 判定层温度固定 0：候选已经由规则层锁定，模型只判「升不升级」，
 * 同一正文、同一状态快照重复扫描必须得到同一结果。
 */
const SCAN_TEMPERATURE = 0;
const MAX_CANDIDATES = 24;
const MAX_LEAKS = 12;
const EVIDENCE_LIMIT = 40;

const SCAN_PROMPT = `你是历史悬疑的知情状态判定器。下面是从正文里机械筛出的候选，
每个候选已经锁定「角色 + 事实 + 原句」。你的任务只有一件：判断这一句是否让该角色
对该事实的知情状态上升一级。只输出一个 JSON 对象：
{"transitions":[{"candidate":"C1","toState":"suspects|partial|knows|exposed"}]}

规则：
- 只能使用候选清单里的编号；不要新增候选，不要改角色，不要改事实。
- 状态只能比当前高一级：未知→怀疑→半知→已知→公开。
- 只是同句提到、没有明确认知变化，就不要输出。
- 跳级、降级、猜测、推断一律不要输出。
- 没有明确变化就返回 {"transitions":[]}。

候选清单：
{candidateList}

当前知情状态（只列非「未知」；未列出即未知）：
{stateList}`;

/** 言说/书写动作：用于粗筛「角色说出了事实内容」。不能用裸「道」，会把「知道」也算进来。 */
const SPEECH_RE = /[「」“”"'‘’]|说|问|答|念|喊|叫|告诉|提及|讲|道出|脱口|写道/;

class ScanInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ScanInputError';
    this.status = status;
  }
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

function shortContent(content, limit = 80) {
  const text = normalizeText(content).replace(/\s+/g, ' ');
  return Array.from(text).slice(0, limit).join('');
}

function characterVariants(character) {
  const variants = [character.name];
  const aliases = String(character.aliases || '');
  for (const alias of aliases.split(/[,，、]/)) {
    const value = alias.trim();
    if (value) variants.push(value);
  }
  return variants;
}

function findCharacter(characters, name) {
  const target = normalizeText(name);
  if (!target) return null;
  return characters.find((c) => characterVariants(c).includes(target)) || null;
}

function stateFor(states, characterId, factId) {
  return states.get(characterId)?.get(factId) || 'unknown';
}

function nextState(current) {
  const rank = STATE_RANK[current] ?? 0;
  if (rank >= STATE_RANK.exposed) return 'exposed';
  return Object.keys(STATE_RANK).find((key) => STATE_RANK[key] === rank + 1) || 'suspects';
}

function splitSentences(text) {
  const rows = [];
  const re = /[^。！？!?；;\n]+[。！？!?；;]?/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const sentence = match[0].trim();
    if (sentence) rows.push(sentence);
  }
  return rows;
}

/** 段落切分：越界粗筛按「同段共现」，不按句。 */
function splitParagraphs(text) {
  return normalizeText(text)
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean);
}

/** 角色名与别名的 bigram：事实关键词里属于人名的 bigram 会被剔除，避免只凭人名就产生候选。 */
function nameBigrams(characters) {
  const set = new Set();
  for (const character of characters) {
    for (const variant of characterVariants(character)) {
      if (!variant) continue;
      set.add(variant);
      const chars = Array.from(variant);
      for (let i = 0; i + 1 < chars.length; i++) set.add(chars[i] + chars[i + 1]);
    }
  }
  return set;
}

/**
 * 事实的可命中词：显式 keywords 优先；否则按标点切段，再取 2-gram。
 * 纯函数、顺序固定，保证候选层可重复。
 */
function factTerms(fact, excluded = new Set()) {
  const explicit = normalizeText(fact.keywords)
    .split(/[,，、;；|]/)
    .map((word) => word.replace(/\s+/g, ''))
    .filter((word) => Array.from(word).length >= 2);
  if (explicit.length) return explicit.slice(0, 12);

  const content = normalizeText(fact.content).replace(/\s+/g, '');
  const parts = content
    .split(/[，。、；：！？,.;:!?\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const terms = [];
  const push = (term) => {
    if (Array.from(term).length < 2) return;
    if (excluded.has(term)) return;
    if (!terms.includes(term)) terms.push(term);
  };

  for (const part of parts) {
    if (Array.from(part).length <= 12) push(part);
    const chars = Array.from(part);
    for (let i = 0; i + 1 < chars.length; i++) push(chars[i] + chars[i + 1]);
  }
  return terms.slice(0, 16);
}

/**
 * 规则层候选：同一句里出现「角色名/别名 + 事实关键词」。
 *
 * 只做定位，不判状态；证据句取首次命中的原句前 40 字（仍是正文逐字子串）。
 *
 * @param {Object} params
 * @param {Array} params.characters
 * @param {Array} params.facts
 * @param {string} params.text
 * @returns {Array<{id, character, fact, evidence}>}
 */
function collectCandidates({ characters, facts, text }) {
  const sentences = splitSentences(normalizeText(text));
  const excluded = nameBigrams(characters);
  const rows = [];

  for (const character of characters) {
    const variants = characterVariants(character).filter(Boolean);
    for (const fact of facts) {
      const terms = factTerms(fact, excluded);
      if (!terms.length) continue;
      const sentence = sentences.find(
        (line) => variants.some((name) => line.includes(name)) && terms.some((term) => line.includes(term))
      );
      if (!sentence) continue;
      rows.push({
        id: `C${rows.length + 1}`,
        character,
        fact,
        evidence: Array.from(sentence).slice(0, EVIDENCE_LIMIT).join(''),
      });
      if (rows.length >= MAX_CANDIDATES) return rows;
    }
  }
  return rows;
}

/**
 * 文本越界粗筛：角色在正文里说出/写出他尚未 knows 的事实内容。
 *
 * 判定用「同段共现」：同一段落里同时出现角色名、事实关键词与言说动作/引号，
 * 就把这一对记成 possible_leak。不要求角色名与事实词在同一句——
 * 中文常把说话人写在引号后面（「……。」司马懿说），按句会漏掉这种写法。
 *
 * 命中只进 pending，不直接判违规；粗筛的误报由作者在待确认列表里消掉。
 *
 * @param {Object} params
 * @param {Array} params.characters
 * @param {Array} params.facts
 * @param {Map} params.states knowledgeAt 归并后的状态
 * @param {string} params.text
 * @returns {Array}
 */
function detectPossibleLeaks({ characters, facts, states, text }) {
  const paragraphs = splitParagraphs(normalizeText(text));
  const excluded = nameBigrams(characters);
  const leaks = [];
  const seen = new Set();

  for (const paragraph of paragraphs) {
    if (!SPEECH_RE.test(paragraph)) continue;
    const sentences = splitSentences(paragraph);

    for (const character of characters) {
      const variants = characterVariants(character).filter(Boolean);
      if (!variants.some((name) => paragraph.includes(name))) continue;

      for (const fact of facts) {
        // 背景事实（年龄/籍贯/寄养原因）本来就要说出口，不算越界。
        if (normalizeText(fact.fact_type) === 'background') continue;
        const terms = factTerms(fact, excluded);
        if (!terms.some((term) => paragraph.includes(term))) continue;

        const current = stateFor(states, character.id, fact.id);
        if ((STATE_RANK[current] ?? 0) >= STATE_RANK.knows) continue;

        const key = `${character.id}\u0000${fact.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // 证据句优先取「角色名 + 事实词」同句的那一句；没有就取命中事实词的句子。
        const evidenceSentence =
          sentences.find(
            (line) =>
              variants.some((name) => line.includes(name)) &&
              terms.some((term) => line.includes(term))
          ) || sentences.find((line) => terms.some((term) => line.includes(term))) || paragraph;

        leaks.push({
          characterId: character.id,
          characterName: character.name,
          factId: fact.id,
          fromState: current,
          toState: nextState(current),
          evidence: Array.from(evidenceSentence).slice(0, EVIDENCE_LIMIT).join(''),
          reason: 'possible_leak',
        });
        if (leaks.length >= MAX_LEAKS) return leaks;
      }
    }
  }
  return leaks;
}

function buildStateList(characters, facts, labels, states) {
  const lines = [];
  for (const character of characters) {
    const entries = [];
    for (const fact of facts) {
      const state = states.get(character.id)?.get(fact.id);
      if (state) entries.push(`${labels.get(fact.id)} ${state}`);
    }
    if (entries.length) lines.push(`${character.name}：${entries.join('、')}`);
  }
  return lines.length ? lines.join('\n') : '（无）';
}

function buildCandidateList(candidates, labels) {
  return candidates
    .map(
      (candidate) =>
        `${candidate.id}｜角色：${candidate.character.name}｜事实：${labels.get(candidate.fact.id)} ${shortContent(candidate.fact.content, 50)}｜原句：${candidate.evidence}`
    )
    .join('\n');
}

async function callWithTimeout(provider, messages, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([
      provider
        .chat({
          messages,
          temperature: SCAN_TEMPERATURE,
          maxTokens: SCAN_MAX_TOKENS,
          jsonOutput: true,
          thinking: 'disabled',
          signal:
            typeof AbortSignal !== 'undefined' && AbortSignal.timeout
              ? AbortSignal.timeout(timeoutMs)
              : undefined,
        })
        .catch((err) => ({ __error: err })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scanFailed(workId, chapterId, chapterSeq, reason) {
  console.error(
    JSON.stringify({
      event: 'knowledge_scan_failed',
      workId,
      chapterId,
      chapterSeq,
      reason,
    })
  );
  return {
    applied: [],
    pending: [],
    failed: true,
    skippedModel: false,
    knowledgePendingCount: 0,
  };
}

/**
 * 高置信状态：即使校验全过也不自动写，必须作者确认。
 *
 * 错判成「已知/公开」的代价不对称——悬念被抹掉、后文对不上；
 * 漏判只是少收紧，下一章还能补。
 */
const CONFIRM_REQUIRED_STATES = new Set(['knows', 'exposed']);

function sortRows(rows) {
  return rows.sort((a, b) =>
    `${a.characterName || ''}|${a.factLabel || ''}|${a.fromState || ''}|${a.toState || ''}|${a.evidence || ''}|${a.reason || ''}`
      .localeCompare(`${b.characterName || ''}|${b.factLabel || ''}|${b.fromState || ''}|${b.toState || ''}|${b.evidence || ''}|${b.reason || ''}`)
  );
}

/**
 * 扫描一章正文中的知情变化。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} params.chapterId
 * @param {number} [params.chapterSeq] 不传则从章节行读取
 * @param {string} params.text 正文
 * @param {Object} [params.provider] 仅供测试注入
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{applied: Array, pending: Array, failed: boolean, skippedModel: boolean}>}
 */
async function scanKnowledge(params = {}) {
  const { workId, chapterId, chapterSeq, text, provider, timeoutMs = SCAN_TIMEOUT_MS } = params;

  if (!workId || !chapterId) throw new ScanInputError('缺少 workId 或 chapterId');
  const body = normalizeText(text);
  if (!body) throw new ScanInputError('缺少要扫描的正文');

  const chapter = await get(
    'SELECT * FROM chapters WHERE id = ? AND work_id = ?',
    [chapterId, workId]
  );
  if (!chapter) throw new ScanInputError('章节不存在', 404);

  // 第 N 章写完后才生效：扫描请求的 chapterSeq 必须就是这一章，
  // 否则会把变化写到别的章，后面的边界全错。
  if (chapterSeq != null && Number(chapterSeq) !== Number(chapter.seq)) {
    throw new ScanInputError(
      `chapterSeq 与章节不一致：请求 ${chapterSeq}，章节是 ${chapter.seq}`
    );
  }
  const seq = Number(chapter.seq);

  const characters = await all(
    'SELECT * FROM characters WHERE work_id = ? ORDER BY name',
    [workId]
  );
  const facts = await all(
    'SELECT * FROM story_facts WHERE work_id = ? ORDER BY created_at ASC, id ASC',
    [workId]
  );
  if (!characters.length || !facts.length) {
    return { applied: [], pending: [], failed: false, skippedModel: true, knowledgePendingCount: 0 };
  }

  // 与注入块同一套编号：按创建顺序 F1…Fn，模型看到的是编号，落库时再换回 id。
  const labels = new Map(facts.map((fact, index) => [fact.id, `F${index + 1}`]));
  const factByLabel = new Map();
  for (const fact of facts) factByLabel.set(labels.get(fact.id), fact);

  const visible = await knowledgeAt(workId, seq);
  const states = new Map();
  for (const row of visible) {
    if (!states.has(row.character_id)) states.set(row.character_id, new Map());
    states.get(row.character_id).set(row.fact_id, row.state);
  }

  // ---- 规则层：候选与越界先算出来，零成本、顺序固定 ----
  const candidates = collectCandidates({ characters, facts, text: body });
  const leaks = detectPossibleLeaks({ characters, facts, states, text: body });

  const applied = [];
  const pending = [];
  const appliedKeys = new Set();
  const pendingKeys = new Set();
  const statements = [];
  const now = new Date().toISOString();

  const pendingKey = (row) =>
    [row.characterId, row.factId, row.fromState, row.toState, row.evidence, row.reason].join('\u0000');

  /** 进 pending：库里同键已有 pending 时不再重复插入，但结果里仍保留一条。 */
  const pushPending = async (row) => {
    pending.push(row);
    const key = pendingKey(row);
    if (pendingKeys.has(key)) return;
    pendingKeys.add(key);
    const exists = await get(
      `SELECT id FROM knowledge_pending
       WHERE work_id = ? AND chapter_id = ? AND character_id = ? AND fact_id = ?
         AND from_state = ? AND to_state = ? AND evidence = ? AND reason = ?
         AND status = 'pending'`,
      [workId, chapterId, row.characterId, row.factId, row.fromState, row.toState, row.evidence, row.reason]
    );
    if (exists) return;
    statements.push({
      sql: `INSERT INTO knowledge_pending
              (id, work_id, chapter_id, chapter_seq, character_id, character_name,
               fact_id, fact_label, from_state, to_state, evidence, reason,
               status, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      params: [
        crypto.randomUUID(),
        workId,
        chapterId,
        seq,
        row.characterId,
        row.characterName,
        row.factId,
        row.factLabel,
        row.fromState,
        row.toState,
        row.evidence,
        row.reason,
        now,
        now,
      ],
    });
  };

  // 越界命中先入队（规则层产物，不依赖模型）。
  for (const leak of leaks) {
    await pushPending({
      characterName: leak.characterName,
      characterId: leak.characterId,
      factLabel: labels.get(leak.factId),
      factId: leak.factId,
      fromState: leak.fromState,
      toState: leak.toState,
      evidence: leak.evidence,
      reason: 'possible_leak',
    });
  }

  if (candidates.length) {
    let active = provider;
    if (!active) {
      try {
        active = resolveProvider(aiConfig.getConfig()).provider;
      } catch (e) {
        return scanFailed(workId, chapterId, seq, '没有可用的 AI provider');
      }
    }

    const stateList = buildStateList(characters, facts, labels, states);
    const messages = [
      {
        role: 'system',
        content: SCAN_PROMPT.replace('{candidateList}', buildCandidateList(candidates, labels)).replace(
          '{stateList}',
          stateList
        ),
      },
      {
        role: 'user',
        content: `候选清单共 ${candidates.length} 条。只输出候选编号对应的状态迁移；没有明确变化就返回空数组。`,
      },
    ];

    const result = await callWithTimeout(active, messages, timeoutMs);
    if (!result || result.__timedOut || result.__error) {
      return scanFailed(
        workId,
        chapterId,
        seq,
        result && result.__timedOut ? '扫描超时' : '模型调用失败'
      );
    }

    const parsed = parseModelJson(result.content || '');
    if (!parsed || !Array.isArray(parsed.transitions)) {
      return scanFailed(workId, chapterId, seq, '模型输出不是合法的 transitions 数组');
    }

    for (const raw of parsed.transitions.slice(0, MAX_CANDIDATES)) {
      if (!raw || typeof raw !== 'object') continue;

      // 新契约按候选编号；保留旧的 character/factId 写法给既有调用方。
      let candidate = null;
      const candidateId = normalizeText(raw.candidate).toUpperCase();
      if (candidateId) {
        candidate = candidates.find((item) => item.id === candidateId) || null;
      } else {
        const character = findCharacter(characters, normalizeText(raw.character));
        const factLabelInput = normalizeText(raw.factId);
        const fact = facts.find((item) => item.id === factLabelInput) || factByLabel.get(factLabelInput);
        if (character && fact) {
          candidate = candidates.find(
            (item) => item.character.id === character.id && item.fact.id === fact.id
          ) || null;
        }
      }
      if (!candidate) continue;

      const character = candidate.character;
      const fact = candidate.fact;
      const toState = normalizeText(raw.toState);
      const evidence = normalizeText(raw.evidence) || candidate.evidence;
      const fromState = stateFor(states, character.id, fact.id);

      const base = {
        characterName: character.name,
        characterId: character.id,
        factLabel: labels.get(fact.id),
        factId: fact.id,
        fromState,
        toState,
        evidence,
      };
      const reject = async (reason) => {
        await pushPending({ ...base, reason });
      };

      if (!STATES.has(toState)) {
        await reject(`toState 不合法：${toState || '空'}`);
        continue;
      }
      if (!evidence || !body.includes(evidence)) {
        await reject('证据句不在正文中');
        continue;
      }

      const fromRank = STATE_RANK[fromState] ?? 0;
      const toRank = STATE_RANK[toState];
      if (toRank <= fromRank) {
        await reject('不是升级');
        continue;
      }
      if (toRank - fromRank > 1) {
        await reject('跳级');
        continue;
      }
      // 校验都过了，但「已知/公开」是高置信状态：不自动生效。
      if (CONFIRM_REQUIRED_STATES.has(toState)) {
        await reject(`需作者确认：${toState} 不能自动生效`);
        continue;
      }

      const key = `${character.id}\u0000${fact.id}`;
      if (appliedKeys.has(key)) {
        await reject('同一角色/事实在本章重复');
        continue;
      }

      const exists = await get(
        `SELECT state, note FROM knowledge_matrix
         WHERE character_id = ? AND fact_id = ? AND chapter_seq = ?`,
        [character.id, fact.id, seq]
      );
      if (exists) {
        // 同章同状态同证据 = 上一次扫描已经应用过，按已应用返回，不重复写。
        if (exists.state === toState && normalizeText(exists.note) === evidence) {
          appliedKeys.add(key);
          applied.push(base);
          continue;
        }
        await reject('本章已有该事实的知情记录');
        continue;
      }

      appliedKeys.add(key);
      applied.push(base);
      statements.push({
        sql: `INSERT INTO knowledge_matrix
                (id, work_id, character_id, fact_id, chapter_seq, state,
                 evidence_id, source_chapter_id, note, created_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        params: [
          crypto.randomUUID(),
          workId,
          character.id,
          fact.id,
          seq,
          toState,
          chapterId,
          evidence,
          now,
        ],
      });
    }
  }

  if (statements.length) await transaction(statements);

  sortRows(applied);
  sortRows(pending);

  // pending 在没有 UI 之前不能静默堆积：留一条可检索的日志，
  // 同时在响应里回 knowledgePendingCount，前端/脚本都能看到。
  if (pending.length) {
    console.error(
      JSON.stringify({
        event: 'knowledge_scan_pending',
        workId,
        chapterId,
        chapterSeq: seq,
        // 字段名与接口响应保持一致，日志和前端可以用同一个键检索。
        knowledgePendingCount: pending.length,
        appliedCount: applied.length,
        possibleLeak: pending.filter((row) => row.reason === 'possible_leak').length,
      })
    );
  }
  return {
    applied,
    pending,
    failed: false,
    skippedModel: candidates.length === 0,
    knowledgePendingCount: pending.length,
  };
}

module.exports = {
  STATES,
  STATE_RANK,
  SCAN_TIMEOUT_MS,
  ScanInputError,
  collectCandidates,
  detectPossibleLeaks,
  factTerms,
  splitSentences,
  scanKnowledge,
};
