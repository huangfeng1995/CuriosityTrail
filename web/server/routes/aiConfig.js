const express = require('express');
const router = express.Router();
const aiConfig = require('../services/aiConfig');

// 获取当前配置
router.get('/config', (req, res) => {
  try {
    const config = aiConfig.getConfig();
    // 隐藏敏感信息
    const safeConfig = {
      ...config,
      minimax: {
        ...config.minimax,
        apiKey: config.minimax.apiKey ? '***' + config.minimax.apiKey.slice(-4) : '',
        groupId: config.minimax.groupId ? '***' + config.minimax.groupId.slice(-4) : ''
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
    const status = {
      minimax: {
        available: !!(config.minimax.apiKey && config.minimax.groupId),
        config: {
          baseUrl: config.minimax.baseUrl,
          hasApiKey: !!config.minimax.apiKey,
          hasGroupId: !!config.minimax.groupId
        }
      },
      ollama: {
        available: false,
        error: '',
        models: []
      },
      llamacpp: {
        available: false,
        error: '',
        modelPath: config.llamacpp.modelPath
      }
    };

    // 检查 Ollama
    try {
      const ollama = require('../services/ollama');
      const ollamaStatus = await ollama.checkConnection();
      status.ollama = {
        available: ollamaStatus.success,
        error: ollamaStatus.success ? '' : ollamaStatus.error,
        models: ollamaStatus.models || []
      };
    } catch (error) {
      status.ollama.error = error.message;
    }

    // 检查 LlamaCpp 模型文件
    try {
      const fs = require('fs');
      const modelExists = fs.existsSync(config.llamacpp.modelPath);
      status.llamacpp = {
        available: modelExists,
        error: modelExists ? '' : '模型文件不存在',
        modelPath: config.llamacpp.modelPath
      };
    } catch (error) {
      status.llamacpp.error = error.message;
    }

    res.json({
      currentChatService: config.chatService,
      currentTranslationService: config.translationService,
      services: status
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
    const config = require('../services/aiConfig');
    config.config = config.loadConfig();
    res.json({ success: true, config: config.getConfig() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
