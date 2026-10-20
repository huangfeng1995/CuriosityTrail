'use strict';

/**
 * 角色注册表。
 *
 * 加载五个角色的默认定义，并叠加用户在设置页做的覆盖。
 * 覆盖存放在 prompt_overrides 表（按角色 key），删除覆盖即回到默认。
 *
 * 覆盖项有四项：提示词、温度、模型、思考开关。
 * 模型与思考留空表示"跟随全局设置"——大多数角色用默认模型就够了，
 * 只有审稿/推理这类角色才需要单独指定更强的模型。
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
 * @returns {Promise<Map<string, {systemPrompt: string, temperature: number|null, model: string|null, thinking: number|null}>>}
 */
async function loadOverrides() {
  const rows = await all(
    'SELECT id, system_prompt, temperature, model, thinking FROM prompt_overrides'
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        systemPrompt: row.system_prompt,
        temperature: row.temperature,
        model: row.model || null,
        thinking: row.thinking === null || row.thinking === undefined ? null : !!row.thinking,
      },
    ])
  );
}

/**
 * 把覆盖套到默认定义上。
 *
 * 温度的语义：
 *   没有覆盖行      → 用角色自带温度（写手 0.85、审稿 0.4 这种角色性格）
 *   有覆盖行且有值  → 用作者指定的温度
 *   有覆盖行但为 null → 跟随全局供应商温度
 * 所以不能写成 override?.temperature ?? def.temperature，
 * 那样"显式选跟随全局"会被当成"没设置"给回默认温度。
 */
function withOverride(def, override) {
  return {
    key: def.key,
    name: def.name,
    icon: def.icon,
    description: def.description,
    color: def.color,
    temperature: override ? override.temperature ?? null : def.temperature,
    // 空串表示跟随全局
    model: override?.model || '',
    // null 表示跟随全局
    thinking: override?.thinking ?? null,
    suggestions: def.suggestions,
    systemPrompt: override?.systemPrompt ?? def.systemPrompt,
    overridden: Boolean(override),
  };
}

/**
 * 获取生效中的角色列表（含用户覆盖）。
 * @returns {Promise<Array>}
 */
async function listRoles() {
  const overrides = await loadOverrides();
  return DEFINITIONS.map((def) => withOverride(def, overrides.get(def.key)));
}

/**
 * 获取单个角色的生效定义。
 * @param {string} key
 */
async function getRole(key) {
  const def = BY_KEY.get(key);
  if (!def) return null;

  const override = await get(
    'SELECT system_prompt, temperature, model, thinking FROM prompt_overrides WHERE id = ?',
    [key]
  );

  return withOverride(def, override ? {
    systemPrompt: override.system_prompt,
    temperature: override.temperature,
    model: override.model || null,
    thinking: override.thinking === null || override.thinking === undefined ? null : !!override.thinking,
  } : null);
}

/**
 * 保存提示词覆盖。
 * @param {string} key
 * @param {{systemPrompt: string, temperature?: number, model?: string, thinking?: boolean|null}} payload
 */
async function saveOverride(key, payload) {
  if (!BY_KEY.has(key)) {
    throw new Error(`未知的角色：${key}`);
  }
  const now = new Date().toISOString();
  await run(
    `INSERT INTO prompt_overrides (id, system_prompt, temperature, model, thinking, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       system_prompt = excluded.system_prompt,
       temperature   = excluded.temperature,
       model         = excluded.model,
       thinking      = excluded.thinking,
       updated_at    = excluded.updated_at`,
    [
      key,
      payload.systemPrompt,
      payload.temperature ?? null,
      payload.model || null,
      payload.thinking === null || payload.thinking === undefined ? null : (payload.thinking ? 1 : 0),
      now,
    ]
  );
}

/**
 * 删除提示词覆盖，恢复默认。
 * @param {string} key
 */
async function clearOverride(key) {
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
