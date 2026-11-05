'use strict';

/**
 * 分场 brief：把「这一章必须发生什么」提前到节拍规划之前。
 *
 * 现状的断点不在写手：提纲只写了「父亲来接他，全家告别」，
 * 规划器就排不出「交犀角弓」「司马防托付」这些拍，写手自然写不出。
 * 这一步只做一件事：把必须发生的动作列成可追溯的清单，供规划器硬覆盖，
 * 供写手当具体到物的约束。
 *
 * 纯逻辑 + 一次 provider 调用：不碰数据库、不认识 Express。
 */

const { parseModelJson } = require('./parse');

const KINDS = ['loss', 'mustPresent', 'mustWithhold', 'mustReveal', 'evidence', 'opponent'];

/**
 * 每类用自己的 id 前缀。不能用 kind 首字母：mustPresent / mustWithhold / mustReveal
 * 都会变成 M1，覆盖结果里出现三个 M1，作者根本分不清缺的是哪一类。
 */
const KIND_ID_PREFIX = {
  loss: 'L',
  mustPresent: 'MP',
  mustWithhold: 'MW',
  mustReveal: 'MR',
  evidence: 'E',
  opponent: 'OP',
};

/**
 * 对手必须是外部主体。命中这些词说明模型把「主角的内心状态」当成了对手，
 * 这种条目不能进 brief：规划器无法把「心软」排成一拍的外部阻碍。
 */
const INTERNAL_STATE_RE = /心软|犹豫|内心|挣扎|动摇|怯懦|恐惧|自责|纠结|矛盾|不忍|舍不得/;

/**
 * 告别/离场拍的识别词。
 *
 * 只认「拍目标/信息增量」里的离场语义：告别、门前、登车、出城这类可指认的
 * 场景动作，不按拍序硬编码「倒数第二拍」。
 */
const FAREWELL_RE = /告别|辞行|拜别|离别|离场|送行|送别|启程|出城|离开|上路|动身|登车|上车|门前|门口|门外|城门口|分别/;

/**
 * 「告别」语义优先于「启程」语义。
 *
 * 一章里常有两拍都带离场词：先「在门前告别」，再「随车出城」。
 * 托付发生在人还站在门前、话还说得出口的那一拍；推到「出城」就只剩钩子了。
 */
const STRONG_FAREWELL_RE = /告别|辞行|拜别|离别|送行|送别|门前|门口|门外|分别/;

/**
 * 真正离场的那一拍：启程、上车、离开。
 *
 * 门口那一拍常只是「进府/等示下」，人还站在阶下；交付要落在
 * 人已经往车边走、话说得出口的那一拍，否则写手会被指到错拍。
 */
const DEPARTURE_ACTION_RE = /告别|辞行|拜别|离别|离场|送行|送别|分别|启程|出城|离开|上路|动身|登车|上车/;

/**
 * 托付条目本身的交付语义：条目文字里必须写明「托付/交给/递/塞/赠/留下」这类动作。
 *
 * 「某人到场」「父亲接走主角」不带这些动作，即使模型标了 handover 也不认。
 */
const HANDOVER_ITEM_RE = /托付|嘱|交付|交给|递|塞|赠|留|收着|带上|拿着/;

/**
 * 节拍叙述里的交付语义：必须落成物（交、递、塞、赠、收着、带上）或话（引号/嘱托）。
 *
 * 只写「当场托付一句话或一件物」不算：那是声明意图，正文里没有可引用的话，
 * 也没有具体的物。同理，裸「留下」多半是主角把东西留在原处，不是托付人交付。
 */
function handoverDelivered(narrative) {
  if (/嘱|交|递|塞|赠|收着|带上|拿着|「|」|“|”/.test(narrative)) return true;
  return /(说|讲|道|开口)[^。；;]{0,8}(话|句)/.test(narrative);
}

/**
 * 托付拍的三条硬条件：托付人本人在场、当场交付话或物、交付对象在场。
 *
 * @param {Object} item handover 的 mustPresent 项
 * @param {string} narrative 某一拍的叙述字段
 * @param {Array<string>} terms 托付人关键词
 * @returns {Array<string>} 缺哪几条，空数组表示三条都满足
 */
function handoverMissingParts(item, narrative, terms) {
  const parts = [];
  const personHit = terms.some((term) => text(term).length >= 2 && narrative.includes(text(term)));
  if (!personHit) parts.push('托付人不在场');
  if (!handoverDelivered(narrative)) parts.push('没有可引用的托付话或物');
  const to = text(item.to);
  if (!to) {
    parts.push('交付对象未登记');
  } else if (!narrative.includes(to)) {
    parts.push(`交付对象${to}不在场`);
  }
  return parts;
}

/** 人物卡/设定里的托付关系词。 */
const HANDOVER_RELATION_RE = /寄养|托付|拜师|代养|养父|养母|义父|义母|收养|监护人|师父/;

/**
 * 交付对象的关系词：托付人把主角当面交给谁。
 *
 * 只认「父子/父女/生父/母亲」这类直系登记，不能拿「养父」反推——
 * 养父是托付人本人，不是接收方。
 */
const HANDOVER_TARGET_RELATION_RE = /父子|父女|母子|母女|生父|亲父|生母|亲母|父亲|母亲/;

/** 托付内容的语义：话（可引用的嘱咐）或物（可交付的器物）。 */
const HANDOVER_PROMISE_RE = /保[^。；;，,]{0,8}平安|照看|照应|看顾|平安|照顾好/;
const HANDOVER_OBJECT_RE = /赠|送给|交给|留给|塞给|递|带上|收着/;

/**
 * 硬约束类别：规划器必须把它们落到某一拍。
 * mustReveal 不在这里——它由首次出场章另行校验，不参与节拍硬覆盖。
 */
const HARD_KINDS = ['loss', 'mustPresent', 'mustWithhold'];

const MAX_ITEMS_PER_KIND = 6;
const MAX_KEYWORDS = 6;

const BRIEF_PROMPT = `你是章节分场 brief 规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
任务：根据本章大纲、作品大纲、人物卡、设定、素材与上一章结尾，回答「这一章必须发生哪些动作」。
输出格式：{"items":[{"kind":"loss|mustPresent|mustWithhold|mustReveal|evidence|opponent","text":"具体动作，写到物、写到人","keywords":["能在正文或节拍表里被逐字命中的词"],"source":"本章大纲|作品大纲|人物卡|设定|素材|上一章","inferred":false,"handover":false}],
"invariants":[{"key":"age|hometown|fosterStartAge|fosterYears|keyItemOwner","value":"正文里该怎么说，如十八岁/河内获嘉/十一年","numeric":18,"unit":"岁|年","keywords":["正文里能逐字命中的定位词"],"source":"人物卡|设定|素材|背景事实","inferred":false}]}
六类含义：
- loss：不可逆损失/交出物/说出口的话/做出的决定。必须具体到物，如「交出犀角弓」。
- mustPresent：关键人物必须到场，尤其长辈、托付人、见证人。写清是谁、来做什么。
  只有「把主角托付给他人、或养父/师父等长辈在告别时交付」的场景，才加 "handover":true，
  表示此人必须当场交付一句可引用的话或一件物；人物只是到场、只是接走主角，不要加。
- mustWithhold：本章必须隐瞒、不得解释的信息，防止人物把悬念解释掉。写清「不得解释什么」。
- mustReveal：必须交代的背景信息，如年龄、籍贯、寄养原因。每项要能一句话说清。
- evidence：物证或制度异常，如符传形制、逾制信号。
- opponent：本章对抗、牵制主角的具体外部主体，写成「谁/哪个势力 + 用什么方式阻碍」，
  如「张杨征粮的使者」「司马家不让他带弓」。必须是能在正文里出场的人或势力；
  不接受「心软」「犹豫」「内心挣扎」「恐惧」这类主角内部状态。
  如果输入里确实没有外部对手，输出 {"kind":"opponent","none":true,"reason":"为什么没有","source":"本章大纲"}，
  不要硬编一个。
invariants 的五类含义：age（年龄）、hometown（籍贯）、fosterStartAge（寄养起始年龄）、
fosterYears（寄养年数）、keyItemOwner（关键物归属）。值必须逐字来自人物卡/设定/素材/背景事实；
由两个已知值算出来的（如寄养年数=年龄-起始年龄）要标 inferred:true。numeric 只填阿拉伯数字，
unit 只填「岁」或「年」，keywords 给 1–4 个正文里能定位到这句的锚词（如「今年」「住了」「那年」）。
每条必须能追溯到给定输入：source 填来源，或 inferred 填 true。inferred=true 只表示你的推断，
只能作为建议，不能当成硬约束；不要为了凑数编造人物、器物或事件。
每条 keywords 给 1–4 个能在文本中逐字命中的词，优先用器物名、人名、地名、制度名。`;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unique(list) {
  return Array.from(new Set(list));
}

