'use strict';

/**
 * 通用 OpenAI 兼容 provider。
 *
 * 面向任何实现了 /chat/completions 的服务（自建推理服务、其他云厂商），
 * 换供应商时不需要改业务代码。
 */

const { Provider, readSseStream, fetchWithRetry } = require('./base');

class OpenAICompatProvider extends Provider {
  constructor(settings = {}) {
    super('openaiCompat', settings);
    this.apiKey = (settings.apiKey || '').trim();
    this.baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
    this.model = (settings.model || '').trim();
    this.temperature = settings.temperature ?? 0.7;
    this.maxTokens = settings.maxTokens ?? 4096;
  }

  get configured() {
    return Boolean(this.baseUrl && this.model);
  }

  headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
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
    return body;
  }

  async chat(options = {}) {
    if (!this.configured) {
      throw new Error('未配置 baseUrl 或 model');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const init = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(options)),
    };
    if (options.signal) init.signal = options.signal;

    const response = await fetchWithRetry(url, init);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message || '服务返回错误');
    }

    const choice = data.choices && data.choices[0];
    if (!choice) throw new Error('未返回有效结果');

    return {
      content: (choice.message && choice.message.content) || '',
      usage: data.usage || null,
      raw: data,
    };
  }

  async chatStream(options = {}) {
    if (!this.configured) {
      throw new Error('未配置 baseUrl 或 model');
    }

    const url = `${this.baseUrl}/chat/completions`;
    const body = this.buildBody({ ...options, onToken: () => {} });
    body.stream = true;

    const init = {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    };
    if (options.signal) init.signal = options.signal;

    const response = await fetchWithRetry(url, init);

    let content = '';
    await readSseStream(response, (event) => {
      const delta = event.choices && event.choices[0] && event.choices[0].delta;
      if (delta && delta.content) {
        content += delta.content;
        if (options.onToken) options.onToken(delta.content);
      }
    });

    return { content };
  }

  async checkStatus() {
    if (!this.configured) {
      return { ok: false, detail: '未配置 baseUrl 或 model' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) return { ok: true, detail: `已连接（${this.model}）` };
      return { ok: false, detail: `HTTP ${response.status}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

module.exports = { OpenAICompatProvider };
