const ollama = require('../../services/ollama');
const PROMPTS = require('../../services/prompts');

class KeywordExtractor {
  async execute(params) {
    const { content, topN = 10 } = params;

    if (!content || content.length < 50) {
      return {
        keywords: [],
        topics: [],
        concepts: [],
        error: '内容太短，无法提取关键词'
      };
    }

    const prompt = `请从以下文本中提取关键词和主题：

文本内容：
${content.substring(0, 5000)}

${PROMPTS.keywordExtraction}

请提取最重要的 ${topN} 个关键词。`;

    const result = await ollama.chat({
      messages: [
        {
          role: 'system',
          content: PROMPTS.keywordExtraction
        },
        {
          role: 'user',
          content: `请从以下文本中提取关键词和主题：\n\n${content.substring(0, 5000)}`
        }
      ],
      temperature: 0.3
    });

    if (!result.success) {
      return {
        keywords: [],
        topics: [],
        concepts: [],
        error: '关键词提取失败'
      };
    }

    try {
      const parsed = JSON.parse(result.message.content);
      return {
        keywords: parsed.keywords || [],
        topics: parsed.topics || [],
        concepts: parsed.concepts || []
      };
    } catch (e) {
      // 如果不是 JSON，手动提取
      return this.extractManually(result.message.content);
    }
  }

  extractManually(text) {
    // 简单的关键词提取逻辑
    const words = text.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/g) || [];
    const wordCount = {};
    
    words.forEach(word => {
      if (word.length >= 2) {
        wordCount[word] = (wordCount[word] || 0) + 1;
      }
    });

    const sorted = Object.entries(wordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      keywords: sorted.map(([word, count]) => ({
        word,
        frequency: count,
        importance: count > 5 ? 'high' : 'medium'
      })),
      topics: [],
      concepts: []
    };
  }
}

module.exports = new KeywordExtractor();
