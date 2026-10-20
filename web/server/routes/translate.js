const express = require('express');
const router = express.Router();
const translationManager = require('../services/translation/translationManager');
const aiConfig = require('../services/aiConfig');
const db = require('../database');

// 获取翻译设置
router.get('/settings', (req, res) => {
  try {
    const settings = translationManager.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取翻译服务状态（由AI配置路由提供）
router.get('/status', async (req, res) => {
  try {
    const status = await translationManager.checkAllServicesStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 翻译文本
router.post('/text', async (req, res) => {
  try {
    const { text, targetLang, sourceLang = 'auto' } = req.body;

    if (!text) {
      return res.status(400).json({ error: '翻译文本不能为空' });
    }

    // 如果没有指定目标语言，使用默认配置
    const config = aiConfig.getConfig();
    const effectiveTargetLang = targetLang || config.translation.defaultTargetLang;

    if (!effectiveTargetLang) {
      return res.status(400).json({ error: '目标语言不能为空' });
    }

    const translatedText = await translationManager.translate(text, effectiveTargetLang, sourceLang);

    // 记录翻译历史
    const dbConfig = aiConfig.getConfig();
    db.run(`
      INSERT INTO translation_history (source_text, translated_text, source_lang, target_lang, service)
      VALUES (?, ?, ?, ?, ?)
    `, [text, translatedText, sourceLang, effectiveTargetLang, dbConfig.chatService || dbConfig.translationService]);

    res.json({
      original: text,
      translated: translatedText,
      sourceLang,
      targetLang: effectiveTargetLang,
      service: dbConfig.chatService || dbConfig.translationService,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 翻译文档
router.post('/document', async (req, res) => {
  try {
    const { documentId, targetLang, sourceLang = 'auto' } = req.body;

    if (!documentId) {
      return res.status(400).json({ error: '文档ID不能为空' });
    }

    const config = aiConfig.getConfig();
    const effectiveTargetLang = targetLang || config.translation.defaultTargetLang;

    if (!effectiveTargetLang) {
      return res.status(400).json({ error: '目标语言不能为空' });
    }

    const doc = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM documents WHERE id = ?', [documentId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!doc) {
      return res.status(404).json({ error: '文档不存在' });
    }

    const translatedText = await translationManager.translateDocument(
      Buffer.from(doc.content || '', 'utf-8'),
      effectiveTargetLang,
      sourceLang
    );

    res.json({
      documentId,
      originalContent: doc.content,
      translatedContent: translatedText,
      sourceLang,
      targetLang: effectiveTargetLang,
      service: config.chatService || config.translationService,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取翻译历史
router.get('/history', (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const history = db.all(`
      SELECT * FROM translation_history
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), parseInt(offset)]);

    const total = db.get('SELECT COUNT(*) as count FROM translation_history');

    res.json({
      history,
      total: total.count,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 删除翻译历史
router.delete('/history/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.run('DELETE FROM translation_history WHERE id = ?', [id]);
    res.json({ message: '删除成功' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
