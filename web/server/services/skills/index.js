'use strict';

/**
 * 技能注册表。
 *
 * 一个技能就是一个对象：{ name, label, description, parameters, run }。
 * 字段形状与 OpenAI function schema 对齐，将来要换原生 function calling，
 * 只换传输层，技能代码一行不改。
 *
 * 注册而不是写死数组，是为了让测试能塞进自己的技能
 * （比如一个必定抛错的技能，用来验证错误路径）。
 */

/** 已注册的技能 */
const REGISTRY = new Map();

/**
 * 注册一个技能。
 *
 * @param {Object} skill
 * @param {string} skill.name 唯一标识，模型用它来调用
 * @param {string} skill.label 中文名，显示给作者看
 * @param {string} skill.description 何时该用它，写给模型看
 * @param {Object} skill.parameters OpenAI function schema 形状
 * @param {Function} skill.run 执行体，签名 (params, ctx) => Promise<Object>
 * @returns {Function} 反注册函数
 */
function register(skill) {
  if (!skill || !skill.name) {
    throw new Error('技能必须有 name');
  }
  REGISTRY.set(skill.name, skill);
  return () => REGISTRY.delete(skill.name);
}

/**
 * 列出全部技能（给提示词用）。
 * @returns {Array<Object>}
 */
function listSkills() {
  return Array.from(REGISTRY.values()).map((s) => ({
    name: s.name,
    label: s.label,
    description: s.description,
    parameters: s.parameters || { type: 'object', properties: {}, required: [] },
  }));
}

/**
 * 按名取技能。
 * @param {string} name
 * @returns {Object|null}
 */
function getSkill(name) {
  return REGISTRY.get(name) || null;
}

/** 技能默认超时（毫秒）。技能内部会调模型，不能无限挂着 */
const SKILL_TIMEOUT_MS = 60000;

/**
 * 按 parameters 声明的 schema 做轻量校验。
 *
 * 只查"必填项在不在"和"给了值的类型对不对"：
 * 模型偶尔会把数字写成字符串、把数组写成逗号分隔的串，
 * 放任它进技能里，往往运行到一半才抛错，作者看到的是一个莫名其妙的失败。
 * 校验结果会被 loop.js 当作工具结果喂回模型，让模型自己纠正再试。
 *
 * @param {Object} skill
 * @param {Object} params
 * @returns {string} 空串表示通过
 */
function validateParams(skill, params) {
  const schema = skill.parameters;
  if (!schema) return '';

  const props = schema.properties || {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const key of required) {
    const value = params[key];
    if (value === undefined || value === null || value === '') {
      return `缺少必填参数「${key}」`;
    }
  }

  const typeOf = (value) => {
    if (Array.isArray(value)) return 'array';
    if (value === null) return 'null';
    return typeof value;
  };

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const spec = props[key];
    if (!spec || !spec.type) continue;

    const actual = typeOf(value);
    // 容忍模型把数字写成字符串："1" 在语义上仍是数字
    if (spec.type === 'number' && actual === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
      continue;
    }
    if (spec.type === 'integer' && actual === 'string' && Number.isInteger(Number(value))) {
      continue;
    }
    if (actual !== spec.type) {
      return `参数「${key}」应为 ${spec.type}，实际收到 ${actual}`;
    }
  }

  return '';
}

/**
 * 给技能执行加超时与取消。
 *
 * 技能里的模型调用走的是同一条 provider，取消信号已经传下去了；
 * 这里再兜一层超时，防止某个技能在数据库/HTTP 上卡死拖住整轮对话。
 *
 * @param {Promise} promise
 * @param {number} timeoutMs
 * @param {AbortSignal|null} signal
 * @param {string} label
 */
function withTimeout(promise, timeoutMs, signal, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}执行超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    function onAbort() {
      cleanup();
      reject(new Error('这次请求已取消'));
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error('这次请求已取消'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      }
    );
  });
}

/**
 * 执行技能。
 *
 * 技能不存在、参数不合规、技能抛错都**不抛出去**：调用方（loop.js）要能把错误
 * 当作工具结果喂回模型，让模型自己向作者解释，而不是让整轮对话崩掉。
 *
 * @param {string} name
 * @param {Object} params
 * @param {Object} ctx
 * @returns {Promise<{ok: boolean, result?: Object, error?: string}>}
 */
async function runSkill(name, params, ctx = {}) {
  const skill = getSkill(name);
  if (!skill) {
    return { ok: false, error: `没有名为「${name}」的技能` };
  }

  const clean = params && typeof params === 'object' ? params : {};
  const problem = validateParams(skill, clean);
  if (problem) {
    return { ok: false, error: `${problem}。请按技能参数说明修正后重试。` };
  }

  const timeoutMs = Number(ctx.timeoutMs) > 0 ? Number(ctx.timeoutMs) : SKILL_TIMEOUT_MS;

  try {
    const result = await withTimeout(
      Promise.resolve().then(() => skill.run(clean, { ...ctx, timeoutMs })),
      timeoutMs,
      ctx.signal || null,
      skill.label || name
    );
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  register,
  listSkills,
  getSkill,
  runSkill,
  validateParams,
  REGISTRY,
};

const auditForeshadowing = require('./auditForeshadowing');
register(auditForeshadowing);

const checkConsistency = require('./checkConsistency');
register(checkConsistency);
