const MiniMaxChatService = require('./minimaxChat');
const OllamaChatService = require('./ollamaChat');
const LlamaCppChatService = require('./llamaCppChat');
const aiConfig = require('../aiConfig');

class ChatManager {
  constructor() {
    this.services = {
      minimax: null,
      ollama: null,
      llamacpp: null,
    };
  }

  getCurrentService() {
    const config = aiConfig.getConfig();
    const serviceName = config.chatService;
    this.ensureServiceInitialized(serviceName);
    
    const service = this.services[serviceName];
    
    if (!service) {
      throw new Error(`聊天服务 ${serviceName} 未初始化`);
    }
    
    return service;
  }

  ensureServiceInitialized(serviceName) {
    const config = aiConfig.getConfig();

    try {
      if (serviceName === 'minimax' && !this.services.minimax) {
        if (config.minimax.apiKey && config.minimax.groupId) {
          this.services.minimax = new MiniMaxChatService(
            config.minimax.apiKey,
            config.minimax.groupId,
            config.minimax.baseUrl
          );
        }
      } else if (serviceName === 'ollama' && !this.services.ollama) {
        if (config.ollama.baseUrl) {
          this.services.ollama = new OllamaChatService(
            config.ollama.baseUrl,
            config.ollama.model,
            config.ollama.temperature
          );
        }
      } else if (serviceName === 'llamacpp' && !this.services.llamacpp) {
        if (config.llamacpp.modelPath) {
          // 先不立即初始化，避免 ESM 模块问题
          this.services.llamacpp = new LlamaCppChatService(
            config.llamacpp.modelPath,
            {
              temperature: config.llamacpp.temperature,
              ctxSize: config.llamacpp.ctxSize,
              gpuLayers: config.llamacpp.gpuLayers
            }
          );
        }
      }
    } catch (error) {
      console.error(`初始化服务 ${serviceName} 失败:`, error);
    }
  }

  async chat(messages, options = {}) {
    const service = this.getCurrentService();
    return service.chat(messages, { ...options, systemPrompt: aiConfig.getConfig().chat.systemPrompt });
  }

  async generate(prompt, options = {}) {
    const service = this.getCurrentService();
    return service.generate(prompt, { ...options, systemPrompt: aiConfig.getConfig().chat.systemPrompt });
  }

  async *streamGenerate(prompt, options = {}) {
    const service = this.getCurrentService();
    for await (const chunk of service.streamGenerate(prompt, { ...options, systemPrompt: aiConfig.getConfig().chat.systemPrompt })) {
      yield chunk;
    }
  }

  async checkAllServicesStatus() {
    const config = aiConfig.getConfig();
    const status = {
      current: config.chatService,
      services: {},
    };

    // 检查 MiniMax - 不实际初始化
    if (config.minimax.apiKey && config.minimax.groupId) {
      try {
        // 只检查配置而不初始化
        status.services.minimax = {
          available: true,
          message: 'MiniMax API 已配置',
        };
      } catch (error) {
        status.services.minimax = {
          available: false,
          error: '未配置 API Key',
        };
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
}

const chatManager = new ChatManager();

module.exports = chatManager;
