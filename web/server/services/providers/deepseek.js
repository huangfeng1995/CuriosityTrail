'use strict';

/**
 * DeepSeek provider。
 *
 * 端点：POST https://api.deepseek.com/chat/completions
 * 协议：OpenAI 兼容格式，额外支持 thinking / reasoning_effort / JSON Output。
 *
 * 模型（依 2026-09-10 官方更新日志）：
 *   deepseek-flash   → V4.1-Flash-1017，1M 上下文，支持视觉
 *   deepseek-v4-pro  → V4-Pro-0813，1M 上下文
 * 已停用：deepseek-chat、deepseek-reasoner（2026-07-24）、deepseek-v4-flash 等
 */

const { Provider, readSseStream, fetchWithRetry } = require('./base');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

class DeepSeekProvider extends Provider {
  constructor(settings = {}) {
    super('deepseek', settings);
    this.apiKey = (settings.apiKey || '').trim();
    this.baseUrl = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = (settings.model || DEFAULT_MODEL).trim();
    this.temperature = settings.temperature ?? 0.8;
    this.maxTokens = settings.maxTokens ?? 4096;
    this.reasoningEffort = settings.reasoningEffort || 'high';
    this.thinking = settings.thinking === false ? 'disabled' : 'enabled';
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  buildBody(options) {
    const body = {
      model: options.model || this.model,
      messages: options.messages,
      temperature: options.temperature ?? this.temperature,
      max_tokens: options.maxTokens ?? this.maxTokens,
      stream: Boolean(options.onToken),
    };

    if (options.jsonOutput) {
      body.response_format = { type: 'json_object' };
    }

    // 思考控制：仅在需要时携带，避免无谓消耗
    if (options.thinking !== undefined) {
      body.thinking = { type: options.thinking };
    } else if (this.thinking === 'enabled') {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = options.reasoningEffort || this.reasoningEffort;
    }

    return body;
  }

  async chat(options = {}) {
    if (!this.configured) {
      throw new Error('DeepSeek 未配置 API Key');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(this.buildBody(options)),
    };
    if (options.signal) init.signal = options.signal;

    const response = await fetchWithRetry(url, init);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || 'DeepSeek 返回错误');
    }

    const choice = data.choices && data.choices[0];
    if (!choice) {
      throw new Error('DeepSeek 未返回有效结果');
    }

    const message = choice.message || {};
    return {
      content: message.content || '',
      reasoning: message.reasoning_content || '',
      usage: data.usage || null,
      raw: data,
    };
  }

  /**
   * 流式对话。逐 token 回调 onToken，完整内容返回。
   */
  async chatStream(options = {}) {
    if (!this.configured) {
      throw new Error('DeepSeek 未配置 API Key');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = this.buildBody({ ...options, onToken: () => {} });
    body.stream = true;

    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    };
    if (options.signal) init.signal = options.signal;

    const response = await fetchWithRetry(url, init);

    let content = '';
    let reasoning = '';

    await readSseStream(response, (event) => {
      const delta = event.choices && event.choices[0] && event.choices[0].delta;
      if (!delta) return;

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        if (options.onThinking) options.onThinking(delta.reasoning_content);
      }
      if (delta.content) {
        content += delta.content;
        if (options.onToken) options.onToken(delta.content);
      }
    });

    return { content, reasoning };
  }

  async checkStatus() {
    if (!this.configured) {
      return { ok: false, detail: '未配置 API Key' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return { ok: true, detail: `已连接（${this.model}）` };
      return { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

module.exports = { DeepSeekProvider, DEFAULT_BASE_URL, DEFAULT_MODEL };
