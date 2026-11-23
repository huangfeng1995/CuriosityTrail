'use strict';

/**
 * 章节节拍规划与覆盖自检。
 *
 * 纯逻辑 + 一次 provider 调用：不碰数据库、不认识 Express。
 * 规划与写作共用同一份上下文快照，这里只负责两件事：
 *   1. 把一部长篇的「这一章要发生什么」拆成 4–8 拍，并校验模型给的 JSON；
 *   2. 正文写完后，逐拍判断它有没有真的落到正文里。
 *
 * 之所以要单独拆成模块：规划、自检、重写这三个环节都需要同一套
 * 字段定义与校验规则。规则散在路由里，改一处漏一处就会静默放行
 * 一份缺拍的节拍表。
 */

const { parseModelJson } = require('./parse');
const { countWords } = require('../wordCount');

/** 节拍类型：七选一（险露 仅在历史悬疑模板启用时可用） */
const BEAT_TYPES = ['行动', '转折', '冲突', '揭示', '决定', '过渡', '险露'];

/**
 * 高风险拍「险露」：每章差点暴露。
 *
 * 它不是「遇到危险」的动作拍，而是**人物在险境中被迫暴露信息**：
 * 审问、试探、错拿东西、说漏半句——张力来自「差一点被看穿」，
 * 而不是打斗场面。这条语义写进规划提示词，校验只负责数量与相邻章。
 */
const DANGER_TYPE = '险露';

/** 单拍规模：默认 small；一章 large 至多 1 拍。 */
const SCALE_VALUES = ['small', 'medium', 'large'];
const DEFAULT_SCALE = 'small';

/** 单拍压力类型；一章 动作 至多 1 拍。 */
const PRESSURE_VALUES = ['心理', '对峙', '误导', '动作'];

/**
 * 关键抉择暂停点（HP12）。
 *
 * 只有「决定」拍可以设 critical：作者要在正文开写之前先拍板。
 * options 必须 2–3 项且每项带 label 与 consequence——不写后果的选项
 * 等于让作者掷骰子，宁可判这一拍不合格。
 */
const DECISION_TYPE = '决定';
const PAUSE_OPTION_MIN = 2;
const PAUSE_OPTION_MAX = 3;

/**
 * 功能拍枚举：这一拍在章节结构里承担什么。
 *
 * 与 type 是两件事：type 说「事件性质」（冲突/揭示），function 说
 * 「在全章曲线上负责哪一段」（开场/身世/告别）。篇幅配比只看 function，
 * 不再按 goal 文案里的关键词猜——「回城/猎鹿」这类地点词会把开场拍
 * 误判成启程拍，正文份额就会全盘错位。
 */
const BEAT_FUNCTIONS = ['opening', 'discussion', 'identity', 'father', 'farewell', 'departure'];
const FUNCTION_LABELS = {
  opening: '开场',
  discussion: '议论',
  identity: '身世',
  father: '长辈到',
  farewell: '告别托付',
  departure: '启程',
};

/** 变量：每拍至少改变一个 */
const DELTA_VARIABLES = ['处境', '关系', '信息', '决心'];

/** 节拍数范围 */
const MIN_BEATS = 4;
const MAX_BEATS = 8;
/** 六类功能全覆盖的起算拍数：少于 6 拍不可能排进六类，不据此判降级。 */
const MIN_BEATS_WITH_FUNCTIONS = 6;

/**
 * 单拍段数与全章段数。
 *
 * 基线范文（5000 字量级）实测 45 个自然段、6 拍。旧的「每拍 1–4 段、
 * 全章 8–14 段」是按两千字短章推的，会把长篇写成提纲，已经作废。
 */
const MIN_PARAGRAPHS = 3;
/**
 * 单拍段数上限。
 *
 * 范文实测的最大功能拍是「议论」25.2%（约 1260 字），按段均 112 字约 11 段；
 * 上限卡在 10 会把议论拍逼成每段 120 字以上的超长段。12 段 × 105 字
 * ≈ 1260 字，才装得下范文的 25.2% 份额。
 */
const MAX_PARAGRAPHS = 12;
// 段落数只做安全下限（防止把长章规划成几段），不作为文章结构的验收门槛。
const MIN_TOTAL_PARAGRAPHS = 20;
const MAX_TOTAL_PARAGRAPHS = 80;

/** 范文口径的全章目标字数（仅用于把份额换算成每拍目标字数）。 */
const CHAPTER_TARGET_CHARS = 5000;
/**
 * 对白承载比例。
 *
 * 范文实测对白占 17.99%（docs/superpowers/baseline/measure.py）。
 * 夜宴/审问这类题材容易把整章写成对话，规划阶段就要定目标并压住：
 * 默认 18%，上限 27%（范文 ×1.5），超出的信息必须落到叙述、心理与动作。
 */
const SAMPLE_DIALOGUE_PERCENT = 17.99;
const DIALOGUE_TARGET_DEFAULT = 18;
const DIALOGUE_TARGET_MIN = 14;
const DIALOGUE_TARGET_MAX = 27;

/**
 * 规划器给的对白目标：缺省按范文 18%，越界夹到 14–27。
 * 下限与形态自检同一来源（范文 -20%），低于它说明把该说的交锋写成了概述。
 * 这里是「目标」不是验收线，越界不判计划作废，避免为配比再拒一轮。
 */
function normalizeDialoguePercent(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return DIALOGUE_TARGET_DEFAULT;
  return Math.min(DIALOGUE_TARGET_MAX, Math.max(DIALOGUE_TARGET_MIN, Math.round(raw)));
}
/**
 * 范文段均字数（docs/superpowers/baseline/measure.py 实测 sample.md）。
 *
 * 段落数必须由目标字数反推，而不是让模型凭感觉给 3–12 段：
 * 5000 字的章节约 45 段，和范文的 45 段一致。写死 112 也避免
 * 「计划 26 段、正文 6328 字」这种平均 243 字一段的交付。
 */
const SAMPLE_MEAN_CHARS = 112.16;

/** 空钩子话术，出现即判不合格 */
const EMPTY_HOOKS = ['且听下回分解', '欲知后事', '下回分解'];

/** 回城/身世是本章的承重拍：并进「过渡」拍且份额过低，等于把身世交代糊过去。 */
const ARC_BEAT_RE = /回城|到家|进城|身世|寄养|旧事|年龄|籍贯/;
/**
 * 判「身世被并进过渡拍」只认身世语义，不认「回城」这个地点词。
 *
 * 范文里「下山议论」这一拍本来就发生在回城路上（25%），如果拿「回城」
 * 当判据，会把合法的途中议论拍全部打成「身世合并」，整章计划被拒后
 * 降级直写，后面的自检连跑都跑不到。
 */
const IDENTITY_MERGE_RE = /身世|寄养|旧事|年龄|籍贯|小时候|自幼|童年/;
/** 身世拍的最低份额 = 范文实测 identity 16.2%（见 SAMPLE_SHARES），不是手调值。 */
const ARC_MIN_SHARE = 16.2;

/**
 * 范文实测的六段功能配比（百分点，纯汉字占比）。
 *
 * 切分依据（sample.md 45 段，1-based 段号）：
 *   - opening 1–5（9.0%）：瞄准母鹿→松弦→箭偏→起身苦笑，完成「放走母鹿」的损失。
 *   - discussion 6–17（25.2%）：司马懿从雪堆出来，两人争论仁心/猎杀，随后上路、
 *     回城并议论河内形势；段 18 起转入籍贯回忆，不属议论。
 *   - identity 18–23（16.2%）：P18「温县并非他的乡籍所在」起，插叙籍贯、父亲、
 *     寄养旧事与「如果一直这样生活下去」的安稳感，到 P23 止。
 *   - father 24–35（24.6%）：马蹄声打断→报信→回府→见杨俊→符传形制→司马防解释。
 *     P34–35 仍是长辈报信/解释，不是告别。
 *   - farewell 36–42（18.4%）：P36 末尾交弓起，接弓、拥抱、出府、上车、司马防托付。
 *   - departure 43–45（6.7%）：车出城，司马防喃喃与「许都」险恶的收束/钩子。
 *
 * 只看显式 function，不按文案关键词猜。模型可以写 6–8 拍，但每一类
 * 功能的目标份额是固定的；同类功能有多拍时按计划段数分摊。
 * 容差 ±5pp 由 checkWordShares 统一处理，这里只给中心值。
 *
 * 注：旧值 9 / 14 / 30 / 15.5 / 25 / 6.5 是推算值，全部作废；
 * 用户上一轮引用的 8.6 / 25.6 / 15.9 / 24.8 / 18.5 / 6.6 是同一刀切的
 * countWords（含标点）占比；本表按 targetChars 的口径换算成纯汉字。
 */
const SAMPLE_SHARES = Object.freeze({
  opening: 9.0,
  discussion: 25.2,
  identity: 16.2,
  father: 24.6,
  farewell: 18.4,
  departure: 6.7,
});

const SHARE_ROLES = [
  { role: 'opening', label: FUNCTION_LABELS.opening, target: SAMPLE_SHARES.opening },
  { role: 'discussion', label: FUNCTION_LABELS.discussion, target: SAMPLE_SHARES.discussion },
  { role: 'identity', label: FUNCTION_LABELS.identity, target: SAMPLE_SHARES.identity },
  { role: 'father', label: FUNCTION_LABELS.father, target: SAMPLE_SHARES.father },
  { role: 'farewell', label: FUNCTION_LABELS.farewell, target: SAMPLE_SHARES.farewell },
  { role: 'departure', label: FUNCTION_LABELS.departure, target: SAMPLE_SHARES.departure },
];
const SHARE_TOLERANCE = 5;

/** 功能拍覆盖：六类各至少一拍。 */
function functionCoverage(beats) {
  const covered = BEAT_FUNCTIONS.filter((fn) => beats.some((beat) => beat.function === fn));
  return {
    covered,
    missing: BEAT_FUNCTIONS.filter((fn) => !covered.includes(fn)),
  };
}

function classifyShareRole(beat) {
  return BEAT_FUNCTIONS.includes(beat.function) ? beat.function : '';
}