function normalizeKeywords(value) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === 'string') {
    raw = value.split(/[,，、;；|]/);
  }
  const keywords = [];
  for (const item of raw) {
    const word = text(item).replace(/\s+/g, '');
    if (word.length < 2) continue;
    if (!keywords.includes(word)) keywords.push(word);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

/** 对手条目的关键词：模型没给就从 text 里按标点切段，保证覆盖校验有可比对的词。 */
function opponentKeywords(raw, itemText) {
  const explicit = normalizeKeywords(raw.keywords);
  if (explicit.length) return explicit;
  return itemText
    .split(/[，,、；;|：:]/)
    .map((part) => part.trim())
    .filter((part) => Array.from(part).length >= 2)
    .slice(0, 3);
}

function normalizeItem(raw, index, dropped) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push(`第 ${index + 1} 条不是对象`);
    return null;
  }
  const kind = text(raw.kind);
  if (!KINDS.includes(kind)) {
    dropped.push(`第 ${index + 1} 条 kind 不合法：${kind || '空'}`);
    return null;
  }
  const itemText = text(raw.text);
  const inferred = raw.inferred === true;
  const source = text(raw.source);

  // 对手缺失是合法结论：必须说明为什么没有，不许硬编。
  if (kind === 'opponent' && raw.none === true) {
    const reason = text(raw.reason) || itemText;
    if (!reason) {
      dropped.push(`第 ${index + 1} 条 opponent 标了 none 但没有说明原因`);
      return null;
    }
    return {
      id: '',
      kind,
      text: '',
      keywords: [],
      source: source || (inferred ? 'inferred' : ''),
      inferred,
      none: true,
      reason,
    };
  }

  if (!itemText) {
    dropped.push(`第 ${index + 1} 条 text 为空`);
    return null;
  }

  // 对手必须是外部主体：「心软/犹豫/挣扎」无法排成外部阻碍。
  if (kind === 'opponent') {
    if (INTERNAL_STATE_RE.test(itemText)) {
      dropped.push(`第 ${index + 1} 条 opponent 是主角内部状态，不是外部对手：「${itemText}」`);
      return null;
    }
    if (Array.from(itemText).length < 4) {
      dropped.push(`第 ${index + 1} 条 opponent 过于笼统，落不到具体主体：「${itemText}」`);
      return null;
    }
  }

  if (!source && !inferred) {
    // 追溯不到输入的条目不能进 brief：否则规划器会把模型臆造当硬约束。
    dropped.push(`第 ${index + 1} 条没有来源且未标 inferred：「${itemText}」`);
    return null;
  }
  /**
   * handover 只在条目本身带交付语义时成立。
   *
   * 模型常把「某人到场」「父亲接走主角」也标 handover，这会让告别拍背上一条
   * 排不进去的硬约束。这里按条目文本机械判定：没有托付/交付/给物的动作就不算。
   */
  const handover =
    kind === 'mustPresent' &&
    raw.handover === true &&
    HANDOVER_ITEM_RE.test(itemText);
  const handoverTo = text(raw.to);
  const handoverKind = ['话', '物', '话或物'].includes(text(raw.handoverKind))
    ? text(raw.handoverKind)
    : '';

  return {
    id: `${kind[0].toUpperCase()}${index + 1}`,
    kind,
    text: itemText,
    keywords: kind === 'opponent' ? opponentKeywords(raw, itemText) : normalizeKeywords(raw.keywords),
    source: inferred && !source ? 'inferred' : source,
    inferred,
    handover,
    ...(handover ? { to: handoverTo, handoverKind, once: true } : {}),
  };
}

/**
 * 全章不变项：同一事实在正文里前后必须一致。
 *
 * 只收五类可机械核对的：年龄、籍贯、寄养起始年龄、寄养年数、关键物归属。
 * 数值不是来自模型打分，而是来自人物卡/设定/素材，或由两个已知值算得并标 inferred。
 */
const INVARIANT_KEYS = ['age', 'hometown', 'fosterStartAge', 'fosterYears', 'keyItemOwner'];
const INVARIANT_LABELS = {
  age: '年龄',
  hometown: '籍贯',
  fosterStartAge: '寄养起始年龄',
  fosterYears: '寄养年数',
  keyItemOwner: '关键物归属',
};
const INVARIANT_UNITS = { age: '岁', fosterStartAge: '岁', fosterYears: '年' };
const CN_NUM_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字转整数：只处理常见写法（十八、二十、二十五、一百）。 */
function cnNumber(value) {
  const chars = Array.from(String(value || '').trim());
  if (!chars.length) return null;
  let total = 0;
  let current = 0;
  for (const ch of chars) {
    if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (CN_NUM_DIGITS[ch] !== undefined) {
      current = CN_NUM_DIGITS[ch];
    } else {
      return null;
    }
  }
  return total + current;
}

function parseNumberToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;
  return /^[0-9]+$/.test(raw) ? Number(raw) : cnNumber(raw);
}

function normalizeInvariant(raw, index, dropped) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push(`不变项第 ${index + 1} 条不是对象`);
    return null;
  }
  const key = text(raw.key);
  if (!INVARIANT_KEYS.includes(key)) {
    dropped.push(`不变项第 ${index + 1} 条 key 不合法：${key || '空'}`);
    return null;
  }
  const value = text(raw.value);
  if (!value) {
    dropped.push(`不变项 ${key} 的 value 为空`);
    return null;
  }
  const inferred = raw.inferred === true;
  const source = text(raw.source);
  if (!source && !inferred) {
    dropped.push(`不变项 ${key} 没有来源且未标 inferred`);
    return null;
  }

  const unit = ['岁', '年'].includes(text(raw.unit))
    ? text(raw.unit)
    : INVARIANT_UNITS[key] || '';
  const valueMatch = value.match(/([一二三四五六七八九十百零〇两0-9]+)(岁|年)/);
  const numericRaw = Number(raw.numeric);
  const numeric = Number.isInteger(numericRaw) && numericRaw > 0
    ? numericRaw
    : valueMatch
      ? parseNumberToken(valueMatch[1])
      : null;

  return {
    key,
    label: INVARIANT_LABELS[key],
    value,
    numeric: numeric && numeric > 0 ? numeric : null,
    unit: valueMatch ? valueMatch[2] : unit,
    keywords: normalizeKeywords(raw.keywords),
    source: inferred && !source ? 'inferred' : source,
    inferred,
  };
}

/**
 * 校验并归一化一份分场 brief。
 *
 * @param {Object|string} candidate 模型输出（对象或 JSON 原文）
 * @returns {{ok: boolean, brief: {items: Array, invariants: Array, dropped: string[]}|null, errors: string[]}}
 */
