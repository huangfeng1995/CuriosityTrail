const TranslationService = require('./translationService');
const crypto = require('crypto');

class MiniMaxTranslationService extends TranslationService {
  constructor(apiKey, groupId) {
    super();
    this.apiKey = apiKey;
    this.groupId = groupId;
    this.baseUrl = 'https://api.minimax.chat/v1';
  }

  getHeaders() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    if (!this.apiKey || !this.groupId) {
      throw new Error('MiniMax API 密钥未配置');
    }

    try {
      const langMap = {
        'zh': 'Chinese',
        'en': 'English',
        'ja': 'Japanese',
        'ko': 'Korean',
        'fr': 'French',
        'de': 'German',
        'es': 'Spanish',
        'ru': 'Russian',
        'auto': 'auto',
      };

      const sourceLangName = langMap[sourceLang] || 'auto';
      const targetLangName = langMap[targetLang] || 'Chinese';

      const timestamp = Date.now();
      const signature = crypto
        .createHmac('sha256', Buffer.from(this.apiKey, 'utf-8'))
        .update(`${this.groupId}${timestamp}`)
        .digest('hex');

      const response = await fetch(`${this.baseUrl}/translate`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          source_lang: sourceLangName,
          target_lang: targetLangName,
          text: text,
          timestamp: timestamp,
          signature: signature,
          group_id: this.groupId,
        }),
      });

      if (!response.ok) {
        throw new Error(`MiniMax API 错误: ${response.status}`);
      }

      const result = await response.json();
      return result.data?.translated_text || result.translated_text || result.text;
    } catch (error) {
      console.error('MiniMax 翻译错误:', error);
      throw new Error(`翻译失败: ${error.message}`);
    }
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('MiniMax 暂不支持文档翻译，请使用文本翻译功能');
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('MiniMax 暂不支持 OCR 翻译');
  }

  async checkStatus() {
    if (!this.apiKey || !this.groupId) {
      return {
        available: false,
        error: 'API 密钥未配置',
      };
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
      });

      if (response.ok) {
        return {
          available: true,
          message: 'MiniMax API 连接正常',
        };
      } else {
        return {
          available: false,
          error: `API 错误: ${response.status}`,
        };
      }
    } catch (error) {
      return {
        available: false,
        error: error.message,
      };
    }
  }
}

module.exports = MiniMaxTranslationService;
