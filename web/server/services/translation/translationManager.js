const MiniMaxTranslationService = require('./minimaxTranslation');
const OllamaTranslationService = require('./ollamaTranslation');

class TranslationManager {
  constructor() {
    this.services = {
      minimax: null,
      ollama: null,
    };
    this.currentService = 'ollama';
    this.settings = {
      service: 'ollama',
      minimax: {
        apiKey: '',
        groupId: '',
      },
      ollama: {
        baseUrl: 'http://localhost:11434',
        model: 'llama3.2:3b',
      },
      defaultTargetLang: 'zh',
    };
  }

  initialize(settings = {}) {
    if (settings.minimax) {
      this.settings.minimax = {
        ...this.settings.minimax,
        ...settings.minimax,
      };
      this.services.minimax = new MiniMaxTranslationService(
        this.settings.minimax.apiKey,
        this.settings.minimax.groupId
      );
    }

    if (settings.ollama) {
      this.settings.ollama = {
        ...this.settings.ollama,
        ...settings.ollama,
      };
      this.services.ollama = new OllamaTranslationService(
        this.settings.ollama.baseUrl,
        this.settings.ollama.model
      );
    }

    if (settings.service) {
      this.settings.service = settings.service;
      this.currentService = settings.service;
    }

    if (settings.defaultTargetLang) {
      this.settings.defaultTargetLang = settings.defaultTargetLang;
    }
  }

  getCurrentService() {
    const serviceName = this.currentService;
    const service = this.services[serviceName];

    if (!service) {
      throw new Error(`翻译服务 ${serviceName} 未初始化`);
    }

    return service;
  }

  async translate(text, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    return service.translate(text, targetLang, sourceLang);
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    if (typeof service.translateDocument === 'function') {
      return service.translateDocument(fileBuffer, targetLang, sourceLang);
    }
    throw new Error('当前翻译服务不支持文档翻译');
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    const service = this.getCurrentService();
    if (typeof service.ocrAndTranslate === 'function') {
      return service.ocrAndTranslate(imageBuffer, targetLang, sourceLang);
    }
    throw new Error('当前翻译服务不支持 OCR 翻译');
  }

  async checkAllServicesStatus() {
    const status = {
      current: this.currentService,
      services: {},
    };

    for (const [name, service] of Object.entries(this.services)) {
      if (service) {
        try {
          status.services[name] = await service.checkStatus();
        } catch (error) {
          status.services[name] = {
            available: false,
            error: error.message,
          };
        }
      } else {
        status.services[name] = {
          available: false,
          error: '服务未初始化',
        };
      }
    }

    return status;
  }

  setService(serviceName) {
    if (!this.services[serviceName]) {
      throw new Error(`翻译服务 ${serviceName} 不存在`);
    }
    this.currentService = serviceName;
    this.settings.service = serviceName;
  }

  updateSettings(newSettings) {
    if (newSettings.service && newSettings.service !== this.currentService) {
      this.setService(newSettings.service);
    }

    if (newSettings.minimax) {
      this.settings.minimax = {
        ...this.settings.minimax,
        ...newSettings.minimax,
      };
      this.services.minimax = new MiniMaxTranslationService(
        this.settings.minimax.apiKey,
        this.settings.minimax.groupId
      );
    }

    if (newSettings.ollama) {
      this.settings.ollama = {
        ...this.settings.ollama,
        ...newSettings.ollama,
      };
      this.services.ollama = new OllamaTranslationService(
        this.settings.ollama.baseUrl,
        this.settings.ollama.model
      );
    }

    if (newSettings.defaultTargetLang) {
      this.settings.defaultTargetLang = newSettings.defaultTargetLang;
    }
  }

  getSettings() {
    return {
      ...this.settings,
      minimax: {
        ...this.settings.minimax,
        apiKey: this.settings.minimax.apiKey ? '******' + this.settings.minimax.apiKey.slice(-4) : '',
      },
    };
  }
}

const translationManager = new TranslationManager();

translationManager.initialize({
  service: 'ollama',
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
  },
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || '',
    groupId: process.env.MINIMAX_GROUP_ID || '',
  },
});

module.exports = translationManager;
