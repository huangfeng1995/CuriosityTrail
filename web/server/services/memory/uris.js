'use strict';

/**
 * 记忆 URI 构造与解析。
 *
 * URI 约定：
 *
 *   viking://resources/u/{userId}/w/{workId}/chapter/{chapterId}/{chunkNo}
 *   viking://resources/u/{userId}/w/{workId}/character/{characterId}/{chunkNo}
 *   viking://resources/u/{userId}/w/{workId}/setting/{settingId}/{chunkNo}
 *   viking://resources/u/{userId}/w/{workId}/conv_raw/{convId}/{msgId}/{chunkNo}
 *   viking://resources/u/{userId}/w/{workId}/conv_fact/{convId}/{msgId}/{chunkNo}
 *   viking://resources/u/{userId}/w/{workId}/conv_manual/{convId}/{msgId}/{chunkNo}
 *
 * 两点必须记住：
 *
 * 1. **路径段直接用 source_type 的名字**，不再共用 `conv/`。
 *    对话有三层（原始 / 自动抽取事实 / 手动标记），它们的块号都从 0 开始，
 *    共用一个目录会互相覆盖——每层必须有自己的一段路径。
 *
 * 2. **路径段只能用字母数字下划线、中文、横线**。
 *    openviking 的 `_sanitize_for_path` 会把其它字符丢掉，
 *    sidecar 校验不通过会直接 400。所以这里用 id 原值，
 *    不加 `manual:` 之类的前缀标记——那种标记放在数据库字段里。
 *
 * 前缀隔离靠 sidecar 的 prefix 过滤实现，用户段永远在最前面，
 * 任何一次查询的 targetUri 都必须带上 `u/{userId}/`。
 */

const ROOT = 'viking://resources/u/';

/** 允许出现在 URI 路径段里的字符（与 openviking 的 _sanitize_for_path 一致）。 */
const SAFE_SEGMENT = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/;

/** 对话类来源：路径里多一段会话 id。 */
const CONV_TYPES = new Set(['conv_raw', 'conv_fact', 'conv_manual']);

/** 全部合法的来源类型。 */
const SOURCE_TYPES = ['chapter', 'character', 'setting', ...CONV_TYPES];

/**
 * 校验一个路径段能否安全落盘。
 * @param {string} segment
 * @returns {boolean}
 */
function isSafeSegment(segment) {
  return typeof segment === 'string' && segment.length > 0 && SAFE_SEGMENT.test(segment);
}

/**
 * 用户级根前缀（用于用户级重建）。
 * @param {string} userId
 * @returns {string}
 */
function userRoot(userId) {
  return `${ROOT}${userId}/`;
}

/**
 * 作品级根前缀（查询的 targetUri 用它）。
 * @param {string} userId
 * @param {string} workId
 * @returns {string}
 */
function workRoot(userId, workId) {
  return `${ROOT}${userId}/w/${workId}/`;
}

/**
 * 单块 URI。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.sourceType chapter | character | setting | conv_raw | conv_fact | conv_manual
 * @param {string} params.sourceId 章节/人物/设定 id，或消息 id
 * @param {number} [params.chunkNo]
 * @param {string} [params.conversationId] 对话类必填
 * @returns {string}
 */
function chunkUri({ userId, workId, sourceType, sourceId, chunkNo = 0, conversationId }) {
  if (!SOURCE_TYPES.includes(sourceType)) {
    throw new Error(`未知记忆来源类型：${sourceType}`);
  }

  const segments = [userId, 'w', workId, sourceType];
  if (CONV_TYPES.has(sourceType)) {
    if (!conversationId) throw new Error('对话记忆必须提供 conversationId');
    segments.push(conversationId);
  }
  segments.push(sourceId, String(chunkNo));

  for (const segment of segments) {
    if (!isSafeSegment(segment)) {
      throw new Error(`URI 路径段不合法：${segment}`);
    }
  }

  return `${ROOT}${segments.join('/')}`;
}

/**
 * 解析 URI，取出结构化信息。
 *
 * 解析不出来就返回 null——召回结果里的 URI 理论上都由我们自己拼，
 * 但 sidecar 也可能返回意外内容，这里不做假设。
 *
 * @param {string} uri
 * @returns {{userId: string, workId: string, sourceType: string, sourceId: string, conversationId: string|null, messageId: string|null, chunkNo: number}|null}
 */
function parseUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(ROOT)) return null;
  const segments = uri.slice(ROOT.length).split('/').filter(Boolean);
  if (segments.length < 5) return null;

  const [userId, w, workId, sourceType, ...rest] = segments;
  if (w !== 'w') return null;
  if (!SOURCE_TYPES.includes(sourceType)) return null;

  const chunkNo = Number(rest[rest.length - 1]);
  if (!Number.isInteger(chunkNo)) return null;

  let conversationId = null;
  let sourceId = '';
  let messageId = null;
  if (CONV_TYPES.has(sourceType)) {
    // conv_*/{conversationId}/{messageId}/{chunkNo}
    if (rest.length < 3) return null;
    conversationId = rest[0];
    sourceId = rest[1];
    // 对话三层的 sourceId 就是消息 id。单独给一份出来，
    // 召回时要拿它去查消息表（取日期、校验归属）。
    messageId = sourceId;
  } else {
    // {sourceId}/{chunkNo}
    if (rest.length < 2) return null;
    sourceId = rest[0];
  }
  if (!sourceId) return null;

  return { userId, workId, sourceType, sourceId, conversationId, messageId, chunkNo };
}

module.exports = {
  ROOT,
  SOURCE_TYPES,
  CONV_TYPES,
  isSafeSegment,
  userRoot,
  workRoot,
  chunkUri,
  parseUri,
};
