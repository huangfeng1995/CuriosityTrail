'use strict';

/**
 * 正文实体识别。
 *
 * 只做一件事：读一段刚写进正文的文字，找出里面值得沉淀成卡片的新实体
 * （人物 / 情节节点 / 设定），返回**提案**，不碰数据库、不写卡片表。
 *
 * 失败策略：一律静默。识别是写作的附带能力，模型超时或抽风不能
 * 让作者保存不了稿子，也不能弹错误——所以这里超时即放弃，不重试。
 */

const aiConfig = require('../aiConfig');
const { resolveProvider } = require('../providers');
const { parseModelJson } = require('../agent/parse');

/** 单次识别上限。实测一段正文的识别在 3–8s，20s 足够，超了就放弃。 */
const DEFAULT_TIMEOUT_MS = 20000;
/** 一轮最多产出多少条提案：太多会变成刷屏，作者反而不会看 */
const MAX_PROPOSALS = 6;
/** 太短的段落不值得识别（例如一两句话的过渡段） */
const MIN_TEXT_LENGTH = 30;
/** 标题长度上限，与卡片表里的 name/title 展示宽度匹配 */
const MAX_TITLE_LENGTH = 60;
/** 单条原文证据最多留多少字 */
const MAX_QUOTE_LENGTH = 80;
/** 单次识别的正文上限：一段应用通常远低于这个长度，超长只是防上下文失控 */
const MAX_TEXT_LENGTH = 4000;

const KINDS = new Set(['character', 'setting', 'plot']);

const SYSTEM_PROMPT = `你是小说编辑部的资料员。任务是从作者刚写好的正文里，找出值得沉淀为卡片的新实体。

只输出 JSON，不要任何解释：
{
  "proposals": [
    {
      "kind": "character",
      "title": "人物名（用正文里的写法）",
      "content": "一句话说明此人在这一段里的身份或行为",
      "role": "身份/职业",
      "identity": "背景",
      "personality": "性格",
      "source_quote": "正文里支持这条提案的原句（必须原文照抄）"
    },
    {
      "kind": "setting",
      "title": "地点/组织/物品/规则的名字",
      "category": "地点",
      "content": "这条设定是什么",
      "source_quote": "正文原句"
    },
    {
      "kind": "plot",
      "title": "情节节点的一句话概括",
      "content": "这一节点发生了什么、改变了什么",
      "source_quote": "正文原句"
    }
  ]
}

规则：
1. 只提正文里**明确出现或明确发生**的实体，不要推测后续剧情。
2. 只提**新**实体。已经出现在「已有卡片」清单里的名字/节点不要再提。
3. 人名用正文中的写法；不要合并两个不同的人。
4. setting 的 category 只能是：地点、组织、物品、规则。
5. source_quote 必须从正文原文照抄，不超过 60 字。
6. 没有值得沉淀的实体就返回 {"proposals":[]}。`;

/**
 * 归一化标题：去空格、限长。
 * @param {*} value
 * @returns {string}
 */
