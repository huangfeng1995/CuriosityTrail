'use strict';

/**
 * 本地 Ollama provider。
 *
 * DeepSeek key 未配置时的兜底，保证平台在离线状态下仍可使用。
 * 协议与 OpenAI 不同：POST /api/chat，NDJSON 流。
 */

const { Provider, readNdjsonStream } = require('./base');

class OllamaProvider extends Provider {
  constructor(settings = {}) {
    super('ollama', settings);
    this.baseUrl = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    this.model = (settings.model || 'qwen2.5:7b').trim();
    this.temperature = settings.temperature ?? 0.7;
    this.maxTokens = settings.maxTokens ?? 4096;
  }

  get configured() {
    return Boolean(this.baseUrl && this.model);
  }

  buildBody(options) {
    const body = {
      model: options.model || this.model,
      messages: options.messages,
      stream: Boolean(options.onToken),
      options: {
        temperature: options.temperature ?? this.temperature,
        num_predict: options.maxTokens ?? this.maxTokens,
      },
    };

    if (options.jsonOutput) {
      body.format = 'json';
    }

    return body;
  }

  async chat(options = {}) {
    if (!this.configured) {
      throw new Error('Ollama 未配置 baseUrl 或 model');
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(options)),
      signal: options.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    return {
      content: (data.message && data.message.content) || '',
      finishReason: data.done_reason || '',
      raw: data,
    };
  }

  async chatStream(options = {}) {
    if (!this.configured) {
      throw new Error('Ollama 未配置 baseUrl 或 model');
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.buildBody(options)),
      signal: options.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama HTTP ${response.status}: ${detail.slice(0, 200)}`);
    }

    let content = '';
    let finishReason = '';
    await readNdjsonStream(response, (event) => {
      // Ollama 在最后一条 NDJSON 里带 done_reason（'stop' / 'length'）
      if (event.done_reason) {
        finishReason = event.done_reason;
      }
      const piece = event.message && event.message.content;
      if (piece) {
        content += piece;
        if (options.onToken) options.onToken(piece);
      }
    });

    return { content, finishReason };
  }

  async checkStatus() {
    if (!this.configured) {
      return { ok: false, detail: '未配置 baseUrl 或 model' };
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };

      const data = await response.json();
      const models = (data.models || []).map((m) => m.name);
      const hasModel = models.some((m) => m.startsWith(this.model.split(':')[0]));
      return {
        ok: hasModel,
        detail: hasModel
          ? `已连接（${this.model}）`
          : `已连接但未安装 ${this.model}，现有：${models.join(', ') || '无'}`,
      };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  }
}

module.exports = { OllamaProvider };
