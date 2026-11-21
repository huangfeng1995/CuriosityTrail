/**
 * 灵感方向的纯函数。
 *
 * 缓存与偏好都放在 localStorage：它们是这台设备上的写作偏好，
 * 与「长期记忆开关」同一套做法，不需要动数据库。
 */

export const PREFS_KEY = 'ct:inspiration-prompt-prefs';
export const PREFS_EVENT = 'ct:inspiration-prefs-changed';
export const CACHE_PREFIX = 'ct:inspiration-prompts:';

export const DEFAULT_PREFS = Object.freeze({
  enabled: true,
  // null 表示全部维度；设置页保存后会变成显式数组
  dimensions: null,
  count: 2,
  auto: true,
});

const VALID_COUNTS = new Set([1, 2, 3]);

function resolveStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

/**
 * 校验并补齐偏好。任何脏数据都退回默认值，不让面板因为一条坏缓存打不开。
 */
export function normalizePrefs(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const dimensions = Array.isArray(source.dimensions)
    ? Array.from(
        new Set(
          source.dimensions.filter((key) => typeof key === 'string' && key.trim())
        )
      ).slice(0, 12)
    : null;
  const count = Number(source.count);

  return {
    enabled: source.enabled !== false,
    dimensions: dimensions && dimensions.length ? dimensions : null,
    count: VALID_COUNTS.has(count) ? count : DEFAULT_PREFS.count,
    auto: source.auto !== false,
  };
}

export function readPrefs(storage) {
  const store = resolveStorage(storage);
  if (!store) return { ...DEFAULT_PREFS };
  try {
    const raw = store.getItem(PREFS_KEY);
    return normalizePrefs(raw ? JSON.parse(raw) : {});
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs, storage) {
  const normalized = normalizePrefs(prefs);
  const store = resolveStorage(storage);
  if (!store) return normalized;
  try {
    store.setItem(PREFS_KEY, JSON.stringify(normalized));
  } catch (e) {
    // 隐私模式或配额满：偏好写不进去不影响本次使用
  }
  return normalized;
}

export function cacheKey(workId, chapterId) {
  return `${CACHE_PREFIX}${workId || 'none'}:${chapterId || 'work'}`;
}

/**
 * 读最近一组候选。只做形状校验，不改内容。
 */
export function readCache(workId, chapterId, storage) {
  const store = resolveStorage(storage);
  if (!store || !workId) return null;
  try {
    const parsed = JSON.parse(store.getItem(cacheKey(workId, chapterId)) || 'null');
    if (!parsed || !Array.isArray(parsed.groups)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

export function writeCache(workId, chapterId, payload, storage) {
  const store = resolveStorage(storage);
  if (!store || !workId) return;
  try {
    store.setItem(
      cacheKey(workId, chapterId),
      JSON.stringify({
        ...payload,
        workId,
        chapterId: chapterId || '',
        savedAt: new Date().toISOString(),
      })
    );
  } catch (e) {
    // 缓存写不进去就只影响下次打开时的首屏，不影响本次生成
  }
}

/**
 * 去重后的「已出现提示」列表，用于让模型避开重复。
 */
export function collectExclude(groups, dismissed = []) {
  const seen = new Set();
  const out = [];
  const push = (text) => {
    const value = String(text || '').trim();
    if (!value) return;
    const key = normalizeForCompare(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };

  for (const group of groups || []) {
    for (const prompt of group?.prompts || []) push(prompt?.text);
  }
  for (const text of dismissed || []) push(text);

  return out.slice(-40);
}

/**
 * 归一化文本，用于去重比较。只保留前 80 个非标点字符。
 */
export function normalizeForCompare(text) {
  return String(text || '')
    .replace(/[\s\u3000。，、；：！？,.!?;:'"“”‘’—…（）()【】\[\]《》<>·]/g, '')
    .slice(0, 80);
}

export function clipTitle(text, max = 24) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function countPrompts(groups) {
  return (groups || []).reduce(
    (sum, group) => sum + (Array.isArray(group?.prompts) ? group.prompts.length : 0),
    0
  );
}