function normalizeTitle(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * 是否与已有卡片重名。
 * 大小写与空白不敏感：作者库里已有「林砚」，模型再提「林 砚」就是重复。
 */
function sameTitle(a, b) {
  return String(a || '').replace(/\s+/g, '').toLowerCase() ===
    String(b || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 校验并清洗模型输出。
 *
 * 纯函数：输入模型原文与已有卡片标题，输出可入库的提案。
 * 任何解析失败都返回空数组——调用方不需要区分「没提案」和「模型坏了」。
 *
 * @param {string} raw 模型原文
 * @param {{existingTitles?: Array<string>, text?: string}} [options]
 * @returns {Array<{kind: string, title: string, content: string, payload: Object, source_quote: string}>}
 */
function parseProposals(raw, options = {}) {
  const parsed = parseModelJson(raw);
  if (!parsed || !Array.isArray(parsed.proposals)) return [];

  const existingTitles = Array.isArray(options.existingTitles)
    ? options.existingTitles
    : [];
  const text = String(options.text || '');

  const out = [];
  const seen = new Set();

  for (const item of parsed.proposals) {
    if (!item || typeof item !== 'object') continue;

    const kind = String(item.kind || '').trim();
    if (!KINDS.has(kind)) continue;

    const title = normalizeTitle(item.title);
    if (!title) continue;

    // 与本轮其它提案、已有卡片重名的一律不要
    if (seen.has(`${kind}:${title}`)) continue;
    if (existingTitles.some((t) => sameTitle(t, title))) continue;

    const content = normalizeTitle(item.content);
    const quoteRaw = String(item.source_quote || '').trim();
    const sourceQuote = quoteRaw.slice(0, MAX_QUOTE_LENGTH);

    // 证据不是原文照抄时留空：宁可没有证据，也不要给作者一条对不上的引文
    const quoteVerified = sourceQuote && text.includes(sourceQuote);

    const payload = {};
    for (const key of ['role', 'identity', 'personality', 'speech', 'goal', 'arc', 'aliases', 'category']) {
      if (item[key] != null && String(item[key]).trim()) {
        payload[key] = String(item[key]).trim();
      }
    }

    // 设定必须有合法分类，否则落库时会是一张没法归类的卡
    if (kind === 'setting') {
      const category = String(payload.category || '').trim();
      if (!['地点', '组织', '物品', '规则'].includes(category)) continue;
    }

    seen.add(`${kind}:${title}`);
    out.push({
      kind,
      title,
      content: content || sourceQuote || title,
      payload,
      source_quote: quoteVerified ? sourceQuote : '',
    });

    if (out.length >= MAX_PROPOSALS) break;
  }

  return out;
}

/**
 * 带超时的模型调用。
 *
 * 用 Promise.race 而不是只依赖 AbortSignal：测试 provider 与
 * 部分兼容后端不一定实现 signal，双保险可以保证「绝不卡死」。
 * 落败的那个 promise 挂了 catch，避免超时后产生未处理的 rejection。
 */
async function callWithTimeout(provider, messages, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([
      provider
        .chat({
          messages,
          temperature: 0.3,
          maxTokens: 1200,
          jsonOutput: true,
          thinking: 'disabled',
          signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
            ? AbortSignal.timeout(timeoutMs)
            : undefined,
        })
        .catch((err) => ({ __error: err })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 识别一段正文里的新实体。
 *
 * @param {Object} params
 * @param {string} params.text 刚写入正文的文字
 * @param {Array<string>} [params.existingTitles] 已有卡片名称（避免重复提案）
 * @param {Object} [params.provider] 仅供测试注入；生产走 aiConfig
 * @param {number} [params.timeoutMs]
 * @returns {Promise<Array>} 提案数组；失败/超时返回 []
 */
async function recognize(params = {}) {
  const { text, existingTitles = [], provider, timeoutMs = DEFAULT_TIMEOUT_MS } = params;

  const trimmed = String(text || '').trim().slice(0, MAX_TEXT_LENGTH);
  if (trimmed.length < MIN_TEXT_LENGTH) return [];

  let active = provider;
  if (!active) {
    try {
      active = resolveProvider(aiConfig.getConfig()).provider;
    } catch (e) {
      return [];
    }
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `已有卡片：\n${
        existingTitles.length ? existingTitles.join('、') : '（暂无）'
      }\n\n正文：\n${trimmed}`,
    },
  ];

  try {
    const result = await callWithTimeout(active, messages, timeoutMs);
    if (!result || result.__timedOut || result.__error) return [];

    return parseProposals(result.content || '', { existingTitles, text: trimmed });
  } catch (e) {
    // 识别是附带能力：任何异常都不向调用方抛
    return [];
  }
}

module.exports = {
  recognize,
  parseProposals,
  normalizeTitle,
  MIN_TEXT_LENGTH,
  MAX_PROPOSALS,
  MAX_TITLE_LENGTH,
};
