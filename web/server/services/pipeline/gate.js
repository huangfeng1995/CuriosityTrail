'use strict';

/**
 * 创作模板开关。
 *
 * 这是流水线是否启用的**唯一判定点**：上下文装配、写后断言、知情抽取
 * 都只读 works.template，不各自判断。
 *
 * 用白名单常量而不是布尔，是为了之后加「推理」「武侠」模板时
 * 不需要再改 works 的列结构。
 */

const TEMPLATES = new Set(['history_thriller']);

/**
 * 作品是否启用了创作流水线模板。
 *
 * @param {Object|null|undefined} work works 表的一行
 * @returns {boolean}
 */
function isPipelineEnabled(work) {
  return Boolean(work && TEMPLATES.has(work.template));
}

module.exports = { TEMPLATES, isPipelineEnabled };
