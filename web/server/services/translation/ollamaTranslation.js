const TranslationService = require('./translationService');

class OllamaTranslationService extends TranslationService {
  constructor(baseUrl = 'http://localhost:11434', model = 'llama3.2:3b') {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    try {
      const sourceLangDisplay = this.getLanguageDisplay(sourceLang);
      const targetLangDisplay = this.getLanguageDisplay(targetLang);

      const prompt = this.buildTranslationPrompt(text, sourceLangDisplay, targetLangDisplay);

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.3,
            top_p: 0.9,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API 错误: ${response.status}`);
      }

      const result = await response.json();
      return result.response?.trim() || result.response;
    } catch (error) {
      console.error('Ollama 翻译错误:', error);
      throw new Error(`本地模型翻译失败: ${error.message}`);
    }
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    const text = fileBuffer.toString('utf-8');
    return this.translate(text, targetLang, sourceLang);
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('Ollama 暂不支持 OCR，请先提取文本');
  }

  async checkStatus() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);

      if (response.ok) {
        const data = await response.json();
        const models = data.models || [];

        return {
          available: true,
          message: `Ollama 连接正常，当前有 ${models.length} 个模型`,
          models: models.map(m => m.name),
        };
      } else {
        return {
          available: false,
          error: `Ollama 服务不可用: ${response.status}`,
        };
      }
    } catch (error) {
      return {
        available: false,
        error: `无法连接到 Ollama: ${error.message}`,
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
    return `请将以下${sourceLang}文本翻译成${targetLang}。

要求：
1. 保持原文的格式和风格
2. 翻译准确、流畅
3. 对于专业术语，保留原文或提供解释
4. 只返回翻译结果，不要添加任何解释

原文：
${text}

${targetLang}翻译：
`;
  }
}

module.exports = OllamaTranslationService;
