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

/** 告别/离场拍的识别词。 */
const FAREWELL_RE = /告别|辞行|拜别|离场|送行|送别|启程|出城|离开|上路|动身|托付|嘱托/;

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

/** 人物卡/设定里的托付关系词。 */
const HANDOVER_RELATION_RE = /寄养|托付|拜师|代养|养父|养母|义父|义母|收养|监护人|师父/;

/**
 * 硬约束类别：规划器必须把它们落到某一拍。
 * mustReveal 不在这里——它由首次出场章另行校验，不参与节拍硬覆盖。
 */
const HARD_KINDS = ['loss', 'mustPresent', 'mustWithhold'];

const MAX_ITEMS_PER_KIND = 6;
const MAX_KEYWORDS = 6;

const BRIEF_PROMPT = `你是章节分场 brief 规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
任务：根据本章大纲、作品大纲、人物卡、设定、素材与上一章结尾，回答「这一章必须发生哪些动作」。
输出格式：{"items":[{"kind":"loss|mustPresent|mustWithhold|mustReveal|evidence|opponent","text":"具体动作，写到物、写到人","keywords":["能在正文或节拍表里被逐字命中的词"],"source":"本章大纲|作品大纲|人物卡|设定|素材|上一章","inferred":false,"handover":false}]}
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

  return {
    id: `${kind[0].toUpperCase()}${index + 1}`,
    kind,
    text: itemText,
    keywords: kind === 'opponent' ? opponentKeywords(raw, itemText) : normalizeKeywords(raw.keywords),
    source: inferred && !source ? 'inferred' : source,
    inferred,
    handover,
  };
}

/**
 * 校验并归一化一份分场 brief。
 *
 * @param {Object|string} candidate 模型输出（对象或 JSON 原文）
 * @returns {{ok: boolean, brief: {items: Array, dropped: string[]}|null, errors: string[]}}
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

  return {
    ok: true,
    brief: { items: limited, dropped },
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
  return `- [${item.kind}] ${item.text}${source}${keywords}`;
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
    ['托付（告别/离场拍必须由托付人当场交付一句可引用的话或一件物）', handover],
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
 * 告别/离场拍：所有命中告别词的拍；一个都没有就退到末拍。
 *
 * 一章里可能既有「与司马朗告别」也有「司马防院中送行」，两个都要认，
 * 否则托付项会被错判到不相干的那一拍。
 *
 * @param {Array} beats
 * @returns {Array<Object>}
 */
function farewellBeats(beats) {
  if (!Array.isArray(beats) || !beats.length) return [];
  const hits = beats.filter((beat) => FAREWELL_RE.test(beatNarrative(beat)));
  return hits.length ? hits : [beats[beats.length - 1]];
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

  // ---- 开场对手：只认 beats[0].obstacle，避免「对手出现在 goal/cost」也算覆盖 ----
  const opponents = concreteOpponents(brief);
  const opponentNone = (brief && Array.isArray(brief.items) ? brief.items : []).some(
    (item) => item.kind === 'opponent' && item.none === true && item.inferred !== true
  );
  let opponent = 'absent';
  if (opponents.length) {
    const obstacle = beats.length ? text(beats[0].obstacle) : '';
    const hit = Boolean(obstacle) && opponents.some((item) => itemHit(item, obstacle));
    if (hit) {
      opponent = 'covered';
      for (const item of opponents) covered.push(item.id);
    } else {
      opponent = 'missing';
      for (const item of opponents) {
        missing.push({ id: item.id, kind: 'opponent', text: item.text, slot: 'opening' });
      }
    }
  } else if (opponentNone) {
    opponent = 'none';
  } else if (brief && Array.isArray(brief.items) && brief.items.length) {
    // 既没给对手、也没说明为什么没有：不能让开场拍悄悄绕过这条硬校验。
    // brief 本身为空（生成失败、走旧链路）时不打这条，避免把回落也算成降级。
    opponent = 'missing';
    missing.push({
      id: 'OP0',
      kind: 'opponent',
      text: '（brief 未给出对手，也未说明本章为什么没有）',
      slot: 'opening',
    });
  }

  // ---- 告别托付：人物必须在该拍出现，且同拍有交付语义 ----
  const handovers = groupByKind(brief, ['mustPresent']).filter(
    (item) => item.handover === true && item.inferred !== true
  );
  let handoverStatus = 'absent';
  if (handovers.length) {
    const candidates = farewellBeats(beats);
    for (const item of handovers) {
      const terms = item.keywords && item.keywords.length ? item.keywords : [item.text];
      // 人物必须和交付动作出现在同一拍：只说「要托付」而没有落成话或物，不算覆盖。
      const hit = candidates.find((beat) => {
        const narrative = beatNarrative(beat);
        const personHit = terms.some((term) => term.length >= 2 && narrative.includes(term));
        return personHit && handoverDelivered(narrative);
      });
      if (hit) covered.push(item.id);
      else missing.push({ id: item.id, kind: 'mustPresent', text: item.text, slot: 'handover' });
    }
    handoverStatus = handovers.every((item) => covered.includes(item.id)) ? 'covered' : 'missing';
  }

  return {
    covered,
    missing,
    hardTotal: hard.length + opponents.length + handovers.length,
    opponent,
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
    lines.push(`- 托付（告别/离场拍由托付人当场交付一句可引用的话或一件物）：${handover.map((x) => x.text).join('；')}`);
  }
  if (withhold.length) lines.push(`- 不得解释（必须 withhold）：${withhold.map((x) => x.text).join('；')}`);
  if (reveal.length) lines.push(`- 必须交代（每项至少一句）：${reveal.map((x) => x.text).join('；')}`);
  if (evidence.length) lines.push(`- 必须落地的物证/制度异常：${evidence.map((x) => x.text).join('；')}`);
  if (opponentNone.length) {
    lines.push(`- 本章没有明确的外部对手（${opponentNone.map((x) => x.reason).join('；')}）；不要硬编一个。`);
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
    // 开场对手：只能落到第一拍的 obstacle，且必须写成外部主体施加的阻碍。
    if (item.slot === 'opening') {
      const beat = beats[0] || null;
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
          ? `必须落到 ${beat.id} 的 obstacle：由外部对手「${item.text}」施加阻碍，不能写成主角自我克服`
          : '必须新增开场拍，把这一项放进该拍的 obstacle',
      };
    }
    // 告别托付：只能落到告别/离场拍，且人物必须当场交付话或物。
    if (item.slot === 'handover') {
      const beat =
        farewellCandidates.find((candidate) =>
          (item.keywords || []).some(
            (term) => term.length >= 2 && beatNarrative(candidate).includes(term)
          )
        ) ||
        farewellCandidates[0] ||
        null;
      return {
        ...item,
        targetBeats: beat ? [beat.id] : [],
        hint: beat
          ? `必须落到 ${beat.id}（告别/离场拍）：让托付人本人在场，并当场交付一句可引用的话或一件物`
          : '必须新增告别/离场拍，让托付人本人在场并当场交付话或物',
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
 * 把「托付关系」确定性地并进 brief。
 *
 * 人物卡/设定里一旦登记了寄养、托付、拜师、代养，告别拍就必须让托付人本人在场，
 * 并留下一句正文可引用的话或一件物。这一步只读输入、不改写手提示词：
 * 模型漏了，这里补一条 handover 的 mustPresent，交给规划器硬覆盖。
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
    if (trustee) trustees.set(trustee, '设定');
  }

  if (!trustees.size) return brief;

  let presentCount = brief.items.filter((item) => item.kind === 'mustPresent').length;
  const added = [];
  const items = brief.items.map((item) => {
    if (item.inferred === true || item.kind !== 'mustPresent' || item.none === true) return item;
    const trustee = Array.from(trustees.keys()).find((name) => (item.keywords || []).includes(name));
    if (!trustee) return item;
    // 只有「这一条就是在写这个托付人」才升级：正文里顺带提到名字不算。
    trustees.delete(trustee);
    return { ...item, handover: true };
  });

  for (const [name, source] of trustees) {
    presentCount += 1;
    added.push({
      id: `${KIND_ID_PREFIX.mustPresent}${presentCount}`,
      kind: 'mustPresent',
      text: `${name}在告别/离场拍当场托付${protagonistName || '主角'}，留下一句可引用的话或一件物`,
      keywords: [name],
      source,
      inferred: false,
      handover: true,
    });
  }

  if (!added.length) return { ...brief, items };
  return { ...brief, items: items.concat(added) };
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

module.exports = {
  KINDS,
  HARD_KINDS,
  BRIEF_PROMPT,
  validatePlanBrief,
  formatPlanBrief,
  briefCoverage,
  briefWriterBlock,
  partitionCoverage,
  buildReplanInstruction,
  mergeHandoverIntoBrief,
  generatePlanBrief,
};
