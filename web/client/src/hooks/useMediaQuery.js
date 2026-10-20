import { useEffect, useState } from 'react';

/**
 * 媒体查询 hook。
 *
 * 全站布局都用 inline style 写（没有 CSS 文件），所以断点判断也得走 JS。
 * matchMedia 比监听 resize 便宜：只有跨越断点时才触发重渲染。
 *
 * @param {string} query 例如 '(max-width: 768px)'
 * @returns {boolean}
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;

    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);

    // query 变了要重新订阅
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** 窄屏（手机）。 */
export function useIsMobile() {
  return useMediaQuery('(max-width: 768px)');
}

/** 中等宽度（平板）。 */
export function useIsTablet() {
  return useMediaQuery('(max-width: 1024px)');
}
