'use strict';

/**
 * 素材类 agent 技能。
 *
 * 三个工具分工：
 *   searchMaterials —— 先查作者自己的素材库，避免重复劳动；
 *   webSearch       —— 外部检索/抓取。没配 key 时明确不可用，绝不退回模型记忆；
 *   saveMaterials   —— 批量入库。所有机械约束在 materials/store 里执行。
 *
 * 检索台账挂在 ctx.searchLedger 上：webSearch 每查一次就记一条，
 * saveMaterials 据此判断 origin='web' 的条目有没有可核的检索来源。
 */

const localSearch = require('../search/local');
const deepseekSearch = require('../search/deepseekSearch');
const store = require('../materials/store');
const upgrade = require('../pipeline/upgrade');

/** 检索结果里给模型看的条目上限，避免把上下文撑爆 */
const MAX_ITEMS = 10;

const searchMaterials = {
  name: 'searchMaterials',
  label: '素材检索',
  description:
    '从作者自己的素材库里检索可用片段。整理素材前先用它查一遍，避免重复入库。只返回已启用且不是「待补」的条目。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词，用具体的名词组合，如「明代 酒楼 陈设」' },
      limit: { type: 'integer', description: '返回条数，默认 8，最多 20' },
    },
    required: ['query'],
  },
  async run(params, ctx) {
    const query = String(params.query || '').trim();
    if (!query) {
      return { label: '素材检索', summary: '检索词为空，没有查。', detail: [] };
    }
    if (!ctx.userId) {
      return { label: '素材检索', summary: '缺少用户身份，没能检索。', detail: [] };
    }

    const limit = Math.min(Math.max(Number(params.limit) || 8, 1), 20);
    let results = await localSearch.search(query, { limit, userId: ctx.userId });
    if (!results.length) {
      results = await localSearch.searchLoose(query, { limit, userId: ctx.userId });
    }

    const detail = results.map((r) => ({
      label: r.title,
      text: [r.source, r.page ? `第 ${r.page} 页` : '', r.snippet].filter(Boolean).join(' · '),
    }));

    return {
      label: '素材检索',
      summary: results.length ? `站内命中 ${results.length} 条` : '站内没有命中，可以继续外部检索',
      detail,
      items: results,
    };
  },
};

const webSearch = {
  name: 'webSearch',
  label: '联网检索',
  description:
    '联网搜索外部资料，可选抓取网页正文。没配置 DeepSeek API Key 时会明确返回不可用；此时不要用模型记忆冒充查证，应把缺口写成 confidence=missing。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词，不超过 128 字' },
      count: { type: 'integer', description: '返回条数，默认 8，最多 20' },
      fetchUrl: { type: 'string', description: '需要原文时给一个搜索结果里的 URL，抓取正文' },
    },
    required: ['query'],
  },
  async run(params, ctx) {
    const query = String(params.query || '').trim();
    if (!query) {
      return { label: '联网检索', summary: '检索词为空，没有查。', detail: [] };
    }

    if (!deepseekSearch.available()) {
      return {
        label: '联网检索',
        degraded: true,
        unavailable: true,
        summary: '联网检索不可用：未配置 DeepSeek API Key，联网检索不可用',
        detail: [{ label: '状态', text: '不可用，请把缺口标成 missing，不要用记忆冒充有出处' }],
        items: [],
      };
    }

    const count = Math.min(Math.max(Number(params.count) || 8, 1), 20);
    const result = await deepseekSearch.search(query, {
      count,
      oriQuestion: String(ctx.originalQuestion || ''),
    });

    const ledgerEntry = {
      query,
      count: result.items.length,
      urls: result.items.map((it) => it.url).filter(Boolean),
      ok: result.ok,
      fetched: [],
    };

    let fetched = null;
    if (result.ok && params.fetchUrl) {
      fetched = await deepseekSearch.fetchPage(String(params.fetchUrl));
      ledgerEntry.fetched.push({ url: String(params.fetchUrl), ok: fetched.ok });
      if (fetched.ok && fetched.content) {
        ledgerEntry.urls.push(String(params.fetchUrl));
      }
    }

    // 台账只在调用方传了数组时记录；技能本身不持有请求级状态
    if (Array.isArray(ctx.searchLedger)) ctx.searchLedger.push(ledgerEntry);

    const detail = result.items.slice(0, MAX_ITEMS).map((it) => ({
      label: it.title,
      text: [it.url, it.snippet].filter(Boolean).join(' · '),
    }));
    if (fetched) {
      detail.push({
        label: `抓取：${fetched.title || params.fetchUrl}`,
        text: fetched.ok ? fetched.content.slice(0, 800) : fetched.reason,
      });
    }

    return {
      label: '联网检索',
      degraded: !result.ok,
      summary: result.ok
        ? `外部命中 ${result.items.length} 条${fetched ? '，已抓取正文' : ''}`
        : result.reason,
      detail,
      items: result.items,
      fetched: fetched && fetched.ok ? fetched : null,
    };
  },
};

