'use strict';

/**
 * 设定压力测试（HP9 / P.7）。
 *
 * 产物是**风险清单**，不是剧情方案：模型只许指出「哪条设定在第几章会穿帮、
 * 为什么、怎么补」，绝不改设定、也不写正文。
 *
 * 闸门与 P.7.2 一致：
 *   - 四类（制度 / 证据 / 时间 / 人）每类至少一条才算齐全；
 *   - earliest_break_chapter 必须是 1..章节总数+5 的整数，写成「第十章左右」的整条作废；
 *   - detail 必须写出具体机制，不合格条目直接丢弃，不返回半成品。
 *
 * 调用预算：1 次、jsonOutput、maxTokens 2000、temperature 0.4、超时 60s。
 * 失败一律返回空清单 + notice，不阻塞任何写作。
 */

const crypto = require('crypto');
const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');
const { parseModelJson } = require('../agent/parse');
const { all, get, run, transaction } = require('../../database');

const CATEGORIES = ['institution', 'evidence', 'time', 'human'];
const CATEGORY_LABELS = Object.freeze({
  institution: '制度',
  evidence: '证据',
  time: '时间',
  human: '人',
});

const SEVERITIES = new Set(['block', 'warn']);
const MAX_RISKS = 12;
const TEST_TIMEOUT_MS = 60000;
const TEST_MAX_TOKENS = 2000;
const TEST_TEMPERATURE = 0.4;

/** 输入裁剪：压力测试只需要核对，不需要把整本书塞进去。 */
const MAX_SETTINGS = 30;
const MAX_CHARACTERS = 20;
const MAX_ANCHORS = 20;
const MAX_CHAPTERS = 40;
const MAX_FIELD_CHARS = 400;
const MAX_INPUT_CHARS = 14000;

/** 具体机制的判定线索：没有这些词的短句多半是「可能有制度问题」式空话。 */
const MECHANISM_RE =
  /因为|导致|一旦|就会|必须|需要|只有|才能|否则|使得|矛盾|冲突|无法|不能|不可能|越界|穿帮|暴露|发现|知道|时间|地点|制度|证据|年龄|距离|身份|官职|流程|顺序/;
const VAGUE_ONLY_RE =
  /^(可能有|可能存在|或许有|大概有|好像有|可能有些)(一些|些)?(制度|设定|逻辑|时间|人物|细节)?(上的)?问题[。.]?$|^(不太合理|需要注意|存在漏洞|可能有漏洞)[。.]?$/;

