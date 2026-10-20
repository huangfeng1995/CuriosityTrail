const MiniMaxTranslationService = require('./minimaxTranslation');
const OllamaTranslationService = require('./ollamaTranslation');
const LlamaCppTranslationService = require('./llamaCppTranslation');
const aiConfig = require('../aiConfig');

class TranslationManager {
  constructor() {
    this.services = {
      minimax: null,
      ollama: null,
      llamacpp: null,
    };
  }

  getCurrentService() {
    const config = aiConfig.getConfig();
    const serviceName = config.translationService;
    
    // 如果翻译服务没有设置，默认使用聊天服务
    const effectiveService = serviceName || config.chatService;
    
    // 确保服务已初始化
    this.ensureServiceInitialized(effectiveService);
    
    const service = this.services[effectiveService];
    
    if (!service) {
      throw new Error(`翻译服务 ${effectiveService} 未初始化`);
    }
    
    return service;
  }

  ensureServiceInitialized(serviceName) {
    const config = aiConfig.getConfig();

    try {
      if (serviceName === 'minimax' && !this.services.minimax) {
        if (config.minimax.apiKey && config.minimax.groupId) {
          this.services.minimax = new MiniMaxTranslationService(
            config.minimax.apiKey,
            config.minimax.groupId
          );
        }
      } else if (serviceName === 'ollama' && !this.services.ollama) {
        if (config.ollama.baseUrl) {
          this.services.ollama = new OllamaTranslationService(
            config.ollama.baseUrl,
            config.ollama.model
          );
        }
      } else if (serviceName === 'llamacpp' && !this.services.llamacpp) {
        if (config.llamacpp.modelPath) {
          // 先不立即初始化，避免 ESM 模块问题
          this.services.llamacpp = new LlamaCppTranslationService(
            config.llamacpp.modelPath,
            config.llamacpp.temperature
          );
        }
      }
    } catch (error) {
      console.error(`初始化翻译服务 ${serviceName} 失败:`, error);
    }
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    return service.translate(text, targetLang, sourceLang);
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    if (typeof service.translateDocument === 'function') {
      return service.translateDocument(fileBuffer, targetLang, sourceLang);
    }
    throw new Error('当前翻译服务不支持文档翻译');
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    if (typeof service.ocrAndTranslate === 'function') {
      return service.ocrAndTranslate(imageBuffer, targetLang, sourceLang);
    }
    throw new Error('当前翻译服务不支持 OCR 翻译');
  }

  async checkAllServicesStatus() {
    const config = aiConfig.getConfig();
    const status = {
      current: config.translationService || config.chatService,
      services: {},
    };

    // 检查 MiniMax - 不实际初始化
    if (config.minimax.apiKey && config.minimax.groupId) {
      try {
        status.services.minimax = {
          available: true,
          message: 'MiniMax API 已配置',
        };
      } catch (error) {
        status.services.minimax = { available: false, error: '未配置 API Key' };
      }
    } else {
      status.services.minimax = { available: false, error: '未配置 API Key' };
    }

    // 检查 Ollama
    if (config.ollama.baseUrl) {
      try {
        this.ensureServiceInitialized('ollama');
        if (this.services.ollama) {
          status.services.ollama = await this.services.ollama.checkStatus();
        } else {
          status.services.ollama = { available: false, error: '未配置 Ollama' };
        }
      } catch (error) {
        status.services.ollama = {
          available: false,
          error: error.message,
        };
      }
    } else {
      status.services.ollama = { available: false, error: '未配置 Ollama' };
    }

    // 检查 LlamaCpp - 只检查文件存在性而不初始化
    if (config.llamacpp.modelPath) {
      try {
        const fs = require('fs');
        const modelExists = fs.existsSync(config.llamacpp.modelPath);
        status.services.llamacpp = {
          available: modelExists,
          message: modelExists ? `模型文件就绪: ${config.llamacpp.modelPath}` : '模型文件不存在',
          modelPath: config.llamacpp.modelPath
        };
      } catch (error) {
        status.services.llamacpp = {
          available: false,
          error: `检查状态失败: ${error.message}`,
        };
      }
    } else {
      status.services.llamacpp = { available: false, error: '未配置本地模型路径' };
    }

    return status;
  }

  getSettings() {
    const config = aiConfig.getConfig();
    return {
      service: config.translationService || config.chatService,
      minimax: {
        apiKey: config.minimax.apiKey ? '******' + config.minimax.apiKey.slice(-4) : '',
        groupId: config.minimax.groupId ? '******' + config.minimax.groupId.slice(-4) : '',
      },
      ollama: config.ollama,
      llamaCpp: config.llamacpp,
      defaultTargetLang: config.translation.defaultTargetLang,
    };
  }
}

const translationManager = new TranslationManager();

module.exports = translationManager;
