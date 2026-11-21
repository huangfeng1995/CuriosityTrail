import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_PREFS,
  PREFS_EVENT,
  readPrefs,
  writePrefs,
} from '../components/Sidebar/inspirationPromptModel';

/**
 * 灵感方向偏好。
 *
 * 与「长期记忆开关」一样存在 localStorage：它属于这台设备上的作者。
 * 设置页保存后广播事件，写作页的灵感面板能立刻读到新值。
 */
export default function useInspirationPromptPrefs() {
  const [prefs, setPrefs] = useState(() => readPrefs());

  useEffect(() => {
    const sync = () => setPrefs(readPrefs());
    window.addEventListener(PREFS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PREFS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const save = useCallback((next) => {
    const normalized = writePrefs(next);
    setPrefs(normalized);
    window.dispatchEvent(new CustomEvent(PREFS_EVENT));
    return normalized;
  }, []);

  const reset = useCallback(() => save({ ...DEFAULT_PREFS }), [save]);

  return { prefs, save, reset };
}
