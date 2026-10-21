'use strict';

/**
 * DeepSeek 联网检索（Search / Fetch）。
 *
 * 与站内 FTS5 检索互补：
 *   站内 = 作者自己的积累（写小说的人最贴自己风格的素材）
 *   联网 = 外部事实（历史背景、地理气候、典故出处这类作者记不准的东西）
 *
 * 端点（与对话端点共用同一把 Bearer key）：
 *   POST /v1/tools/search  搜索
 *     入参 { query(必填,1-128), count(默认10,最多50), ori_question(≤128),
 *            localization, need_content }
 *     返回每条含 title / url / summary(约600-800字) / snippet /
 *            rerank_score(0-3) / authority(0-4) / date
 *   POST /v1/tools/fetch   抓取网页正文
 *     入参 { url(必填,最长8192) }
 *     返回 { title, content }，content 是 Markdown 正文
 *
 * 限流：官方文档标注账号级 Search 100 QPS、Fetch 25 QPS（两者独立计算），
 * Fetch 另有域名级限制。本地节流取得比这更保守，单人写作够用。
 * 重试：仅 429 与 5xx 指数退避（最多 3 次），其余 4xx 直接失败不重试。
 *
 * 官方建议用 rerank_score >= 1.5 过滤低质结果，authority >= 3 为高度权威来源。
 */

const aiConfig = require('../aiConfig');
const { fetchWithRetry } = require('../providers/base');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

/** 账号级节流：220ms 一次，约 4.5 QPS，比官方上限保守 */
const ACCOUNT_INTERVAL_MS = 220;

/** 同一域名的抓取间隔：1 秒一次，避开域名级 QPS 限制 */
const DOMAIN_INTERVAL_MS = 1000;

/** 默认返回条数 */
const DEFAULT_COUNT = 8;

/** 官方限制：query 与 ori_question 都不超过 128 个字符 */
const MAX_QUERY_CHARS = 128;

/** 单页正文最多保留多少字，避免把上下文撑爆 */
const MAX_FETCH_CHARS = 8000;

/** 上一次请求时间（账号级节流） */
let lastRequestAt = 0;

/** 每个域名上一次抓取时间（域名级节流） */
const lastFetchAt = new Map();

/**
 * 账号级节流。
 */
async function throttleAccount() {
  const wait = lastRequestAt + ACCOUNT_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
}

/**
 * 域名级节流。同一域名 ≤1 QPS。
 */
async function throttleDomain(domain) {
  const last = lastFetchAt.get(domain) || 0;
  const wait = last + DOMAIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastFetchAt.set(domain, Date.now());
}

/**
 * 从响应里取出结果数组。
 *
 * 官方文档给的是字段清单，没写外层信封名。不同版本信封可能不同
 * （results / data / items / web_pages），这里逐个兜底，
 * 免得因为字段名对不上就检索不到东西。
 */
function extractItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  const keys = ['results', 'data', 'items', 'webPages', 'web_pages', 'list', 'documents'];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.results)) {
      return value.results;
    }
  }
  return [];
}

/**
 * 归一化单条搜索结果。
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const url = String(raw.url || raw.link || raw.source_url || '').trim();
  const title = String(raw.title || raw.name || '').trim();
  if (!url && !title) return null;

  const rerank = Number(raw.rerank_score ?? raw.rerankScore);
  const authority = Number(raw.authority);

  return {
    title: title || url,
    url,
    // summary 密度高于 snippet，优先用
    snippet: String(raw.summary || raw.snippet || raw.content || '').trim(),
    date: String(raw.date || raw.publish_date || '').trim(),
    // 字段缺失时当作未知：不过滤掉，排序时靠后
    rerankScore: Number.isFinite(rerank) ? rerank : null,
    authority: Number.isFinite(authority) ? authority : null,
  };
}

/**
 * 排序：权威来源优先，其次相关度（rerank_score）。
 */