function validatePlanBrief(candidate) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  const errors = [];
  const dropped = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, brief: null, errors: ['没有解析出 JSON 对象'] };
  }

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const seen = new Set();
  const items = [];

  for (let index = 0; index < rawItems.length; index++) {
    const item = normalizeItem(rawItems[index], index, dropped);
    if (!item) continue;
    const key = `${item.kind}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }

  const byKind = new Map();
  const limited = [];
  for (const item of items) {
    const count = byKind.get(item.kind) || 0;
    if (count >= MAX_ITEMS_PER_KIND) {
      dropped.push(`超出 ${item.kind} 数量上限：「${item.text}」`);
      continue;
    }
    byKind.set(item.kind, count + 1);
    limited.push({ ...item, id: `${KIND_ID_PREFIX[item.kind]}${count + 1}` });
  }

  const rawInvariants = Array.isArray(data.invariants) ? data.invariants : [];
  const invariants = [];
  const seenKeys = new Set();
  for (let index = 0; index < rawInvariants.length; index++) {
    const invariant = normalizeInvariant(rawInvariants[index], index, dropped);
    if (!invariant) continue;
    if (seenKeys.has(invariant.key)) continue;
    seenKeys.add(invariant.key);
    invariants.push(invariant);
    if (invariants.length >= INVARIANT_KEYS.length) break;
  }

  return {
    ok: true,
    brief: { items: limited, invariants, dropped },
    errors,
  };
}

function groupByKind(brief, kinds) {
  const items = (brief && Array.isArray(brief.items) ? brief.items : []).filter(
    (item) => kinds.includes(item.kind) && item.inferred !== true
  );
  return items;
}

/** 具体的对手条目（排除 none 的「本章没有对手」结论）。 */
function concreteOpponents(brief) {
  return groupByKind(brief, ['opponent']).filter((item) => item.none !== true);
}

function itemLine(item) {
  const source = item.source ? `（来源：${item.source}）` : '';
  const keywords = item.keywords && item.keywords.length
    ? `（关键词：${item.keywords.join('、')}）`
    : '';
  const handover = item.handover === true
    ? `（交付给：${item.to || '未登记'}；形式：${item.handoverKind || '话或物'}；全章只交付一次）`
    : '';
  return `- [${item.kind}] ${item.text}${handover}${source}${keywords}`;
}

/**
 * 把 brief 格式化成规划/写作共用的硬约束块。没有条目时返回空串，
 * 由调用方按「无 brief」回落旧行为。
 *
 * @param {{items: Array}|null} brief
 * @returns {string}
 */
function formatPlanBrief(brief) {
  if (!brief || !Array.isArray(brief.items) || !brief.items.length) return '';

  const hard = groupByKind(brief, ['loss']);
  const present = groupByKind(brief, ['mustPresent']).filter((item) => item.handover !== true);
  const withhold = groupByKind(brief, ['mustWithhold']);
  const reveal = groupByKind(brief, ['mustReveal']);
  const evidence = groupByKind(brief, ['evidence']);
  const opponent = concreteOpponents(brief);
  const opponentNone = brief.items.filter((item) => item.kind === 'opponent' && item.none === true);
  const handover = groupByKind(brief, ['mustPresent']).filter((item) => item.handover === true);
  const inferred = brief.items.filter((item) => item.inferred === true);

  const lines = [
    '## 本章分场 brief（来自前一步，必须落实到节拍表与正文）',
    '下列硬约束必须分别落到某一拍的 goal/obstacle/cost 或正文的具体动作里；不得用抽象概括代替。',
  ];

  const sections = [
    ['不可逆损失/交出物/决定', hard],
    ['外部对手（开场拍必须由它施加阻碍，不能写成主角自我克服）', opponent],
    ['必须到场的人物', present],
    ['托付（全章只允许一次完整交付，告别/离场拍由托付人本人把主角交给登记对象并交付话或物；交付对象必须在场）', handover],
    ['必须 withhold、不得解释的信息', withhold],
    ['必须交代的背景信息', reveal],
    ['物证/制度异常', evidence],
  ];
  for (const [label, items] of sections) {
    if (!items.length) continue;
    lines.push(`${label}：`);
    for (const item of items) lines.push(itemLine(item));
  }

  for (const item of opponentNone) {
    lines.push(`- 本章没有明确的外部对手（${item.reason}）；不要把主角的内心状态当对手，也不要硬编一个。`);
  }

  const invariants = Array.isArray(brief.invariants) ? brief.invariants : [];
  if (invariants.length) {
    lines.push('全章不变项（同一事实前后数值/归属必须一致，不得改动）：');
    for (const invariant of invariants) {
      const origin = invariant.source ? `（来源：${invariant.source}）` : '';
      lines.push(`- ${invariant.label}：${invariant.value}${origin}`);
    }
  }

  if (inferred.length) {
    lines.push('仅供参考（inferred，不得当成硬约束、不得为了它新增事实）：');
    for (const item of inferred) lines.push(itemLine(item));
  }

  return lines.join('\n');
}

function beatHaystack(beat) {
  if (!beat || typeof beat !== 'object') return '';
  const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
  return [
    beat.goal,
    beat.obstacle,
    beat.cost,
    beat.infoGain,
    beat.endHook,
    delta.variable,
    delta.from,
    delta.to,
  ]
    .map((x) => text(x))
    .filter(Boolean)
    .join('\n');
}

function itemHit(item, haystack) {
  if (haystack.includes(item.text)) return true;
  const terms = item.keywords && item.keywords.length ? item.keywords : [item.text];
  const hits = terms.filter((term) => term.length >= 2 && haystack.includes(term)).length;
  // 单关键词命中即可；多关键词至少要命中两个锚点，
  // 否则「司马防」单独出现就会被判成「司马防到场并当面托付」已覆盖。
  return hits >= Math.min(2, terms.length);
}

/**
 * 拍的叙述字段（不含 delta）。
 *
 * 托付/告别只认「这一拍写了什么」，delta 里的「想留下」「决定离城」是主角的
 * 内心变化，不能因为出现一个「留」字就算托付人交付了东西。
 */
function beatNarrative(beat) {
  if (!beat || typeof beat !== 'object') return '';
  return [beat.goal, beat.obstacle, beat.cost, beat.infoGain, beat.endHook]
    .map((x) => text(x))
    .filter(Boolean)
    .join('\n');
}

/**
 * 告别/离场拍：所有在 goal / infoGain 里带离场语义的拍。
 *
 * 只认这两个字段，是因为它们回答「这一拍要做什么、会得到什么」；
 * 不再回落到末拍——末拍通常是章末钩子，把托付塞进去正是之前的问题。
 *
 * @param {Array} beats
 * @returns {Array<Object>}
 */
function farewellBeats(beats) {
  if (!Array.isArray(beats) || !beats.length) return [];
  return beats.filter((beat) => {
    if (!beat || typeof beat !== 'object') return false;
    return FAREWELL_RE.test(text(beat.goal)) || FAREWELL_RE.test(text(beat.infoGain));
  });
}

/**
 * 从告别候选里选托付落点。
 *
 * 排序依据可解释：
 *   1. goal 里已经出现托付人 → 就是他那一拍；
 *   2. goal 是「启程/上车/离开/告别」而非「门口等待」→ 优先；
 *   3. 再退到叙述里出现托付人的候选，最后才是第一个告别候选。
 *
 * @param {Array} candidates
 * @param {string} trustee
 * @returns {Object|null}
 */
function pickHandoverBeat(candidates, trustee) {
  return orderHandoverCandidates(candidates, trustee)[0] || null;
}

/**
 * 按交付语义排序告别候选。
 *
 * 离场拍（启程/上车/离开）排在门口交接之前；门口那一拍常常只是
 * 「等示下」，托付话留在那里会被写手误当成已完成。
 */
function orderHandoverCandidates(candidates, trustee) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const rest = candidates.slice();
  const ordered = [];
  const take = (test) => {
    for (let i = 0; i < rest.length; ) {
      if (test(rest[i])) {
        ordered.push(rest[i]);
        rest.splice(i, 1);
      } else {
        i += 1;
      }
    }
  };
  take((beat) => DEPARTURE_ACTION_RE.test(text(beat.goal)));
  take((beat) => trustee && text(beat.goal).includes(trustee));
  take((beat) => STRONG_FAREWELL_RE.test(text(beat.goal)));
  take((beat) => trustee && beatNarrative(beat).includes(trustee));
  take(() => true);
  return ordered;
}

/**
 * 三条硬条件在同一拍里同时成立才算交付落点。
 *
 * @param {Object} item handover 项
 * @param {Array<Object>} candidates 告别/离场候选拍
 * @returns {Object|null}
 */
function handoverTarget(item, candidates) {
  const terms = item.keywords && item.keywords.length ? item.keywords : [item.text];
  const ordered = orderHandoverCandidates(candidates, text(terms[0]));
  return (
    ordered.find((beat) => handoverMissingParts(item, beatNarrative(beat), terms).length === 0) ||
    null
  );
}

/**
 * 校验节拍表是否覆盖 brief 的硬约束。
 *
 * 除三类通用硬覆盖外，另有两条按拍定位的校验：
 *   - 开场拍（B1）的 obstacle 必须由具体外部对手施加，不能是主角自我克服；
 *   - 告别/离场拍必须由托付人当场交付一句可引用的话或一件物。
 *
 * @param {{items: Array}|null} brief
 * @param {Object|null} plan validateBeatPlan 归一化后的节拍表
 * @returns {{covered: string[], missing: Array<{id,kind,text,slot?}>, hardTotal: number,
 *           opponent: string, handover: string}}
 */
/**
 * 开场拍：只认显式 function=opening。
 *
 * 旧实现按 beats[0] 判对手，B1 被错标成 departure 时整条对手校验就失效了。
 * 没有 function 的老节拍表（测试或回落链路）退回第一拍，保持兼容。
 *
 * @param {Array} beats
 * @returns {Object|null}
 */
function openingBeat(beats) {
  const list = Array.isArray(beats) ? beats : [];
  const hit = list.find((beat) => beat && beat.function === 'opening');
  if (hit) return hit;
  const hasFunction = list.some((beat) => beat && beat.function);
  return hasFunction ? null : list[0] || null;
}

/**
 * 对手落位：必须由开场拍的 obstacle 完成，且逐字含 brief 对手关键词。
 *
 * @param {{items: Array}|null} brief
 * @param {Object|null} plan
 * @returns {{status: 'covered'|'missing'|'none'|'absent', opponents: Array, openingBeatId: string,
 *           obstacle: string, missing: Array}}
 */
function openingOpponentCoverage(brief, plan) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const opponents = concreteOpponents(brief);
  const opponentNone = (brief && Array.isArray(brief.items) ? brief.items : []).some(
    (item) => item.kind === 'opponent' && item.none === true && item.inferred !== true
  );
  const opening = openingBeat(beats);
  const obstacle = opening ? text(opening.obstacle) : '';
  const openingBeatId = opening ? text(opening.id) : '';
  const missing = [];

  let status = 'absent';
  if (opponents.length) {
    const hit = Boolean(obstacle) && opponents.some((item) => itemHit(item, obstacle));
    status = hit ? 'covered' : 'missing';
    if (!hit) {
      for (const item of opponents) {
        missing.push({
          id: item.id,
          kind: 'opponent',
          text: item.text,
          slot: 'opening',
          openingBeatId,
        });
      }
    }
  } else if (opponentNone) {
    status = 'none';
  } else if (brief && Array.isArray(brief.items) && brief.items.length) {
    // 既没给对手、也没说明为什么没有：不能让开场拍悄悄绕过这条硬校验。
    // brief 本身为空（生成失败、走旧链路）时不打这条，避免把回落也算成降级。
    status = 'missing';
    missing.push({
      id: 'OP0',
      kind: 'opponent',
      text: '（brief 未给出对手，也未说明本章为什么没有）',
      slot: 'opening',
      openingBeatId,
    });
  }

  return { status, opponents, openingBeatId, obstacle, missing };
}

function briefCoverage(brief, plan) {
  const hard = groupByKind(brief, HARD_KINDS).filter((item) => item.handover !== true);
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const haystacks = beats.map(beatHaystack);

  const covered = [];
  const missing = [];
  for (const item of hard) {
    const hit = haystacks.some((haystack) => itemHit(item, haystack));
    if (hit) covered.push(item.id);
    else missing.push({ id: item.id, kind: item.kind, text: item.text });
  }

  // ---- 开场对手：只认 function=opening 拍（无 function 的老表退回第一拍）的 obstacle ----
  // 对手出现在 goal/cost/endHook 都不算覆盖：正文里必须由开场场景动作先一步打断。
  const opponentCoverage = openingOpponentCoverage(brief, plan);
  const opponent = opponentCoverage.status;
  if (opponent === 'covered') {
    for (const item of opponentCoverage.opponents) covered.push(item.id);
  } else if (opponent === 'missing') {
    for (const item of opponentCoverage.missing) missing.push(item);
  }

  // ---- 告别托付：托付人、交付动作、交付对象必须同处告别/离场拍 ----
  const handovers = groupByKind(brief, ['mustPresent']).filter(
    (item) => item.handover === true && item.inferred !== true
  );
  let handoverStatus = 'absent';
  if (handovers.length) {
    const candidates = farewellBeats(beats);
    for (const item of handovers) {
      const terms = item.keywords && item.keywords.length ? item.keywords : [item.text];
      // 落点按语义选（离场拍优先于出城），三条必须在这同一拍里同时成立。
      const target = handoverTarget(item, candidates);
      if (target) {
        covered.push(item.id);
      } else {
        const fallback = pickHandoverBeat(candidates, text(terms[0]));
        const partsForReport = fallback
          ? handoverMissingParts(item, beatNarrative(fallback), terms)
          : ['没有告别/离场拍'];
        missing.push({
          id: item.id,
          kind: 'mustPresent',
          text: item.text,
          slot: 'handover',
          keywords: item.keywords,
          to: item.to,
          handoverKind: item.handoverKind,
          missingParts: partsForReport,
        });
      }
    }
    handoverStatus = handovers.every((item) => covered.includes(item.id)) ? 'covered' : 'missing';
  }

  return {
    covered,
    missing,
    hardTotal: hard.length + opponentCoverage.opponents.length + handovers.length,
    opponent,
    openingBeatId: opponentCoverage.openingBeatId,
    handover: handoverStatus,
  };
}

/**
 * 给写手组指令的具体约束块。
 *
 * 只写非 inferred 的项；每行都具体到物、到人、到不得解释的内容。
 *
 * @param {{items: Array}|null} brief
 * @returns {string}
 */
function briefWriterBlock(brief) {
  if (!brief || !Array.isArray(brief.items) || !brief.items.length) return '';

  const lines = [];
  const loss = groupByKind(brief, ['loss']);
  const present = groupByKind(brief, ['mustPresent']).filter((item) => item.handover !== true);
  const withhold = groupByKind(brief, ['mustWithhold']);
  const reveal = groupByKind(brief, ['mustReveal']);
  const evidence = groupByKind(brief, ['evidence']);
  const opponent = concreteOpponents(brief);
  const handover = groupByKind(brief, ['mustPresent']).filter((item) => item.handover === true);
  const opponentNone = brief.items.filter(
    (item) => item.kind === 'opponent' && item.none === true && item.inferred !== true
  );

  if (loss.length) lines.push(`- 本章不可逆损失/交出物：${loss.map((x) => x.text).join('；')}`);
  if (opponent.length) {
    lines.push(`- 开场的外部对手（阻碍必须由它造成，不能写主角自我克服）：${opponent.map((x) => x.text).join('；')}`);
  }
  if (present.length) lines.push(`- 必须到场：${present.map((x) => x.text).join('；')}`);
  if (handover.length) {
    const detail = handover
      .map((x) => `${x.text}（交给：${x.to || '未登记'}；形式：${x.handoverKind || '话或物'}）`)
      .join('；');
    const beat = text(brief.handoverBeat);
    const onceLine = beat
      ? `全章只允许一次完整交付，已经在第 ${beat} 拍完成；其他拍不得重复托付话或重复交割，最多保留递、接、握住手这类预备动作。`
      : '全章只允许一次完整交付；其他拍不得重复托付话或重复交割，最多保留递、接、握住手这类预备动作。';
    lines.push(`- 托付（${onceLine}交付对象必须同处该拍）：${detail}`);
  }
  if (withhold.length) lines.push(`- 不得解释（必须 withhold）：${withhold.map((x) => x.text).join('；')}`);
  if (reveal.length) lines.push(`- 必须交代（每项至少一句）：${reveal.map((x) => x.text).join('；')}`);
  if (evidence.length) lines.push(`- 必须落地的物证/制度异常：${evidence.map((x) => x.text).join('；')}`);
  if (opponentNone.length) {
    lines.push(`- 本章没有明确的外部对手（${opponentNone.map((x) => x.reason).join('；')}）；不要硬编一个。`);
  }

  const invariants = Array.isArray(brief.invariants) ? brief.invariants : [];
  if (invariants.length) {
    lines.push(
      `- 全章不变项（前后数值/归属必须一致，不得改动）：${invariants
        .map((x) => `${x.label}=${x.value}${x.source ? `（${x.source}）` : ''}`)
        .join('；')}`
    );
  }

  const inferred = brief.items.filter((item) => item.inferred === true);
  if (inferred.length) {
    lines.push(`- 建议（inferred，可不用，不得为它新增事实）：${inferred.map((x) => x.text).join('；')}`);
  }

  if (!lines.length) return '';
  return ['## 本章不可逆约束（具体到物，不能抽象化）', ...lines].join('\n');
}

/**
 * 把硬缺项分配到「最近可落点」，仅用于重排指令的文案。
 *
 * 不修改模型返回的节拍表：规划器有它自己的结构校验，
 * 这里只告诉它「这一项应该落在哪一拍附近」。
 *
 * @param {Object|null} plan
 * @param {{missing: Array}} coverage
 * @returns {Array<{id,kind,text,targetBeats: string[], hint: string}>}
 */
function partitionCoverage(plan, coverage) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const missing = coverage && Array.isArray(coverage.missing) ? coverage.missing : [];
  const farewellCandidates = farewellBeats(beats);

  return missing.map((item) => {
    // 开场对手：只能落到 function=opening 拍的 obstacle，且必须写成外部主体
    // 「先一步打断」的场景动作（人到了/传唤声/时限到）。
    if (item.slot === 'opening') {
      const beat = openingBeat(beats);
      // OP0 是「brief 根本没给对手」：这是输入缺项，重排也编不出来，明确让规划器别硬造。
      if (item.id === 'OP0') {
        return {
          ...item,
          targetBeats: beat ? [beat.id] : [],
          hint: '分场 brief 没有给出对手，也没有说明为什么没有——这是输入缺项，不要在节拍表里编造对手；需补一条势力/反派素材后重排',
        };
      }
      return {
        ...item,
        targetBeats: beat ? [beat.id] : [],
        hint: beat
          ? `必须落到 ${beat.id}（function=opening）的 obstacle：由外部对手「${item.text}」先一步打断当前场景——人已经到了、传唤声从门外响起、时限到了、车马已在门外；不能写成主角自我克服或同伴的期待`
          : '节拍表里没有 function=opening 的拍：新增或改出一拍 function=opening（放在开头），把外部对手「' +
            item.text +
            '」写成先一步打断的场景动作放进该拍 obstacle',
      };
    }
    // 告别托付：只能落到告别/离场拍，且托付人、交付动作、交付对象必须在同一拍。
    if (item.slot === 'handover') {
      const trustee = (item.keywords || [])[0] || '托付人';
      const beat = pickHandoverBeat(farewellCandidates, text(trustee));
      const to = text(item.to);
      const kind = text(item.handoverKind) || '话或物';
      const missingText =
        Array.isArray(item.missingParts) && item.missingParts.length
          ? `；当前缺：${item.missingParts.join('、')}`
          : '';
      return {
        ...item,
        targetBeats: beat ? [beat.id] : [],
        hint: beat
          ? `必须落到 ${beat.id}（${text(beat.goal).slice(0, 24)}）：${trustee}本人在场，把主角当场${to ? `交给${to}` : '交给登记的交付对象'}，并交付${kind}；写进该拍 goal/obstacle/cost，不能只塞进 endHook，也不能推到后面的拍${missingText}`
          : `必须新增一拍，goal/infoGain 写清告别/离场语义，把${trustee}与${to || '登记的交付对象'}放进同一拍${missingText}`,
      };
    }

    const target = beats.find((beat) => {
      const haystack = beatHaystack(beat);
      if (item.kind === 'loss') return /代价|交|失去|决定|放弃/.test(haystack);
      if (item.kind === 'mustPresent') return /见|到|来|托付|告别/.test(haystack);
      return false;
    });
    const fallback = beats.length ? beats[Math.max(0, beats.length - 2)] : null;
    const beat = target || fallback;
    return {
      ...item,
      targetBeats: beat ? [beat.id] : [],
      hint: beat
        ? `建议落到 ${beat.id}（该拍已有「${text(beat.goal).slice(0, 30)}」）`
        : '建议新增一拍承接这一项，或在现有拍里改写 goal/cost',
    };
  });
}

/** handover 项（非 inferred）。 */
function handoverItems(brief) {
  return groupByKind(brief, ['mustPresent']).filter(
    (item) => item.handover === true && item.inferred !== true
  );
}

/**
 * brief 的 handover 项落进哪一拍：与覆盖校验共用同一套语义选点。
 *
 * @param {{items: Array}|null} brief
 * @param {Object|null} plan
 * @returns {string} 拍 id；找不到返回空串
 */
function handoverBeatId(brief, plan) {
  const handovers = handoverItems(brief);
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const candidates = farewellBeats(beats);
  for (const item of handovers) {
    const target = handoverTarget(item, candidates);
    if (target) return target.id;
  }
  return '';
}

function splitBodyParagraphs(body) {
  return String(body || '')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 完成态的交付动作：递到/交到/塞进…手里；「往…送了送」这类预备动作不算。 */
const HANDOVER_GIVE_RE = /交(?:给|到|进)|递(?:给|到|进)|塞(?:给|到|进)|放进|送到|托付|嘱托/;

/** 按句切分：交付要在一句里同时点名托付人与交付对象。 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[。！？；!?;])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 按拍计划里声明的 paragraphs 数，把正文段落顺序切给各拍。 */
function paragraphRanges(beats, count) {
  const weights = beats.map((beat) => Math.max(1, Number(beat.paragraphs) || 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || beats.length || 1;
  let cursor = 0;
  return beats.map((beat, index) => {
    const remainingBeats = beats.length - index;
    const remaining = count - cursor;
    let take =
      index === beats.length - 1
        ? remaining
        : Math.round((weights[index] / total) * count);
    take = Math.max(0, Math.min(take, remaining - (remainingBeats - 1)));
    const range = [cursor, cursor + take];
    cursor += take;
    return range;
  });
}

/**
 * 全章扫描完整交付形态。
 *
 * 完整形态 = 托付人与交付对象在同一句或相邻两句里 + 交付句有完成态动作
 * （交到/递到/塞进/放进/托付…）。
 *
 * 同段各提一次名字、或「某人把符传往前一递」这种只有一方在场的动作
 * 都不算：前者常是「司马朗的话是说给杨俊听的」这类旁白，后者往往
 * 只是出示符传、递东西，并没有把主角交出去。
 *
 * 只扫正文，不依赖模型自检；大于一次时返回除指定拍以外的拍 id。
 *
 * @param {{items: Array}|null} brief
 * @param {string} body
 * @param {Object|null} plan
 * @returns {{beatIds: string[], handoverBeat: string, evidence: Array<{id, text}>}}
 */
function findHandoverDuplicates(brief, body, plan) {
  const items = handoverItems(brief);
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  if (!items.length || !beats.length) return { beatIds: [], handoverBeat: '', evidence: [] };

  const item = items[0];
  const trustee = text((item.keywords || [])[0]);
  const to = text(item.to);
  if (!trustee || !to) return { beatIds: [], handoverBeat: '', evidence: [] };

  const paragraphs = splitBodyParagraphs(body);
  const ranges = paragraphRanges(beats, paragraphs.length);
  const evidence = [];

  for (const [index, beat] of beats.entries()) {
    const range = ranges[index];
    const texts = paragraphs.slice(range[0], range[1]);
    const sentences = splitSentences(texts.join(''));
    // 托付人和交付对象常被逗号/句号隔成两句（「杨俊在旁边站着。」「人我交给你了。」），
    // 单句匹配会漏掉真实交付；这里用相邻两句的窗口，仍在同一拍内，不跨拍。
    const delivered = sentences.some((sentence, index) => {
      const previous = index > 0 ? sentences[index - 1] : '';
      const window = previous + sentence;
      return window.includes(trustee) && window.includes(to) && HANDOVER_GIVE_RE.test(sentence);
    });
    if (delivered) {
      evidence.push({ id: beat.id, text: texts.join('') });
    }
  }

  const designated = text(brief && brief.handoverBeat) || handoverBeatId(brief, plan);
  const delivering = evidence.map((x) => x.id);
  const canonical = designated && delivering.includes(designated) ? designated : delivering[0] || '';
  return {
    beatIds: delivering.filter((id) => id !== canonical),
    handoverBeat: canonical || designated,
    evidence,
  };
}

/**
 * 把 handover 缺项确定性落进告别/离场拍。
 *
 * 只在重排之后调用：重排仍把托付留在章末钩子时，这里按 slot 选一个
 * goal/infoGain 带离场语义的拍，把「托付人把主角交给对象并交付话/物」
 * 追加到该拍 goal。不改人物、不改写手提示词，只补规划输入。
 *
 * 找不到告别/离场拍，或 brief 缺托付人/交付对象时不动手——留给
 * planDegraded 如实报缺，不硬编。
 *
 * @param {Object|null} plan
 * @param {{missing: Array}} coverage
 * @returns {{plan: Object|null, placed: string[], unplaced: Array}}
 */
function placeHandoverInPlan(plan, coverage) {
  const missing =
    coverage && Array.isArray(coverage.missing)
      ? coverage.missing.filter((item) => item.slot === 'handover')
      : [];
  if (!plan || !Array.isArray(plan.beats) || !plan.beats.length || !missing.length) {
    return { plan, placed: [], unplaced: [] };
  }

  const beats = plan.beats.map((beat) => ({ ...beat }));
  const candidates = farewellBeats(beats);
  const placed = [];
  const unplaced = [];

  for (const item of missing) {
    const trustee = text((item.keywords || [])[0]);
    const to = text(item.to);
    if (!trustee || !to) {
      unplaced.push(item);
      continue;
    }
    const target = handoverTarget(item, candidates) || pickHandoverBeat(candidates, trustee);
    if (!target) {
      unplaced.push(item);
      continue;
    }
    if (handoverMissingParts(item, beatNarrative(target), [trustee]).length === 0) {
      placed.push(target.id);
      continue;
    }
    const kind = text(item.handoverKind);
    const delivery =
      kind === '物'
        ? '并交付一件可引用的物'
        : kind === '话或物'
          ? '并交付一句可引用的话或一件物'
          : '并留下一句可引用的话（「保他平安」这一级）';
    const clause = `${trustee}当场把主角交给${to}，${delivery}`;
    target.goal = [text(target.goal), clause].filter(Boolean).join('；');
    placed.push(target.id);
  }

  return { plan: { ...plan, beats }, placed, unplaced };
}

/**
 * 生成重排指令。把缺项和可落点一起给规划器，避免它原样再输出一遍。
 *
 * @param {Array} partitioned partitionCoverage 的结果
 * @returns {string}
 */
function buildReplanInstruction(partitioned) {
  if (!Array.isArray(partitioned) || !partitioned.length) return '';
  const lines = [
    '上一版节拍表没有覆盖分场 brief 的以下硬性动作，请重排节拍表（可以改 goal/obstacle/cost，必要时新增一拍）：',
  ];
  for (const item of partitioned) {
    lines.push(`- [${item.kind}] ${item.text}；${item.hint}`);
  }
  lines.push('每一项都必须能在某一拍的字段里被逐字命中；不要为了覆盖新增输入里没有的人物或事件。');
  return lines.join('\n');
}

/**
 * 开场拍定向重排指令（R2）。
 *
 * 只改 function=opening 的那一拍：其余拍必须原样保留（目标、阻碍、代价、
 * 变量、钩子都不许重写），避免一次修对手把已经合格的六类结构推翻。
 *
 * @param {{opponents?: Array, openingBeatId?: string}} params
 * @returns {string}
 */
function buildOpeningReplanInstruction({ opponents = [], openingBeatId = '' } = {}) {
  const who = opponents.map((item) => text(item.text)).filter(Boolean).join('；') || 'brief 里的外部对手';
  const target = openingBeatId
    ? `function=opening 的拍是 ${openingBeatId}；只改它的 obstacle，goal/cost/delta/endHook 原样保留。`
    : '节拍表里没有 function=opening 的拍：把开头一拍改成 function=opening（或新增一拍放在开头），其余拍原样保留。';
  return [
    '（对手落位自检：brief 有外部对手，但开场拍的 obstacle 没有接住。只做一次开场定向重排。）',
    target,
    `该拍 obstacle 必须由外部对手「${who}」施加阻碍，并写成「先一步打断」的场景动作：`,
    '人已经到了、传唤声从门外响起、时限到了、车马已在门外；对手要在这一拍就出现，不能只留在后面的拍。',
    'obstacle 里必须逐字出现 brief 对手的关键词。',
    '不许用主角自己的心软、犹豫，或同伴的期待顶替外部对手。',
    '除这一拍外，其余拍一律原样输出；只输出完整节拍表 JSON，不要解释。',
  ].join('\n');
}

function parseRelations(value) {
  try {
    const parsed = JSON.parse(text(value));
    if (Array.isArray(parsed)) {
      return parsed.filter((row) => row && typeof row === 'object');
    }
  } catch (err) {
    // 非 JSON 的关系串就当作没有登记，不因此让 brief 失败。
  }
  return [];
}

/**
 * 交付对象：托付人把主角当面交给谁。
 *
 * 只从人物卡关系里找「父子/父女/生父/母亲」这一级直系登记，
 * 排除托付人本人；找不到就返回空串，交给覆盖校验如实报「交付对象未登记」，
 * 不从设定文本里猜一个名字。
 *
 * @param {string} protagonistName
 * @param {string} trustee
 * @param {Array} cards
 * @returns {string}
 */
function resolveHandoverTarget(protagonistName, trustee, cards) {
  for (const card of cards) {
    const owner = text(card.name);
    for (const relation of parseRelations(card.relations)) {
      const label = text(relation.relation);
      if (!label || !HANDOVER_TARGET_RELATION_RE.test(label)) continue;
      const counterpart = text(relation.characterName || relation.name);
      if (!counterpart) continue;
      const candidate =
        protagonistName && owner === protagonistName
          ? counterpart
          : protagonistName && counterpart === protagonistName
            ? owner
            : '';
      // 托付人本人不是交付对象（养父关系常也记成「父子」，要排除掉）。
      if (candidate && candidate !== trustee) return candidate;
    }
  }
  return '';
}

/**
 * 交付形式：话还是物。
 *
 * 设定/人物卡里已经写明「保…平安 / 照看」这类可引用的话，就取「话」；
 * 写明「赠 / 交给 / 留给」且与告别、临行同处一段，才取「物」。
 * 都没写明时按范文的托付句取「话」，这是默认而不是编造具体内容。
 *
 * @param {string} trustee
 * @param {Array} cards
 * @param {Array} settings
 * @returns {'话'|'物'|'话或物'}
 */
function resolveHandoverKind(trustee, cards, settings) {
  let line = false;
  let thing = false;
  for (const config of settings) {
    const haystack = [text(config.name), text(config.category), text(config.content)].join('\n');
    if (!haystack.includes(trustee)) continue;
    if (HANDOVER_PROMISE_RE.test(haystack)) line = true;
    if (
      HANDOVER_OBJECT_RE.test(haystack) &&
      (FAREWELL_RE.test(haystack) || /托付|临行|临别|辞行/.test(haystack))
    ) {
      thing = true;
    }
  }
  for (const card of cards) {
    if (text(card.name) !== trustee) continue;
    const haystack = [text(card.identity), text(card.role), text(card.relations)].join('\n');
    if (HANDOVER_PROMISE_RE.test(haystack)) line = true;
  }
  if (line && thing) return '话或物';
  if (thing) return '物';
  return '话';
}

/**
 * 把「托付关系」确定性地并进 brief。
 *
 * 人物卡/设定里一旦登记了寄养、托付、拜师、代养，告别拍就必须让托付人本人在场，
 * 把主角当面交给关系里登记的那位直系亲属，并留下一句正文可引用的话或一件物。
 * 这一步只读输入、不改写手提示词：模型漏了，这里补一条 handover 的 mustPresent，
 * 交给规划器按 slot 落进告别拍。
 *
 * `to` 与 `handoverKind` 都来自人物卡关系/设定原文；找不到交付对象就留空，
 * 由覆盖校验报「交付对象未登记」，不硬编一个名字。
 *
 * @param {{items: Array}|null} brief
 * @param {{characters?: Array, settings?: Array}} input
 * @returns {{items: Array}|null} brief 为 null 时原样返回，保持旧回落链路
 */
function mergeHandoverIntoBrief(brief, { characters = [], settings = [] } = {}) {
  if (!brief || !Array.isArray(brief.items)) return brief;

  const cards = Array.isArray(characters) ? characters : [];
  const configs = Array.isArray(settings) ? settings : [];
  const protagonist = cards.find((card) => text(card.role).includes('主角')) || null;
  const protagonistName = protagonist ? text(protagonist.name) : '';

  /** @type {Map<string, string>} 托付人 → 来源 */
  const trustees = new Map();

  for (const card of cards) {
    const owner = text(card.name);
    for (const relation of parseRelations(card.relations)) {
      const label = text(relation.relation);
      if (!label || !HANDOVER_RELATION_RE.test(label)) continue;
      const counterpart = text(relation.characterName || relation.name);
      if (!counterpart) continue;
      if (protagonistName) {
        // 关系记在主角卡上 → 对端是托付人；记在托付人卡上 → 本人是托付人。
        if (owner === protagonistName) trustees.set(counterpart, '人物卡');
        else if (counterpart === protagonistName) trustees.set(owner, '人物卡');
      } else {
        trustees.set(counterpart, '人物卡');
      }
    }
  }

  const cardNames = cards.map((card) => text(card.name)).filter(Boolean);
  for (const setting of configs) {
    const haystack = [text(setting.name), text(setting.category), text(setting.content)].join('\n');
    if (!HANDOVER_RELATION_RE.test(haystack)) continue;
    // 托付人必须是作品里真实存在的人物卡，不能从设定文本里凭空捏一个名字。
    const trustee = cardNames.find((name) => name !== protagonistName && haystack.includes(name));
    // 人物卡关系是主来源：设定只是补充，不能把「人物卡」覆盖成「设定」。
    if (trustee && !trustees.has(trustee)) trustees.set(trustee, '设定');
  }

  if (!trustees.size) return brief;

  let presentCount = brief.items.filter((item) => item.kind === 'mustPresent').length;
  const added = [];
  const items = brief.items.map((item) => {
    if (item.inferred === true || item.kind !== 'mustPresent' || item.none === true) return item;
    const trustee = Array.from(trustees.keys()).find((name) => (item.keywords || []).includes(name));
    if (!trustee) {
      // 模型自己带 handover 的条目：仍从人物卡关系解析交付对象，不用模型写的 to。
      const owner = text((item.keywords || [])[0]);
      if (item.handover === true && owner) {
        return {
          ...item,
          to: resolveHandoverTarget(protagonistName, owner, cards),
          handoverKind: resolveHandoverKind(owner, cards, configs),
          once: true,
        };
      }
      return item;
    }
    // 只有「这一条就是在写这个托付人」才升级：正文里顺带提到名字不算。
    trustees.delete(trustee);
    return {
      ...item,
      handover: true,
      to: resolveHandoverTarget(protagonistName, trustee, cards),
      handoverKind: resolveHandoverKind(trustee, cards, configs),
      once: true,
    };
  });

  for (const [name, source] of trustees) {
    const to = resolveHandoverTarget(protagonistName, name, cards);
    const handoverKind = resolveHandoverKind(name, cards, configs);
    const targetText = to ? `把${protagonistName || '主角'}当面交给${to}` : `当面托付${protagonistName || '主角'}`;
    const deliveryText =
      handoverKind === '物'
        ? '并交付一件可引用的物'
        : handoverKind === '话或物'
          ? '并留下一句可引用的话或一件物'
          : '并留下一句可引用的话（「保他平安」这一级）';
    presentCount += 1;
    added.push({
      id: `${KIND_ID_PREFIX.mustPresent}${presentCount}`,
      kind: 'mustPresent',
      text: `${name}在告别/离场拍${targetText}，${deliveryText}`,
      keywords: [name],
      source,
      inferred: false,
      handover: true,
      to,
      handoverKind,
      once: true,
    });
  }

  if (!added.length) return { ...brief, items };
  return { ...brief, items: items.concat(added) };
}

const HOMETOWN_RE = /(?:^|[，,；;。：:\s]|是|为)([\u4e00-\u9fa5]{2,6})人(?:[，,；;。]|$|\s)/;
const AGE_RE = /(?:今年|今年年方|年方|时年)?([一二三四五六七八九十百零〇两0-9]+)岁/;
const GIFT_RE = /赠|赐|所留|留给|传给他|交给他/;

/**
 * 从人物卡/设定/背景事实里确定性提取不变项。
 *
 * 只提取能逐字找到出处的：年龄、籍贯、关键物归属。
 * 寄养起始年龄/年数在输入里常只有「自幼」「十余年」这类模糊说法，
 * 交给 brief 模型标注来源或 inferred，不在这里硬编一个数。
 */
function deriveInvariants({ characters = [], settings = [], facts = [] } = {}) {
  const derived = [];
  const cards = Array.isArray(characters) ? characters : [];
  const protagonist = cards.find((card) => text(card.role).includes('主角')) || null;

  const identitySources = [];
  if (protagonist) {
    identitySources.push({ content: text(protagonist.identity), source: '人物卡' });
  }
  for (const fact of Array.isArray(facts) ? facts : []) {
    const content = text(fact && fact.content);
    if (content) identitySources.push({ content, source: '背景事实' });
  }

  for (const { content, source } of identitySources) {
    if (!content) continue;
    if (!derived.some((item) => item.key === 'age')) {
      const age = content.match(AGE_RE);
      if (age) {
        const numeric = parseNumberToken(age[1]);
        if (numeric && numeric > 0 && numeric < 120) {
          derived.push({
            key: 'age',
            label: INVARIANT_LABELS.age,
            value: `${age[1]}岁`,
            numeric,
            unit: '岁',
            keywords: ['今年', `${age[1]}岁`],
            source,
            inferred: false,
          });
        }
      }
    }
    if (!derived.some((item) => item.key === 'hometown')) {
      const hometown = content.match(HOMETOWN_RE);
      if (hometown) {
        derived.push({
          key: 'hometown',
          label: INVARIANT_LABELS.hometown,
          value: hometown[1],
          numeric: null,
          unit: '',
          keywords: [hometown[1]],
          source,
          inferred: false,
        });
      }
    }
  }

  for (const setting of Array.isArray(settings) ? settings : []) {
    if (derived.some((item) => item.key === 'keyItemOwner')) break;
    const content = text(setting && setting.content);
    const itemName = text(setting && setting.name);
    if (!content || !itemName || !GIFT_RE.test(content)) continue;
    // 归属人必须是人物卡里登记过的人名，不能靠「为X所赠」猜一个代词或受赠者。
    const donor = cards.find(
      (card) =>
        text(card.name) &&
        text(card.name).length >= 2 &&
        !(protagonist && text(card.name) === text(protagonist.name)) &&
        content.includes(text(card.name))
    );
    if (donor) {
      derived.push({
        key: 'keyItemOwner',
        label: INVARIANT_LABELS.keyItemOwner,
        value: text(donor.name),
        numeric: null,
        unit: '',
        keywords: [itemName],
        source: '设定',
        inferred: false,
      });
    }
  }

  return derived;
}

/**
 * 将确定性提取的不变项并入 brief。
 *
 * 同一 key 以确定性提取为准；寄养年数如果 brief 没给、而年龄和起始年龄都已知，
 * 就按差值算一个并标 inferred。
 */
function mergeInvariants(brief, derived = []) {
  if (!brief) return brief;
  const existing = Array.isArray(brief.invariants) ? brief.invariants : [];
  const byKey = new Map();
  for (const invariant of existing) {
    if (INVARIANT_KEYS.includes(invariant.key)) byKey.set(invariant.key, invariant);
  }
  for (const invariant of derived) {
    if (INVARIANT_KEYS.includes(invariant.key)) byKey.set(invariant.key, invariant);
  }

  if (!byKey.has('fosterYears')) {
    const age = byKey.get('age');
    const start = byKey.get('fosterStartAge');
    if (age && start && Number.isInteger(age.numeric) && Number.isInteger(start.numeric)) {
      const years = age.numeric - start.numeric;
      if (years > 0) {
        byKey.set('fosterYears', {
          key: 'fosterYears',
          label: INVARIANT_LABELS.fosterYears,
          value: `${years}年`,
          numeric: years,
          unit: '年',
          keywords: ['住了', '那之后', '这一递', '吃了'],
          source: '由年龄与寄养起始年龄推算',
          inferred: true,
        });
      }
    }
  }

  return { ...brief, invariants: Array.from(byKey.values()) };
}

/**
 * 外部压力兜底规则：输入里能指认的外部阻碍。
 *
 * 同伴的期待、主角的心软都不算对手（INTERNAL_STATE_RE 已在条目层拦掉），
 * 这里只认能落到开场 obstacle 的硬压力：时限/传车、父命、官威。
 * 规则按优先级排列，取第一个命中的；text 固定成可被 itemHit 逐字命中的写法。
 */
const EXTERNAL_PRESSURE_RULES = [
  {
    id: 'deadline',
    re: /传车|不等人|即刻|连夜|限时|启程|马上走/,
    text: '传车已在门外等候，限时启程',
    keywords: ['传车'],
  },
  {
    id: 'father_order',
    re: /父命|父亲[^。；;\n]{0,16}(要|带|走|来接|叫你)/,
    text: '父亲命他立刻随行，不得耽搁',
    keywords: ['父亲'],
  },
  {
    id: 'authority',
    re: /符传|司空|征辟|传诏|官威|军令/,
    text: '司空府的符传与官威压着，不得拖延',
    keywords: ['符传'],
  },
];

/**
 * 从输入里补一个外部对手。
 *
 * 规划器经常把「本章没有对手」直接标 none，但输入里明明写了传车在门外、
 * 父亲连夜来接、司空府符传压着——这些都是能排进开场 obstacle 的外部压力。
 * 这里不让模型再判断一次，按可解释的规则从 instruction/设定/素材里取第一个命中的，
 * 并写清来源；确实一个都没命中才保留 none 并说明缺什么素材。
 *
 * 已有具体对手时原样返回（包括对象引用），不做二次覆盖。
 *
 * @param {Object|null} brief
 * @param {{instruction?: string, settings?: Array, facts?: Array}} context
 * @returns {Object|null}
 */
function mergeDerivedOpponent(brief, { instruction = '', settings = [], facts = [] } = {}) {
  if (!brief || !Array.isArray(brief.items)) return brief;
  if (concreteOpponents(brief).length) return brief;

  const sources = [
    { text: text(instruction), source: '本章大纲' },
    ...(Array.isArray(settings) ? settings : []).map((row) => ({
      text: [text(row && row.name), text(row && row.category), text(row && row.content)].join('\n'),
      source: '设定',
    })),
    ...(Array.isArray(facts) ? facts : []).map((row) => ({
      text: text(row && row.content),
      source: '素材',
    })),
  ];

  let found = null;
  for (const source of sources) {
    if (!source.text) continue;
    const rule = EXTERNAL_PRESSURE_RULES.find((item) => item.re.test(source.text));
    if (rule) {
      found = { rule, source: source.source };
      break;
    }
  }

  // 模型可能给了一条 none 的结论；补到对手时必须把它替换掉，不能留两条。
  const rest = brief.items.filter(
    (item) => !(item.kind === 'opponent' && item.none === true)
  );
  const id = `OP${rest.filter((item) => item.kind === 'opponent').length + 1}`;

  if (!found) {
    return {
      ...brief,
      items: [
        ...rest,
        {
          id,
          kind: 'opponent',
          text: '',
          keywords: [],
          source: '本章大纲',
          inferred: false,
          none: true,
          reason: '输入里未找到传车/时限、父命、官威这类外部压力，需补势力或反派素材',
        },
      ],
    };
  }

  return {
    ...brief,
    items: [
      ...rest,
      {
        id,
        kind: 'opponent',
        text: found.rule.text,
        keywords: found.rule.keywords.slice(),
        source: found.source,
        inferred: false,
      },
    ],
  };
}

/** 数值必须落在锚词的邻近范围内，否则「三年」会被「住了一夜」这种词误抓。 */
const INVARIANT_KEYWORD_WINDOW = 12;

/**
 * 「寄养起始年龄」的句子上下文：必须是在说进门/寄养这件事。
 *
 * 否则「这把弓是他十岁那年给的」会被「那年」这个锚词拉进寄养起始年龄，
 * 把弓的赠予年龄误判成进门年龄。
 */
const FOSTER_ENTRY_RE = /进门|进府|到(我|这|府|家)|来(到|了|温县|司马|府)|寄养|领进|收养|收留|接来|住进|送(来|到)/;

/**
 * 同章数值一致性检查。
 *
 * 只看有 numeric + unit + keywords 的不变项。每个数字按「离它最近的锚词」
 * 归属到某一个不变项，再和该不变项的期望值比；锚词窗口外的数字不算。
 * 这样既能抓到「六岁/七岁」「十二年/十一年」，又不会把「三年前」按到「住了一夜」上。
 * 返回逐字证据句与所在拍，供分组重写定位。
 */
function checkInvariantConsistency(brief, body, plan) {
  const invariants = ((brief && brief.invariants) || []).filter(
    (item) => Number.isInteger(item.numeric) && item.unit && (item.keywords || []).length
  );
  const beats = (plan && plan.beats) || [];
  const paragraphs = splitBodyParagraphs(body);
  if (!invariants.length || !beats.length || !paragraphs.length) {
    return { applicable: false, total: invariants.length, violations: [], beatIds: [] };
  }

  const ranges = paragraphRanges(beats, paragraphs.length);
  const violations = [];
  const seen = new Set();
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index];
    const [from, to] = ranges[index];
    const beatText = paragraphs.slice(from, to).join('\n');
    if (!beatText) continue;

    for (const sentence of splitSentences(beatText)) {
      const tokens = [];
      for (const invariant of invariants) {
        const pattern = new RegExp(`([一二三四五六七八九十百零〇两0-9]+)(${invariant.unit})`, 'g');
        for (const match of sentence.matchAll(pattern)) {
          tokens.push({ invariant, match, index: match.index, text: match[0] });
        }
      }

      for (const token of tokens) {
        const numeric = parseNumberToken(token.match[1]);
        if (!Number.isInteger(numeric)) continue;
        let best = null;
        for (const invariant of invariants.filter((item) => item.unit === token.invariant.unit)) {
          for (const keyword of invariant.keywords) {
            let at = sentence.indexOf(keyword);
            while (at >= 0) {
              const distance = Math.abs(at - token.index);
              if (distance <= INVARIANT_KEYWORD_WINDOW && (!best || distance < best.distance)) {
                best = { invariant, distance };
              }
              at = sentence.indexOf(keyword, at + 1);
            }
          }
        }
        if (!best || numeric === best.invariant.numeric) continue;
        // 寄养起始年龄只认进门/寄养语义的句子，避免把「十岁那年给的弓」算成进门年龄。
        if (best.invariant.key === 'fosterStartAge' && !FOSTER_ENTRY_RE.test(sentence)) continue;
        // 同一句里已经写明该不变项的期望值时，同单位的其他数字属于另一个量
        // （如「七岁进门，今年十八」里的七岁不是年龄），不能反判成冲突。
        const expectedStated = tokens.some((other) => {
          if (other.invariant.unit !== token.invariant.unit) return false;
          return parseNumberToken(other.match[1]) === best.invariant.numeric;
        });
        if (expectedStated) continue;
        const key = `${beat.id}|${best.invariant.key}|${token.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        violations.push({
          beatId: beat.id,
          key: best.invariant.key,
          label: best.invariant.label,
          expected: best.invariant.value,
          actual: token.text,
          sentence,
        });
      }
    }
  }

  return {
    applicable: true,
    total: invariants.length,
    violations,
    beatIds: unique(violations.map((violation) => violation.beatId)),
  };
}

