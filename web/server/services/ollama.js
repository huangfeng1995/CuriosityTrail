const axios = require('axios');

class OllamaService {
  constructor() {
    this.baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
    this.timeout = 60000;
  }

  async checkConnection() {
    try {
      const response = await axios.get(`${this.baseURL}/api/tags`, {
        timeout: 5000
      });
      return {
        success: true,
        models: response.data.models || []
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async generate(options = {}) {
    const {
      prompt,
      system = '',
      model = this.model,
      temperature = 0.7,
      max_tokens = 2048,
      context = null
    } = options;

    try {
      const requestBody = {
        model,
        prompt,
        system,
        options: {
          temperature,
          num_predict: max_tokens
        },
        stream: false
      };

      if (context) {
        requestBody.context = context;
      }

      const response = await axios.post(
        `${this.baseURL}/api/generate`,
        requestBody,
        { timeout: this.timeout }
      );

      return {
        success: true,
        response: response.data.response,
        context: response.data.context,
        model: response.data.model,
        total_duration: response.data.total_duration
      };
    } catch (error) {
      console.error('Ollama generation error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async chat(options = {}) {
    const {
      messages,
      model = this.model,
      temperature = 0.7,
      max_tokens = 2048
    } = options;

    try {
      const requestBody = {
        model,
        messages,
        options: {
          temperature,
          num_predict: max_tokens
        },
        stream: false
      };

      const response = await axios.post(
        `${this.baseURL}/api/chat`,
        requestBody,
        { timeout: this.timeout }
      );

      return {
        success: true,
        message: response.data.message,
        context: response.data.context,
        model: response.data.model
      };
    } catch (error) {
      console.error('Ollama chat error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async *streamGenerate(options = {}) {
    const {
      prompt,
      system = '',
      model = this.model,
      temperature = 0.7,
      max_tokens = 2048
    } = options;

    try {
      const requestBody = {
        model,
        prompt,
        system,
        options: {
          temperature,
          num_predict: max_tokens
        },
        stream: true
      };

      const response = await axios.post(
        `${this.baseURL}/api/generate`,
        requestBody,
        { 
          timeout: this.timeout,
          responseType: 'stream'
        }
      );

      const stream = response.data;

      for await (const chunk of stream) {
        const data = JSON.parse(chunk.toString());
        if (data.error) {
          throw new Error(data.error);
        }
        yield {
          token: data.response,
          done: data.done,
          context: data.context
        };
      }
    } catch (error) {
      console.error('Ollama stream error:', error.message);
      yield {
        error: error.message,
        done: true
      };
    }
  }

  async embed(text, model = 'nomic-embed-text') {
    try {
      const response = await axios.post(
        `${this.baseURL}/api/embeddings`,
        {
          model,
          prompt: text
        },
        { timeout: 30000 }
      );

      return {
        success: true,
        embedding: response.data.embedding
      };
    } catch (error) {
      console.error('Ollama embedding error:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new OllamaService();
