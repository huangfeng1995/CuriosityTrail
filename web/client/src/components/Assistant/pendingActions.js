/**
 * 待确认的 AI 结果。
 *
 * AI 的输出分两种：
 * - comment / none：只是讨论，没有「应用到正文」按钮
 * - replace / append / insert：确实是正文，作者点「应用到正文」才写进稿子
 *
 * 只有第二种才算「待确认」。把 comment 也算进去的话，
 * 退出专注模式时会提示「有 3 条建议没处理」，但点进去发现没有能确认的——
 * 提示跟实际不符，作者就不信这个提示了。
 */

/** 会写进正文、需要作者确认的 action 类型。 */
const TEXT_ACTIONS = ['replace', 'append', 'insert'];

/**
 * 找出还没写入正文的 AI 结果。
 *
 * @param {Array} messages 消息流
 * @returns {Array} 待确认的消息，按时间顺序
 */
export function pendingActions(messages = []) {
  return messages.filter(
    (m) =>
      m.role === 'assistant' &&
      TEXT_ACTIONS.includes(m.action) &&
      !m.applied
  );
}

export default pendingActions;
