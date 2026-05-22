const ChatService = require('./chatService');
const axios = require('axios');

class MiniMaxChatService extends ChatService {
  constructor(apiKey, groupId, baseUrl = 'https://api.minimax.chat/v1') {
    super();
    this.apiKey = apiKey;
    this.groupId = groupId;
    this.baseUrl = baseUrl;
  }

  async chat(messages, options = {}) {
    const { temperature = 0.7, maxTokens = 2048 } = options;

    try {
      const response = await axios.post(
        `${this.baseUrl}/text/chatcompletion_pro`,
        {
          model: 'abab6.5s-chat',
          messages: messages,
          temperature,
          tokensToGenerate: maxTokens,
          botSetting: [
            {
              bot_name: 'AI研究助手',
              content: options.systemPrompt || '你是一个专业的AI研究助手。'
            }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          params: { GroupId: this.groupId }
        }
      );

      if (response.data.base_resp.status_code !== 0) {
        throw new Error(response.data.base_resp.status_msg);
      }

      return {
        success: true,
        message: {
          role: 'assistant',
          content: response.data.reply
        }
      };
    } catch (error) {
      console.error('MiniMax chat error:', error.message);
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
    try {
      const response = await axios.post(
        `${this.baseUrl}/text/chatcompletion_pro`,
        {
          model: 'abab6.5s-chat',
          messages: [{ role: 'user', content: prompt }],
          temperature: options.temperature || 0.7,
          tokensToGenerate: options.maxTokens || 2048,
          stream: true,
          botSetting: [
            {
              bot_name: 'AI研究助手',
              content: options.systemPrompt || '你是一个专业的AI研究助手。'
            }
          ]
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          params: { GroupId: this.groupId },
          responseType: 'stream'
        }
      );

      let buffer = '';
      for await (const chunk of response.data) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5));
              if (data.base_resp.status_code !== 0) {
                yield { error: data.base_resp.status_msg, done: true };
                return;
              }
              if (data.choices && data.choices.length > 0) {
                const delta = data.choices[0].delta;
                if (delta) {
                  yield { token: delta, done: data.choices[0].finish_reason !== undefined };
                }
              }
            } catch (e) {
              continue;
            }
          }
        }
      }
    } catch (error) {
      console.error('MiniMax stream error:', error.message);
      yield {
        error: error.message,
        done: true
      };
    }
  }

  async checkStatus() {
    try {
      if (!this.apiKey || !this.groupId) {
        return {
          available: false,
          error: '缺少 API Key 或 Group ID'
        };
      }

      await this.chat([{ role: 'user', content: 'ping' }], { maxTokens: 10 });

      return {
        available: true,
        message: 'MiniMax API 连接正常'
      };
    } catch (error) {
      return {
        available: false,
        error: error.message
      };
    }
  }
}

module.exports = MiniMaxChatService;