/**
 * 把每拍的份额换回「目标字数」，并由目标字数反推该给的段落数。
 *
 * R3 的约束只允许调这一拍的 paragraphs 与目标字数，不许为配比重排整章。
 * 段数一律按范文段均 112 字（measure.py 实测）折算：1345 字约 12 段，
 * 960 字约 9 段。以前只对 reference 模式的 shareRole 拍做校正，
 * 大纲模式完全交给模型，于是出现「26 段 / 6328 字」——写手只能靠合并硬凑段数。
 */
function applyTargetChars(beats) {
  for (const beat of beats) {
    const share = Number(beat.wordShare);
    if (!Number.isFinite(share)) continue;
    beat.targetChars = Math.round((share / 100) * CHAPTER_TARGET_CHARS);
    const desired = Math.min(
      MAX_PARAGRAPHS,
      Math.max(MIN_PARAGRAPHS, Math.round(beat.targetChars / SAMPLE_MEAN_CHARS))
    );
    beat.targetParagraphs = desired;
    // 差 1 段属于模型正常的取整抖动，不必推翻它；差 2 段以上才说明
    // 「段数」和「目标字数」真的对不上，才校正。
    if (Math.abs(desired - (Number(beat.paragraphs) || 0)) >= 2) {
      beat.paragraphs = desired;
    }
  }
}

/**
 * 按功能给每拍套用范文配比。
 *
 * 同类功能有多拍时按 paragraphs 权重分摊该功能的总份额；
 * 功能未分类的拍保留模型/段落折算出来的原始份额，并记进 functionMissing，
 * 交给路由重排——这里绝不按文案关键词替它猜一个功能。
 */
function applyReferenceShares(beats) {
  const byRole = new Map();
  for (const beat of beats) {
    beat.shareRole = classifyShareRole(beat);
    if (!beat.shareRole) continue;
    const rows = byRole.get(beat.shareRole) || [];
    rows.push(beat);
    byRole.set(beat.shareRole, rows);
  }

  for (const rule of SHARE_ROLES) {
    const rows = byRole.get(rule.role);
    if (!rows || !rows.length) continue;
    const totalParagraphs = rows.reduce((sum, beat) => sum + Math.max(1, beat.paragraphs || 1), 0);
    for (const beat of rows) {
      const weight = Math.max(1, beat.paragraphs || 1);
      beat.wordShare = Math.round(rule.target * (weight / totalParagraphs) * 10) / 10;
    }
  }

  // 未分类的拍也要有可比的区间：沿用原来折算出来的份额作为中心值。
  for (const beat of beats) {
    if (!beat.shareRole) beat.shareRole = '';
  }

  const coverage = functionCoverage(beats);
  return coverage.missing;
}

/** 完整交付的机械识别：把某人交给某人。预备动作（递、接、握住手）不算。 */
const DELIVERY_FULL_RE = /把[\u4e00-\u9fa5]{2,4}交给[\u4e00-\u9fa5]{2,4}/;

function beatNarrative(beat) {
  return [beat.goal, beat.obstacle, beat.cost, beat.infoGain, beat.endHook].join('\n');
}

/** 覆盖证据的长度上限：够定位原句，又不至于把正文抄一遍 */
const MAX_EVIDENCE_CHARS = 30;

/**
 * 规划提示词。独立于 writer.js 的正文提示词——规划器只描述节拍表，
 * 不写正文，避免模型顺手开始写小说。
 */
const PLAN_PROMPT = `你是章节节拍规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
字段：chapterGoal, protagonistIntent, obstacle, cost, hook, avoidRepeat（数组，可为空）, mainType, beats[], dialoguePercent。
dialoguePercent：本章直接引语占全章正文字数的目标百分比；范文实测 18%，不得低于 14%，不得超过 27%。
对白承载不了的背景、判断与心理要写进 beats[].goal/infoGain，用叙述、动作与停顿推进，
不要把整拍的信息全塞进对话；夜宴、审问这类场景也要给叙述和动作留出份额，
但关键交锋不能只写概述——该由人物亲口说的，要排成有来有回的对白。
beats 6–8 个；每拍含 id（B1…Bn）、function、functionReason、type（行动|转折|冲突|揭示|决定|过渡|险露）、
goal、obstacle、cost、delta{variable:处境|关系|信息|决心, from, to}、infoGain、paragraphs（3–12）、
targetChars、wordShare、endHook（这一拍结束时的悬念或钩子）、entities（数组）、
scale（small|medium|large，默认 small）、pressure（心理|对峙|误导|动作）。
险露=人物在险境中被迫暴露信息（被试探、说漏、错拿），不是单纯遇险；每章至多 1 拍。
决定拍若会改变后文走向，设 critical=true 并给 options（2–3 个 {id,label,consequence}），
consequence 写清选它之后人物付出什么、失去什么；每章至多 1 拍 critical=true，其余拍不要给 options。
entities 列出这一拍出现的人名、物名、关键道具；只能用给定资料里出现过的人或物，
没有出处的一律不许写，也不许用「父亲/老师/领导」这类新角色代替已有角色。
function 只能取以下六类，且全章六类必须各出现至少一次（可以有同类多拍）：
- opening：开场。有外部对手施加压力、主角被叫走/被传唤，外部压力先一步打断当前场景。
  这一拍的 obstacle 必须写清对手是谁、用什么方式阻碍，正文会据此校验对手是否落进开场。
- discussion：同行议论且发生信息交换（谁告诉谁什么新信息）。
- identity：交代身世与旧日（年龄、籍贯、寄养、旧事）。
- father：长辈到场并带符传/传诏等制度性信物。
- farewell：交割与托付（交物、交人、留下可引用的话）。
- departure：上车出城/启程离场。
function 按事件语义判，不许按关键词猜：判断依据写进 functionReason，一句话说明「谁在场、发生什么、改变了什么」。
错误示例：把雪地猎鹿的开场拍写成 departure、把门前告别写成 departure、把回城身世并进过渡拍。
单章是 5000 字量级的长章：每拍 3–12 段，且全章合计必须落在 20–80 段之间（长章大致 35–65 段即可，
不必凑固定段数）；单拍上限与全章总区间同时生效，不能只满足其中一个。
paragraphs 是这一拍的段落数，硬上限 12；targetChars 是这一拍的目标纯汉字数（不含标点），
wordShare 是这一拍占全章正文的百分比。范文实测配比（纯汉字）：
opening 9%、discussion 25%、identity 16%、father 25%、farewell 18%、departure 7%，允许 ±5pp。
targetChars 与 wordShare 要能对上：targetChars ≈ wordShare × 5000 / 100。
身世只占 16%：范文把籍贯、父亲、寄养旧事拆进回城路上与府门口的对话里穿插交代（6 段），
不单独集中铺陈成长篇回忆；议论才是第二长拍（25%），靠一来一回的信息交换推进。
回城/身世这一拍不能并进过渡拍，目标份额低于 16% 会被判不合格。
每个节拍必须让至少一个变量发生改变，必须写出代价，禁止空转抒情段。
mainType 必须与某一个 beats[].type 相同。只依据给定上下文，不新增未提供的人物或设定；
情节卡里待写/进行中的节点要排进拍表，不要当作已发生事件写进 avoidRepeat；已完成的只承接不重演。`;

/**
 * 有本章大纲时的规划提示词。
 *
 * 这是 P1 的核心改动：不再套用范文的六类功能与固定份额，而是把作者
 * 给的本章大纲按因果拆成 4–8 拍。每拍仍要求「目标 / 阻碍 / 转折 / 代价」，
 * 保证写手拿到的是事件链，不是功能标签。
 *
 * 六类功能与份额只在没有本章大纲时走 PLAN_PROMPT 兜底。
 */
const OUTLINE_PLAN_PROMPT = `你是章节节拍规划器。只输出一个 JSON 对象，不要解释、不要 markdown、不要正文。
本章已有作者写好的大纲。请把大纲里的事件按因果顺序拆成 4–8 拍，不要套用任何固定功能模板。
字段：chapterGoal, protagonistIntent, obstacle, cost, hook, avoidRepeat（数组，可为空）, mainType, beats[], dialoguePercent。
dialoguePercent：本章直接引语占全章正文字数的目标百分比；范文实测 18%，不得低于 14%，不得超过 27%。
对白承载不了的背景、判断与心理要写进 beats[].goal/infoGain，用叙述、动作与停顿推进，
不要把整拍的信息全塞进对话；宴席、审问这类多对话场景也要给叙述和动作留出份额，
但关键交锋不能只写概述——该由人物亲口说的，要排成有来有回的对白。
每拍含 id（B1…Bn）、function（自由标签，如「入场」「试探」「冲突」「决定」，不要求六类）、
type（行动|转折|冲突|揭示|决定|过渡|险露）、goal、obstacle、turn（这一拍的转折）、cost、
delta{variable:处境|关系|信息|决心, from, to}、infoGain、paragraphs（3–12）、wordShare、endHook、entities（数组）、
scale（small|medium|large，默认 small）、pressure（心理|对峙|误导|动作）。
险露=人物在险境中被迫暴露信息（被试探、说漏、错拿），不是单纯遇险；每章至多 1 拍。
决定拍若会改变后文走向，设 critical=true 并给 options（2–3 个 {id,label,consequence}），
consequence 写清选它之后人物付出什么、失去什么；每章至多 1 拍 critical=true，其余拍不要给 options。

硬规则：
1. 4–8 拍；每拍 3–12 段，全章合计 20–80 段。
2. 每拍必须有主角的一个具体目标（他要做什么、想得到什么）、一个阻碍、一个转折、一个代价。
   主角不能只被事件推着走：他要主动做出至少一个选择，并承担选择的后果。
3. entities 列出这一拍出现的人名、物名、关键道具。只能用「可用实体」清单、本章大纲、
   本章情节卡里已经出现过的名字；这些来源之外的人名、物名、关键道具一律不许出现。
   不许用「父亲/老师/领导/陌生人」这类新角色来补拍，也不许新增证明、信件、名额之类
   这些来源里没有的关键道具。
4. 情节卡里 status=待写/进行中的节点是本章要发生的事件，应排进拍表，不要写进 avoidRepeat；
   status=已完成的节点才是已经写过的内容，只能承接、不得重演。
   不得新增本章大纲与情节卡都没有的事件，不得改变事件结果；可以细化动作、对话与场面。
5. 只依据给定资料，不新增人物或设定；卡里没有的东西不要补。
6. mainType 必须与某一个 beats[].type 相同。`;

