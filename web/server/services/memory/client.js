'use strict';

/**
 * viking 记忆服务（Python sidecar）客户端。
 *
 * sidecar 只做四件事：写入、召回、删除、探活。它不认识用户与作品，
 * 所有业务语义（切块、权重、预算、隔离校验）都在 Node 侧。
 *
 * 三条硬规则：
 *
 * 1. **召回永远不抛异常。** 记忆是加分项，不是必需品。
 *    sidecar 挂了、没启动、超时、返回 500 —— 对话都必须照常继续，
 *    所以 query() 失败时返回 `degraded: true` 的空结果，由调用方提示作者。
 *
 * 2. **索引失败要抛异常。** 索引是后台任务，失败必须能感知，
 *    好让台账记录 attempts/last_error 并安排重试。
 *
 * 3. **正文不写日志。** 记忆内容属于用户隐私，日志里只留 URI 与计数。
 */

const config = require('../../config');

/** 错误分类，供上层决定是否重试。 */
const ErrorCode = {
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
  HTTP_ERROR: 'http_error',
  BAD_RESPONSE: 'bad_response',
};

/**
 * 记忆服务调用错误。
 */
class MemoryServiceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'MemoryServiceError';
    this.code = code;
    this.status = options.status || 0;
    this.retryable = options.retryable !== false;
  }
}

/**
 * 记忆功能是否开启。
 * @returns {boolean}
 */
function isEnabled() {
  return Boolean(config.memoryEnabled);
}

/**
 * 统一的 HTTP 调用：超时、错误分类、JSON 解析。
 *
 * @param {string} path
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>}
 */
async function call(path, options = {}) {
  const method = options.method || 'GET';
  const timeoutMs = options.timeoutMs || config.vikingTimeoutMs;
  const url = `${config.vikingBaseUrl}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // AbortSignal.timeout 抛的是 TimeoutError
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new MemoryServiceError(ErrorCode.TIMEOUT, `记忆服务超时（${timeoutMs}ms）`);
    }
    // 连接被拒 = sidecar 没启动
    throw new MemoryServiceError(ErrorCode.UNAVAILABLE, '记忆服务未运行', { retryable: true });
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (e) {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && (payload.detail || payload.message || payload.error)) ||
      `HTTP ${response.status}`;
    // 4xx 是我们自己的请求有问题（URI 非法等），重试没有意义
    const retryable = response.status >= 500;
    throw new MemoryServiceError(
      ErrorCode.HTTP_ERROR,
      `记忆服务返回错误：${detail}`,
      { status: response.status, retryable }
    );
  }

  if (!payload || typeof payload !== 'object') {
    throw new MemoryServiceError(ErrorCode.BAD_RESPONSE, '记忆服务返回格式不正确');
  }

  return payload;
}

/**
 * 探活。sidecar 没起来时返回 null，不抛异常——调用方只想知道"能不能用"。
 *
 * @returns {Promise<{ok: boolean, model: string, dim: number}|null>}
 */
async function health() {
  if (!isEnabled()) return null;
  try {
    const payload = await call('/health', { timeoutMs: config.vikingTimeoutMs });
    if (!payload || payload.ok !== true) return null;
    return { ok: true, model: payload.model || '', dim: Number(payload.dim) || 0 };
  } catch (e) {
    return null;
  }
}

/**
 * 写入一段文本到记忆库。
 *
 * 失败一律抛 MemoryServiceError，由索引队列决定重试还是放弃。
 *
 * @param {string} uri 目标 URI（末段会被 sidecar 当作文件名）
 * @param {string} text 正文
 * @returns {Promise<{ok: boolean, rootUri: string}>}
 */
async function index(uri, text) {
  if (!isEnabled()) {
    throw new MemoryServiceError(ErrorCode.UNAVAILABLE, '记忆功能已关闭', { retryable: false });
  }
  const payload = await call('/index', {
    method: 'POST',
    body: { uri, text },
    timeoutMs: config.vikingIndexTimeoutMs,
  });
  return { ok: Boolean(payload.ok), rootUri: payload.rootUri || uri };
}

/**
 * 删除一个 URI（递归）。删除不存在的路径也算成功。
 *
 * @param {string} uri
 * @returns {Promise<{ok: boolean}>}
 */
async function remove(uri) {
  if (!isEnabled()) {
    throw new MemoryServiceError(ErrorCode.UNAVAILABLE, '记忆功能已关闭', { retryable: false });
  }
  const payload = await call('/index', {
    method: 'DELETE',
    body: { uri },
    timeoutMs: config.vikingIndexTimeoutMs,
  });
  return { ok: Boolean(payload.ok) };
}

/**
 * 语义召回。
 *
 * 失败不抛异常，返回 degraded 的空结果——记忆层挂了不能影响对话。
 *
 * @param {object} params
 * @param {string} params.query 查询文本
 * @param {string} params.targetUri 范围前缀（必须含 u/{userId}/）
 * @param {number} [params.limit]
 * @param {number} [params.minScore]
 * @returns {Promise<{results: Array, degraded: boolean, reason: string}>}
 */
async function query({ query: text, targetUri, limit, minScore }) {
  if (!isEnabled()) {
    return { results: [], degraded: true, reason: '记忆功能已关闭' };
  }

  try {
    const payload = await call('/query', {
      method: 'POST',
      body: {
        query: text,
        targetUri,
        limit: limit || config.memoryTopK,
        minScore: minScore === undefined ? config.memoryMinScore : minScore,
      },
      timeoutMs: config.vikingTimeoutMs,
    });

    const results = Array.isArray(payload.results) ? payload.results : [];
    return {
      results: results.map((item) => ({
        uri: item.uri || '',
        fileUri: item.fileUri || '',
        score: Number(item.score) || 0,
        text: typeof item.text === 'string' ? item.text : '',
      })),
      degraded: false,
      reason: '',
    };
  } catch (e) {
    const reason = e instanceof MemoryServiceError ? e.message : '记忆召回失败';
    return { results: [], degraded: true, reason };
  }
}

module.exports = {
  ErrorCode,
  MemoryServiceError,
  isEnabled,
  health,
  index,
  remove,
  query,
};
