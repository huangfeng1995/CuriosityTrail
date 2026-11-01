import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

const STORAGE_KEY = 'ct.focus';
const WORK_KEY = 'ct.focusWork';

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

  // 进入专注时所在的作品。
  //
  // 为什么要单独记：专注模式是设备级的状态，跟着这台设备走，
  // 但「是不是换了一个作品」这个判断必须活过组件卸载——
  // Workspace 在离开工作区时整个卸载，再用组件内的 ref 记上次作品 id
  // 没用：下次进来是全新挂载，ref 的初值就是新作品 id，永远「没变过」。
  // FocusProvider 在路由之上，不卸载，所以它记着。
  const [focusWorkId, setFocusWorkId] = useState(() => {
    try {
      return localStorage.getItem(WORK_KEY) || null;
    } catch {
      return null;
    }
  });

  // 当前打开的作品，由 Workspace 登记。
  const [currentWorkId, setCurrentWorkId] = useState(null);

  // 持久化。专注模式刷新后还在——作者写到一半刷新页面，
  // 不该被弹回三栏界面重新摆一次。
  //
  // 作品 id 跟开关一起存：刷新后还得知道「我是在哪个作品里专注的」，
  // 否则换个作品打开时无从判断该不该退出。
  useEffect(() => {
    try {
      if (focusMode) {
        localStorage.setItem(STORAGE_KEY, '1');
        if (focusWorkId) localStorage.setItem(WORK_KEY, focusWorkId);
        else localStorage.removeItem(WORK_KEY);
      } else {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(WORK_KEY);
      }
    } catch {
      // 存不下就算了，本次会话内仍然生效
    }
  }, [focusMode, focusWorkId]);

  // 收到进入/退出请求后改状态。
  //
  // 事件而不是直接调 setState：请求的发起方（Workspace）要在改状态之前
  // 先算好「有几条 AI 建议没确认」并弹提示，顺序不能反。
  useEffect(() => {
    const onEnter = () => {
      // 不在工作区就不进专注模式：那儿没有侧栏可藏，进去也没有界面变化，
      // 只会留下一个「作者不知道自己开着」的状态。
      if (!currentWorkId) return;
      setFocusMode(true);
      setFocusWorkId(currentWorkId);
    };
    const onExit = () => {
      setFocusMode(false);
      setFocusWorkId(null);
    };

    window.addEventListener(ENTER_FOCUS_EVENT, onEnter);
    window.addEventListener(EXIT_FOCUS_EVENT, onExit);
    return () => {
      window.removeEventListener(ENTER_FOCUS_EVENT, onEnter);
      window.removeEventListener(EXIT_FOCUS_EVENT, onExit);
    };
  }, [currentWorkId]);

  // 换作品就退出专注模式：新作品是新的写作场景，
  // 带着上一个作品的沉浸界面过去会很别扭。
  //
  // 走 setFocusMode 而不是退出事件——退出事件会弹
  // 「AI 有 N 条建议还没处理」，那说的是上一个作品的事。
  useEffect(() => {
    if (!focusMode || !currentWorkId) return;
    if (!focusWorkId) {
      // 没有记录（老数据、或在作品外按了快捷键）：认下当前作品
      setFocusWorkId(currentWorkId);
      return;
    }
    if (focusWorkId !== currentWorkId) {
      setFocusMode(false);
      setFocusWorkId(null);
    }
  }, [focusMode, currentWorkId, focusWorkId]);

  // 快捷键。
  //
  // Esc 任何时候都能退出专注模式——包括焦点在输入框里。
  // 这个编辑器没有给 textarea 绑 Esc（只有 Cmd+Z / Cmd+Shift+Z / Cmd+Y），
  // 所以不存在「Esc 该留给输入框」的问题；反过来说，
  // 「焦点在输入框时 Esc 不退出」只会让作者以为按键坏了。
  //
  // 用捕获阶段监听（第三个参数 true）：
  // antd 的抽屉在处理 Esc 时会调 stopPropagation——它的 handler 挂在
  // React 根节点上，一 stop，document 上的冒泡监听就再也收不到 Esc 了。
  // 典型场景：作者打开 AI 历史抽屉、选完一条对话，抽屉关了但焦点还留在
  // 抽屉的残留节点上（antd 默认不销毁 DOM），这时按 Esc 毫无反应。
  // 捕获阶段在事件向下传播时就拿到，绕不过去。
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

        // 浮层开着时，Esc 归浮层：先关掉弹窗/抽屉，而不是退出专注模式。
        // 作者的注意力在浮层上，关浮层才是他这一下想要的。
        //
        // 判断「有没有浮层开着」而不是「事件是不是从浮层里来的」：
        // 浮层打开后焦点未必落在它里面（点按钮打开 Modal 时，
        // 焦点可能还留在按钮上），按事件来源判断会漏掉。
        //
        // 用 clientRects 判可见：antd 的 Modal 关掉后 DOM 还在，
        // 只是被藏起来——那是残留，不是浮层。
        const hasOverlay = Array.prototype.some.call(
          document.querySelectorAll('.ant-modal-wrap, .ant-drawer-open'),
          (el) => el.getClientRects().length > 0
        );
        if (hasOverlay) return;

        e.preventDefault();
        window.dispatchEvent(new CustomEvent(EXIT_FOCUS_EVENT));
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
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
      /** 登记当前打开的作品，用于判断「是不是换作品了」。 */
      setCurrentWorkId,
    }),
    [focusMode, enterFocus, exitFocus, setCurrentWorkId]
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