/** 代词与泛称：不算「新实体」，不需要在资料里有出处。 */
const GENERIC_ENTITIES = new Set([
  '主角',
  '我',
  '他',
  '她',
  '他们',
  '她们',
  '我们',
  '你们',
  '自己',
  '对方',
  '众人',
  '有人',
  '人们',
  '旁白',
]);

/** 实体归一化：去空白与书名/引号，大小写不敏感。 */
function normalizeEntity(value) {
  return String(value == null ? '' : value)
    .replace(/[「」“”《》\s]/g, '')
    .toLowerCase();
}

/**
 * 把 grounding 资料压成一段可做包含判断的语料。
 *
 * 语料必须等于「规划器实际拿到的资料」，而不是它的一个子集：
 *   - 本章大纲、作者本次指令、作品信息；
 *   - 人物卡整张（名/别名/身份/性格/说话风格/目标/成长弧/关系/备注/弱点）；
 *   - 设定名与设定正文；
 *   - 素材标题与正文；
 *   - 本章情节卡（标题/备注）；
 *   - 上一章结尾原文（规划上下文里的「末句/衔接」）；
 *   - 分场 brief 里非 inferred 的条目（brief 会原样拼进规划提示词，
 *     其中的器物名/动作名本来就属于给定输入）。
 *
 * 旧实现只取人物姓名与设定名，于是人物卡身份里的「征辟」、上一章末句里的
 * 「弓」、brief 里的「名刺/门吏」都被判成找不到出处，规划被连着拒掉后只能
 * 降级直写——这不是「卡外可编」，是语料比提示词窄。
 *
 * 边界不变：以上来源之外的人名/物名/关键道具仍然找不到出处。
 * brief 里 inferred=true 的条目是模型推断，不能给自己当出处。
 */
function groundCorpus(ground) {
  if (!ground) return '';
  const briefItems = ground.brief && Array.isArray(ground.brief.items)
    ? ground.brief.items
        .filter((item) => item && item.inferred !== true)
        .flatMap((item) => [item.text, ...(Array.isArray(item.keywords) ? item.keywords : [])])
    : [];
  const parts = [
    ground.outline,
    ground.instruction,
    ground.workTitle,
    ground.workOutline,
    ground.synopsis,
    ground.previousChapter,
    ...(ground.characters || []).flatMap((row) => [
      row.name,
      row.aliases,
      row.identity,
      row.personality,
      row.speech,
      row.goal,
      row.arc,
      row.relations,
      row.notes,
      row.weakness,
      row.role,
    ]),
    ...(ground.settings || []).flatMap((row) => [row.name, row.category, row.content]),
    ...(ground.materials || []).flatMap((row) => [
      row.title,
      String(row.body || row.content || '').slice(0, 4000),
    ]),
    ...(ground.plotCards || []).flatMap((row) => [row.title, row.content]),
    ...briefItems,
  ];
  return normalizeEntity(parts.filter(Boolean).join('\n'));
}

function entityGrounded(entity, corpus) {
  const probe = normalizeEntity(entity);
  if (!probe) return true;
  if (GENERIC_ENTITIES.has(probe)) return true;
  return Boolean(corpus && corpus.includes(probe));
}

/**
 * 校验一拍的实体是否有出处。
 *
 * @param {Object} beat
 * @param {string} corpus
 * @returns {string[]} 没有出处的实体
 */
function ungroundedEntities(beat, corpus) {
  return (beat.entities || []).filter((entity) => !entityGrounded(entity, corpus));
}

const CARD_KIND_LABELS = Object.freeze({
  plot: '情节',
  character: '人物',
  setting: '设定',
  conflict: '冲突',
  foreshadow: '伏笔',
});
const CARD_STATUS_LABELS = Object.freeze({
  todo: '待写',
  doing: '进行中',
  done: '已完成',
});

