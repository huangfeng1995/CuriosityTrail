const ollama = require('../services/ollama');
const PROMPTS = require('../services/prompts');
const { v4: uuidv4 } = require('uuid');

class AgentOrchestrator {
  constructor() {
    this.conversations = new Map();
    this.toolRegistry = new Map();
    this.registerDefaultTools();
  }

  registerDefaultTools() {
    // 注册默认工具
    this.registerTool('search', require('./tools/search'));
    this.registerTool('reportGenerator', require('./tools/reportGenerator'));
    this.registerTool('keywordExtractor', require('./tools/keywordExtractor'));
    this.registerTool('summarizer', require('./tools/summarizer'));
    this.registerTool('contentAnalyzer', require('./tools/contentAnalyzer'));
  }

  registerTool(name, tool) {
    this.toolRegistry.set(name, tool);
  }

  async processMessage(userId, message, options = {}) {
    const conversationId = options.conversationId || userId;
    
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        id: conversationId,
        messages: [],
        context: {},
        createdAt: new Date()
      });
    }

    const conversation = this.conversations.get(conversationId);
    
    // 添加用户消息
    conversation.messages.push({
      role: 'user',
      content: message,
      timestamp: new Date()
    });

    // 理解用户意图
    const intentResult = await this.understandIntent(message);
    
    // 生成响应
    let response;
    if (intentResult.requiresTools) {
      response = await this.executeWithTools(conversation, intentResult);
    } else {
      response = await this.generateResponse(conversation, message);
    }

    // 添加助手消息
    conversation.messages.push({
      role: 'assistant',
      content: response.content,
      timestamp: new Date(),
      intent: intentResult
    });

    return {
      content: response.content,
      intent: intentResult,
      conversationId
    };
  }

  async understandIntent(message) {
    const result = await ollama.chat({
      messages: [
        {
          role: 'system',
          content: PROMPTS.intentUnderstanding
        },
        {
          role: 'user',
          content: message
        }
      ],
      temperature: 0.3
    });

    if (!result.success) {
      return {
        intent: 'general',
        requiresTools: false,
        subtasks: [],
        confidence: 0
      };
    }

    try {
      // 尝试解析为 JSON
      const parsed = JSON.parse(result.message.content);
      return {
        intent: parsed.intent,
        requiresTools: parsed.required_tools && parsed.required_tools.length > 0,
        subtasks: parsed.subtasks || [],
        tools: parsed.required_tools || [],
        domain: parsed.domain,
        complexity: parsed.complexity,
        clarificationNeeded: parsed.clarification_needed
      };
    } catch (e) {
      // 如果不是 JSON，尝试简单分类
      return {
        intent: this.classifyIntent(message),
        requiresTools: this.checkIfToolsNeeded(message),
        subtasks: [],
        confidence: 0.5
      };
    }
  }

  classifyIntent(message) {
    const lowerMessage = message.toLowerCase();
    
    if (lowerMessage.includes('生成') || lowerMessage.includes('写') || lowerMessage.includes('创建')) {
      return 'report_generation';
    }
    if (lowerMessage.includes('分析') || lowerMessage.includes('研究')) {
      return 'analysis';
    }
    if (lowerMessage.includes('搜索') || lowerMessage.includes('查找')) {
      return 'search';
    }
    if (lowerMessage.includes('总结') || lowerMessage.includes('摘要')) {
      return 'summarization';
    }
    if (lowerMessage.includes('提取') || lowerMessage.includes('关键词')) {
      return 'extraction';
    }
    
    return 'general';
  }

  checkIfToolsNeeded(message) {
    const keywords = ['分析', '搜索', '生成', '提取', '查找', '总结'];
    return keywords.some(kw => message.includes(kw));
  }

  async executeWithTools(conversation, intentResult) {
    const toolResults = [];
    
    for (const toolName of intentResult.tools || []) {
      const tool = this.toolRegistry.get(toolName);
      if (tool) {
        try {
          const result = await tool.execute(conversation.messages[conversation.messages.length - 1].content);
          toolResults.push({
            tool: toolName,
            result
          });
        } catch (error) {
          toolResults.push({
            tool: toolName,
            error: error.message
          });
        }
      }
    }

    // 基于工具结果生成最终响应
    const toolsContext = toolResults
      .map(r => `工具 ${r.tool} 的结果：${r.result || r.error}`)
      .join('\n');

    const finalPrompt = `基于以下工具执行结果，回答用户的问题：

工具结果：
${toolsContext}

用户问题：${conversation.messages[conversation.messages.length - 1].content}

请基于工具结果给出完整的回答。`;

    const result = await ollama.generate({
      prompt: finalPrompt,
      system: PROMPTS.assistant,
      temperature: 0.7
    });

    return {
      content: result.success ? result.response : '抱歉，工具执行过程中出现问题。',
      toolResults
    };
  }

  async generateResponse(conversation, message) {
    const messages = conversation.messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const result = await ollama.chat({
      messages: [
        {
          role: 'system',
          content: PROMPTS.assistant
        },
        ...messages
      ],
      temperature: 0.7
    });

    return {
      content: result.success ? result.message.content : '抱歉，我暂时无法回答这个问题。'
    };
  }

  async *streamMessage(userId, message, options = {}) {
    const conversationId = options.conversationId || userId;
    
    if (!this.conversations.has(conversationId)) {
      this.conversations.set(conversationId, {
        id: conversationId,
        messages: [],
        context: {},
        createdAt: new Date()
      });
    }

    const conversation = this.conversations.get(conversationId);
    
    conversation.messages.push({
      role: 'user',
      content: message,
      timestamp: new Date()
    });

    const messages = conversation.messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const fullResponse = [];

    for await (const chunk of ollama.streamGenerate({
      prompt: message,
      system: PROMPTS.assistant,
      temperature: 0.7
    })) {
      if (chunk.error) {
        yield { error: chunk.error, done: true };
        break;
      }

      fullResponse.push(chunk.token);
      yield { token: chunk.token, done: chunk.done };
    }

    if (fullResponse.length > 0) {
      conversation.messages.push({
        role: 'assistant',
        content: fullResponse.join(''),
        timestamp: new Date()
      });
    }
  }

  getConversation(conversationId) {
    return this.conversations.get(conversationId);
  }

  clearConversation(conversationId) {
    if (this.conversations.has(conversationId)) {
      this.conversations.delete(conversationId);
      return true;
    }
    return false;
  }
}

module.exports = new AgentOrchestrator();
