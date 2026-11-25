/**
 * 生成中的待发送队列。
 *
 * 生成一轮要几分钟，期间输入框不再禁用：作者可以继续说，消息先入队，
 * 本轮正常结束后按顺序自动发出。这里只做纯数据操作，不碰 React，
 * 出队时由调用方判断「这一条还属于当前章吗」。
 *
 * 一条待发送消息记下入队当时的上下文（角色、章节、章节标题）：
 * 作者中途切章后，队列里的旧消息不能发到新章上。
 */

/** 入队。空内容直接忽略，不产生一条空气泡。 */
export function enqueue(queue, item) {
  if (!item || !String(item.text || '').trim()) return queue;
  return [...queue, { ...item }];
}

/** 出队首，返回 { head, rest }；空队列时 head 为 null。 */
export function dequeue(queue) {
  if (!queue.length) return { head: null, rest: queue };
  const [head, ...rest] = queue;
  return { head, rest };
}

/** 看队首，不出队。 */
export function peek(queue) {
  return queue.length ? queue[0] : null;
}

export function size(queue) {
  return queue.length;
}

export function clearQueue() {
  return [];
}

/** 队首是否属于这一章。只有成立才允许自动发出。 */
export function headBelongsTo(queue, chapterId) {
  const head = peek(queue);
  return Boolean(head) && (head.chapterId || '') === (chapterId || '');
}

/**
 * 给界面用的队列摘要。空队列返回 null，调用方据此隐藏提示条。
 *
 * 返回：
 *   count      队列总条数
 *   inCurrent  队首是否属于当前章
 *   headTitle  队首所属章节标题（用于「有 N 条属于《某章》」）
 *   otherCount 不属于当前章的条数
 */
export function summarize(queue, chapterId) {
  if (!queue.length) return null;
  const head = queue[0];
  const current = chapterId || '';
  return {
    count: queue.length,
    inCurrent: (head.chapterId || '') === current,
    headTitle: head.chapterTitle || '',
    otherCount: queue.filter((item) => (item.chapterId || '') !== current).length,
  };
}
