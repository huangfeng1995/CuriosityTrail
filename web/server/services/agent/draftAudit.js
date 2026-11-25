'use strict';

/**
 * 写后确定性审查。
 *
 * 正文落定后要跑的一串检查：托付是否重复交付、悬念是否被提前解释、
 * 不变项有没有前后矛盾、篇幅配比、段落形态。全部是本地字符串/结构比对，
 * 不调模型、不发事件、不落库——原先内联在 /chat 里，抽出来后可单独断言。
 *
 * 覆盖自检（beatCheck）是模型给的，不在这里：这一层只负责「正文自己说话」的部分。
 */

const planBrief = require('./planBrief');
const segmentWriter = require('./segmentWriter');
const { checkWordShares } = require('./beatPlan');

/**
 * @param {Object} params
 * @param {Object|null} params.plan 节拍表；规划降级时为 null
 * @param {Object|null} params.brief 分场 brief
 * @param {string} params.text 本次交付的正文
 * @returns {{
 *   handover: Object,
 *   withhold: Object,
 *   invariant: Object,
 *   wordShares: Object|null,
 *   shape: Object,
 *   shapeDelivery: Object,
 *   shapeIds: string[]
 * }}
 */
function auditDraft({ plan = null, brief = null, text = '' } = {}) {
  // 交付只允许一次：确定性扫正文，不依赖模型自检。
  const handover = planBrief.findHandoverDuplicates(brief, text, plan);

  // 悬念自检：同一拍里制度词和结论词同时出现就判「把悬念解释掉」。
  // 与覆盖自检独立：模型说拍子写完了，但把制度结论讲完，仍然算违规。
  const withhold = planBrief.checkMustWithhold(brief, text, plan);

  // 同章一致性：同一不变项在正文里出现两个数（十年/十五年、六岁/七岁）即判冲突。
  const invariant = planBrief.checkInvariantConsistency(brief, text, plan);

  // 篇幅配比只记账：按纯汉字量，与每拍 wordShare 目标比，超出 ±5pp 就列出拍号。
  const wordShares = plan ? checkWordShares(plan, text) : null;

  // 段落形态自检：分布校验（数值来自范文实测）。硬拦只有单段 >320；
  // 40–79 段占比超范文 +10pp、连续 3 段 <40、段均偏离 ±15%、每拍段数 ±2
  // 都算分布违规。违规只重写违规拍所在的组，不整章重写。
  const shape = segmentWriter.checkParagraphShape(plan, text);
  // 不再逐段卡 80–140：范文自己就有 24/45 段在这个区间外。
  const shapeDelivery = segmentWriter.evaluateShapeDelivery(shape);
  const shapeIds = [
    ...new Set(
      shapeDelivery.blocking
        .flatMap((row) => (Array.isArray(row.beatIds) && row.beatIds.length ? row.beatIds : [row.beatId]))
        .filter(Boolean)
    ),
  ];

  return { handover, withhold, invariant, wordShares, shape, shapeDelivery, shapeIds };
}

module.exports = { auditDraft };
