class TranslationService {
  async translate(text, targetLang, sourceLang = 'auto') {
    throw new Error('translate() must be implemented by subclass');
  }

  async translateDocument(fileBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('translateDocument() must be implemented by subclass');
  }

  async ocrAndTranslate(imageBuffer, targetLang, sourceLang = 'auto') {
    throw new Error('ocrAndTranslate() must be implemented by subclass');
  }

  async checkStatus() {
    throw new Error('checkStatus() must be implemented by subclass');
  }
}

module.exports = TranslationService;
