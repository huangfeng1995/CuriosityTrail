const TranslationService = require('./translationService');

class LlamaCppTranslationService extends TranslationService {
  constructor(modelPath, temperature = 0.3) {
    super();
    this.modelPath = modelPath;
    this.temperature = temperature;
    this.model = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    
    try {
      const { Llama } = require('node-llama-cpp');
      this.model = await Llama.loadModel({
        modelPath: this.modelPath,
        gpuLayers: -1, // 使用所有可用的 GPU 层
      });
      this.initialized = true;
    } catch (error) {
      console.error('LlamaCpp 初始化失败:', error);
      throw new Error(`初始化 LlamaCpp 失败: ${error.message}`);
    }
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    if (!this.initialized) {
      await this.init();
    }

    try {
      const sourceLangDisplay = this.getLanguageDisplay(sourceLang);
      const targetLangDisplay = this.getLanguageDisplay(targetLang);
      const prompt = this.buildTranslationPrompt(text, sourceLangDisplay, targetLangDisplay);

      const session = await this.model.createSession();
      const result = await session.generate(prompt, {
        temperature: this.temperature,
        topP: 0.9,
        repeatLastN: 64,
        repeatPenalty: 1.1,
        maxTokens: 2048,
        stopSequence: ['<|im_end|>', '\n\n'],
      });

      let translation = result.trim();
      const endIndex = translation.indexOf('<|im_end|>');
      if (endIndex !== -1) {
        translation = translation.slice(0, endIndex).trim();
      }

      return translation;
    } catch (error) {
      console.error('LlamaCpp 翻译错误:', error);
      throw new Error(`本地模型翻译失败: ${error.message}`);
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
      const fs = require('fs');
      const modelExists = fs.existsSync(this.modelPath);
      
      return {
        available: modelExists,
        message: modelExists ? `模型文件就绪: ${this.modelPath}` : '模型文件不存在',
        modelPath: this.modelPath,
      };
    } catch (error) {
      return {
        available: false,
        error: `检查状态失败: ${error.message}`,
      };
    }
  }

  getLanguageDisplay(lang) {
    const langMap = {
      'zh': '中文',
      'en': 'English',
      'ja': '日语',
      'ko': '韩语',
      'fr': '法语',
      'de': '德语',
      'es': '西班牙语',
      'ru': '俄语',
      'auto': '自动检测',
    };
    return langMap[lang] || '中文';
  }

  buildTranslationPrompt(text, sourceLang, targetLang) {
    return `<|im_start|>system
你是一个专业的翻译助手。请准确、流畅地将${sourceLang}翻译成${targetLang}。<|im_end|>
<|im_start|>user
请将以下${sourceLang}文本翻译成${targetLang}，只返回翻译结果，不要添加任何解释：

${text}<|im_end|>
<|im_start|>assistant
`;
  }
}

module.exports = LlamaCppTranslationService;
