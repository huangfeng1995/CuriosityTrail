'use strict';

/**
 * 历史锚点的规则归一化。
 *
 * 这一层不碰数据库：`rules` 里未知的 rule_type 只丢弃该条规则，
 * 不丢掉整条锚点——锚点正文本身仍然有价值。
 *
 * 规则投影（rule_type）只校验类型是否合法。参数的具体语义由 HP4 的
 * anchorCheck 负责；这里不做二次解释，避免两处各写一套判定。
 */

/** 与 work_anchors.kind 的 CHECK 保持一致 */
const KINDS = new Set(['event', 'person', 'time', 'place', 'office', 'custom']);

/** P.5.4 允许的六种断言类型 */
const RULE_TYPES = new Set([
  'presence_forbidden',
  'event_forbidden',
  'term_forbidden',
  'chronology',
  'blank_guard',
  'manual_only',
]);

/** 素材正文截成 source_quote 时的上限 */
const MAX_QUOTE_LENGTH = 200;

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * 归一化 rules。
 *
 * 未知 rule_type 不拒绝整条锚点，只丢弃该条规则：
 * P.5.7 的既定策略是「规则坏了就降级为仅人工核对」，
 * 锚点正文本身仍然有价值，不能因为模型多写了一个类型就整条丢掉。
 *
 * @param {*} value
 * @returns {{rules: Array<{rule_type: string, params: Object}>, dropped: string[], degraded: boolean}}
 */
function normalizeRules(value) {
  let rules = value;
  if (typeof rules === 'string') {
    try {
      rules = JSON.parse(rules);
    } catch (e) {
      rules = [];
    }
  }
  if (!Array.isArray(rules)) rules = [];

  const out = [];
  const dropped = [];
  for (const item of rules) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const type = normalizeToken(item.rule_type);
    if (!RULE_TYPES.has(type)) {
      if (type) dropped.push(type);
      continue;
    }
    const params =
      item.params && typeof item.params === 'object' && !Array.isArray(item.params)
        ? item.params
        : {};
    out.push({ rule_type: type, params });
  }

  const degraded = out.length === 0;
  if (degraded) out.push({ rule_type: 'manual_only', params: {} });
  return { rules: out, dropped, degraded };
}

module.exports = {
  KINDS,
  MAX_QUOTE_LENGTH,
  normalizeRules,
};
