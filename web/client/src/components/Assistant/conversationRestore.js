/**
 * 回到写作页时，决定该显示哪一条对话。
 *
 * 之前只看 localStorage 指针：指针只在「发完一轮」或「手动打开历史」时写入，
 * 所以功能上线前就存在的对话、以及别的浏览器里聊过的对话永远没有指针，
 * 刷新后右栏永远是空的。
 *
 * 现在的顺序：
 *   ① 这一章点过「清空 / 新对话」→ 就该是空的，不再兜底；
 *   ② 有指针 → 按指针恢复，保证「每章各自一条」；
 *   ③ 没指针 / 指针失效 → 取这部作品最近一条有消息的会话恢复，
 *      并把它绑定到当前章，下次不会又跳到别处更新的会话。
 */
import {
  mapConversationMessages,
  readChapterEntry,
  saveChapterConversation,
} from './conversationStore.js';

async function getJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    // 网络失败或响应不是 JSON：当作没有，不挡住作者继续写
    return null;
  }
}

function pack(data, conversationId, roles, chapterId, source) {
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  return {
    source,
    conversationId,
    messages: mapConversationMessages(rawMessages, roles, chapterId),
    lastRoleKey: rawMessages
      .map((m) => m.roleKey)
      .filter(Boolean)
      .pop() || '',
  };
}

const EMPTY = { source: 'empty', conversationId: null, messages: [], lastRoleKey: '' };

const messagesUrl = (id) => `/api/ai/conversations/${encodeURIComponent(id)}/messages`;

/**
 * @param {Object} opts
 * @param {string} opts.workId
 * @param {string} opts.chapterId
 * @param {Array} opts.roles
 * @param {Function} [opts.fetchImpl] 便于测试注入
 */
export async function restoreChapterConversation({
  workId,
  chapterId,
  roles,
  fetchImpl = globalThis.fetch,
}) {
  if (!workId || !chapterId) return { ...EMPTY, source: 'missing' };

  const entry = readChapterEntry(workId, chapterId);
  if (entry.cleared) return { ...EMPTY, source: 'cleared' };

  if (entry.id) {
    const data = await getJson(fetchImpl, messagesUrl(entry.id));
    if (data) return pack(data, data.id || entry.id, roles, chapterId, 'pointer');
    // 指针指向的会话已不存在（被删、换了账号）：继续走兜底
  }

  const list = await getJson(
    fetchImpl,
    `/api/ai/conversations?workId=${encodeURIComponent(workId)}&limit=1`
  );
  const latestId = Array.isArray(list) && list.length ? list[0]?.id : '';
  if (!latestId) return { ...EMPTY, source: 'none' };

  const data = await getJson(fetchImpl, messagesUrl(latestId));
  if (!data) return { ...EMPTY, source: 'none' };

  const conversationId = data.id || latestId;
  saveChapterConversation(workId, chapterId, conversationId);
  return pack(data, conversationId, roles, chapterId, 'latest');
}
