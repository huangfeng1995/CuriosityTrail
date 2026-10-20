'use strict';

/**
 * AI 配置管理。
 *
 * 配置落在 DATA_DIR/ai-config.json（容器可替换，卷内持久）。
 * 环境变量（平台 secrets）优先于文件，避免文件被覆盖后连回退都失效。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

const DEFAULT_CONFIG = {
  version: '2.0',
  // 当前使用的 provider：deepseek | openaiCompat | ollama
  provider: 'deepseek',
  deepseek: {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    temperature: 0.8,
    maxTokens: 8192,
    reasoningEffort: 'high',
    thinking: true,
  },
  openaiCompat: {
    apiKey: '',
    baseUrl: '',
    model: '',
    temperature: 0.7,
    maxTokens: 8192,
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b',
    temperature: 0.7,
    maxTokens: 4096,
  },
  // 检索配置
  search: {
    provider: 'deepseek',
    // 低质结果过滤阈值（rerank_score 0-3）
    rerankScoreThreshold: 1.5,
  },
};

class AIConfigManager {
  constructor() {
    this.configPath = config.aiConfigPath;
    this.config = this.loadConfig();
  }

  loadConfig() {
    let saved = {};
    try {
      if (fs.existsSync(this.configPath)) {
        saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (e) {
      console.error('AI 配置读取失败，使用默认值：', e.message);
    }

    const merged = {
      ...DEFAULT_CONFIG,
      ...saved,
      deepseek: { ...DEFAULT_CONFIG.deepseek, ...(saved.deepseek || {}) },
      openaiCompat: { ...DEFAULT_CONFIG.openaiCompat, ...(saved.openaiCompat || {}) },
      ollama: { ...DEFAULT_CONFIG.ollama, ...(saved.ollama || {}) },
      search: { ...DEFAULT_CONFIG.search, ...(saved.search || {}) },
    };

    // 环境变量优先：平台注入的 key 不被文件里的空值覆盖
    if (config.deepseekApiKey) {
      merged.deepseek.apiKey = config.deepseekApiKey;
    }
    if (process.env.OLLAMA_BASE_URL) {
      merged.ollama.baseUrl = process.env.OLLAMA_BASE_URL;
    }
    if (process.env.OLLAMA_MODEL) {
      merged.ollama.model = process.env.OLLAMA_MODEL;
    }

    return merged;
  }

  saveConfig() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      return true;
    } catch (e) {
      console.error('AI 配置保存失败：', e.message);
      return false;
    }
  }

  getConfig() {
    return this.config;
  }

  updateConfig(updates) {
    this.config = {
      ...this.config,
      ...updates,
      deepseek: { ...this.config.deepseek, ...(updates.deepseek || {}) },
      openaiCompat: { ...this.config.openaiCompat, ...(updates.openaiCompat || {}) },
      ollama: { ...this.config.ollama, ...(updates.ollama || {}) },
      search: { ...this.config.search, ...(updates.search || {}) },
    };
    return this.saveConfig();
  }

  /**
   * 给前端看的安全视图：DeepSeek 的 key 只回传是否已配置与掩码，不回传原文。
   */
  getPublicConfig() {
    const c = this.config;
    return {
      provider: c.provider,
      deepseek: {
        configured: Boolean(c.deepseek.apiKey),
        apiKeyMasked: maskKey(c.deepseek.apiKey),
        baseUrl: c.deepseek.baseUrl,
        model: c.deepseek.model,
        temperature: c.deepseek.temperature,
        maxTokens: c.deepseek.maxTokens,
        reasoningEffort: c.deepseek.reasoningEffort,
        thinking: c.deepseek.thinking,
      },
      openaiCompat: {
        configured: Boolean(c.openaiCompat.baseUrl && c.openaiCompat.model),
        apiKeyMasked: maskKey(c.openaiCompat.apiKey),
        baseUrl: c.openaiCompat.baseUrl,
        model: c.openaiCompat.model,
        temperature: c.openaiCompat.temperature,
        maxTokens: c.openaiCompat.maxTokens,
      },
      ollama: {
        configured: Boolean(c.ollama.baseUrl && c.ollama.model),
        baseUrl: c.ollama.baseUrl,
        model: c.ollama.model,
        temperature: c.ollama.temperature,
        maxTokens: c.ollama.maxTokens,
      },
      search: c.search,
    };
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

module.exports = new AIConfigManager();
module.exports.AIConfigManager = AIConfigManager;
