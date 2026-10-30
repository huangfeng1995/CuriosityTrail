'use strict';

/**
 * Agent 多步循环。
 *
 * 模型可以要求调用技能，技能结果再喂回模型，模型据此给出最终回答。
 *
 * 关键约束：**纯逻辑**。不碰数据库、不碰 HTTP、不认识 Express。
 * 数据从参数进，回调出。这样它能单独测——喂一个假 provider 就能跑完整循环。
 *
 * token 延迟推送（无感的硬保证）：
 *   工具轮次模型输出的是 {"action":"call_tool",...} 这种 JSON 片段。
 *   照常下发的话，作者会看到一堆 JSON 噪音，「无感」直接破功。
 *   所以每一轮自带缓冲区：判定为工具轮就整轮丢弃，判定为正常轮才放行。
 */

const { parseModelJson } = require('./parse');
const skills = require('../skills');

/** 最多几轮模型调用 */
const DEFAULT_MAX_STEPS = 4;

/**
 * 判定缓冲区里的 action 取值。
 *
 * 模型不保证把 action 放在第一个键，所以整段扫描。
 * 但正文里可能出现字面量 "action":"xxx"，那是转义过的（\"action\"），
 * 要求匹配到的引号未被转义，否则正文会被误判成工具调用。
 *
 * @param {string} text
 * @returns {'call_tool'|'other'|null} null = 还判不出来
 */
function detectAction(text) {
  const re = /"action"\s*:\s*"([a-z_]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // 匹配起点前一个字符是反斜杠 → 引号被转义 → 是正文里的字面量
    if (m.index > 0 && text[m.index - 1] === '\\') continue;
    return m[1] === 'call_tool' ? 'call_tool' : 'other';
  }
  return null;
}

/**
 * 跑一轮模型调用。
 *
 * @returns {Promise<{raw: string, parsed: Object|null, finishReason: string, reasoning: string}>}
 */
async function runRound({ provider, messages, options, onToken }) {
  let raw = '';         // 完整原文，用于解析
  let buffer = '';      // 展示缓冲，用于延迟推送
  let released = false; // 缓冲是否已放行
  let suppressed = false; // 是否判定为工具轮（停止下发）
  let reasoning = '';   // 本轮思考内容

  const emit = (text) => {
    if (text) onToken(text);
  };

  const result = await provider.chatStream({
    messages,
    ...options,
    jsonOutput: true,
    onThinking: (chunk) => {
      reasoning += chunk;
    },
    onToken: (chunk) => {
      raw += chunk;
      if (released) { emit(chunk); return; }

      buffer += chunk;
      // 判定为工具轮后**继续攒 buffer**，只是不下发。
      // 万一最终解析出来不是工具调用（模型只是正文里提到了这个字符串），
      // 补发时才能给作者完整的内容，而不是半截。
      if (suppressed) return;

      const action = detectAction(buffer);
      if (action === 'call_tool') {
        suppressed = true;
        return;
      }
      if (action === 'other') {
        released = true;
        emit(buffer);
        buffer = '';
      }
    },
  });

  const rawText = result.content || raw;
  const parsed = parseModelJson(rawText);
  const isToolCall = Boolean(parsed && parsed.action === 'call_tool');

  // 兜底：模型没按契约输出 JSON（判不出 action），也得让作者看到内容，
  // 不能留一个空气泡。反过来，解析出来确实是工具调用就整轮丢弃。
  if (!isToolCall && !released) {
    released = true;
    emit(buffer);
  }

  return { raw: rawText, parsed, finishReason: result.finishReason || '', reasoning };
}

/**
 * 驱动多步循环。
 *
 * @param {Object} params
 * @param {Object} params.provider 已解析的 provider
 * @param {Array}  params.messages 初始消息数组
 * @param {Object} [params.options] 传给 provider 的额外参数（temperature/model/thinking）
 * @param {Function} [params.onToken] 正常回复轮的 token 回调
 * @param {Function} [params.onToolStart] 技能开始执行
 * @param {Function} [params.onToolDone] 技能执行结束
 * @param {Function} [params.onToolError] 技能失败
 * @param {Object} [params.ctx] 技能的执行上下文（userId/workId/provider/...）
 * @param {number} [params.maxSteps]
 * @returns {Promise<{parsed: Object|null, raw: string, toolCalls: Array}>}
 */
async function runAgentLoop(params) {
  const {
    provider,
    messages,
    options = {},
    onToken = () => {},
    onToolStart = () => {},
    onToolDone = () => {},
    onToolError = () => {},
    ctx = {},
    maxSteps = DEFAULT_MAX_STEPS,
  } = params;

  const convo = [...messages];
  const toolCalls = [];

  for (let step = 0; step < maxSteps; step++) {
    const round = await runRound({ provider, messages: convo, options, onToken });

    const isToolCall = round.parsed && round.parsed.action === 'call_tool';

    if (!isToolCall) {
      return {
        parsed: round.parsed,
        raw: round.raw,
        finishReason: round.finishReason,
        reasoning: round.reasoning,
        toolCalls,
      };
    }

    const toolName = String(round.parsed.tool || '');
    const toolParams = round.parsed.params || {};

    // 技能的中文名从注册表取。tool_start 事件要立刻发出去，
    // 那时技能还没执行完、拿不到结果里的 label，
    // 所以标签只能来自注册表——作者看到的是「伏笔盘点」，不是「audit_foreshadowing」。
    const skill = skills.getSkill(toolName);
    onToolStart({ tool: toolName, label: (skill && skill.label) || toolName, params: toolParams });

    const outcome = await skills.runSkill(toolName, toolParams, {
      ...ctx,
      provider,
      providerName: ctx.providerName,
    });

    if (outcome.ok) {
      const result = outcome.result || {};
      // 这里是工具调用的**唯一**记账点：摘要要落库、要重放，
      // 路由只负责把事件推给前端，不再自己记一份。
      toolCalls.push({
        tool: toolName,
        label: result.label || toolName,
        summary: result.summary || '',
        detail: result.detail || [],
        degraded: !!result.degraded,
      });
      onToolDone({ tool: toolName, result });
      // 喂回：assistant 侧保留模型原始 JSON 原文，user 侧放工具结果
      convo.push({ role: 'assistant', content: round.raw });
      convo.push({
        role: 'user',
        content: `【工具结果：${result.label || toolName}】\n${JSON.stringify(result.findings || result)}`,
      });
    } else {
      toolCalls.push({
        tool: toolName,
        label: toolName,
        summary: '',
        detail: [],
        degraded: false,
        error: outcome.error,
      });
      onToolError({ tool: toolName, error: outcome.error });
      convo.push({ role: 'assistant', content: round.raw });
      convo.push({
        role: 'user',
        content: `【工具结果：${toolName}】执行失败：${outcome.error}。请把这件事直接告诉作者，不要重试同一个技能。`,
      });
    }
  }

  // maxSteps 用尽：连续要技能却拿不到结果。不能静默停在一半——
  // 抛出去由路由层转成可见错误并清理孤立消息。
  const err = new Error('模型反复调用技能但没有拿到结果，这次没能查完。请换个说法再问一次。');
  err.code = 'MAX_STEPS';
  throw err;
}

module.exports = { runAgentLoop, detectAction, DEFAULT_MAX_STEPS };
