'use strict';

/**
 * 对话事实抽取。
 *
 * 每轮对话结束后，AI 会从「作者问了什么 + AI 答了什么」里挑出
 * 值得长期记住的事实（剧情走向、人物决定、设定变更、新出现的专名）。
 *
 * 这一层是记忆库里**信噪比最高**的部分：原始层存的是完整对话，
 * 噪声大、召回时容易捞到无关闲聊；事实层只留"以后还会用到"的结论。
 *
 * 三条原则：
 *
 *  1. **宁缺毋滥。** 挑不出就不写。记忆库宁可少一条，也不能塞满
 *     "作者说继续""好的"这种垃圾——垃圾会挤掉真正重要的召回名额。
 *  2. **抽取失败就整批丢弃。** 模型输出不合格（不是 JSON、条数超限、
 *     内容为空）时，这一轮的事实全部作废，只保留原始层。
 *     半拉子的事实比没有事实更危险：模型会当成真的来用。
 *  3. **绝不阻塞对话。** 抽取是异步的，作者等的是答案，不是记忆。
 */

const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');

/** 每轮最多记几条事实。 */
const MAX_FACTS = 5;

/** 单条事实最多多少字。超了说明模型在写总结而不是记事实。 */
const MAX_FACT_LENGTH = 120;

/** 抽取用的系统提示词。 */
const EXTRACT_SYSTEM_PROMPT = [
  '你是一部长篇小说的「设定管理员」。作者正在和 AI 助手讨论剧情，',
  '你要从这一轮对话里挑出**值得长期记住的事实**。',
  '',
  '值得记的：',
  '- 敲定了某个剧情走向、人物决定、伏笔安排',
  '- 人物或世界观的设定变更（改名、改身份、改规则）',
  '- 第一次出现的人物名、地名、物件名等专有名词',
  '- 作者表达了明确意图（"必须这样"、"不要那样"、"就按这个写"）',
  '',
  '不值得记的：',
  '- 寒暄、闲聊、单纯的写作技巧讨论',
  '- 一次性的、不影响后文的细节',
  '- AI 自己的客套话和免责声明',
  '',
  '最多 5 条。每条一句话，不超过 40 字，用陈述句，脱离上下文也能看懂。',
  '只输出 JSON，不要任何解释文字：{"facts": ["...", "..."]}',
  '没有值得记的就输出 {"facts": []}',
].join('\n');

/** 正在进行的抽取任务。测试用它等待。 */
const pending = new Set();

/**
 * 剥掉 markdown 代码块围栏。
 * @param {string} text
 * @returns {string}
 */
function stripFence(text) {
  const fence = String(text || '').match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? fence[1].trim() : String(text || '').trim();
}

/**
 * 从模型输出里解析出事实数组。
 *
 * 模型可能给数组、也可能给带 facts 键的对象；都认。
 * 解析不出来返回 null —— 调用方据此判定"整批丢弃"。
 *
 * @param {string} raw 模型输出
 * @returns {string[]|null}
 */
function parseFacts(raw) {
  const text = stripFence(raw);
  if (!text) return null;

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 退而求其次：截取第一对 [ ]
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        return null;
      }
    } else {
      return null;
    }
  }

  let list = null;
  if (Array.isArray(data)) {
    list = data;
  } else if (data && typeof data === 'object') {
    // 找第一个数组字段
    for (const key of ['facts', 'items', 'list', 'memories', 'result']) {
      if (Array.isArray(data[key])) {
        list = data[key];
        break;
      }
    }
    if (!list) {
      const firstArray = Object.values(data).find((v) => Array.isArray(v));
      list = Array.isArray(firstArray) ? firstArray : null;
    }
  }

  if (!list) return null;

  const facts = list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const value = item.fact || item.text || item.content || item.value;
        return typeof value === 'string' ? value.trim() : '';
      }
      return '';
    })
    .filter((text) => text.length > 0)
    .map((text) => text.slice(0, MAX_FACT_LENGTH))
    .slice(0, MAX_FACTS);

  return facts;
}

/**
 * 抽取一轮对话里的事实。
 *
 * 失败（没有 provider、请求出错、输出不合格）一律返回 null。
 *
 * @param {object} params
 * @param {string} params.userText 作者说了什么
 * @param {string} params.assistantText AI 答了什么
 * @returns {Promise<string[]|null>}
 */
async function extractFacts({ userText, assistantText }) {
  if (!userText && !assistantText) return null;

  const cfg = aiConfig.getConfig();
  const { provider } = resolveProvider(cfg);

  const result = await provider.chat({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `作者：${String(userText || '').slice(0, 2000)}\n\nAI：${String(assistantText || '').slice(0, 2000)}`,
      },
    ],
    temperature: 0.2,
    thinking: 'disabled',
    jsonOutput: true,
    maxTokens: 800,
  });

  return parseFacts(result && result.content);
}

/**
 * 异步抽取一轮对话的事实。
 *
 * 立刻返回，抽取在后台跑。作者不该为了"AI 顺便记一下"多等一秒。
 *
 * @param {object} params
 * @param {string} params.userText
 * @param {string} params.assistantText
 * @param {Function} params.onFacts 抽取成功时的回调，收到 facts 数组
 */
function scheduleExtract({ userText, assistantText, onFacts }) {
  const task = extractFacts({ userText, assistantText })
    .then(async (facts) => {
      // 空数组 = 这一轮没什么值得记的，不是失败
      if (!facts || !facts.length) return;
      if (typeof onFacts !== 'function') return;
      // 必须 await：onFacts 是异步的（要查库、要写台账）。
      // 不 await 的话它返回的 Promise 没人接，
      // 里面抛错就成了 unhandledRejection——Node 15 起默认让进程退出。
      await onFacts(facts);
    })
    .catch((e) => {
      // 抽取失败不影响任何用户操作：原始层已经入库了
      console.error('对话事实抽取失败：', e.message);
    })
    .finally(() => {
      pending.delete(task);
    });

  pending.add(task);
  return task;
}

/**
 * 等所有抽取任务跑完。测试用。
 * @returns {Promise<void>}
 */
async function whenIdle() {
  while (pending.size) {
    await Promise.allSettled([...pending]);
  }
}

module.exports = {
  MAX_FACTS,
  MAX_FACT_LENGTH,
  EXTRACT_SYSTEM_PROMPT,
  parseFacts,
  extractFacts,
  scheduleExtract,
  whenIdle,
};
