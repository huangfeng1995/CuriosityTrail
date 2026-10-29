import { useCallback, useEffect, useState } from 'react';

/**
 * 长期记忆的作者偏好。
 *
 * 记忆是"要不要用"这种应该由作者说了算的事：
 * 服务端只管能不能召回，开不开、剔哪条，得让作者自己决定。
 *
 * 偏好存在 localStorage 里——它属于这台设备上的这个作者，
 * 不进数据库。换台电脑，作者会重新做一次选择，这是对的：
 * 记忆的取舍是个人手感，不该跟着账号跨设备漂移。
 */

const KEY = 'ct:memory:enabled';
const EVENT = 'ct:memory-pref-change';

/**
 * 读当前偏好。默认开启——记忆是加分的，没关过就该用。
 * @returns {boolean}
 */
export function getMemoryPref() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return true;
    return raw !== 'false';
  } catch (e) {
    return true;
  }
}

/**
 * 写偏好，并通知其它订阅者。
 * @param {boolean} enabled
 */
export function setMemoryPref(enabled) {
  try {
    localStorage.setItem(KEY, enabled ? 'true' : 'false');
  } catch (e) {
    // 隐私模式下写不了就算了，本次会话内仍然生效
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { enabled } }));
}

/**
 * 订阅偏好变化。
 * @param {(enabled: boolean) => void} fn
 * @returns {() => void} 取消订阅
 */
export function subscribeMemoryPref(fn) {
  const onChange = (e) => {
    fn(e.detail ? e.detail.enabled : getMemoryPref());
  };
  window.addEventListener(EVENT, onChange);
  // 另一个标签页改了偏好，这边也要跟着变
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * React 侧的偏好读写。
 * @returns {[boolean, (enabled: boolean) => void]}
 */
export function useMemoryPref() {
  const [enabled, setEnabled] = useState(getMemoryPref);

  useEffect(() => subscribeMemoryPref(setEnabled), []);

  const toggle = useCallback((next) => {
    setMemoryPref(next);
    setEnabled(next);
  }, []);

  return [enabled, toggle];
}
