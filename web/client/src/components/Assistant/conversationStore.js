/**
 * 分章对话的本地指针。
 *
 * 服务端的会话只按作品存（conversations.work_id），消息上没有章节字段；
 * 所以「哪一章上次聊的是哪条会话」只能记在客户端。
 *
 * 这里只存指针，不存消息正文：消息仍由服务端
 * /api/ai/conversations/:id/messages 提供，不新造第二套存储。
 * 键按 workId + chapterId 分开，换作品、换章都不会串。
 */
const STORAGE_KEY = 'ct.chat.chapter.v1';

function readMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    // 存储不可用或数据坏了：当作没有，不影响本次对话
    return {};
  }
}

function writeMap(map) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // 存不下就算了，本次会话内仍然正常
  }
}

/** 读某一章上次用的会话 id；没有则返回空串。 */
export function readChapterConversation(workId, chapterId) {
  return readChapterEntry(workId, chapterId).id;
}

/**
 * 读某一章的指针条目。
 *
 * 条目有两种形态：
 *   { id }            —— 这一章上次聊的是这条会话；
 *   { cleared: true } —— 作者在这一章点过「清空 / 新对话」，不要再兜底恢复。
 *
 * 旧版本直接存字符串，这里兼容一下，读到时按「有指针」处理。
 */
function normalizeEntry(raw) {
  if (typeof raw === 'string') return { id: raw, cleared: false };
  if (raw && typeof raw === 'object') {
    return {
      id: typeof raw.id === 'string' ? raw.id : '',
      cleared: Boolean(raw.cleared),
    };
  }
  return { id: '', cleared: false };
}

export function readChapterEntry(workId, chapterId) {
  if (!workId || !chapterId) return { id: '', cleared: false };
  const map = readMap();
  return normalizeEntry(map[workId]?.[chapterId]);
}

/**
 * 读这部作品下所有章节的指针，key 是 chapterId。
 *
 * 兜底恢复要用它判断「这部作品到底分没分过章」：
 * 只要别的章已经指到某条会话，说明作品已经按章用起来了，
 * 这一章没用过对话就该是空的，不能去借别人的会话。
 */
export function readWorkEntries(workId) {
  if (!workId) return {};
  const map = readMap();
  const raw = map[workId];
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(
    Object.entries(raw).map(([chapterId, value]) => [chapterId, normalizeEntry(value)])
  );
}

/** 记住某一章当前用的会话 id。 */
export function saveChapterConversation(workId, chapterId, conversationId) {
  if (!workId || !chapterId || !conversationId) return;
  const map = readMap();
  map[workId] = { ...(map[workId] || {}), [chapterId]: { id: conversationId } };
  writeMap(map);
}

/**
 * 清掉某一章的会话指针（作者点了「清空当前对话」或开了新对话）。
 *
 * 这里不是简单删除：删掉之后「按作品恢复最近会话」的兜底会把刚清掉的
 * 对话又拉回来。留一个 cleared 标记，兜底见到它就停手。
 */
export function clearChapterConversation(workId, chapterId) {
  if (!workId || !chapterId) return;
  const map = readMap();
  map[workId] = { ...(map[workId] || {}), [chapterId]: { cleared: true } };
  writeMap(map);
}

/**
 * 服务端消息 → 侧栏消息流。
 *
 * 历史对话与「回到写作页自动恢复」读的是同一份服务端数据，
 * 用同一个映射，免得两条路径各写一遍、字段慢慢走样。
 */
export function mapConversationMessages(rawMessages, roles, chapterId) {
  const roleMap = new Map((Array.isArray(roles) ? roles : []).map((r) => [r.key, r]));
  let lastPrompt = '';

  return (Array.isArray(rawMessages) ? rawMessages : []).map((m) => {
    if (m.role === 'user') {
      lastPrompt = m.content;
      return {
        id: m.id,
        role: 'user',
        content: m.content,
        chapterId,
        serverMessageId: m.id,
      };
    }

    const role = roleMap.get(m.roleKey);
    return {
      id: m.id,
      role: 'assistant',
      roleKey: m.roleKey || '',
      content: m.content,
      action: m.action,
      target: m.target || '',
      reason: m.reason || '',
      citations: m.citations || [],
      findings: Array.isArray(m.findings) ? m.findings : [],
      // 历史消息也保留节拍/降级/冲突徽标：payload 里存了同一份结构化结果。
      beatCheck: m.beatCheck || null,
      planDegraded: m.planDegraded || '',
      anchorViolations: Array.isArray(m.anchorViolations) ? m.anchorViolations : [],
      roleLabel: m.roleLabel || (role ? `${role.icon} ${role.name}` : ''),
      toolTrace: m.toolTrace || [],
      applied: false,
      chapterId,
      prompt: lastPrompt,
      serverMessageId: m.id,
      memoryRefs: [],
      memoryDegraded: false,
      memoryReason: '',
      excludedRefIds: [],
    };
  });
}
