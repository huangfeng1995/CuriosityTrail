const ChatService = require('./chatService');
const llamaCppService = require('../llamaCpp');

class LlamaCppChatService extends ChatService {
  constructor(modelPath, options = {}) {
    super();
    this.modelPath = modelPath;
    this.temperature = options.temperature || 0.3;
  }

  async chat(messages, options = {}) {
    const { temperature = this.temperature, maxTokens = 2048, systemPrompt } = options;

    // 构建提示词
    let prompt = '';
    if (systemPrompt) {
      prompt += systemPrompt + '\n\n';
    }
    for (const msg of messages) {
      if (msg.role === 'user') {
        prompt += '用户: ' + msg.content + '\n';
      } else if (msg.role === 'assistant') {
        prompt += '助手: ' + msg.content + '\n';
      }
    }
    prompt += '助手: ';

    try {
      // 使用现有的 llamaCpp 服务
      llamaCppService.modelPath = this.modelPath;
      const result = await llamaCppService.generate({
        prompt,
        temperature,
        maxTokens
      });
      
      return {
        success: true,
        message: {
          role: 'assistant',
          content: result.response
        }
      };
    } catch (error) {
      console.error('LlamaCpp chat error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generate(prompt, options = {}) {
    return this.chat([{ role: 'user', content: prompt }], options);
  }

  async *streamGenerate(prompt, options = {}) {
    // 简单版流生成，先不实现流，直接一次性返回
    const result = await this.generate(prompt, options);
    if (result.success) {
      yield { token: result.message.content, done: true };
    } else {
      yield { error: result.error, done: true };
    }
  }

  async checkStatus() {
    try {
      llamaCppService.modelPath = this.modelPath;
      const available = llamaCppService.isAvailable();
      
      return {
        available,
        message: available ? 'LlamaCpp 服务可用' : 'LlamaCpp 服务不可用',
        modelPath: this.modelPath
      };
    } catch (error) {
      return {
        available: false,
        error: `检查状态失败: ${error.message}`
      };
    }
  }
}

module.exports = LlamaCppChatService;
