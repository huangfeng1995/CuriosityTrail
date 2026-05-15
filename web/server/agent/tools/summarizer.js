const ollama = require('../../services/ollama');
const PROMPTS = require('../../services/prompts');

class Summarizer {
  async execute(params) {
    const { content, type = 'general', maxLength = 500 } = params;

    if (!content || content.length < 100) {
      return content;
    }

    let prompt;
    
    switch (type) {
      case 'detailed':
        prompt = `请为以下内容生成一份详细摘要，包括主要观点、关键论据和结论：

${content.substring(0, 8000)}

详细摘要（500字以上）：`;
        break;
      
      case 'bullet':
        prompt = `请为以下内容生成要点列表：

${content.substring(0, 8000)}

要点列表（使用 Markdown）：`;
        break;
      
      default:
        prompt = `请为以下内容生成简洁摘要：

${content.substring(0, 8000)}

摘要（${maxLength}字以内）：`;
    }

    const result = await ollama.generate({
      prompt,
      temperature: 0.5,
      max_tokens: 1024
    });

    return result.success ? result.response : '摘要生成失败';
  }

  async abstract(content) {
    return this.execute({ content, type: 'general', maxLength: 300 });
  }

  async bulletPoints(content) {
    return this.execute({ content, type: 'bullet' });
  }
}

module.exports = new Summarizer();
