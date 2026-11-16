/**
 * 会话指针绑定。
 *
 * 问题背景：服务端只在 done 事件里把 conversationId 告诉客户端。
 * 如果作者在「消息已经出现、流还没结束」时切章、刷新或关页面，
 * done 永远到不了，这一章就永远没有指针，下次进来是空的。
 *
 * 所以指针要尽早落，并且始终落在**发起这次请求的那一章**：
 *   ① 继续已有会话 → 请求发出前就落（最稳，覆盖任何中途离开）；
 *   ② 本章第一次发问 → 服务端建会话后会在流里先发事件，
 *      收到第一个事件时用「发送前的会话列表 + 新增的一条」认出它并落指针；
 *   ③ done 到达 → 用服务端给的精确 id 再落一次（覆盖 ② 认错/没认出的情况）。
 *
 * 如果同一时刻冒出新会话不止一条（别的标签页也在发），② 不猜，交给 ③。
 */
import { saveChapterConversation } from './conversationStore.js';

async function getJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    // 网络失败：这一轮就先不认领，等 done
    return null;
  }
}

const listUrl = (workId) => `/api/ai/conversations?workId=${encodeURIComponent(workId)}&limit=20`;

/**
 * 同一部作品里同时在跑的发送。
 *
 * 只有一条在跑时才敢用「新增的那一条会话」来认领；
 * 两条同时跑（另一标签页、或极快地连发）时分不清哪条是自己的，
 * 不猜，各自等 done 的精确 id。
 */
const pendingByWork = new Map();

function registerPending(workId) {
  const token = Symbol('binding');
  const set = pendingByWork.get(workId) || new Set();
  set.add(token);
  pendingByWork.set(workId, set);
  return () => {
    set.delete(token);
    if (!set.size) pendingByWork.delete(workId);
  };
}

function pendingCount(workId) {
  return pendingByWork.get(workId)?.size || 0;
}


export function createConversationBinding({
  workId,
  chapterId,
  conversationId,
  fetchImpl = globalThis.fetch,
}) {
  let boundId = conversationId || '';
  let baseline = null;
  let trying = false;
  let ambiguous = false;
  let closed = false;
  let release = null;

  const remember = (id) => {
    if (!id || !workId || !chapterId) return;
    boundId = id;
    saveChapterConversation(workId, chapterId, id);
  };

  const releasePending = () => {
    if (release) {
      release();
      release = null;
    }
  };

  return {
    /**
     * 必须在请求发出之前 await：这里记下「发送前作品里有哪些会话」，
     * 之后新增的那一条才是这一次请求创建的。
     */
    async start() {
      if (boundId) {
        remember(boundId);
        return boundId;
      }
      if (!workId) return '';
      // 继续已有会话不需要认领，只有「本章第一次发问」才登记待认领
      release = registerPending(workId);
      const list = await getJson(fetchImpl, listUrl(workId));
      if (Array.isArray(list)) baseline = new Set(list.map((c) => c && c.id));
      return '';
    },

    /** 收到任意流事件时调用；认出这次请求的会话就把指针落下去。 */
    onEvent() {
      if (closed || boundId || ambiguous || trying || !baseline) return;
      // 同一作品还有别的发送在跑：分不清哪条会话是自己的，等 done
      if (pendingCount(workId) > 1) {
        ambiguous = true;
        return;
      }
      trying = true;
      getJson(fetchImpl, listUrl(workId))
        .then((list) => {
          if (closed || boundId || !Array.isArray(list)) return;
          const fresh = list.filter((c) => c && c.id && !baseline.has(c.id));
          if (fresh.length === 1) remember(fresh[0].id);
          else if (fresh.length > 1) ambiguous = true;
          // fresh 为空：会话行可能还没提交，下一个事件再试
        })
        .finally(() => {
          trying = false;
        });
    },

    /** done：服务端给出精确的 conversationId。 */
    finish(id) {
      if (id) remember(id);
      releasePending();
    },

    dispose() {
      closed = true;
      releasePending();
    },
  };
}
