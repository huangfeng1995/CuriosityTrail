'use strict';

/**
 * 模型输出的解析。
 *
 * 从 routes/ai.js 搬出来的独立模块：循环层（services/agent/loop.js）
 * 也要用它，而路由文件只导出 router，循环层引用不到路由里的私有函数。
 *
 * 纯函数：不碰数据库、不碰 HTTP，输入模型原文，输出结构化对象或 null。
 */

/**
 * 解析模型的 JSON 输出。
 * 模型可能返回带 markdown 代码块的 JSON，需要剥掉。
 *
 * @param {string} text 模型原文
 * @returns {Object|null}
 */
function parseModelJson(text) {
  if (!text) return null;

  let candidate = text.trim();

  // 剥掉 ```json ... ``` 包裹
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    candidate = fence[1].trim();
  }

  try {
    return JSON.parse(candidate);
  } catch (e) {
    // 退而求其次：截取第一个 { 到最后一个 }
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { parseModelJson };
