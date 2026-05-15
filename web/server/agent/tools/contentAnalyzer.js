const ollama = require('../../services/ollama');
const PROMPTS = require('../../services/prompts');

class ContentAnalyzer {
  async execute(params) {
    const { content, analysisType = 'general' } = params;

    if (!content || content.length < 50) {
      return {
        error: '内容太短，无法分析'
      };
    }

    let analysisPrompt;
    
    switch (analysisType) {
      case 'critique':
        analysisPrompt = `请对以下内容进行批判性分析：

${content.substring(0, 6000)}

批判性分析包括：
1. 论点的 strengths 和 weaknesses
2. 证据的可靠性
3. 逻辑连贯性
4. 与其他研究的对比
5. 可能的 bias`;
        break;
      
      case 'compare':
        analysisPrompt = `请比较以下内容中的不同观点：

${content.substring(0, 6000)}

比较分析包括：
1. 主要观点梳理
2. 观点间的异同
3. 各观点的优势
4. 争议焦点`;
        break;
      
      default:
        analysisPrompt = `请分析以下内容：

${content.substring(0, 6000)}

分析包括：
1. 主要论点
2. 关键概念
3. 重要证据
4. 结论总结`;
    }

    const result = await ollama.chat({
      messages: [
        {
          role: 'system',
          content: PROMPTS.literatureAnalysis
        },
        {
          role: 'user',
          content: analysisPrompt
        }
      ],
      temperature: 0.5,
      max_tokens: 2048
    });

    if (!result.success) {
      return {
        error: '分析失败'
      };
    }

    return {
      analysis: result.message.content,
      type: analysisType
    };
  }

  async structure(content) {
    const result = await ollama.chat({
      messages: [
        {
          role: 'user',
          content: `请分析以下内容的结构：

${content.substring(0, 6000)}

请指出：
1. 整体结构（引言、方法、结果、讨论等）
2. 各部分的主要观点
3. 逻辑关系`
        }
      ],
      temperature: 0.5
    });

    return result.success ? result.message.content : '结构分析失败';
  }

  async extractInsights(content) {
    const result = await ollama.chat({
      messages: [
        {
          role: 'user',
          content: `从以下内容中提取有价值的 insights：

${content.substring(0, 6000)}

Insights 包括：
1. 意外的发现
2. 新观点或角度
3. 实际应用价值
4. 未来研究方向`
        }
      ],
      temperature: 0.7
    });

    return result.success ? result.message.content : '洞察提取失败';
  }
}

module.exports = new ContentAnalyzer();
