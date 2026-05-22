class ChatService {
  async chat(messages, options = {}) {
    throw new Error('chat() must be implemented by subclass');
  }

  async generate(prompt, options = {}) {
    throw new Error('generate() must be implemented by subclass');
  }

  async *streamGenerate(prompt, options = {}) {
    throw new Error('streamGenerate() must be implemented by subclass');
  }

  async checkStatus() {
    throw new Error('checkStatus() must be implemented by subclass');
  }
}

module.exports = ChatService;
