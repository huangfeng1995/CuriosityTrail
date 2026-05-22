const ChatService = require('./chatService');
const axios = require('axios');

class OllamaChatService extends ChatService {
  constructor(baseUrl = 'http://localhost:11434', model = 'llama3.2:3b', temperature = 0.7) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.temperature = temperature;
    this.timeout = 60000;
  }

  async chat(messages, options = {}) {
    const { temperature = this.temperature, maxTokens = 2048, systemPrompt } = options;

    try {
      const requestBody = {
        model: this.model,
        messages,
        options: {
          temperature,
          num_predict: maxTokens
        },
        stream: false
      };

      if (systemPrompt) {
        requestBody.messages = [
          { role: 'system', content: systemPrompt },
          ...messages
        ];
      }

      const response = await axios.post(
        `${this.baseUrl}/api/chat`,
        requestBody,
        { timeout: this.timeout }
      );

      return {
        success: true,
        message: response.data.message
      };
    } catch (error) {
      console.error('Ollama chat error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generate(prompt, options = {}) {
    const { temperature = this.temperature, maxTokens = 2048, systemPrompt } = options;

    try {
      const requestBody = {
        model: this.model,
        prompt,
        system: systemPrompt || '',
        options: {
          temperature,
          num_predict: maxTokens
        },
        stream: false
      };

      const response = await axios.post(
        `${this.baseUrl}/api/generate`,
        requestBody,
        { timeout: this.timeout }
      );

      return {
        success: true,
        response: response.data.response
      };
    } catch (error) {
      console.error('Ollama generate error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async *streamGenerate(prompt, options = {}) {
    const { temperature = this.temperature, maxTokens = 2048, systemPrompt } = options;

    try {
      const requestBody = {
        model: this.model,
        prompt,
        system: systemPrompt || '',
        options: {
          temperature,
          num_predict: maxTokens
        },
        stream: true
      };

      const response = await axios.post(
        `${this.baseUrl}/api/generate`,
        requestBody,
        {
          timeout: this.timeout,
          responseType: 'stream'
        }
      );

      for await (const chunk of response.data) {
        try {
          const data = JSON.parse(chunk.toString());
          if (data.error) {
            throw new Error(data.error);
          }
          yield {
            token: data.response,
            done: data.done
          };
        } catch (e) {
          continue;
        }
      }
    } catch (error) {
      console.error('Ollama stream error:', error.message);
      yield {
        error: error.message,
        done: true
      };
    }
  }

  async checkStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000
      });

      return {
        available: true,
        message: 'Ollama 服务正常',
        models: response.data.models || []
      };
    } catch (error) {
      return {
        available: false,
        error: error.message
      };
    }
  }
}

module.exports = OllamaChatService;
