'use strict';

/**
 * 一致性核对技能。
 *
 * 把 consistency.js 的**规则层**包装成模型可调用的技能：
 * 免费、确定、立刻出结果，不额外花钱调模型。
 *
 * 只报规则层能确定的问题（人物没出场、设定没落地、别名重名、章节重名等），
 * 不做语义上的矛盾判断——那是「全书审校」的活，会消耗大量 token，
 * 不该由一句「帮我看看有没有矛盾」顺手触发。
 *
 * 这个技能只读，不修改任何正文：模型拿到结果后自行向作者解释。
 */

const { get } = require('../../database');
const consistency = require('../consistency');

/** 明细里最多列多少条，避免工具结果过长 */
const DETAIL_LIMIT = 20;

/**
 * @param {Object} params 无参数
 * @param {Object} ctx
 * @returns {Promise<Object>} { label, summary, detail, findings }
 */
async function run(params, ctx = {}) {
  const { userId, workId } = ctx;

  if (!workId) {
    return { label: '一致性核对', summary: '没有找到要查的作品', detail: [], findings: [] };
  }

  // 只查当前用户自己的作品：workId 是模型给的参数，不能拿它读别人的库。
  const work = await get('SELECT id FROM works WHERE id = ? AND user_id = ?', [workId, userId]);
  if (!work) {
    return { label: '一致性核对', summary: '没有找到要查的作品', detail: [], findings: [] };
  }

  const issues = await consistency.runRuleChecks(workId);

  const detail = issues.slice(0, DETAIL_LIMIT).map((issue) => ({
    label: issue.title,
    text: issue.detail,
  }));

  let summary;
  if (!issues.length) {
    summary = '规则层面没有发现明显问题';
  } else {
    summary = `规则层面发现 ${issues.length} 处需要留意的地方`;
    if (issues.length > DETAIL_LIMIT) {
      summary += `（仅列出前 ${DETAIL_LIMIT} 条）`;
    }
  }

  return { label: '一致性核对', summary, detail, findings: issues };
}

module.exports = {
  name: 'check_consistency',
  label: '一致性核对',
  description:
    '检查作品在规则层面的一致性：人物卡是否在正文中出现、设定是否落地、别名/章节是否重名等。当作者问「有没有前后矛盾」「设定有没有漏」时使用。只做规则核对，不改正文。',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  run,
};