const saveMaterials = {
  name: 'saveMaterials',
  label: '素材入库',
  description:
    `把整理好的素材批量写入素材库。单批最多 ${store.MAX_BATCH} 条，超出请分批。` +
    'sourced 必须给 provenance；missing 必须 provenance 为空且正文首行写「待补：<缺什么>」；' +
    'origin=web 的条目必须能对应本次 webSearch 的检索记录，否则会被降级。',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '素材条目数组',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            provenance: { type: 'string', description: '出处：书名/篇目/网页标题' },
            confidence: {
              type: 'string',
              description: 'sourced（有出处） / inferable（可推定） / missing（查不到）',
            },
            origin: { type: 'string', description: 'web / model / internal / user' },
            sourceUrl: { type: 'string' },
            tags: { type: 'string' },
          },
          required: ['title', 'body', 'confidence'],
        },
      },
    },
    required: ['items'],
  },
  async run(params, ctx) {
    if (!ctx.userId) {
      return { label: '素材入库', summary: '缺少用户身份，没有入库。', detail: [] };
    }
    try {
      const result = await store.saveBatch(ctx.userId, params.items, {
        workId: ctx.workId || '',
        createdBy: 'agent',
        ledger: Array.isArray(ctx.searchLedger) ? ctx.searchLedger : [],
      });
      const detail = [
        ...result.created.map((x) => ({
          label: `新建：${x.title}`,
          text: `${x.confidence} · ${x.status}${x.status === 'pending' ? '（待作者批量确认）' : ''}`,
        })),
        ...result.merged.map((x) => ({
          label: `合并：${x.title}`,
          text: `已有近重复条目，已合并为 ${x.confidence}`,
        })),
      ];
      return {
        label: '素材入库',
        summary: result.summary,
        detail,
        created: result.created,
        merged: result.merged,
      };
    } catch (err) {
      // 交给 loop 作为工具错误回传，让模型按约束修正后重试
      throw err;
    }
  },
};

const upgradeAnchors = {
  name: 'upgradeAnchors',
  label: '素材升格锚点',
  description:
    '把素材显式升格为锚点草稿（初始状态为待确认，作者确认后才生效）。' +
    '只对「天然应当成为硬约束」的条目使用：年代、人物生卒、职官、明确的正史事件。' +
    '规则推不出来时不要硬编，交给服务退成 manual_only。',
  parameters: {
    type: 'object',
    properties: {
      materialIds: {
        type: 'array',
        description: '要升格的素材 id 列表',
        items: { type: 'string' },
      },
      rulesByMaterial: {
        type: 'object',
        description:
          '可选：按素材 id 显式给出规则，形如 {"素材id": [{"rule_type":"chronology","params":{...}}]}；不给则退 manual_only',
      },
    },
    required: ['materialIds'],
  },
  async run(params, ctx) {
    if (!ctx.userId) {
      return { label: '素材升格锚点', summary: '缺少用户身份，没有升格。', detail: [] };
    }
    if (!ctx.workId) {
      return {
        label: '素材升格锚点',
        summary: '当前对话没有绑定作品，锚点没有归属，未升格。',
        detail: [],
      };
    }

    const result = await upgrade.upgradeMaterials(ctx.userId, ctx.workId, params.materialIds, {
      explicitRulesByMaterial:
        params.rulesByMaterial && typeof params.rulesByMaterial === 'object'
          ? params.rulesByMaterial
          : {},
    });

    const detail = [
      ...result.created.map((item) => ({
        label: `草稿：${item.anchor.subject}`,
        text: `${item.confidence} · ${item.anchor.kind} · ${item.rules
          .map((rule) => rule.rule_type)
          .join('/')}`,
      })),
      ...result.skipped.map((item) => ({
        label: '跳过',
        text: `${item.id}：${item.reason}`,
      })),
    ];

    return {
      label: '素材升格锚点',
      summary: `生成 ${result.created.length} 条锚点草稿，跳过 ${result.skipped.length} 条；确认后才生效。`,
      detail,
      created: result.created.map((item) => ({
        id: item.anchor.id,
        subject: item.anchor.subject,
        confidence: item.confidence,
      })),
      skipped: result.skipped,
    };
  },
};

module.exports = { searchMaterials, webSearch, saveMaterials, upgradeAnchors };
