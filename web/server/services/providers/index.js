'use strict';

/**
 * Provider 工厂。
 *
 * 路由规则：
 *   1. 用户在设置页显式选择的 provider 优先
 *   2. 选择了但未配置（如 DeepSeek 没 key），自动降级到下一个可用 provider
 *   3. 全部不可用时抛错，由路由层返回可读的错误信息
 */

const { DeepSeekProvider } = require('./deepseek');
const { OpenAICompatProvider } = require('./openaiCompat');
const { OllamaProvider } = require('./ollama');

/** provider 优先级：DeepSeek 质量最好，Ollama 保证离线可用 */
const FALLBACK_ORDER = ['deepseek', 'openaiCompat', 'ollama'];

const REGISTRY = {
  deepseek: DeepSeekProvider,
  openaiCompat: OpenAICompatProvider,
  ollama: OllamaProvider,
};

/**
 * 按名称构造 provider 实例。
 * @param {string} name
 * @param {Object} settings
 */
function createProvider(name, settings = {}) {
  const Ctor = REGISTRY[name];
  if (!Ctor) {
    throw new Error(`未知的 provider：${name}`);
  }
  return new Ctor(settings);
}

/**
 * 选出当前实际可用的 provider。
 *
 * @param {Object} aiConfig 服务端 AI 配置（含 provider / 各段参数）
 * @returns {{provider: object, name: string, degraded: boolean, reason?: string}}
 */
function resolveProvider(aiConfig) {
  const preferred = aiConfig.provider || 'deepseek';

  const order = [
    preferred,
    ...FALLBACK_ORDER.filter((n) => n !== preferred),
  ];

  for (const name of order) {
    const settings = aiConfig[name] || {};
    try {
      const provider = createProvider(name, settings);
      if (provider.configured) {
        return {
          provider,
          name,
          degraded: name !== preferred,
          reason:
            name !== preferred
              ? `${preferred} 未配置或不可用，已降级到 ${name}`
              : undefined,
        };
      }
    } catch (e) {
      // 构造失败就试下一个
    }
  }

  throw new Error('没有可用的 AI provider，请到设置页配置 DeepSeek key 或本地 Ollama');
}

/**
 * 列出所有 provider 的连通状态。
 * @param {Object} aiConfig
 */
async function checkAllProviders(aiConfig) {
  const results = [];
  for (const name of FALLBACK_ORDER) {
    const settings = aiConfig[name] || {};
    try {
      const provider = createProvider(name, settings);
      if (!provider.configured) {
        results.push({ name, ok: false, detail: '未配置' });
        continue;
      }
      const status = await provider.checkStatus();
      results.push({ name, ...status });
    } catch (e) {
      results.push({ name, ok: false, detail: e.message });
    }
  }
  return results;
}

module.exports = {
  createProvider,
  resolveProvider,
  checkAllProviders,
  FALLBACK_ORDER,
  DeepSeekProvider,
  OpenAICompatProvider,
  OllamaProvider,
};
