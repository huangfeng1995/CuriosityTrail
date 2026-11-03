'use strict';

/**
 * 知情扫描（HP7 / P.6.5）。
 *
 * 正文写完后，让模型只做一件事：从正文里抽出「谁在这一章知道了什么」。
 * 抽出来的是**候选变化**，不是真相；四条校验任何一条不过，都先进
 * knowledge_pending，等作者确认，绝不直接改 knowledge_matrix。
 *
 * 四条校验：
 *   1. 实体存在：角色名/别名能在本章作品里找到，factId 能对到 story_facts；
 *   2. evidence 必须逐字出现在正文里（不靠语义相似，避免模型自证）；
 *   3. toState 合法且为升级；一次只能升一级，跳级进 pending；
 *   4. chapterSeq 与本章一致（「第 N 章写完后生效」）。
 *
 * 失败降级：模型调用/解析失败时零写入，记 knowledge_scan_failed，
 * 下一章继续读旧边界——方向一定是保守，不是激进。
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
const SCAN_TEMPERATURE = 0.2;

const SCAN_PROMPT = `你是历史悬疑的知情变化抽取器。只输出一个 JSON 对象：
{"transitions":[{"character":"角色名","factId":"F1","toState":"suspects|partial|knows|exposed","evidence":"正文原句"}]}

规则：
- 只抽正文里**明确发生**的信息变化；没有就返回 {"transitions":[]}。
- evidence 必须是正文里逐字出现的原句，不超过 40 字；改一个字都不行。
- toState 只能比当前状态高一级：未知→怀疑→半知→已知→公开。
- 跳级、降级、猜测、推断一律不要输出。
- factId 只能使用下方事实清单里的编号；character 只能使用角色清单里的名字。

事实清单：
{factList}

角色清单：
{characterList}

当前知情状态（只列非「未知」；未列出即未知）：
{stateList}`;

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
  return (
    characters.find((c) => characterVariants(c).includes(target)) || null
  );
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
  return { applied: [], pending: [], failed: true };
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
 * @returns {Promise<{applied: Array, pending: Array, failed: boolean}>}
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
    return { applied: [], pending: [], failed: false };
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

  let active = provider;
  if (!active) {
    try {
      active = resolveProvider(aiConfig.getConfig()).provider;
    } catch (e) {
      return scanFailed(workId, chapterId, seq, '没有可用的 AI provider');
    }
  }

  const factList = facts
    .map((fact) => `${labels.get(fact.id)}：${shortContent(fact.content)}`)
    .join('\n');
  const characterList = characters.map((c) => c.name).join('、');
  const stateList = buildStateList(characters, facts, labels, states);
  const messages = [
    {
      role: 'system',
      content: SCAN_PROMPT.replace('{factList}', factList)
        .replace('{characterList}', characterList)
        .replace('{stateList}', stateList),
    },
    { role: 'user', content: body },
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

  const applied = [];
  const pending = [];
  const appliedKeys = new Set();
  const statements = [];
  const now = new Date().toISOString();

  for (const raw of parsed.transitions.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue;

    const characterName = normalizeText(raw.character);
    const character = findCharacter(characters, characterName);
    const factLabelInput = normalizeText(raw.factId);
    const fact = facts.find((item) => item.id === factLabelInput) || factByLabel.get(factLabelInput);
    const toState = normalizeText(raw.toState);
    const evidence = normalizeText(raw.evidence);
    const fromState = character && fact
      ? states.get(character.id)?.get(fact.id) || 'unknown'
      : 'unknown';

    const base = {
      characterName,
      characterId: character ? character.id : null,
      factLabel: fact ? labels.get(fact.id) : factLabelInput,
      factId: fact ? fact.id : null,
      fromState,
      toState,
      evidence,
    };

    const reject = (reason) => {
      pending.push({ ...base, reason });
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
          base.characterId,
          characterName,
          base.factId,
          base.factLabel,
          fromState,
          toState,
          evidence,
          reason,
          now,
          now,
        ],
      });
    };

    if (!character) {
      reject('角色不存在');
      continue;
    }
    if (!fact) {
      reject('事实不存在');
      continue;
    }
    if (!STATES.has(toState)) {
      reject(`toState 不合法：${toState || '空'}`);
      continue;
    }
    if (!evidence || !body.includes(evidence)) {
      reject('证据句不在正文中');
      continue;
    }

    const fromRank = STATE_RANK[fromState] ?? 0;
    const toRank = STATE_RANK[toState];
    if (toRank <= fromRank) {
      reject('不是升级');
      continue;
    }
    if (toRank - fromRank > 1) {
      reject('跳级');
      continue;
    }

    const key = `${character.id}\u0000${fact.id}`;
    if (appliedKeys.has(key)) {
      reject('同一角色/事实在本章重复');
      continue;
    }

    const exists = await get(
      `SELECT state FROM knowledge_matrix
       WHERE character_id = ? AND fact_id = ? AND chapter_seq = ?`,
      [character.id, fact.id, seq]
    );
    if (exists) {
      reject('本章已有该事实的知情记录');
      continue;
    }

    appliedKeys.add(key);
    applied.push({
      characterId: character.id,
      character: character.name,
      factId: fact.id,
      factLabel: labels.get(fact.id),
      fromState,
      toState,
      evidence,
    });
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

  if (statements.length) await transaction(statements);
  return { applied, pending, failed: false };
}

module.exports = {
  STATES,
  STATE_RANK,
  SCAN_TIMEOUT_MS,
  ScanInputError,
  scanKnowledge,
};