/** 给规划提示词追加「可用实体」清单。 */
function buildGroundBlock(ground) {
  if (!ground) return '';
  const names = unique([
    ...(ground.characters || []).map((row) => row.name),
    ...(ground.settings || []).map((row) => row.name),
  ].filter(Boolean));
  const materials = unique((ground.materials || []).map((row) => row.title).filter(Boolean));
  const cards = (ground.plotCards || []).filter((card) => card && card.title);

  const lines = ['## 可用实体（人名 / 物名 / 关键道具只能从这里取）'];
  if (ground.outline) lines.push(`本章大纲：${ground.outline}`);
  lines.push(`人物与设定：${names.length ? names.join('、') : '（未登记，只能使用大纲里已有的名字）'}`);
  if (materials.length) lines.push(`素材：${materials.join('、')}`);
  if (cards.length) {
    lines.push(
      '本章情节卡（「待写/进行中」是本章要排进拍表的事件来源；「已完成」只承接、不重演）：'
    );
    for (const card of cards) {
      const kind = CARD_KIND_LABELS[card.kind] || '情节';
      const status = CARD_STATUS_LABELS[card.status] || '待写';
      const hint = card.status === 'done' ? '已完成：只承接，不重演' : `${status}：本章要写出`;
      const content = String(card.content || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      lines.push(
        `- [${kind}] ${String(card.title).slice(0, 60)}（${hint}）${content ? `：${content}` : ''}`
      );
    }
  }
  lines.push('清单、大纲与情节卡之外的人名、物名、关键道具一律不得出现。');
  return `\n\n---\n\n${lines.join('\n')}`;
}

/**
 * 自检提示词。
 *
 * 每拍必须带证据：只说「覆盖了」不给原句，等于让模型自己给自己打分。
 * 证据限 30 字，够定位到正文里的那一句，又不会把正文再抄一遍。
 * 同时明确：段数多少不是判缺拍的标准——拍是否落地看事件与变化，不看篇幅。
 */
const COVERAGE_PROMPT = `你是节拍覆盖检查器。只输出一个 JSON 对象，不要解释、不要 markdown。
输入是《节拍表》和一段正文。逐个节拍判断它是否真正落到正文里：
- covered：该拍的 goal 或 obstacle 能在正文里找到对应的事件句，并且 delta.from→to 或 infoGain 至少有一项能找到对应句。
  每项写成 {"id":"B1","evidence":"正文里的原句或片段"}；evidence 不超过 30 个字，必须能在正文中逐字找到。
  没有 evidence 的拍不算 covered。
- weak：写了事件，但没有写出变量变化（元素为 {id, reason}）。
- missing：完全不满足 covered 的条件，或整拍被「总之/后来/从此」类总结句替代。
段数多少不是判断标准：某拍只写了两段，只要事件和变化都在，也照常算 covered。
- repeatViolations：逐条核对节拍表的 avoidRepeat（上一章已经写过、本章不得重演的旧事件）。
  正文若重演了其中某条，把重演的那句原文放进来；没有重演就输出空数组。
另需判断章末最后一段的收束质量（不要只判「有没有钩子」）：
- newInfo：最后一段是否带来前文没有的新信息（新事实、新代价、新发现）。
- unresolvedDecision：最后一段是否留下一个后果未定的决定或动作。
- repeatedImagery：最后一段是否重复前文已经出现过的意象或描写
  （同一比喻、同一种天气、同一件道具的同一细节）。
hookPresent 仅在（newInfo 或 unresolvedDecision）且 repeatedImagery=false 时为 true；
只重复前文意象、没有新信息，不算钩子。
chapterGoalMet：正文是否回答了 chapterGoal 的人物+动作+结果。
输出字段：covered（数组）、missing（数组）、weak（数组）、chapterGoalMet（布尔）、
ending（对象，三个布尔字段：newInfo / unresolvedDecision / repeatedImagery）、
repeatViolations（字符串数组）。
只使用节拍表里出现过的 id，不要编造。`;

function text(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function unique(list) {
  return Array.from(new Set(list));
}

/**
 * 归一化关键抉择的选项。
 *
 * 只保留 label 与 consequence 都非空的项：缺后果的选项没法让作者判断，
 * 留着只会制造「选了也没什么变化」的错觉。id 缺失或重复时按序号补，
 * 保证作者点的那一项在恢复时能被准确认出来。
 */
function normalizeDecisionOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const label = text(item.label);
    const consequence = text(item.consequence);
    if (!label || !consequence) return;
    let id = text(item.id) || `o${index + 1}`;
    if (seen.has(id)) id = `o${index + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, label, consequence });
  });
  return out.slice(0, PAUSE_OPTION_MAX);
}

/**
 * 校验并归一化一份节拍表。
 *
 * 校验放在服务端，不交给模型自觉：一份缺代价、缺信息增量或段落数
 * 注水的表，会让写手写成流水账，而作者只会怪「AI 写得不好」。
 *
 * @param {Object|string} candidate 模型输出（对象或 JSON 原文）
 * @param {Object} [options]
 * @param {'outline'|'reference'} [options.mode] outline=按本章大纲规划；reference=无大纲时用范文六类兜底
 * @param {Object} [options.ground] 实体接地资料（本章大纲/人物卡/设定/素材）
 * @param {string[]} [options.allowedTypes] 本作品允许的节拍类型；险露 只在模板启用时传入
 * @param {string} [options.previousMainType] 上一章 mainType，用于相邻章不得同为 险露
 * @returns {{ok: boolean, plan: Object|null, errors: string[]}}
 */
function validateBeatPlan(candidate, options = {}) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  const errors = [];
  const outlineMode = options.mode === 'outline';
  const ground = options.ground || null;
  const corpus = groundCorpus(ground);
  const allowedTypes = Array.isArray(options.allowedTypes)
    ? options.allowedTypes.filter((type) => BEAT_TYPES.includes(type))
    : BEAT_TYPES;
  const allowedSet = new Set(allowedTypes);
  const previousMainType = text(options.previousMainType);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, plan: null, errors: ['没有解析出 JSON 对象'] };
  }

  const chapterGoal = text(data.chapterGoal);
  const protagonistIntent = text(data.protagonistIntent);
  const obstacle = text(data.obstacle);
  const cost = text(data.cost);
  const hook = text(data.hook);
  const mainType = text(data.mainType);
  const avoidRepeat = Array.isArray(data.avoidRepeat)
    ? data.avoidRepeat.map((x) => text(x)).filter(Boolean)
    : [];

  for (const [key, value] of Object.entries({
    chapterGoal,
    protagonistIntent,
    obstacle,
    cost,
    hook,
  })) {
    if (!value) errors.push(`顶层字段 ${key} 不能为空`);
  }
  if (EMPTY_HOOKS.some((word) => hook.includes(word))) {
    errors.push('hook 不能是「且听下回分解」式空钩');
  }
  if (mainType && !allowedSet.has(mainType)) {
    errors.push(
      `mainType 必须是本作品允许的节拍类型之一（${allowedTypes.join('/')}），收到「${mainType}」`
    );
  }
  if (mainType === DANGER_TYPE && previousMainType === DANGER_TYPE) {
    errors.push('上一章 mainType 已是 险露，相邻两章不得同为 险露');
  }

  const rawBeats = Array.isArray(data.beats) ? data.beats : [];
  if (rawBeats.length < MIN_BEATS || rawBeats.length > MAX_BEATS) {
    errors.push(`节拍数必须在 ${MIN_BEATS}–${MAX_BEATS} 之间，收到 ${rawBeats.length}`);
  }

  const beats = [];
  const functionReasonMissing = [];
  let totalParagraphs = 0;

  rawBeats.forEach((beat, index) => {
    const where = `第 ${index + 1} 拍`;
    if (!beat || typeof beat !== 'object') {
      errors.push(`${where}不是对象`);
      return;
    }

    const id = text(beat.id) || `B${index + 1}`;
    const type = text(beat.type);
    const rawFunction = text(beat.function);
    // 有大纲时 function 只是自由标签（入场/试探/冲突…），不再要求落在六类里；
    // 没有大纲时才用六类功能与范文份额兜底。
    const beatFunction = outlineMode
      ? rawFunction.slice(0, 20)
      : BEAT_FUNCTIONS.includes(rawFunction)
        ? rawFunction
        : '';
    const functionReason = text(beat.functionReason);
    const goal = text(beat.goal);
    const beatObstacle = text(beat.obstacle);
    const beatCost = text(beat.cost);
    const turn = text(beat.turn);
    const infoGain = text(beat.infoGain);
    const endHook = text(beat.endHook);
    const entities = Array.isArray(beat.entities)
      ? beat.entities.map((x) => text(x)).filter(Boolean)
      : null;
    const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
    const variable = text(delta.variable);
    const from = text(delta.from);
    const to = text(delta.to);
    const paragraphs = Number(beat.paragraphs);
    const rawScale = text(beat.scale).toLowerCase();
    const scale = rawScale || DEFAULT_SCALE;
    const pressure = text(beat.pressure);
    const rawCritical = beat.critical === true;
    const decisionOptions = normalizeDecisionOptions(beat.options);

    if (id !== `B${index + 1}`) errors.push(`${where}的 id 必须是 B${index + 1}，收到「${id}」`);
    if (!allowedSet.has(type)) {
      errors.push(
        `${where}的 type 不合法：${type || '空'}（本作品允许：${allowedTypes.join('/')}）`
      );
    }
    if (!SCALE_VALUES.includes(scale)) {
      errors.push(`${where}的 scale 必须是 small/medium/large，收到「${rawScale}」`);
    }
    if (pressure && !PRESSURE_VALUES.includes(pressure)) {
      errors.push(`${where}的 pressure 必须是 心理/对峙/误导/动作，收到「${pressure}」`);
    }
    // 关键抉择：只有「决定」拍能挂暂停点，且必须给 2–3 个带后果的选项。
    // 缺选项的 critical 拍会让作者点进一个空面板，比不暂停更糟。
    if (rawCritical) {
      if (type !== DECISION_TYPE) {
        errors.push(`${where}只有 type=决定 的拍可以设 critical，收到「${type || '空'}」`);
      } else if (
        decisionOptions.length < PAUSE_OPTION_MIN ||
        decisionOptions.length > PAUSE_OPTION_MAX
      ) {
        errors.push(
          `${where}标了 critical，必须给 ${PAUSE_OPTION_MIN}–${PAUSE_OPTION_MAX} 个带 label 与 consequence 的选项`
        );
      }
    }
    // function 缺失/非法不直接判计划作废：作废会掉进整章直写，比缺分类更糟。
    // 这里只记为「未分类」，由路由重排一次；重排后仍缺才写进 plan_degraded。
    if (!outlineMode && !beatFunction) {
      functionReasonMissing.push(`${id}:未分类${rawFunction ? `(${rawFunction})` : ''}`);
    } else if (!outlineMode && functionReason.length < 8) {
      functionReasonMissing.push(`${id}:缺判定依据`);
    }

    // 实体接地：有大纲时必须给 entities（可为空数组），且每一项都要有出处。
    // 没有大纲时只记警告，不拒绝——此时作者就是让模型从零构思。
    if (entities === null) {
      if (outlineMode) errors.push(`${where}缺少 entities 数组`);
    } else if (outlineMode && ground) {
      const invented = ungroundedEntities({ entities }, corpus);
      if (invented.length) {
        errors.push(
          `${where}的实体「${invented.join('、')}」在本章大纲/人物卡/设定/素材里找不到出处`
        );
      }
    }
    for (const [key, value] of Object.entries({ goal, obstacle: beatObstacle, cost: beatCost })) {
      if (!value) errors.push(`${where}的 ${key} 不能为空`);
    }
    if (!DELTA_VARIABLES.includes(variable)) {
      errors.push(`${where}的 delta.variable 必须是处境/关系/信息/决心之一`);
    }
    if (!from || !to) errors.push(`${where}的 delta.from / delta.to 不能为空`);
    if (from && to && from === to) errors.push(`${where}的 delta.from 与 to 不能相同`);
    if (infoGain.length < 8) errors.push(`${where}的 infoGain 至少 8 个字`);
    if (!endHook) errors.push(`${where}的 endHook 不能为空`);
    if (!Number.isInteger(paragraphs) || paragraphs < MIN_PARAGRAPHS || paragraphs > MAX_PARAGRAPHS) {
      errors.push(`${where}的 paragraphs 必须是 ${MIN_PARAGRAPHS}–${MAX_PARAGRAPHS} 的整数`);
    } else {
      totalParagraphs += paragraphs;
    }

    const rawShare = Number(beat.wordShare);
    beats.push({
      id,
      planMode: outlineMode ? 'outline' : 'reference',
      function: beatFunction,
      functionReason,
      type,
      goal,
      obstacle: beatObstacle,
      turn,
      cost: beatCost,
      delta: { variable, from, to },
      infoGain,
      paragraphs: Number.isInteger(paragraphs) ? paragraphs : 0,
      wordShare: Number.isFinite(rawShare) && rawShare > 0 && rawShare <= 100 ? rawShare : null,
      endHook,
      entities: entities || [],
      scale: SCALE_VALUES.includes(scale) ? scale : DEFAULT_SCALE,
      pressure: PRESSURE_VALUES.includes(pressure) ? pressure : '',
      critical:
        rawCritical &&
        type === DECISION_TYPE &&
        decisionOptions.length >= PAUSE_OPTION_MIN &&
        decisionOptions.length <= PAUSE_OPTION_MAX,
      options:
        rawCritical && type === DECISION_TYPE ? decisionOptions : [],
    });
  });

  // 险露与两个可选字段都是「全章配额」，单拍校验看不出来，必须按整份表再数一遍。
  const dangerBeats = beats.filter((beat) => beat.type === DANGER_TYPE);
  if (dangerBeats.length > 1) {
    errors.push(`每章至多 1 拍 险露，收到 ${dangerBeats.length} 拍（${dangerBeats.map((b) => b.id).join('、')}）`);
  }
  const largeBeats = beats.filter((beat) => beat.scale === 'large');
  if (largeBeats.length > 1) {
    errors.push(`一章 large 不得超过 1 拍，收到 ${largeBeats.length} 拍（${largeBeats.map((b) => b.id).join('、')}）`);
  }
  const actionPressureBeats = beats.filter((beat) => beat.pressure === '动作');
  if (actionPressureBeats.length > 1) {
    errors.push(`一章 pressure=动作 不得超过 1 拍，收到 ${actionPressureBeats.length} 拍（${actionPressureBeats.map((b) => b.id).join('、')}）`);
  }
  // 暂停点一次只能停在一个抉择上：两拍都 critical 时无法判断该等作者选哪一个。
  const criticalBeats = beats.filter((beat) => beat.critical);
  if (criticalBeats.length > 1) {
    errors.push(`每章至多 1 拍 critical（关键抉择），收到 ${criticalBeats.length} 拍（${criticalBeats.map((b) => b.id).join('、')}）`);
  }

  // wordShare：模型给齐了就按它的配比；缺项或合计明显不对，就按段落权重折算，
  // 保证每拍都有目标份额，而不是让某一拍静默缺失。
  const totalParagraphsForShare = beats.reduce((sum, b) => sum + (b.paragraphs || 0), 0);
  const rawShareTotal = beats.reduce((sum, b) => sum + (b.wordShare || 0), 0);
  const usableRawShare =
    beats.every((b) => b.wordShare !== null) && rawShareTotal >= 90 && rawShareTotal <= 110;
  for (const beat of beats) {
    if (usableRawShare) {
      beat.wordShare = Math.round(beat.wordShare * 10) / 10;
    } else if (totalParagraphsForShare > 0) {
      beat.wordShare = Math.round(((beat.paragraphs || 0) / totalParagraphsForShare) * 1000) / 10;
    } else {
      beat.wordShare = Math.round((100 / Math.max(1, beats.length)) * 10) / 10;
    }
    beat.plannedShare = beat.wordShare;
  }

  // 范文配比优先：有合法 function 的拍改用实测目标；未分类的拍保留原份额，
  // 但绝不按文案关键词补猜一个功能（猜错会让整章份额错位）。
  // 有大纲时完全按大纲自己的节奏，不再套范文份额。
  const shareMissing = outlineMode ? [] : applyReferenceShares(beats);
  const fnCoverage = functionCoverage(beats);
  // 六类功能是「5000 字长章 6–8 拍」的结构要求。短章（<6 拍）本来就排不下
  // 六类，不拿它判降级；功能字段仍按拍使用，只是不做全覆盖硬校验。
  const requireFunctions = !outlineMode && beats.length >= MIN_BEATS_WITH_FUNCTIONS;
  // 先按模型给的原始段数卡 20–80，再按目标字数反推段数。
  // 顺序不能反：反推后的段数几乎总在区间内，会把「模型给 96 段」这种
  // 明显越界的输入悄悄洗成合格计划。
  const rawParagraphs = beats.reduce((sum, beat) => sum + (Number(beat.paragraphs) || 0), 0);
  const rawParagraphsValid =
    rawParagraphs >= MIN_TOTAL_PARAGRAPHS && rawParagraphs <= MAX_TOTAL_PARAGRAPHS;
  if (beats.length && !rawParagraphsValid) {
    errors.push(`全章段落数必须在 ${MIN_TOTAL_PARAGRAPHS}–${MAX_TOTAL_PARAGRAPHS} 之间，收到 ${rawParagraphs}`);
  }
  if (rawParagraphsValid) applyTargetChars(beats);
  const adjustedParagraphs = beats.reduce((sum, beat) => sum + (beat.paragraphs || 0), 0);
  totalParagraphs = adjustedParagraphs;
  if (mainType && beats.length && !beats.some((b) => b.type === mainType)) {
    errors.push('mainType 必须与某一个节拍的 type 相同');
  }

  // 身世不能并进过渡拍：计划份额低于 20% 说明这一拍只是顺带提一句。
  // 只认身世语义，不认「回城」地点词——途中议论拍本来就发生在回城路上。
  // 这是范文结构规则，只在无大纲的兜底模式里生效。
  if (!outlineMode) {
    for (const beat of beats) {
      const planned = Number.isFinite(beat.plannedShare) ? beat.plannedShare : beat.wordShare;
      const identitySemantic = beat.function === 'identity' || IDENTITY_MERGE_RE.test(beatNarrative(beat));
      if (beat.type === '过渡' && identitySemantic && planned < ARC_MIN_SHARE) {
        errors.push(
          `${beat.id}把身世（寄养/年龄/籍贯/旧事）并进了过渡拍（计划份额仅 ${planned}%，应 ≥${ARC_MIN_SHARE}%），` +
            '身世必须单独成拍'
        );
      }
    }

    // 完整交付只能有一拍；两拍都写「把某人交给某人」就是重复交付。
    const deliveryBeats = beats.filter((beat) => DELIVERY_FULL_RE.test(beatNarrative(beat)));
    if (deliveryBeats.length > 1) {
      errors.push(
        `${deliveryBeats.map((b) => b.id).join('、')} 两拍都写了完整交付；交付全章只写一次`
      );
    }
  }

  if (errors.length) return { ok: false, plan: null, errors };

  // 无大纲的兜底模式不做实体硬校验（此时作者就是让模型从零构思），
  // 但把「资料里找不到出处」的实体记成警告，方便在 plan_degraded 里看见。
  const groundingWarnings = [];
  if (!outlineMode && ground) {
    for (const beat of beats) {
      const invented = ungroundedEntities(beat, corpus);
      if (invented.length) groundingWarnings.push(`${beat.id}:${invented.join('、')}`);
    }
  }

  return {
    ok: true,
    plan: {
      planMode: outlineMode ? 'outline' : 'reference',
      chapterGoal,
      protagonistIntent,
      obstacle,
      cost,
      hook,
      avoidRepeat,
      mainType,
      dialoguePercent: normalizeDialoguePercent(data.dialoguePercent),
      beats,
      totalParagraphs,
      shareMissing,
      functionCovered: fnCoverage.covered,
      functionMissing: requireFunctions ? fnCoverage.missing : [],
      functionReasonMissing: requireFunctions ? functionReasonMissing : [],
      groundingWarnings,
    },
    errors: [],
  };
}

/**
 * 「最接近合法」兜底：校验失败时不把整章丢给写手直写。
 *
 * 把可解析的节拍表按硬边界修复：段数夹到 3–12、缺失必填字段补占位、
 * 非法文不加猜测。修复后的表仍可能缺功能拍/缺对手，但至少保留
 * 事件链与篇幅结构，比「整章 85 段直写」更接近合格产物。
 *
 * @param {Object|string} candidate 模型最后一次输出
 * @param {Object} [options] 同 validateBeatPlan
 * @returns {Object|null}
 */
function salvageBeatPlan(candidate, options = {}) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const outlineMode = options.mode === 'outline';
  const ground = options.ground || null;
  const corpus = groundCorpus(ground);
  const allowedTypes = Array.isArray(options.allowedTypes)
    ? options.allowedTypes.filter((type) => BEAT_TYPES.includes(type))
    : BEAT_TYPES;
  const allowedSet = new Set(allowedTypes);
  const previousMainType = text(options.previousMainType);
  const rawBeats = Array.isArray(data.beats) ? data.beats : [];
  if (!rawBeats.length) return null;

  let beats = rawBeats.slice(0, MAX_BEATS).map((raw) => {
    const beat = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const delta = beat.delta && typeof beat.delta === 'object' ? beat.delta : {};
    const rawParagraphs = Number(beat.paragraphs);
    const paragraphs = Number.isInteger(rawParagraphs)
      ? Math.min(MAX_PARAGRAPHS, Math.max(MIN_PARAGRAPHS, rawParagraphs))
      : MIN_PARAGRAPHS;
    const rawShare = Number(beat.wordShare);
    const entities = Array.isArray(beat.entities)
      ? beat.entities.map((x) => text(x)).filter(Boolean)
      : [];
    const rawType = text(beat.type);
    const rawScale = text(beat.scale).toLowerCase();
    const pressure = text(beat.pressure);
    const rawCritical = beat.critical === true;
    const decisionOptions = normalizeDecisionOptions(beat.options);
    return {
      id: '',
      planMode: outlineMode ? 'outline' : 'reference',
      function: outlineMode
        ? text(beat.function).slice(0, 20)
        : BEAT_FUNCTIONS.includes(text(beat.function))
          ? text(beat.function)
          : '',
      functionReason: text(beat.functionReason),
      type: allowedSet.has(rawType) ? rawType : '过渡',
      goal: text(beat.goal) || '（原计划缺目标，按章目标推进）',
      obstacle: text(beat.obstacle) || '（原计划缺阻碍，按现有情境补写）',
      turn: text(beat.turn),
      cost: text(beat.cost) || '（原计划缺代价，按事件结果补写）',
      delta: {
        variable: DELTA_VARIABLES.includes(text(delta.variable)) ? text(delta.variable) : '处境',
        from: text(delta.from) || '原状',
        to: text(delta.to) || '新的处境',
      },
      infoGain: text(beat.infoGain) || '（原计划缺少信息增量，按现有事件补写）',
      paragraphs,
      wordShare: Number.isFinite(rawShare) && rawShare > 0 && rawShare <= 100 ? rawShare : null,
      endHook: text(beat.endHook) || '（原计划缺钩子，按下一拍推进）',
      entities,
      scale: SCALE_VALUES.includes(rawScale) ? rawScale : DEFAULT_SCALE,
      pressure: PRESSURE_VALUES.includes(pressure) ? pressure : '',
      critical:
        rawCritical &&
        allowedSet.has(rawType) &&
        rawType === DECISION_TYPE &&
        decisionOptions.length >= PAUSE_OPTION_MIN,
      options: decisionOptions,
    };
  });

  // 有大纲时，含无出处实体的拍直接拒绝，不交给写手去圆。
  // 剩下的拍不足 4 个就放弃计划，宁可直写也不写一章新人物。
  if (outlineMode && ground) {
    beats = beats.filter((beat) => ungroundedEntities(beat, corpus).length === 0);
    if (beats.length < 4) return null;
  }
  // 单章配额：修复时保留第一拍，其余就地降级，不因为配额问题丢掉整份事件链。
  // 相邻章同为 险露 由 mainType 兜底处理，这里只保证「每章至多 1 拍」。
  let seenDanger = false;
  let seenLarge = false;
  let seenAction = false;
  for (const beat of beats) {
    if (beat.type === DANGER_TYPE) {
      if (seenDanger) beat.type = '转折';
      else seenDanger = true;
    }
    if (beat.scale === 'large') {
      if (seenLarge) beat.scale = 'small';
      else seenLarge = true;
    }
    if (beat.pressure === '动作') {
      if (seenAction) beat.pressure = '心理';
      else seenAction = true;
    }
  }
  // 关键抉择同样只保留第一拍：修复时不因为多标了一拍 critical 就整份作废，
  // 停不下来的抉择点等于没停——但事件链与其余字段必须原样保留。
  let seenCritical = false;
  for (const beat of beats) {
    if (!beat.critical) {
      beat.options = [];
      continue;
    }
    if (seenCritical) {
      beat.critical = false;
      beat.options = [];
    } else {
      seenCritical = true;
    }
  }
  beats.forEach((beat, index) => {
    beat.id = `B${index + 1}`;
  });

  // mainType 兜底：上一章已是 险露 时丢弃本章 mainType（保留节拍），
  // 与 P.8.1「重试一次仍非法则丢弃 mainType 但保留节拍」一致。
  let mainType = text(data.mainType);
  if (!allowedSet.has(mainType) || (mainType === DANGER_TYPE && previousMainType === DANGER_TYPE)) {
    const fallback = beats.find((beat) => beat.type !== DANGER_TYPE) || beats[0];
    mainType = fallback ? fallback.type : '过渡';
  }

  const totalParagraphsForShare = beats.reduce((sum, b) => sum + (b.paragraphs || 0), 0);
  const rawShareTotal = beats.reduce((sum, b) => sum + (b.wordShare || 0), 0);
  const usableRawShare =
    beats.every((b) => b.wordShare !== null) && rawShareTotal >= 90 && rawShareTotal <= 110;
  for (const beat of beats) {
    if (usableRawShare) {
      beat.wordShare = Math.round(beat.wordShare * 10) / 10;
    } else if (totalParagraphsForShare > 0) {
      beat.wordShare = Math.round(((beat.paragraphs || 0) / totalParagraphsForShare) * 1000) / 10;
    } else {
      beat.wordShare = Math.round((100 / Math.max(1, beats.length)) * 10) / 10;
    }
    beat.plannedShare = beat.wordShare;
  }
  const shareMissing = outlineMode ? [] : applyReferenceShares(beats);
  applyTargetChars(beats);
  const fnCoverage = functionCoverage(beats);
  const requireFunctions = !outlineMode && beats.length >= MIN_BEATS_WITH_FUNCTIONS;
  const functionReasonMissing = [];
  if (requireFunctions) {
    for (const beat of beats) {
      if (!beat.function) functionReasonMissing.push(`${beat.id}:未分类`);
      else if (!beat.functionReason || beat.functionReason.length < 8) {
        functionReasonMissing.push(`${beat.id}:缺判定依据`);
      }
    }
  }

  return {
    planMode: outlineMode ? 'outline' : 'reference',
    chapterGoal: text(data.chapterGoal) || '（原计划缺章目标，按写作指令推进）',
    protagonistIntent: text(data.protagonistIntent) || '（原计划缺主角意图，按章目标推断）',
    obstacle: text(data.obstacle) || '（原计划缺主要阻碍）',
    cost: text(data.cost) || '（原计划缺代价）',
    hook: text(data.hook) || '（原计划缺钩子）',
    avoidRepeat: Array.isArray(data.avoidRepeat)
      ? data.avoidRepeat.map((x) => text(x)).filter(Boolean)
      : [],
    mainType,
    dialoguePercent: normalizeDialoguePercent(data.dialoguePercent),
    beats,
    totalParagraphs: beats.reduce((sum, beat) => sum + (beat.paragraphs || 0), 0),
    shareMissing,
    functionCovered: fnCoverage.covered,
    functionMissing: requireFunctions ? fnCoverage.missing : [],
    functionReasonMissing,
    salvaged: true,
  };
}

/**
 * 功能拍重排指令：只补缺的功能分类，不重写已经合格的事件。
 */
function buildFunctionReplanInstruction(plan, missing, reasonMissing = []) {
  const labels = missing.map((fn) => `${fn}（${FUNCTION_LABELS[fn]}）`).join('、');
  const current = (plan && plan.beats ? plan.beats : [])
    .map((beat) => `${beat.id}=${beat.function || '未分类'}`)
    .join('、');
  return [
    '（功能拍自检：节拍表的功能分类不完整，只做一次重排。）',
    `当前功能：${current || '无'}；缺少：${labels || '无'}。`,
    reasonMissing.length ? `判定依据缺失：${reasonMissing.join('、')}。` : '',
    '给每拍补 function（opening|discussion|identity|father|farewell|departure）与 functionReason（谁在场、发生什么、改变了什么）。',
    '按事件语义判，不许按关键词猜：opening=外部对手施压/被叫走；discussion=同行议论且信息交换；',
    'identity=交代身世旧日；father=长辈到场并带符传；farewell=交割托付；departure=上车出城。',
    '六类必须各至少一拍，全章 6–8 拍；每拍 3–12 段，全章合计 20–80 段；其余已经合格的拍保留原目标与事件，不要重写成新剧情。',
    '只输出完整节拍表 JSON，不要解释。',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 把节拍表格式化成给写手看的硬约束块。
 *
 * 放在 system 末尾、技能清单之前（由 assembleContext 插入）。
 * 正文里不插任何节拍标记——对账交给自检，不让作者看到 B1/B2 的噪音。
 *
 * @param {Object} plan validateBeatPlan 归一化后的 plan
 * @returns {string}
 */
function formatBeatPlan(plan) {
  if (!plan) return '';
  // 选项只在暂停面板里给作者看。写手拿到的是「已定」的那一项（由路由追加），
  // 这里若仍列出全部选项，模型会自己挑一个，作者的选择就白做了。
  const beats = Array.isArray(plan.beats)
    ? plan.beats.map((beat) => {
        if (!beat || !Array.isArray(beat.options) || !beat.options.length) return beat;
        const { options, ...rest } = beat;
        return rest;
      })
    : plan.beats;
  return [
    '## 本章节拍表（硬约束，必须覆盖）',
    '按 B1→Bn 顺序推进；每拍至少改变一个变量；不得把两拍合并成一段总结；正文里不要写节拍编号。',
    `本章对白占比目标 ${DIALOGUE_TARGET_MIN}–${DIALOGUE_TARGET_MAX}%（默认 ${DIALOGUE_TARGET_DEFAULT}%，范文 ${SAMPLE_DIALOGUE_PERCENT}%）：` +
      '同一轮交流写进同一段，不要一句一引号；低于下限要把关键交锋写成直接引语，' +
      '超出对白承载的背景、心理与判断改成叙述、动作和停顿。',
    JSON.stringify({ ...plan, beats }),
  ].join('\n');
}

/**
 * 证据核对前的归一化：只忽略空白。
 *
 * 模型抄原句时常把换行改成空格、多打一个空行；逐字比会把真证据判丢。
 * 除了空白之外不做任何宽松处理——标点、字词都要对得上。
 */
function normalizeEvidence(value) {
  return String(value || '').replace(/\s+/g, '');
}

/**
 * 章末最后一段是否在重复前文意象。
 *
 * 用二元组重合度判断：末段有 65% 以上的二元组已经在前文某段出现过，
 * 说明它主要在复述同一场景/比喻，而不是带来新信息。末段太短时不做机械判定，
 * 交给自检模型自己报 repeatedImagery。
 */
const ENDING_REPEAT_MIN_CHARS = 20;
const ENDING_REPEAT_SIMILARITY = 0.65;

function detectRepeatedEnding(body) {
  const paragraphs = String(body || '')
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (paragraphs.length < 2) return { repeated: false, index: -1 };
  const last = normalizeEvidence(paragraphs.pop());
  if (last.length < ENDING_REPEAT_MIN_CHARS) return { repeated: false, index: -1 };

  const bigrams = (value) => {
    const map = new Map();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const lastCounts = bigrams(last);
  for (let index = 0; index < paragraphs.length; index += 1) {
    const earlier = normalizeEvidence(paragraphs[index]);
    if (earlier.length < 8) continue;
    const earlierCounts = bigrams(earlier);
    let shared = 0;
    for (const [gram, count] of lastCounts) {
      const other = earlierCounts.get(gram) || 0;
      if (other) shared += Math.min(count, other);
    }
    if (shared / Math.max(1, last.length - 1) >= ENDING_REPEAT_SIMILARITY) {
      return { repeated: true, index };
    }
  }
  return { repeated: false, index: -1 };
}

/**
 * 校验自检结果。
 *
 * 以节拍表为准重新计算 missing：模型有时会给出自相矛盾的
 * covered / missing 列表，照抄会把已覆盖的拍报成缺拍，触发无意义重写。
 *
 * 证据必须真的出现在正文里（归一化空白后做包含判断）：
 * 只校验「evidence 非空」挡不住模型自己编一句原句——那样的 covered
 * 等于自评分，缺拍重写永远不会触发，作者看到的是全绿徽标和一篇没覆盖
 * 计划的稿子。正文拿不到时按未覆盖处理：宁可贵一点重写，不可放过。
 *
 * @param {Object|string} candidate 自检输出
 * @param {Object} plan 已校验的节拍表
 * @param {string} body 正文纯文本
 * @returns {Object|null} 合法返回覆盖报告，否则 null
 */
function validateCoverage(candidate, plan, body) {
  const data = typeof candidate === 'string' ? parseModelJson(candidate) : candidate;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!plan || !Array.isArray(plan.beats)) return null;

  const haystack = normalizeEvidence(body);
  const ids = plan.beats.map((b) => b.id);
  const toIds = (value, keyed) =>
    Array.isArray(value)
      ? value
          .map((x) => (keyed && x && typeof x === 'object' ? x.id : x))
          .map((x) => text(x))
          .filter((id) => ids.includes(id))
      : [];

  const weakIds = unique(toIds(data.weak, true));

  // covered 每项必须带 evidence：只有「覆盖了」三个字、没有原句，
  // 等于模型自己给自己打分，missing 会永远算不准。
  // 没有证据、或证据在正文里找不到的条目，一律按未覆盖处理，交给 missing 重算。
  const evidenceById = new Map();
  const claimed = [];
  for (const item of Array.isArray(data.covered) ? data.covered : []) {
    const id = text(item && typeof item === 'object' ? item.id : item);
    const evidence = text(item && typeof item === 'object' ? item.evidence : '');
    if (!ids.includes(id) || !evidence) continue;

    const probe = normalizeEvidence(evidence);
    if (!probe || !haystack.includes(probe)) continue;

    claimed.push(id);
    if (!evidenceById.has(id)) {
      evidenceById.set(id, Array.from(evidence).slice(0, MAX_EVIDENCE_CHARS).join(''));
    }
  }

  const covered = unique(claimed).filter((id) => !weakIds.includes(id));
  const evidence = covered.map((id) => ({ id, evidence: evidenceById.get(id) }));

  const modelMissing = unique(toIds(data.missing, false)).filter(
    (id) => !covered.includes(id) && !weakIds.includes(id)
  );
  const missing = unique([
    ...ids.filter((id) => !covered.includes(id) && !weakIds.includes(id)),
    ...modelMissing,
  ]);

  const weak = Array.isArray(data.weak)
    ? data.weak
        .filter((w) => w && ids.includes(text(w.id)))
        .map((w) => ({ id: text(w.id), reason: text(w.reason) }))
    : [];

  // 自检同时核对 avoidRepeat：规划器给出的「本章不要重演上一章的旧事件」
  // 不能只停在计划表里。违规片段随报告一起下发，作者能看到它被真的用上了。
  const repeatViolations = Array.isArray(data.repeatViolations)
    ? data.repeatViolations
        .map((x) => text(x))
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const avoidRepeat = Array.isArray(plan.avoidRepeat) ? plan.avoidRepeat : [];
  // 章末自检：从「有没有钩子」改成「最后一段有没有新信息/未决决定，且不重复前文意象」。
  // 兼容旧自检输出：只给 hookPresent 时按 newInfo 处理。
  const endingRaw = data.ending && typeof data.ending === 'object' && !Array.isArray(data.ending)
    ? data.ending
    : null;
  const legacyHook = data.hookPresent === true;
  const newInfo = endingRaw ? endingRaw.newInfo === true : legacyHook;
  const unresolvedDecision = endingRaw ? endingRaw.unresolvedDecision === true : false;
  const repeated = detectRepeatedEnding(body);
  const repeatedImagery = (endingRaw ? endingRaw.repeatedImagery === true : false) || repeated.repeated;
  const endingPassed = (newInfo || unresolvedDecision) && !repeatedImagery;

  return {
    covered,
    missing,
    weak,
    evidence,
    hookPresent: endingPassed,
    ending: {
      newInfo,
      unresolvedDecision,
      repeatedImagery,
      repeatedWith: repeated.repeated ? repeated.index : -1,
      passed: endingPassed,
    },
    chapterGoalMet: data.chapterGoalMet === true,
    avoidRepeat,
    repeatViolations,
  };
}

/**
 * 生成缺拍重写指令。
 *
 * 明确列出缺哪几拍、每拍该写出什么变化，并要求重写全文——
 * 不让模型局部拼接，否则补丁段落和原稿的语气、人称一定对不上。
 *
 * @param {Object} plan
 * @param {{missing: string[], weak: Array}} coverage
 * @param {string[]} [mustReveal] 首次出场章仍缺的背景事实
 * @returns {string}
 */
function buildRewriteInstruction(plan, coverage, mustReveal = [], handover = {}) {
  const byId = new Map((plan && plan.beats ? plan.beats : []).map((b) => [b.id, b]));
  const lines = [
    `（覆盖自检结果：正文没有完整覆盖节拍表。缺失：${(coverage.missing || []).join('、') || '无'}。）`,
    '请重写全文，按 B1→Bn 顺序补足下面这些节拍，不要局部插入，不要解释：',
  ];

  // 重写是整组/全文重来，最容易把上一章写过的旧事件再讲一遍。
  const avoidRepeat = Array.isArray(plan && plan.avoidRepeat)
    ? plan.avoidRepeat.filter(Boolean)
    : [];
  if (avoidRepeat.length) {
    lines.push(
      `本章不要重演上一章已经写过的事件：${avoidRepeat.join('；')}。` +
        '这些事件只能一句话交代后果，不得换个说法再讲一遍。'
    );
  }

  const handoverBeat = handover && handover.handoverBeat ? `第 ${handover.handoverBeat} 拍` : '';
  const dupIds = (coverage && coverage.handoverDuplicated) || [];
  if (handoverBeat) {
    lines.push(
      `本章交付只发生一次，${handoverBeat} 完成；其余拍不要重复托付话或重复交割，` +
        '最多保留递、接、握住手这类预备动作。'
    );
  }
  if (dupIds.length) {
    lines.push(
      `以下拍已经重复交付，必须删掉完整形态，只保留预备动作：${dupIds.join('、')}。`
    );
  }
  const withholdIds = (handover && handover.mustWithholdIds) || [];
  for (const id of withholdIds) {
    lines.push(
      `- ${id}：本拍只写形制细节与人物反应，不写制度结论，不替读者解释；` +
        '删掉所有关于私辟/传诏/符传/逾制/该不该的判断句。'
    );
  }
  for (const conflict of (handover && handover.invariantConflicts) || []) {
    if (!conflict || !conflict.beatId) continue;
    lines.push(
      `- ${conflict.beatId}：${conflict.label}应写「${conflict.expected}」，正文写成了「${conflict.actual}」；` +
        '同一事实只保留一个数，改成 brief 不变项里的值。'
    );
  }

  for (const id of coverage.missing) {
    const beat = byId.get(id);
    if (!beat) continue;
    lines.push(
      `- ${id}：目标「${beat.goal}」，阻碍「${beat.obstacle}」，代价「${beat.cost}」，` +
        `变量「${beat.delta.variable}」从「${beat.delta.from}」变为「${beat.delta.to}」，` +
        `结束时留下「${beat.endHook}」。`
    );
  }

  const weak = coverage.weak || [];
  for (const item of weak) {
    const beat = byId.get(item.id);
    if (!beat) continue;
    lines.push(
      `- ${item.id}（写了事件但没写出变化）：必须写出「${beat.delta.from}」到「${beat.delta.to}」的变化。`
    );
  }

  if (mustReveal.length) {
    lines.push(
      '同时必须交代以下背景事实（主角首次出场章，每项至少一句，写进对话或叙述，不得一句话带过）：'
    );
    for (const content of mustReveal) lines.push(`- ${content}`);
  }

  lines.push('保持已经合格的节拍，不要删掉它们。章末要留下 hook。');
  return lines.join('\n');
}

/**
 * 给作者看的编排徽标。没有问题时返回空串。
 *
 * @param {Object} params
 * @param {Object|null} params.coverage
 * @param {string} params.checkError
 * @param {boolean} params.rewrote
 * @param {boolean} params.rewriteFailed
 * @param {boolean} params.truncated
 * @returns {string}
 */
function beatBadge({ coverage, checkError, rewrote, rewriteFailed, truncated } = {}) {
  if (truncated) return '【编排自检：未自检（截断）】';
  if (checkError === 'time_budget') return '【编排自检：未自检（时间不足）】';
  // 重写本身成功了，但复核没跑成。此时手上的 missing 是重写前的旧报告，
  // 不能拿它冒充当前稿的结论，只能说复核未完成。
  if (checkError === 'recheck') return '【编排自检：已重写，复核未完成】';
  if (checkError || !coverage) return '【编排自检：未自检】';
  if (!coverage.missing.length) return '';
  if (rewriteFailed) {
    return `【编排自检：重写失败，保留第一版；缺 ${coverage.missing.join('、')}】`;
  }
  return rewrote
    ? `【编排自检：重写后仍缺 ${coverage.missing.join('、')}】`
    : `【编排自检：缺 ${coverage.missing.join('、')}】`;
}

/**
 * 给规划提示词追加类型可用性与单章配额。
 *
 * 险露 是阶段三扩展，只在历史悬疑模板启用时可用；非模板作品即使模型
 * 想「加一点紧张感」，也不能凭空多出一种类型。相邻章规则只带上一章
 * mainType，不额外查询上一章正文。
 */
function buildBeatTypeBlock({ allowedTypes = BEAT_TYPES, previousMainType = '' } = {}) {
  const lines = [
    '单拍可选字段：scale（small|medium|large，默认 small；一章 large 至多 1 拍）、' +
      'pressure（心理|对峙|误导|动作；一章 动作 至多 1 拍）。',
  ];
  if (allowedTypes.includes(DANGER_TYPE)) {
    lines.push(
      '本作品已启用历史悬疑模板：type 可用 险露（每章至多 1 拍）。' +
        '险露拍要让人物在险境中被迫暴露信息（被试探、说漏、错拿），不是单纯遇险。'
    );
  } else {
    lines.push(
      `本作品未启用历史悬疑模板：禁止使用 险露 类型，type 只能取 ${allowedTypes.join('|')}。`
    );
  }
  if (previousMainType === DANGER_TYPE) {
    lines.push('上一章 mainType=险露；相邻两章不得同为 险露，本章 mainType 不要再选 险露。');
  }
  return `\n\n${lines.join('\n')}`;
}

/**
 * 规划调用。
 *
 * 失败一律返回 plan=null，由路由降级直写——规划只是增强，
 * 不能因为它挂掉就让整轮起稿失败。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {string} params.systemPrompt 与写作共用的上下文快照
 * @param {string} params.instruction 作者本次的写作指令
 * @param {Object} [params.options] temperature/model/thinking/signal
 * @param {'outline'|'reference'} [params.planMode] 有本章大纲时按大纲拆拍；否则用范文六类兜底
 * @param {Object} [params.ground] 实体接地资料
 * @param {string[]} [params.allowedTypes] 本作品允许的节拍类型
 * @param {string} [params.previousMainType] 上一章 mainType
 * @returns {Promise<{plan: Object|null, raw: string, errors: string[], reason: string}>}
 */
async function generateBeatPlan({
  provider,
  systemPrompt,
  instruction,
  options = {},
  planMode = 'reference',
  ground = null,
  allowedTypes = BEAT_TYPES,
  previousMainType = '',
}) {
  const signal = options.signal || null;
  const outlineMode = planMode === 'outline';
  const prompt = outlineMode ? OUTLINE_PLAN_PROMPT : PLAN_PROMPT;
  const groundBlock = ground ? buildGroundBlock(ground) : '';
  const typeBlock = buildBeatTypeBlock({ allowedTypes, previousMainType });
  let lastRaw = '';
  let lastErrors = [];
  let lastUsage = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal && signal.aborted) {
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'timeout', usage: lastUsage };
    }

    const repairTail = outlineMode
      ? '按错误清单修正，必须保留本章大纲的事件与结果；只使用可用实体里的人名、物名、关键道具，' +
        '不得新增大纲没有的人物、证明、名额之类的东西；4–8 拍，每拍写清目标/阻碍/转折/代价。'
      : '请在保留可用节拍的前提下按错误清单修正：格式/段数/份额错误的拍就地改，' +
        '缺身世拍或对手拍就补一拍；只输出完整的合格 JSON，不要解释，不要省略任何一拍。';

    const userContent = attempt === 0
      ? `请为这一章生成节拍表。选题：${instruction}`
      : `上一次输出不合格：${lastErrors.join('；')}。` +
        repairTail +
        (lastRaw ? `\n上一次输出：\n${lastRaw}` : '');

    try {
      const result = await provider.chat({
        messages: [
          { role: 'system', content: `${systemPrompt}\n\n---\n\n${prompt}${groundBlock}${typeBlock}` },
          { role: 'user', content: userContent },
        ],
        ...options,
        jsonOutput: true,
        // 实测：6 拍 / 45 段的完整节拍表约 1558 tokens；加上 functionReason、
        // targetChars 与 8 拍上限，2600 才留得住余量，2000 会在末拍截断。
        maxTokens: 2600,
      });

      lastRaw = String(result.content || '');
      lastUsage = result.usage || null;
      const check = validateBeatPlan(lastRaw, {
        mode: planMode,
        ground,
        allowedTypes,
        previousMainType,
      });
      if (check.ok) {
        return { plan: check.plan, raw: lastRaw, errors: [], reason: '', usage: lastUsage };
      }
      lastErrors = check.errors;
    } catch (err) {
      if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
        return {
          plan: null,
          raw: lastRaw,
          errors: lastErrors,
          reason: err.code === 'AI_ABORTED' ? 'aborted' : 'timeout',
          usage: lastUsage,
        };
      }
      return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'error', usage: lastUsage };
    }
  }

  // R4：两次都不合格时按「最接近合法」的版本交付，不丢给写手直写。
  // 修复只夹边界与补占位，不猜剧情；缺功能拍/对手会在 plan_degraded 里写明。
  // 有大纲时，salvage 会再拒绝含无出处实体的拍，避免「父亲+证明」混进正文。
  const salvaged = salvageBeatPlan(lastRaw, {
    mode: planMode,
    ground,
    allowedTypes,
    previousMainType,
  });
  if (salvaged) {
    return { plan: salvaged, raw: lastRaw, errors: lastErrors, reason: 'salvaged', usage: lastUsage };
  }
  return { plan: null, raw: lastRaw, errors: lastErrors, reason: 'invalid', usage: lastUsage };
}

/**
 * 覆盖自检调用。失败返回 null，由路由按「未自检」交付。
 *
 * @param {Object} params
 * @param {Object} params.provider
 * @param {Object} params.plan
 * @param {string} params.body 正文纯文本
 * @param {Object} [params.options]
 * @returns {Promise<{coverage: Object|null, reason: string}>}
 */
async function checkBeatCoverage({ provider, plan, body, options = {} }) {
  if (!plan || !body || !body.trim()) return { coverage: null, reason: 'no_body' };

  try {
    const result = await provider.chat({
      messages: [
        { role: 'system', content: COVERAGE_PROMPT },
        {
          role: 'user',
          content: `《节拍表》\n${JSON.stringify(plan)}\n\n《正文》\n${body.slice(0, 20000)}`,
        },
      ],
      ...options,
      // 自检只需要判断，不需要发散。
      temperature: 0.2,
      jsonOutput: true,
      maxTokens: 800,
    });

    const coverage = validateCoverage(result.content, plan, body);
    return {
      coverage,
      reason: coverage ? '' : 'invalid',
      usage: result.usage || null,
    };
  } catch (err) {
    if (err.code === 'AI_TIMEOUT' || err.code === 'AI_ABORTED' || err.name === 'TimeoutError') {
      return { coverage: null, reason: 'timeout', usage: null };
    }
    return { coverage: null, reason: 'error', usage: null };
  }
}

/** 纯汉字计数：篇幅配比只看正文汉字，不含标点与空白。 */
function cjkCount(value) {
  return Array.from(String(value || '')).filter((ch) => /[\u4e00-\u9fff]/.test(ch)).length;
}

function shareParagraphRanges(beats, paragraphCount) {
  const weights = beats.map((beat) => Math.max(1, Number(beat.paragraphs) || 1));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const ranges = [];
  let from = 0;
  for (let i = 0; i < beats.length; i += 1) {
    const last = i === beats.length - 1;
    const to = last
      ? paragraphCount
      : Math.min(paragraphCount, Math.max(from, from + Math.round((weights[i] / totalWeight) * paragraphCount)));
    ranges.push([from, to]);
    from = to;
  }
  return ranges;
}

/**
 * 正文实际篇幅配比：逐拍量纯汉字，和目标 wordShare 比，超过 ±5pp 就记账。
 *
 * 只报告、不改写——配比是规划问题，重写逃不出一份本来就失衡的节拍表。
 *
 * @param {Object} plan 已校验节拍表
 * @param {string} body 正文
 * @param {number} [tolerance=5] 允许偏离的百分点
 * @returns {{applicable: boolean, total: number, beats: Array, outOfRange: string[],
 *           shareMissing: string[], reason?: string}}
 */
function checkWordShares(plan, body, tolerance = SHARE_TOLERANCE) {
  const beats = plan && Array.isArray(plan.beats) ? plan.beats : [];
  const paragraphs = String(body || '')
    .split(/\n+/)
    .map((row) => row.trim())
    .filter(Boolean);
  const emptyRoleShares = SHARE_ROLES.map((rule) => ({
    function: rule.role,
    label: rule.label,
    target: rule.target,
    range: [rule.target - tolerance, rule.target + tolerance],
    share: null,
    hit: false,
    present: false,
  }));
  if (!beats.length || !paragraphs.length) {
    return {
      applicable: false,
      total: 0,
      countTotal: 0,
      beats: [],
      roleShares: emptyRoleShares,
      outOfRange: [],
      shareMissing: [],
    };
  }

  // 按大纲拆拍时不套范文的功能份额：function 是自由标签，没有「discussion 25%」
  // 这种目标。份额验收只在无大纲的六类兜底模式里生效；但每拍的字数与总字数
  // 仍要算出来——扩写判断靠它，不能因为不验配比就看不到「全章只有 4735 字」。
  const outlineMode = Boolean(plan && plan.planMode === 'outline');

  const ranges = shareParagraphRanges(beats, paragraphs.length);
  const rows = [];
  const total = cjkCount(paragraphs.join(''));
  // 扩写闸门的「5000 字」是作者口径的 countWords（含标点），与 measure.py 一致；
  // total 是纯汉字，只用于拍份额。两者都返回，别混用。
  const countTotal = countWords(paragraphs.join('\n'));
  for (let i = 0; i < beats.length; i += 1) {
    const [from, to] = ranges[i];
    const chars = to > from ? cjkCount(paragraphs.slice(from, to).join('')) : 0;
    const share = total > 0 ? Math.round((chars / total) * 1000) / 10 : 0;
    const target = Number(beats[i].wordShare);
    const beatFunction = BEAT_FUNCTIONS.includes(beats[i].function) ? beats[i].function : '';
    const hasTarget = Number.isFinite(target);
    rows.push({
      id: beats[i].id,
      function: beatFunction,
      label: FUNCTION_LABELS[beatFunction] || '',
      target: hasTarget ? target : null,
      range: hasTarget ? [Math.round((target - tolerance) * 10) / 10, Math.round((target + tolerance) * 10) / 10] : null,
      share,
      delta: hasTarget ? Math.round((share - target) * 10) / 10 : null,
      hit: hasTarget ? Math.abs(share - target) <= tolerance : false,
      chars,
    });
  }

  if (outlineMode) {
    return {
      applicable: false,
      reason: 'outline_mode',
      total,
      countTotal,
      beats: rows,
      roleShares: emptyRoleShares,
      outOfRange: [],
      shareMissing: [],
    };
  }

  // 按功能汇总：检查表要的是「discussion 25%、farewell 18%」这类实测配比，
  // 不是逐拍数字。同类功能多拍时把实际份额相加再和规则目标比。
  const roleShares = SHARE_ROLES.map((rule) => {
    const sameRole = rows.filter((row) => row.function === rule.role);
    const share = sameRole.length
      ? Math.round(sameRole.reduce((sum, row) => sum + row.share, 0) * 10) / 10
      : null;
    return {
      function: rule.role,
      label: rule.label,
      target: rule.target,
      range: [rule.target - tolerance, rule.target + tolerance],
      share,
      hit: sameRole.length ? Math.abs(share - rule.target) <= tolerance : false,
      present: sameRole.length > 0,
    };
  });

  const shareMissing = Array.isArray(plan?.shareMissing) ? plan.shareMissing : [];
  // 六段功能拍没排齐时，剩余目标份额合计不到 100：再按绝对配比逐个判越界，
  // 等于把「计划缺拍」伪装成「正文每一拍都写错」。这里只报缺哪类功能拍，
  // 不产出逐拍越界清单；结构问题归规划层，不赖在写手身上。
  if (shareMissing.length) {
    return {
      applicable: false,
      reason: 'share_missing',
      shareMissing,
      total,
      countTotal,
      beats: rows,
      roleShares,
      outOfRange: [],
    };
  }
  const outOfRange = rows
    .filter((row) => row.target !== null && Math.abs(row.delta) > tolerance)
    .map((row) => row.id);
  return { applicable: true, total, countTotal, beats: rows, roleShares, outOfRange, shareMissing };
}

module.exports = {
  BEAT_TYPES,
  BEAT_FUNCTIONS,
  FUNCTION_LABELS,
  DELTA_VARIABLES,
  DANGER_TYPE,
  DECISION_TYPE,
  PAUSE_OPTION_MIN,
  PAUSE_OPTION_MAX,
  SCALE_VALUES,
  PRESSURE_VALUES,
  SAMPLE_SHARES,
  SHARE_ROLES,
  SHARE_TOLERANCE,
  PLAN_PROMPT,
  OUTLINE_PLAN_PROMPT,
  COVERAGE_PROMPT,
  validateBeatPlan,
  salvageBeatPlan,
  functionCoverage,
  buildFunctionReplanInstruction,
  checkWordShares,
  validateCoverage,
  formatBeatPlan,
  buildRewriteInstruction,
  beatBadge,
  generateBeatPlan,
  checkBeatCoverage,
};
