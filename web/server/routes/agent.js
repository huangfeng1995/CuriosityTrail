const express = require('express');
const router = express.Router();
const agentOrchestrator = require('../agent/orchestrator');
const { MemorySystem, initializeMemoryTable } = require('../agent/memory/memory');

// 初始化记忆表
initializeMemoryTable();

// 检查 Ollama 连接状态
router.get('/status', async (req, res) => {
  try {
    const ollamaService = require('../services/ollama');
    const status = await ollamaService.checkConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// 发送消息（流式响应）
router.post('/chat', async (req, res) => {
  const { message, userId = 'default', conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    for await (const chunk of agentOrchestrator.streamMessage(userId, message, { conversationId })) {
      if (chunk.error) {
        res.write(`data: ${JSON.stringify({ error: chunk.error })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
  }

  res.end();
});

// 发送消息（非流式）
router.post('/message', async (req, res) => {
  const { message, userId = 'default', conversationId } = req.body;

  if (!message) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  try {
    const result = await agentOrchestrator.processMessage(userId, message, { conversationId });
    
    // 保存到记忆系统
    await MemorySystem.saveToLongTerm(userId, 'conversation', {
      message,
      response: result.content,
      intent: result.intent
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取对话历史
router.get('/conversation/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const conversation = agentOrchestrator.getConversation(conversationId);
  
  if (!conversation) {
    return res.status(404).json({ error: '对话不存在' });
  }

  res.json(conversation);
});

// 清除对话
router.delete('/conversation/:conversationId', (req, res) => {
  const { conversationId } = req.params;
  const success = agentOrchestrator.clearConversation(conversationId);
  
  if (success) {
    res.json({ message: '对话已清除' });
  } else {
    res.status(404).json({ error: '对话不存在' });
  }
});

// 获取记忆
router.get('/memory/:userId', async (req, res) => {
  const { userId } = req.params;
  const { type, limit = 50 } = req.query;

  try {
    const memories = await MemorySystem.getLongTermMemory(userId, type, parseInt(limit));
    res.json(memories);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 搜索记忆
router.get('/memory/:userId/search', async (req, res) => {
  const { userId } = req.params;
  const { q } = req.query;

  if (!q) {
    return res.status(400).json({ error: '搜索关键词不能为空' });
  }

  try {
    const results = await MemorySystem.searchSemanticMemory(userId, q);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除记忆
router.delete('/memory/:memoryId', async (req, res) => {
  const { memoryId } = req.params;

  try {
    const success = await MemorySystem.deleteMemory(parseInt(memoryId));
    if (success) {
      res.json({ message: '记忆已删除' });
    } else {
      res.status(500).json({ error: '删除失败' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 工具调用
router.post('/tools/:toolName', async (req, res) => {
  const { toolName } = req.params;
  const params = req.body;

  const tool = agentOrchestrator.toolRegistry.get(toolName);
  if (!tool) {
    return res.status(404).json({ error: '工具不存在' });
  }

  try {
    const result = await tool.execute(params);
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
