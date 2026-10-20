const express = require('express');
const router = express.Router();
const aiConfig = require('../services/aiConfig');
const chatManager = require('../services/chat/chatManager');
const translationManager = require('../services/translation/translationManager');

// 获取当前配置
router.get('/config', (req, res) => {
  try {
    const config = aiConfig.getConfig();
    // 隐藏敏感信息
    const safeConfig = {
      ...config,
      minimax: {
        ...config.minimax,
        apiKey: (config.minimax && config.minimax.apiKey) ? '***' + config.minimax.apiKey.slice(-4) : '',
        groupId: (config.minimax && config.minimax.groupId) ? '***' + config.minimax.groupId.slice(-4) : ''
      }
    };
    res.json(safeConfig);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 更新配置
router.post('/config', (req, res) => {
  try {
    const updates = req.body;
    
    // 合并配置，保留原始敏感数据（如果前端只发送星号）
    const currentConfig = aiConfig.getConfig();
    if (updates.minimax) {
      if (updates.minimax.apiKey && updates.minimax.apiKey.includes('***')) {
        updates.minimax.apiKey = currentConfig.minimax.apiKey;
      }
      if (updates.minimax.groupId && updates.minimax.groupId.includes('***')) {
        updates.minimax.groupId = currentConfig.minimax.groupId;
      }
    }
    
    aiConfig.updateConfig(updates);
    res.json({ success: true, config: aiConfig.getConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 检查各服务状态
router.get('/status', async (req, res) => {
  try {
    const config = aiConfig.getConfig();
    const [chatStatus, translationStatus] = await Promise.all([
      chatManager.checkAllServicesStatus(),
      translationManager.checkAllServicesStatus()
    ]);

    // 合并状态信息
    const services = {};
    for (const [serviceName, status] of Object.entries(chatStatus.services)) {
      services[serviceName] = {
        ...status,
        translationAvailable: translationStatus.services[serviceName]?.available || false
      };
    }

    res.json({
      currentChatService: config.chatService,
      currentTranslationService: config.translationService || config.chatService,
      services
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 重置为默认配置
router.post('/reset', (req, res) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(__dirname, '../data/ai-config.json');
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    // 重新加载默认配置
    aiConfig.config = aiConfig.loadConfig();
    res.json({ success: true, config: aiConfig.getConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