function rankItems(items) {
  return items.sort((a, b) => {
    const aAuth = a.authority !== null && a.authority >= 2 ? 1 : 0;
    const bAuth = b.authority !== null && b.authority >= 2 ? 1 : 0;
    if (aAuth !== bAuth) return bAuth - aAuth;
    return (b.rerankScore ?? 0) - (a.rerankScore ?? 0);
  });
}

/**
 * 联网搜索。
 *
 * @param {string} query 搜索词
 * @param {Object} [options]
 * @param {string} [options.oriQuestion] 作者的原始问句，帮检索方理解意图
 * @param {number} [options.count] 返回条数
 * @param {boolean} [options.needContent] 是否直接带上正文
 * @returns {Promise<{ok: boolean, items: Array, reason: string}>}
 *   ok=false 表示没配 key 或请求失败，reason 是给作者看的原因
 */
async function search(query, options = {}) {
  const cfg = aiConfig.getConfig();
  const apiKey = (cfg.deepseek?.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, items: [], reason: '未配置 DeepSeek API Key，联网检索不可用' };
  }

  const text = String(query || '').trim();
  if (!text) {
    return { ok: true, items: [], reason: '' };
  }

  const baseUrl = (cfg.deepseek?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  // 官方允许 count 到 50，这里收到 20：写作查资料用不了那么多，
  // 少拿几条也能省下模型读长摘要的时间
  const count = Math.min(Math.max(Number(options.count) || DEFAULT_COUNT, 1), 20);
  const threshold = Number(
    options.threshold ?? cfg.search?.rerankScoreThreshold ?? 1.5
  );

  const body = { query: text.slice(0, MAX_QUERY_CHARS), count };
  if (options.oriQuestion) {
    // 官方限制 ori_question 也不超过 128 字符，超了会整个请求被 400 拒掉
    body.ori_question = String(options.oriQuestion).slice(0, MAX_QUERY_CHARS);
  }
  if (options.needContent) {
    body.need_content = true;
  }

  try {
    await throttleAccount();
    const response = await fetchWithRetry(`${baseUrl}/v1/tools/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json();
    const items = extractItems(payload)
      .map(normalizeItem)
      .filter(Boolean)
      // rerank_score 缺失时保留（未知不等于低质），有值时按阈值过滤
      .filter((it) => it.rerankScore === null || it.rerankScore >= threshold);

    return { ok: true, items: rankItems(items).slice(0, count), reason: '' };
  } catch (err) {
    return { ok: false, items: [], reason: `联网检索失败：${err.message}` };
  }
}

/**
 * 抓取网页正文。
 *
 * @param {string} url
 * @returns {Promise<{ok: boolean, title: string, content: string, reason: string}>}
 */
async function fetchPage(url) {
  const cfg = aiConfig.getConfig();
  const apiKey = (cfg.deepseek?.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, title: '', content: '', reason: '未配置 DeepSeek API Key' };
  }

  const target = String(url || '').trim();
  if (!target) {
    return { ok: false, title: '', content: '', reason: '缺少 url' };
  }

  let domain = '';
  try {
    domain = new URL(target).hostname;
  } catch (e) {
    return { ok: false, title: '', content: '', reason: 'url 格式不正确' };
  }

  const baseUrl = (cfg.deepseek?.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');

  try {
    await throttleDomain(domain);
    await throttleAccount();

    const response = await fetchWithRetry(`${baseUrl}/v1/tools/fetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ url: target.slice(0, 8192) }),
    });

    const payload = await response.json();
    const data =
      (payload && (payload.data || payload.result)) || payload || {};

    return {
      ok: true,
      title: String(data.title || '').trim(),
      content: String(data.content || '').slice(0, MAX_FETCH_CHARS),
      reason: '',
    };
  } catch (err) {
    return { ok: false, title: '', content: '', reason: `抓取失败：${err.message}` };
  }
}

/**
 * 联网检索是否可用。
 */
function available() {
  const cfg = aiConfig.getConfig();
  return Boolean((cfg.deepseek?.apiKey || '').trim());
}

module.exports = {
  search,
  fetchPage,
  available,
  extractItems,
  normalizeItem,
  rankItems,
  MAX_FETCH_CHARS,
};