/**
 * 分场 brief 调用。失败返回 brief=null，由路由回落到「无 brief」的旧链路。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} params.systemPrompt 与节拍规划共用的上下文快照
 * @param {string} params.instruction 作者本次的写作指令
 * @param {Object} [params.options] temperature/model/thinking/signal
 * @returns {Promise<{brief: Object|null, raw: string, errors: string[], reason: string, usage: Object|null}>}
 */
async function generatePlanBrief({ provider, systemPrompt, instruction, options = {} }) {
  const signal = options.signal || null;
  let lastRaw = '';
  let lastErrors = [];
  let lastUsage = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) {
      return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'timeout', usage: lastUsage };
    }

    const userContent = attempt === 0
      ? `请为这一章生成分场 brief。选题：${instruction}`
      : `上一次输出不合格：${lastErrors.join('；')}。只输出一个合格的 JSON 对象，不要解释。`;

    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n---\n\n${BRIEF_PROMPT}` },
          { role: 'user', content: userContent },
        ],
        ...options,
        jsonOutput: true,
        maxTokens: 1200,
      });

      lastRaw = String(result.content || '');
      lastUsage = result.usage || null;
      const check = validatePlanBrief(lastRaw);
      if (check.ok) {
        return {
          brief: check.brief,
          raw: lastRaw,
          errors: [],
          reason: '',
          usage: lastUsage,
        };
      }
      lastErrors = check.errors;
    } catch (err) {
      if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
        return {
          brief: null,
          raw: lastRaw,
          errors: lastErrors,
          reason: err.code === 'AI_ABORTED' ? 'aborted' : 'timeout',
          usage: lastUsage,
        };
      }
      return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'error', usage: lastUsage };
    }
  }

  return { brief: null, raw: lastRaw, errors: lastErrors, reason: 'invalid', usage: lastUsage };
}

/**
 * 制度词与结论词：判断「悬念有没有被解释掉」。
 *
 * 不靠模型打分：同一拍里同时出现两个制度词、并且出现一个结论词，
 * 才判违规。只写符传形制、不给人「该不该/对不对」的结论，不会触发。
 */
const WITHHOLD_TERMS = ['私辟', '传诏', '符传', '逾制', '司空', '符节', '印玺'];
const WITHHOLD_CONCLUSION_RE = /不该|不对|少见|没见过|反常|用不着|更不会|哪有|不合制|不发|不称|岂能|怎么会/;

/**
 * 悬念自检：mustWithhold 项映射到拍，看正文有没有把结论讲出来。
 *
 * 规则是确定性的，证据句直接取自正文：
 *   1. 把 brief 的 mustWithhold 项按关键词映射到拍；
 *   2. 同一拍内出现 >=2 个制度词，且出现 >=1 个结论词；
 *   3. 取含结论词的句子作为证据，逐字返回，供作者复核与定向重写。
 *
 * @param {Object} brief
 * @param {string} body
 * @param {Object} plan
 * @returns {{applicable: boolean, total: number, violations: Array, itemBeats: Object}}
 */
function checkMustWithhold(brief, body, plan) {
  const items = ((brief && brief.items) || []).filter((item) => item.kind === 'mustWithhold');
  const beats = (plan && plan.beats) || [];
  const paragraphs = splitBodyParagraphs(body);

  if (!items.length || !beats.length || !paragraphs.length) {
    return { applicable: false, total: items.length, violations: [], itemBeats: {} };
  }

  const ranges = paragraphRanges(beats, paragraphs.length);
  const itemBeats = {};
  for (const item of items) {
    itemBeats[item.id] = beats
      .filter((beat) => itemHit(item, beatHaystack(beat)))
      .map((beat) => beat.id);
  }

  const violations = [];
  for (let index = 0; index < beats.length; index += 1) {
    const beat = beats[index];
    const [from, to] = ranges[index];
    const beatText = paragraphs.slice(from, to).join('\n');
    if (!beatText) continue;

    const terms = WITHHOLD_TERMS.filter((term) => beatText.includes(term));
    if (terms.length < 2) continue;

    const conclusionSentences = splitSentences(beatText).filter((sentence) =>
      WITHHOLD_CONCLUSION_RE.test(sentence)
    );
    // 证据句必须自己带制度词：拍内两个制度词散在不同段落、结论句只说
    // 「静得不对」「不该问」，不是在解释制度，不能算解释掉悬念。
    const evidenceSentences = conclusionSentences.filter((sentence) =>
      WITHHOLD_TERMS.some((term) => sentence.includes(term))
    );
    if (!evidenceSentences.length) continue;

    const best =
      evidenceSentences.find(
        (sentence) => WITHHOLD_TERMS.filter((term) => sentence.includes(term)).length >= 2
      ) || evidenceSentences[0];

    const mapped = items
      .filter((item) => (itemBeats[item.id] || []).includes(beat.id))
      .map((item) => item.id);

    violations.push({
      id: beat.id,
      sentence: best,
      sentences: conclusionSentences,
      terms,
      itemIds: mapped.length ? mapped : items.map((item) => item.id),
    });
  }

  return { applicable: true, total: items.length, violations, itemBeats };
}

module.exports = {
  KINDS,
  HARD_KINDS,
  BRIEF_PROMPT,
  validatePlanBrief,
  formatPlanBrief,
  briefCoverage,
  openingOpponentCoverage,
  openingBeat,
  briefWriterBlock,
  partitionCoverage,
  buildReplanInstruction,
  buildOpeningReplanInstruction,
  mergeHandoverIntoBrief,
  placeHandoverInPlan,
  handoverBeatId,
  findHandoverDuplicates,
  checkMustWithhold,
  WITHHOLD_TERMS,
  deriveInvariants,
  mergeInvariants,
  mergeDerivedOpponent,
  checkInvariantConsistency,
  INVARIANT_KEYS,
  generatePlanBrief,
};
