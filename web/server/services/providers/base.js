'use strict';

/**
 * Provider 基类与共用工具。
 *
 * 所有 AI 调用都经过这一层，不再存在直连某个后端的旁路。
 * 新增供应商只需实现 chat() 与 checkStatus()。
 */

/**
 * 统一的流式文本回调约定：
 *   onToken(text) — 每收到一段文本增量调用
 *   onThinking(text) — 思考内容增量（部分供应商支持）
 */
class Provider {
  constructor(name, settings = {}) {
    this.name = name;
    this.settings = settings;
  }

  /**
   * 发起一次对话。
   * @param {Object} options
   * @param {Array<{role: string, content: string}>} options.messages
   * @param {number} [options.temperature]
   * @param {number} [options.maxTokens]
   * @param {boolean} [options.jsonOutput] 是否要求 JSON 输出
   * @param {string} [options.thinking] 'enabled' | 'disabled'
   * @param {string} [options.reasoningEffort] 'low' | 'high' | 'max'
   * @param {Function} [options.onToken]
   * @param {Function} [options.onThinking]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{content: string, reasoning?: string, raw?: any}>}
   */
  // eslint-disable-next-line no-unused-vars
  async chat(options) {
    throw new Error(`${this.name} provider 未实现 chat()`);
  }

  /**
   * 检查连通性。
   * @returns {Promise<{ok: boolean, detail: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async checkStatus() {
    return { ok: false, detail: '未实现' };
  }
}

/**
 * 读取 SSE 响应流，逐条解析 `data: ` 载荷。
 *
 * @param {Response} response
 * @param {Function} onEvent 收到一个 JSON 对象时调用
 */
async function readSseStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;

      try {
        onEvent(JSON.parse(payload));
      } catch (e) {
        // 非 JSON 的心跳行，忽略
      }
    }
  }
}

/**
 * 读取 NDJSON 流（Ollama 格式），逐行解析 JSON。
 *
 * @param {Response} response
 * @param {Function} onEvent
 */
async function readNdjsonStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch (e) {
        // 忽略非法行
      }
    }
  }
}

/** 单次请求默认超时（毫秒）。流式长回答也不能无限挂着 */
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * 把取消信号 / 超时信号组合起来，并转成能直接显示给作者的中文错误。
 *
 * @param {AbortSignal} signal 已触发的组合信号
 * @param {number} timeoutMs
 * @returns {Error}
 */
function makeAbortError(signal, timeoutMs) {
  const reason = signal && signal.reason;
  if (reason && reason.name === 'TimeoutError') {
    const err = new Error(`AI 请求超时（${Math.round(timeoutMs / 1000)} 秒未完成）`);
    err.code = 'AI_TIMEOUT';
    return err;
  }
  const err = new Error('这次请求已取消');
  err.code = 'AI_ABORTED';
  return err;
}

/**
 * 带重试的 fetch。5xx 与 429 指数退避重试，4xx 直接抛出。
 *
 * 超时与取消：
 *   - 外部传入的 signal（客户端断开）原样透传，触发后立刻抛错、**不重试**；
 *   - 未指定 timeoutMs 时给一个 60s 的整体上限，避免请求永久挂起。
 *
 * @param {string} url
 * @param {Object} init
 * @param {number} [retries]
 * @param {number} [timeoutMs] 0/负数表示不设超时
 */
async function fetchWithRetry(url, init = {}, retries = 3, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const outerSignal = init.signal || null;
  const signals = [];
  if (outerSignal) signals.push(outerSignal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));

  const effectiveSignal =
    signals.length === 0 ? null : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const effectiveInit = effectiveSignal ? { ...init, signal: effectiveSignal } : init;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // 取消或超时后再重试没有意义，直接抛出去让上层收尾。
    if (effectiveSignal && effectiveSignal.aborted) {
      throw makeAbortError(effectiveSignal, timeoutMs);
    }

    try {
      const response = await fetch(url, effectiveInit);
      if (response.ok) return response;

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        // 客户端错误不重试
        const detail = await response.text().catch(() => '');
        const err = new Error(`HTTP ${response.status}: ${detail.slice(0, 300)}`);
        err.status = response.status;
        throw err;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (effectiveSignal && effectiveSignal.aborted) {
        throw makeAbortError(effectiveSignal, timeoutMs);
      }
      if (err.status && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }

  throw lastError || new Error('请求失败');
}

module.exports = { Provider, readSseStream, readNdjsonStream, fetchWithRetry };
