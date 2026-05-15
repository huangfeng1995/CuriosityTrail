const ollama = require('../../services/ollama');
const PROMPTS = require('../../services/prompts');

class ReportGenerator {
  async execute(params) {
    const { title, template = 'scientific', content = '' } = params;

    let prompt;
    
    if (template === 'scientific') {
      prompt = `请基于以下信息生成一份完整的科学探究报告：

主题：${title}
已有内容：${content || '无'}

${PROMPTS.reportWriting}

请严格按照模板格式生成报告，确保内容专业、逻辑清晰。如果有已有内容，请在此基础上扩展和完善。`;
    } else if (template === 'synthesis') {
      prompt = `请基于以下信息生成一份综合调研报告：

调研主题：${title}
已有内容：${content || '无'}

${PROMPTS.reportWriting.split('报告模板（综合调研）')[1]}

请严格按照模板格式生成报告。`;
    } else {
      prompt = `请基于以下信息生成一份报告：

标题：${title}
已有内容：${content || '无'}

请生成一份结构清晰、内容充实的报告。`;
    }

    const result = await ollama.generate({
      prompt,
      system: PROMPTS.reportWriting,
      temperature: 0.7,
      max_tokens: 4096
    });

    if (!result.success) {
      throw new Error('报告生成失败');
    }

    return result.response;
  }

  async expand(content, instructions) {
    const prompt = `请根据以下指示扩展内容：

原文：
${content}

扩展要求：
${instructions}

请在保持原文核心观点的基础上，进行合理扩展和深化。`;

    const result = await ollama.generate({
      prompt,
      system: PROMPTS.reportWriting,
      temperature: 0.7,
      max_tokens: 2048
    });

    return result.success ? result.response : null;
  }

  async outline(topic) {
    const prompt = `请为以下主题生成详细的研究报告大纲：

主题：${topic}

请生成一份详细的研究报告大纲，包括：
1. 主要章节
2. 每个章节的核心内容点
3. 推荐的写作顺序
4. 预计篇幅

使用 Markdown 格式输出。`;

    const result = await ollama.generate({
      prompt,
      temperature: 0.7,
      max_tokens: 2048
    });

    return result.success ? result.response : null;
  }
}

module.exports = new ReportGenerator();
