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

/**
 * 执行技能。
 *
 * 技能不存在与技能抛错都**不抛出去**：调用方（loop.js）要能把错误
 * 当作工具结果喂回模型，让模型自己向作者解释，而不是让整轮对话崩掉。
 *
 * @param {string} name
 * @param {Object} params
 * @param {Object} ctx
 * @returns {Promise<{ok: boolean, result?: Object, error?: string}>}
 */
async function runSkill(name, params, ctx) {
  const skill = getSkill(name);
  if (!skill) {
    return { ok: false, error: `没有名为「${name}」的技能` };
  }
  try {
    const result = await skill.run(params || {}, ctx || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = { register, listSkills, getSkill, runSkill, REGISTRY };
