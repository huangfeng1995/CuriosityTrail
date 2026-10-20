const TranslationService = require('./translationService');
const llamaCppService = require('../llamaCpp');

class LlamaCppTranslationService extends TranslationService {
  constructor(modelPath, temperature = 0.3) {
    super();
    this.modelPath = modelPath;
    this.temperature = temperature;
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    try {
      const sourceLangDisplay = this.getLanguageDisplay(sourceLang);
      const targetLangDisplay = this.getLanguageDisplay(targetLang);
      
      const prompt = `请将以下${sourceLangDisplay}翻译成${targetLangDisplay}：\n\n${text}\n\n翻译结果：`;
      
      // 使用现有的 llamaCpp 服务
      llamaCppService.modelPath = this.modelPath;
      const result = await llamaCppService.generate({
        prompt,
        temperature: this.temperature,
        maxTokens: Math.max(text.length * 2, 2048)
      });
      
      return result.response;
    } catch (error) {
      console.error('LlamaCpp translation error:', error);
      throw new Error(`翻译失败: ${error.message}`);
    }
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    const text = fileBuffer.toString('utf-8');
    return this.translate(text, targetLang, sourceLang);
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('LlamaCpp 暂不支持 OCR，请先提取文本');
  }

  async checkStatus() {
    try {
      llamaCppService.modelPath = this.modelPath;
      const available = llamaCppService.isAvailable();
      
      return {
        available,
        message: available ? `模型文件可用: ${this.modelPath}` : '模型文件不可用',
        modelPath: this.modelPath
      };
    } catch (error) {
      return {
        available: false,
        error: `检查状态失败: ${error.message}`
      };
    }
  }

  getLanguageDisplay(lang) {
    const langMap = {
      'zh': '中文',
      'en': '英文',
      'ja': '日语',
      'ko': '韩语',
      'fr': '法语',
      'de': '德语',
      'es': '西班牙语',
      'ru': '俄语',
      'auto': '自动检测语言'
    };
    return langMap[lang] || '中文';
  }
}

module.exports = LlamaCppTranslationService;
