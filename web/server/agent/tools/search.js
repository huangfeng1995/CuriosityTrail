const ollama = require('../../services/ollama');
const PROMPTS = require('../../services/prompts');
const axios = require('axios');

class SearchTool {
  constructor() {
    this.searchEngines = {
      duckduckgo: this.duckduckgoSearch.bind(this),
      wikipedia: this.wikipediaSearch.bind(this)
    };
  }

  async execute(params) {
    const { query, engine = 'duckduckgo' } = params;

    const searchFunction = this.searchEngines[engine];
    if (!searchFunction) {
      throw new Error(`未知的搜索引擎：${engine}`);
    }

    try {
      const results = await searchFunction(query);
      return this.formatResults(results, query);
    } catch (error) {
      console.error('Search error:', error);
      return '搜索失败，请稍后重试。';
    }
  }

  async duckduckgoSearch(query) {
    try {
      const response = await axios.get('https://api.duckduckgo.com/', {
        params: {
          q: query,
          format: 'json',
          no_redirect: 1,
          skip_disambig: 1
        },
        timeout: 10000
      });

      return {
        title: response.data.Heading || query,
        abstract: response.data.AbstractText || '',
        url: response.data.AbstractURL || '',
        related: response.data.RelatedTopics || []
      };
    } catch (error) {
      throw new Error('DuckDuckGo 搜索失败');
    }
  }

  async wikipediaSearch(query) {
    try {
      const response = await axios.get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(query), {
        timeout: 10000
      });

      return {
        title: response.data.title,
        extract: response.data.extract,
        url: response.data.content_urls?.desktop?.page || ''
      };
    } catch (error) {
      throw new Error('Wikipedia 搜索失败');
    }
  }

  formatResults(results, query) {
    let formatted = `# 搜索结果：${query}\n\n`;

    if (results.title) {
      formatted += `## ${results.title}\n\n`;
    }

    if (results.abstract || results.extract) {
      formatted += `${results.abstract || results.extract}\n\n`;
    }

    if (results.url) {
      formatted += `来源：${results.url}\n`;
    }

    return formatted;
  }
}

module.exports = new SearchTool();
