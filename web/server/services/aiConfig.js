const path = require('path');
const fs = require('fs');

class AIConfigManager {
  constructor() {
    this.configPath = path.join(__dirname, '../data/ai-config.json');
    this.config = this.loadConfig();
    this.defaultConfig = {
      version: '1.0',
      chatService: 'llamacpp', // 默认使用本地模型
      translationService: 'llamacpp',
      minimax: {
        apiKey: '',
        groupId: '',
        baseUrl: 'https://api.minimax.chat/v1'
      },
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2:3b',
        temperature: 0.7
      },
      llamacpp: {
        modelPath: '/Users/openclaw/Downloads/qwen2_05b_int4.gguf',
        temperature: 0.3,
        ctxSize: 4096,
        gpuLayers: -1
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
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
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
