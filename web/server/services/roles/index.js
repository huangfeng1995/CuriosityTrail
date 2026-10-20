'use strict';

/**
 * 角色注册表。
 *
 * 加载五个角色的默认定义，并叠加用户在设置页做的提示词覆盖。
 * 覆盖存放在 prompt_overrides 表（按角色 key），删除覆盖即回到默认。
 */

const { all, get, run } = require('../../database');

const DEFINITIONS = [
  require('./writer'),
  require('./editor'),
  require('./critic'),
  require('./inspiler'),
  require('./researcher'),
];

const BY_KEY = new Map(DEFINITIONS.map((r) => [r.key, r]));

/**
 * 读取所有提示词覆盖。
 * @returns {Promise<Map<string, {system_prompt: string, temperature: number|null}>>}
 */
async function loadOverrides() {
  const rows = await all('SELECT id, system_prompt, temperature FROM prompt_overrides');
  return new Map(
    rows.map((row) => [
      row.id,
      { systemPrompt: row.system_prompt, temperature: row.temperature },
    ])
  );
}

/**
 * 获取生效中的角色列表（含用户覆盖）。
 * @returns {Promise<Array>}
 */
async function listRoles() {
  const overrides = await loadOverrides();

  return DEFINITIONS.map((def) => {
    const override = overrides.get(def.key);
    return {
      key: def.key,
      name: def.name,
      icon: def.icon,
      description: def.description,
      color: def.color,
      temperature: override?.temperature ?? def.temperature,
      suggestions: def.suggestions,
      systemPrompt: override?.systemPrompt ?? def.systemPrompt,
      overridden: Boolean(override),
    };
  });
}

/**
 * 获取单个角色的生效定义。
 * @param {string} key
 */
async function getRole(key) {
  const def = BY_KEY.get(key);
  if (!def) return null;

  const override = await get(
    'SELECT system_prompt, temperature FROM prompt_overrides WHERE id = ?',
    [key]
  );

  return {
    key: def.key,
    name: def.name,
    icon: def.icon,
    description: def.description,
    color: def.color,
    temperature: override?.temperature ?? def.temperature,
    suggestions: def.suggestions,
    systemPrompt: override?.system_prompt ?? def.system_prompt ?? def.systemPrompt,
    overridden: Boolean(override),
  };
}

/**
 * 保存提示词覆盖。
 * @param {string} key
 * @param {{systemPrompt: string, temperature?: number}} payload
 */
async function saveOverride(key, payload) {
  if (!BY_KEY.has(key)) {
    throw new Error(`未知的角色：${key}`);
  }
  const now = new Date().toISOString();
  await run(
    `INSERT INTO prompt_overrides (id, system_prompt, temperature, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       system_prompt = excluded.system_prompt,
       temperature   = excluded.temperature,
       updated_at    = excluded.updated_at`,
    [key, payload.systemPrompt, payload.temperature ?? null, now]
  );
}

/**
 * 删除提示词覆盖，恢复默认。
 * @param {string} key
 */
async function clearOverride(key) {
  if (!BY_KEY.has(key)) {
    throw new Error(`未知的角色：${key}`);
  }
  await run('DELETE FROM prompt_overrides WHERE id = ?', [key]);
}

/**
 * 获取角色的默认提示词（未叠加覆盖），用于设置页的"恢复默认"。
 */
function getDefaultPrompt(key) {
  const def = BY_KEY.get(key);
  return def ? def.systemPrompt : null;
}

module.exports = {
  listRoles,
  getRole,
  saveOverride,
  clearOverride,
  getDefaultPrompt,
  DEFINITIONS,
};
