const path = require('path');
const fs = require('fs');
const config = require('../config');

class AIConfigManager {
  constructor() {
    // 统一走 DATA_DIR：容器可替换，容器内相对路径不持久
    this.configPath = config.aiConfigPath;
    this.defaultConfig = {
      version: '1.0',
      chatService: 'ollama',
      translationService: 'ollama',
      minimax: {
        apiKey: process.env.MINIMAX_API_KEY || '',
        groupId: process.env.MINIMAX_GROUP_ID || '',
        baseUrl: process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1'
      },
      ollama: {
        baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
        model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
        temperature: parseFloat(process.env.OLLAMA_TEMPERATURE) || 0.7
      },
      llamacpp: {
        modelPath: process.env.LLAMACPP_MODEL_PATH || '/Users/openclaw/Downloads/qwen2_05b_int4.gguf',
        temperature: parseFloat(process.env.LLAMACPP_TEMPERATURE) || 0.3,
        ctxSize: parseInt(process.env.LLAMACPP_CTX_SIZE) || 4096,
        gpuLayers: parseInt(process.env.LLAMACPP_GPU_LAYERS) || -1
      },
      translation: {
        defaultTargetLang: 'zh',
        defaultSourceLang: 'auto',
        useSameServiceForTranslation: true
      },
      chat: {
        maxTokens: 2048,
        systemPrompt: '你是一个专业的AI研究助手，帮助用户进行科学研究、报告撰写、文献分析和知识探索。',
        temperature: 0.7
      }
    };
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const savedConfig = JSON.parse(data);
        // 合并已保存配置和默认配置，确保所有字段都存在
        return {
          ...this.defaultConfig,
          ...savedConfig,
          minimax: {
            ...this.defaultConfig.minimax,
            ...savedConfig.minimax
          },
          ollama: {
            ...this.defaultConfig.ollama,
            ...savedConfig.ollama
          },
          llamacpp: {
            ...this.defaultConfig.llamacpp,
            ...savedConfig.llamacpp
          },
          translation: {
            ...this.defaultConfig.translation,
            ...savedConfig.translation
          },
          chat: {
            ...this.defaultConfig.chat,
            ...savedConfig.chat
          }
        };
      }
    } catch (error) {
      console.error('Error loading AI config:', error);
    }
    return { ...this.defaultConfig };
  }

  saveConfig() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      return true;
    } catch (error) {
      console.error('Error saving AI config:', error);
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
      minimax: {
        ...this.defaultConfig.minimax,
        ...this.config.minimax,
        ...updates.minimax
      },
      ollama: {
        ...this.defaultConfig.ollama,
        ...this.config.ollama,
        ...updates.ollama
      },
      llamacpp: {
        ...this.defaultConfig.llamacpp,
        ...this.config.llamacpp,
        ...updates.llamacpp
      },
      translation: {
        ...this.defaultConfig.translation,
        ...this.config.translation,
        ...updates.translation
      },
      chat: {
        ...this.defaultConfig.chat,
        ...this.config.chat,
        ...updates.chat
      }
    };
    return this.saveConfig();
  }

  getChatService() {
    return this.config.chatService || this.defaultConfig.chatService;
  }

  getTranslationService() {
    return this.config.translationService || this.defaultConfig.translationService;
  }

  getLlamaCppConfig() {
    return this.config.llamacpp || this.defaultConfig.llamacpp;
  }

  getOllamaConfig() {
    return this.config.ollama || this.defaultConfig.ollama;
  }

  getMiniMaxConfig() {
    return this.config.minimax || this.defaultConfig.minimax;
  }
}

module.exports = new AIConfigManager();