const TEST_PROMPT = `你是历史悬疑小说的设定审稿人。任务不是想剧情，而是穷举「这套设定会在哪里穿帮」。
只输出一个 JSON 对象，不要解释、不要 markdown：
{"risks":[{"category":"institution|evidence|time|human","title":"一句话点明风险","detail":"具体机制：哪条设定、在什么条件下、和什么冲突或为什么不可能成立","earliest_break_chapter":3,"fix":["修补方案1","修补方案2"],"severity":"warn|block","anchor_id":"可选，只能引用输入里给出的锚点 id"}]}

硬规则：
1. 四个分类每类至少 1 条，总数不超过 12 条：
   institution=制度/官职/流程，evidence=物证/人证/知情链，time=时间线/年龄/路程，human=人物动机/立场/能力。
2. earliest_break_chapter 必须是整数，范围 1 到「章节总数+5」。写「第十章左右/大概三章后」的条目会被整条丢弃。
3. detail 必须写出具体机制，不能写「可能有制度问题」「不太合理」这类空话；
   要指名涉及哪条设定、哪个人/物、在哪一章前后会撞上什么。
4. fix 给 1–3 条可执行的修补方向，不替作者定稿。
5. 只依据输入资料，不要新增设定、人物或史料；输入里没写的东西不要当成事实。
6. 只提案，不改设定。`;

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(value, limit = MAX_FIELD_CHARS) {
  const text = normalizeText(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** detail 是否写出了具体机制。 */
function looksConcrete(detail) {
  const value = normalizeText(detail);
  if (value.length < 24) return false;
  if (VAGUE_ONLY_RE.test(value)) return false;
  return MECHANISM_RE.test(value);
}

function normalizeFixes(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? [value]
      : [];
  return raw
    .map((item) => clip(item, 160))
    .filter(Boolean)
    .slice(0, 3);
}

/**
 * 校验并归一化一条风险。
 *
 * @param {*} raw 模型给的条目
 * @param {{chapterCount: number, anchorIds: Set<string>}} context
 * @returns {Object|null} 不合格返回 null（整条丢弃）
 */
function normalizeRisk(raw, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const category = normalizeText(raw.category).toLowerCase();
  if (!CATEGORIES.includes(category)) return null;

  const title = clip(raw.title, 80);
  const detail = clip(raw.detail, 600);
  if (!title || !detail || !looksConcrete(detail)) return null;

  const earliest = Number(raw.earliest_break_chapter);
  const maxChapter = Number(context.chapterCount || 0) + 5;
  if (!Number.isInteger(earliest) || earliest < 1 || earliest > maxChapter) return null;

  const fixes = normalizeFixes(raw.fix);
  if (!fixes.length) return null;

  const anchorId = normalizeText(raw.anchor_id);
  const severity = SEVERITIES.has(normalizeText(raw.severity)) ? normalizeText(raw.severity) : 'warn';

  return {
    category,
    title,
    detail,
    earliestBreakChapter: earliest,
    fixes,
    fix: fixes.join('；'),
    severity,
    anchorId: context.anchorIds.has(anchorId) ? anchorId : '',
  };
}

/** 把一张风险行转成接口形状。 */
function toRisk(row) {
  if (!row) return null;
  const fixes = String(row.fix || '')
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    id: row.id,
    workId: row.work_id,
    category: row.category,
    categoryLabel: CATEGORY_LABELS[row.category] || row.category,
    title: row.title,
    detail: row.detail,
    earliestBreakChapter: row.earliest_break_chapter,
    fixes,
    fix: row.fix || '',
    severity: row.severity,
    anchorId: row.anchor_id || '',
    status: row.status,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}

/**
 * 读取压力测试的输入快照。
 *
 * 输入口径按 P.7.1：作品梗概/大纲 + 核心设定 + active 锚点 + 人物卡 + 章节大纲。
 * 全部只读，不写任何表。
 */
async function loadInput(workId) {
  const work = await get(
    'SELECT id, title, synopsis, outline FROM works WHERE id = ?',
    [workId]
  );
  if (!work) return null;

  const [settings, characters, anchors, chapters] = await Promise.all([
    all(
      `SELECT id, name, category, content, importance FROM settings
       WHERE work_id = ? ORDER BY importance DESC, created_at ASC LIMIT ${MAX_SETTINGS}`,
      [workId]
    ),
    all(
      `SELECT id, name, role, identity, goal, weakness, bottom_line, stance
       FROM characters WHERE work_id = ? ORDER BY created_at ASC LIMIT ${MAX_CHARACTERS}`,
      [workId]
    ),
    all(
      `SELECT id, kind, subject, claim, confidence, source_title
       FROM work_anchors
       WHERE work_id = ? AND status = 'active'
       ORDER BY created_at ASC LIMIT ${MAX_ANCHORS}`,
      [workId]
    ),
    all(
      `SELECT id, title, seq, outline FROM chapters
       WHERE work_id = ? ORDER BY seq ASC LIMIT ${MAX_CHAPTERS}`,
      [workId]
    ),
  ]);

  const hasContent = Boolean(
    normalizeText(work.synopsis) ||
      normalizeText(work.outline) ||
      settings.length ||
      characters.length ||
      anchors.length ||
      chapters.some((row) => normalizeText(row.outline))
  );

  return { work, settings, characters, anchors, chapters, hasContent };
}

function buildInputBlock(input) {
  const lines = ['## 作品'];
  lines.push(`标题：${normalizeText(input.work.title) || '（未命名）'}`);
  if (normalizeText(input.work.synopsis)) lines.push(`梗概：${clip(input.work.synopsis, 1200)}`);
  if (normalizeText(input.work.outline)) lines.push(`作品大纲：${clip(input.work.outline, 2000)}`);

  if (input.settings.length) {
    lines.push('', '## 核心设定（作者登记的设定卡）');
    for (const row of input.settings) {
      lines.push(`- [${row.category || '其他'}] ${row.name}：${clip(row.content)}`);
    }
  }

  if (input.characters.length) {
    lines.push('', '## 人物卡');
    for (const row of input.characters) {
      const parts = [row.role, row.identity, row.goal, row.stance, row.bottom_line, row.weakness]
        .map((item) => normalizeText(item))
        .filter(Boolean);
      lines.push(`- ${row.name}${parts.length ? `：${clip(parts.join(' / '))}` : ''}`);
    }
  }

  if (input.anchors.length) {
    lines.push('', '## 已启用锚点（不可违背的史实；引用时用 id）');
    for (const row of input.anchors) {
      const source = normalizeText(row.source_title) ? `（出处：${row.source_title}）` : '';
      lines.push(`- [id=${row.id}] ${row.subject}：${clip(row.claim)}${source}`);
    }
  }

  if (input.chapters.length) {
    lines.push('', '## 章节大纲');
    lines.push(`章节总数：${input.chapters.length}；最早穿帮章范围 1–${input.chapters.length + 5}。`);
    for (const row of input.chapters) {
      const outline = normalizeText(row.outline);
      lines.push(`- 第 ${row.seq} 章《${row.title}》${outline ? `：${clip(outline)}` : '：（无大纲）'}`);
    }
  }

  const text = lines.join('\n');
  return text.length <= MAX_INPUT_CHARS ? text : `${text.slice(0, MAX_INPUT_CHARS)}…`;
}

function callWithTimeout(provider, messages, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });
  return Promise.race([
    provider
      .chat({
        messages,
        temperature: TEST_TEMPERATURE,
        maxTokens: TEST_MAX_TOKENS,
        jsonOutput: true,
        thinking: 'disabled',
        signal:
          typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
      })
      .catch((err) => ({ __error: err })),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 替换本轮 open 风险：已采纳/已忽略的保留，重新测试只刷新待处理清单。 */
async function saveRisks(workId, risks) {
  const ts = new Date().toISOString();
  const rows = risks.map((risk) => ({ ...risk, id: crypto.randomUUID(), ts }));
  const statements = [
    {
      sql: "DELETE FROM setting_risks WHERE work_id = ? AND status = 'open'",
      params: [workId],
    },
    ...rows.map((row) => ({
      sql: `INSERT INTO setting_risks
              (id, work_id, category, title, detail, earliest_break_chapter,
               fix, severity, anchor_id, status, created_at, modified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      params: [
        row.id,
        workId,
        row.category,
        row.title,
        row.detail,
        row.earliestBreakChapter,
        row.fix,
        row.severity,
        row.anchorId || null,
        row.ts,
        row.ts,
      ],
    })),
  ];
  await transaction(statements);

  const saved = await all(
    `SELECT * FROM setting_risks
     WHERE id IN (${rows.map(() => '?').join(',')})`,
    rows.map((row) => row.id)
  );
  const byId = new Map(saved.map((row) => [row.id, row]));
  return rows.map((row) => toRisk(byId.get(row.id))).filter(Boolean);
}

/**
 * 运行一次设定压力测试并落库。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {Object} [params.provider] 仅供测试注入
 * @param {number} [params.timeoutMs]
 * @returns {Promise<{risks: Array, notice: string, missingCategories: string[],
 *                    chapterCount: number, failed: boolean}>}
 */
async function runPressureTest({ workId, provider, timeoutMs = TEST_TIMEOUT_MS } = {}) {
  const empty = (notice, extra = {}) => ({
    risks: [],
    notice,
    missingCategories: [],
    chapterCount: 0,
    failed: true,
    ...extra,
  });

  let input;
  try {
    input = await loadInput(workId);
  } catch (err) {
    console.error('[pressureTest] 读取输入失败:', err.message);
    return empty('读取作品设定失败，本次没有生成风险清单');
  }
  if (!input) return empty('作品不存在');
  if (!input.hasContent) return empty('这部作品还没有可测试的设定、人物或大纲');

  let active = provider;
  if (!active) {
    try {
      active = resolveProvider(aiConfig.getConfig()).provider;
    } catch (e) {
      return empty('没有可用的 AI provider', { chapterCount: input.chapters.length });
    }
  }

  const messages = [
    { role: 'system', content: TEST_PROMPT },
    { role: 'user', content: buildInputBlock(input) },
  ];

  let result;
  try {
    result = await callWithTimeout(active, messages, timeoutMs);
  } catch (err) {
    return empty('模型调用失败', { chapterCount: input.chapters.length });
  }
  if (!result || result.__timedOut) {
    return empty('压力测试超时', { chapterCount: input.chapters.length });
  }
  if (result.__error) {
    console.error('[pressureTest] 模型调用失败:', result.__error.message);
    return empty('模型调用失败', { chapterCount: input.chapters.length });
  }

  const parsed = parseModelJson(result.content || '');
  const rawRisks = Array.isArray(parsed)
    ? parsed
    : parsed && Array.isArray(parsed.risks)
      ? parsed.risks
      : [];

  const anchorIds = new Set(input.anchors.map((row) => row.id));
  const context = { chapterCount: input.chapters.length, anchorIds };
  const risks = rawRisks
    .slice(0, MAX_RISKS * 3)
    .map((raw) => normalizeRisk(raw, context))
    .filter(Boolean)
    .slice(0, MAX_RISKS);

  const missingCategories = CATEGORIES.filter(
    (category) => !risks.some((risk) => risk.category === category)
  );

  if (!risks.length) {
    return {
      risks: [],
      notice: '模型没有给出可用的风险条目（章序必须是整数、detail 必须写出具体机制）',
      missingCategories: CATEGORIES.slice(),
      chapterCount: input.chapters.length,
      failed: true,
    };
  }

  let saved;
  try {
    saved = await saveRisks(workId, risks);
  } catch (err) {
    console.error('[pressureTest] 风险清单落库失败:', err.message);
    return empty('风险清单落库失败', { chapterCount: input.chapters.length });
  }

  return {
    risks: saved,
    notice: missingCategories.length
      ? `以下分类没有有效条目：${missingCategories.map((c) => CATEGORY_LABELS[c]).join('、')}`
      : '',
    missingCategories,
    chapterCount: input.chapters.length,
    failed: false,
  };
}

/** 风险清单（默认只列 open）。 */
async function listRisks(workId, status = 'open') {
  const rows =
    status === 'all'
      ? await all(
          'SELECT * FROM setting_risks WHERE work_id = ? ORDER BY created_at DESC, id DESC',
          [workId]
        )
      : await all(
          `SELECT * FROM setting_risks WHERE work_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC`,
          [workId, status]
        );
  return rows.map(toRisk);
}

const CATEGORY_TO_SETTING = Object.freeze({
  institution: '制度',
  evidence: '证据',
  time: '时间',
  human: '人物',
});

/**
 * 采纳一条风险：写成设定卡或情节卡。
 *
 * 只在作者显式点「采纳」时调用；压力测试本身永远不会自动改设定。
 */
async function adoptRisk({ workId, riskId, target = 'setting' } = {}) {
  const row = await get(
    'SELECT * FROM setting_risks WHERE id = ? AND work_id = ?',
    [riskId, workId]
  );
  if (!row) return { error: 'not_found', status: 404 };
  if (row.status !== 'open') return { error: 'already_handled', status: 409 };

  const ts = new Date().toISOString();
  const cardId = crypto.randomUUID();
  const content = row.fix ? `${row.detail}\n\n修补方向：${row.fix}` : row.detail;

  if (target === 'plot') {
    const maxSeq = await get('SELECT MAX(seq) AS seq FROM plot_cards WHERE work_id = ?', [workId]);
    const seq = Number(maxSeq && maxSeq.seq ? maxSeq.seq : 0) + 1;
    await transaction([
      {
        sql: `INSERT INTO plot_cards
                (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
              VALUES (?, ?, NULL, ?, 'foreshadow', ?, ?, 'todo', ?, ?)`,
        params: [cardId, workId, row.title, content, seq, ts, ts],
      },
      {
        sql: "UPDATE setting_risks SET status = 'accepted', modified_at = ? WHERE id = ?",
        params: [ts, row.id],
      },
    ]);
  } else {
    await transaction([
      {
        sql: `INSERT INTO settings
                (id, work_id, category, name, content, importance, created_at, modified_at)
              VALUES (?, ?, ?, ?, ?, 4, ?, ?)`,
        params: [
          cardId,
          workId,
          CATEGORY_TO_SETTING[row.category] || '规则',
          row.title,
          content,
          ts,
          ts,
        ],
      },
      {
        sql: "UPDATE setting_risks SET status = 'accepted', modified_at = ? WHERE id = ?",
        params: [ts, row.id],
      },
    ]);
  }

  const updated = await get('SELECT * FROM setting_risks WHERE id = ?', [row.id]);
  return { risk: toRisk(updated), cardId, target };
}

/** 忽略一条风险。 */
async function dismissRisk({ workId, riskId } = {}) {
  const row = await get(
    'SELECT id FROM setting_risks WHERE id = ? AND work_id = ?',
    [riskId, workId]
  );
  if (!row) return null;
  const ts = new Date().toISOString();
  await run(
    "UPDATE setting_risks SET status = 'dismissed', modified_at = ? WHERE id = ? AND status = 'open'",
    [ts, riskId]
  );
  return toRisk(await get('SELECT * FROM setting_risks WHERE id = ?', [riskId]));
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  MAX_RISKS,
  TEST_PROMPT,
  looksConcrete,
  normalizeRisk,
  toRisk,
  loadInput,
  runPressureTest,
  listRisks,
  adoptRisk,
  dismissRisk,
};
