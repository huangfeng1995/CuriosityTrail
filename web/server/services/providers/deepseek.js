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
const { normalizeEffort } = require('../aiConfig');

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
    this.reasoningEffort = normalizeEffort(settings.reasoningEffort);
    // 只有显式配了 true 才开思考。
    // 官方默认是 enabled，但思考模式下 temperature 完全不生效，
    // 所以"没配"应当等价于"不思考"——温度得真的能用。
    this.thinking = settings.thinking === true ? 'enabled' : 'disabled';
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  buildBody(options) {
    // 思考开关必须显式下发：官方默认就是 enabled，
    // 不传等于开了思考，"关闭深度思考"这个设置就形同虚设。
    const thinking = options.thinking !== undefined ? options.thinking : this.thinking;

    const body = {
      model: options.model || this.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? this.maxTokens,
      stream: Boolean(options.onToken),
      thinking: { type: thinking },
    };

    if (thinking === 'enabled') {
      body.reasoning_effort = options.reasoningEffort || this.reasoningEffort;
    } else {
      // 思考模式不接受 temperature / top_p 等采样参数——
      // 官方原文：设了不会报错，但也不会有任何效果。
      // 所以温度只在非思考模式下发，别让人以为滑块在起作用。
      body.temperature = options.temperature ?? this.temperature;
    }

    if (options.jsonOutput) {
      body.response_format = { type: 'json_object' };
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
      finishReason: choice.finish_reason || '',
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
    let finishReason = '';

    await readSseStream(response, (event) => {
      const choice = event.choices && event.choices[0];
      if (!choice) return;

      // finish_reason 决定这次输出是"正常结束"还是"被长度上限截断"。
      // 思考模式下 reasoning 计入 max_tokens，预算被吃光时 content 会是空的——
      // 不把 finish_reason 带回去，上层就分不清"模型没话说"和"被截断了"。
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
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

    return { content, reasoning, finishReason };
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
