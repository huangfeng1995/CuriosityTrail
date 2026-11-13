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
  if (!workId || !chapterId) return '';
  const map = readMap();
  const id = map[workId]?.[chapterId];
  return typeof id === 'string' ? id : '';
}

/** 记住某一章当前用的会话 id。 */
export function saveChapterConversation(workId, chapterId, conversationId) {
  if (!workId || !chapterId || !conversationId) return;
  const map = readMap();
  map[workId] = { ...(map[workId] || {}), [chapterId]: conversationId };
  writeMap(map);
}

/** 清掉某一章的会话指针（作者点了「清空当前对话」或开了新对话）。 */
export function clearChapterConversation(workId, chapterId) {
  if (!workId || !chapterId) return;
  const map = readMap();
  if (!map[workId] || !(chapterId in map[workId])) return;
  delete map[workId][chapterId];
  if (!Object.keys(map[workId]).length) delete map[workId];
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
