import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const STORAGE_KEY = 'ct.focus';

/**
 * 进入 / 退出专注模式的请求事件。
 *
 * 为什么走 window 事件而不是 context：
 * 「有多少条 AI 建议还没确认」这个判断需要 messages，
 * 而 messages 在 workspace context 里——那是包在 FocusProvider 内部的。
 * FocusProvider 读不到它，Workspace 又拿不到 FocusProvider 的方法。
 *
 * 所以拆成两半：FocusProvider 只管开关（广播请求），
 * Workspace 监听到请求后弹提示、再改开关。
 * 两条路径（快捷键、图标按钮）都广播同一批事件，
 * 否则会出现「图标退出不提示、快捷键退出提示」的不一致。
 */
export const ENTER_FOCUS_EVENT = 'ct:request-enter-focus';
export const EXIT_FOCUS_EVENT = 'ct:request-exit-focus';

const FocusContext = createContext(null);

/**
 * 专注模式状态。
 *
 * 专注模式是「只剩稿纸」的沉浸状态：侧栏收起、顶栏最小化、正文加宽。
 * 它是设备级的视图状态，跟着这台设备走，不进 URL、不进历史记录。
 */
export function FocusProvider({ children }) {
  const [focusMode, setFocusMode] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      // 隐私模式下读不到，用默认值
      return false;
    }
  });

  // 持久化。专注模式刷新后还在——作者写到一半刷新页面，
  // 不该被弹回三栏界面重新摆一次。
  useEffect(() => {
    try {
      if (focusMode) localStorage.setItem(STORAGE_KEY, '1');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 存不下就算了，本次会话内仍然生效
    }
  }, [focusMode]);

  // 收到进入/退出请求后改状态。
  //
  // 事件而不是直接调 setState：请求的发起方（Workspace）要在改状态之前
  // 先算好「有几条 AI 建议没确认」并弹提示，顺序不能反。
  useEffect(() => {
    const onEnter = () => setFocusMode(true);
    const onExit = () => setFocusMode(false);

    window.addEventListener(ENTER_FOCUS_EVENT, onEnter);
    window.addEventListener(EXIT_FOCUS_EVENT, onExit);
    return () => {
      window.removeEventListener(ENTER_FOCUS_EVENT, onEnter);
      window.removeEventListener(EXIT_FOCUS_EVENT, onExit);
    };
  }, []);

  // 快捷键。
  //
  // Esc 任何时候都能退出专注模式——包括焦点在输入框里。
  // 这个编辑器没有给 textarea 绑 Esc（只有 Cmd+Z / Cmd+Shift+Z / Cmd+Y），
  // 所以不存在「Esc 该留给输入框」的问题；反过来说，
  // 「焦点在输入框时 Esc 不退出」只会让作者以为按键坏了。
  useEffect(() => {
    const onKeyDown = (e) => {
      // Cmd+. / Ctrl+. 进出切换。
      //
      // 注意 macOS 上 Cmd+. 是「显示/隐藏 Dock」的默认快捷键，
      // 浏览器有时收不到。Esc 始终可用，出口不会断。
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent(focusMode ? EXIT_FOCUS_EVENT : ENTER_FOCUS_EVENT)
        );
        return;
      }

      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 不在专注模式时什么都不做，也不能 preventDefault——
        // antd 的 Modal、HistoryPanel 的抽屉都靠 Esc 关闭。
        if (!focusMode) return;
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EXIT_FOCUS_EVENT));
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [focusMode]);

  const enterFocus = useCallback(() => {
    window.dispatchEvent(new CustomEvent(ENTER_FOCUS_EVENT));
  }, []);

  const exitFocus = useCallback(() => {
    window.dispatchEvent(new CustomEvent(EXIT_FOCUS_EVENT));
  }, []);

  const value = useMemo(
    () => ({
      focusMode,
      setFocusMode,
      enterFocus,
      exitFocus,
    }),
    [focusMode, enterFocus, exitFocus]
  );

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

/**
 * 读专注模式状态。
 *
 * @returns {{focusMode: boolean, setFocusMode: (v: boolean) => void,
 *            enterFocus: () => void, exitFocus: () => void}}
 */
export function useFocus() {
  const ctx = useContext(FocusContext);
  if (!ctx) {
    throw new Error('useFocus 必须在 FocusProvider 内使用');
  }
  return ctx;
}

export default FocusProvider;
