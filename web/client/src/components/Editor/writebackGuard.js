/**
 * 写回正文前的硬保护。
 *
 * 线上出过一次事故：模型被长度上限截断，只返回了第一句，前端把这一句
 * 当成"改写结果"整块覆盖回去，一整章只剩开头一句。
 *
 * 结果好不好是模型的事，"能不能覆盖"不是——这里是最后一道闸：
 * 新内容比原文短太多、或段落被吞掉大半时，宁可拒绝写回、保留原文，
 * 让作者自己决定要不要手动替换。
 *
 * 只有明确要求"缩写"时才允许大幅变短；其余动作（改写/扩写/口语化/
 * 换语气/采纳意见）都应当保持原有信息量。
 */

/** 允许的最小保留比例。低于这个值视为"内容被吃掉了"。 */
export const MIN_KEEP_RATIO = 0.6;

/**
 * 原文短于这个长度时不做比例判断。
 *
 * 十几个字的短句本来就允许被改得更短（"他慢慢地站了起来"→"他起身"），
 * 对它套 60% 只会把正常改写全挡掉。真正危险的是长段落被压成一句。
 */
export const MIN_GUARD_LENGTH = 30;

/** 可见字数（去掉空白），和正文的字数口径一致。 */
export function visibleLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/**
 * 段落数。空行分段与单换行都算，取较粗的口径即可——
 * 这里只用来发现"整段被吞"，不需要和导出格式严格一致。
 */
export function paragraphCount(text) {
  return String(text || '')
    .split(/\n+/)
    .filter((line) => line.trim())
    .length;
}

/**
 * 判断一次覆盖是否安全。
 *
 * @param {string} before 被覆盖前的原文
 * @param {string} after  准备写回的新文
 * @param {{action?: string}} [options] action='shorten' 时跳过长度比例检查
 * @returns {{ok: boolean, code?: string, reason?: string}}
 */
export function assessRewrite(before, after, options = {}) {
  const action = options.action || 'rewrite';
  const prev = String(before || '');
  const next = String(after || '');

  // 空内容永远不写回：覆盖成空白是最坏的一种结果。
  if (!next.trim()) {
    return { ok: false, code: 'EMPTY', reason: '生成结果为空，已保留原文' };
  }

  // 缩写是明确要求变短，只做"别清空"这一条底线。
  if (action === 'shorten') return { ok: true };

  const prevLen = visibleLength(prev);
  const nextLen = visibleLength(next);

  // 原文很短：不做比例判断
  if (prevLen < MIN_GUARD_LENGTH) return { ok: true };

  if (nextLen < prevLen * MIN_KEEP_RATIO) {
    return {
      ok: false,
      code: 'SHRUNK',
      reason: `新内容只有原文的 ${Math.round((nextLen / prevLen) * 100)}%（可能被截断），已拒绝写回，原文保留`,
    };
  }

  // 段落数骤减：原文分了 4 段，结果只剩 1 段，即使字数勉强够也说明结构被吞了。
  const prevParas = paragraphCount(prev);
  const nextParas = paragraphCount(next);
  if (prevParas >= 2 && nextParas <= Math.floor(prevParas / 2)) {
    return {
      ok: false,
      code: 'PARAGRAPHS_LOST',
      reason: `段落数从 ${prevParas} 段减少到 ${nextParas} 段，已拒绝写回，原文保留`,
    };
  }

  return { ok: true };
}
