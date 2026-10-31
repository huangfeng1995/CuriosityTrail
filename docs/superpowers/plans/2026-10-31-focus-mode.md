# 专注模式实现计划

设计文档：[2026-10-31-focus-mode-design.md](../specs/2026-10-31-focus-mode-design.md)

日期：2026-10-31

---

## 任务分解

按依赖顺序拆。每一项独立可验证，做完一项跑一次构建。

### 任务 1：待确认判定（纯函数，最独立）

**新建** `web/client/src/components/Assistant/pendingActions.js`

导出 `pendingActions(messages)`，判定条件见 spec 5.3。

```js
const TEXT_ACTIONS = ['replace', 'append', 'insert'];

export function pendingActions(messages = []) {
  return messages.filter(
    (m) => m.role === 'assistant'
      && TEXT_ACTIONS.includes(m.action)
      && !m.applied
  );
}
```

**为什么先做**：它是纯函数，无依赖，且被 Workspace 和 Sidebar 两边用。先落地可以把判定逻辑固定下来，后面两处直接引用，不会各写一套。

**验证**：可以临时写个断言跑一下，或留到任务 6 的浏览器实测时一起验。

---

### 任务 2：FocusProvider

**新建** `web/client/src/store/focus.jsx`

内容：
- `focusMode` state，初值读 `localStorage['ct.focus'] === '1'`
- `useEffect` 在 `focusMode` 变化时写 localStorage
- `setFocusMode` / `enterFocus` / `exitFocus` / `toggleFocus`
- 监听 `document` keydown：`Esc` 和 `Cmd+.`（spec 5.1）
- 监听 `ct:request-enter-focus` / `ct:request-exit-focus` 自定义事件改 state（spec 5.2.1）

**Esc 的判定**：`e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey`

**Esc 不在 focusMode 时什么都不做**——不 `preventDefault`，免得影响 antd Modal 和 HistoryPanel 抽屉的关闭。

**`Cmd+.` 的判定**：`(e.metaKey || e.ctrlKey) && e.key === '.'`，要 `preventDefault()`（否则在某些输入框里会触发快捷键）。

**快捷键只在专注模式相关时拦截**：`Cmd+.` 在任何时候都 toggle（进入/退出），但如果焦点在输入框里，`Cmd+.` 通常不会跟输入冲突，可以照常拦截。

**注意**：spec 5.2.2 说「FocusProvider 内部监听自己的事件来改 state」。实现时注意 `enterFocus` / `exitFocus` 只是 `dispatchEvent`，真正改 state 的是内部的事件监听器。

**验证**：`npm run build` 通过。

---

### 任务 3：接入 App 层

**改** `web/client/src/App.jsx`

- `import { FocusProvider, useFocus } from './store/focus'`
- `AppShell` 里用 `useFocus()` 拿 `focusMode`
- 顶栏加 class：`className={`ct-topbar${isWorkspace && focusMode ? ' is-focus' : ''}`}`
- `App` 里在 `AuthProvider` 之内包 `FocusProvider`：

```jsx
<AuthProvider>
  <FocusProvider>
    <AppShell isDark={isDark} setIsDark={setIsDark} />
  </FocusProvider>
</AuthProvider>
```

**为什么 FocusProvider 在 AuthProvider 之内**：FocusProvider 不需要登录态，但它是视图状态，跟应用外壳同生共死。放在 AuthProvider 之内更贴近「AppShell 的状态」的语义。

**验证**：`npm run build` 通过。

---

### 任务 4：顶栏最小化样式 + 退出按钮

**改** `web/client/src/App.jsx` + `web/client/src/styles/theme.css`

顶栏在专注模式下要藏导航项、主题切换、退出登录，保留 logo，加一个「退出专注」按钮。

AppShell 里：

```jsx
<div className="ct-topbar-right">
  {isWorkspace && focusMode ? (
    <Button
      type="text"
      className="ct-icon-btn"
      icon={<Minimize2 size={16} />}
      onClick={exitFocus}
      title="退出专注模式（Esc）"
    />
  ) : (
    <>
      <Button ... 主题切换 />
      <Button ... 退出登录 />
    </>
  )}
</div>
```

CSS：

```css
.ct-topbar.is-focus .ct-nav {
  display: none;
}
```

（导航项在 `isWorkspace` 时本来就不渲染，这条 CSS 是双保险。）

logo 在专注模式下点击仍然跳作品列表——不变。

**验证**：`npm run build` 通过。

---

### 任务 5：三栏改为常驻渲染 + CSS 隐藏

**改** `web/client/src/pages/Workspace.jsx` + `web/client/src/styles/theme.css` + `web/client/src/components/Resizer.jsx`

这是最需要小心的一步（spec 4.4）。

**先改 Resizer**：它不透传额外 prop，要加一个 `hidden`。

```jsx
export default function Resizer({ side, value, min, max, onChange, onReset, onCollapse, hidden }) {
  ...
  return (
    <div
      className={`ct-resizer is-${side}${dragging ? ' is-dragging' : ''}`}
      data-hidden={hidden ? 'true' : undefined}
      ...
    >
```

现在：

```jsx
{!collapsed.left ? (
  <>
    <aside className="ct-col-left" style={{ width: widths.left }}>{leftPanel}</aside>
    <Resizer side="left" ... />
  </>
) : (
  <button className="ct-col-toggle is-left" ...>›</button>
)}
```

改成常驻渲染 + `data-hidden`：

```jsx
const hideLeft = focusMode || collapsed.left;
const hideRight = focusMode || collapsed.right;
```

```jsx
<div className={`ct-workspace${focusMode ? ' is-focus' : ''}`}>
  <aside
    className="ct-col-left"
    style={{ width: widths.left }}
    data-hidden={hideLeft}
  >
    {leftPanel}
  </aside>

  <Resizer
    side="left"
    value={widths.left}
    min={LIMITS.left.min}
    max={LIMITS.left.max}
    onChange={setLeft}
    onReset={() => reset('left')}
    onCollapse={toggleLeft}
    data-hidden={hideLeft}
  />

  <main className="ct-col-center">
    <ChapterEditor />
  </main>

  <Resizer side="right" ... data-hidden={hideRight} />

  <aside
    className={`ct-col-right${widths.right < 344 ? ' is-narrow' : ''}`}
    style={{ width: widths.right }}
    data-hidden={hideRight}
  >
    <AssistantSidebar />
  </aside>

  {/* 展开条：只在对应栏折叠且不在专注模式时显示 */}
  <button
    type="button"
    className="ct-col-toggle is-left"
    data-hidden={!collapsed.left || focusMode}
    onClick={toggleLeft}
    title="展开左栏（目录与资料）"
    aria-label="展开左栏"
  >
    ›
  </button>
  <button
    type="button"
    className="ct-col-toggle is-right"
    data-hidden={!collapsed.right || focusMode}
    onClick={toggleRight}
    title="展开右栏（AI 助手）"
    aria-label="展开右栏"
  >
    ‹
  </button>
</div>
```

**`Resizer` 需要透传 `data-hidden`**——它是自定义组件，要加一个 prop 转发到根元素。

CSS：

```css
.ct-workspace [data-hidden='true'] {
  display: none;
}
```

**为什么改成常驻渲染**：折叠时卸载 `AssistantSidebar` 会断掉 SSE 连接。专注模式绝不能断——作者正要让 AI 写一章。

**注意**：`.ct-col-toggle` 的定位（绝对定位贴在边缘）要检查——两个展开条都常驻在 DOM 里了，靠 `data-hidden` 控制显示，定位不受影响，但要确认 `display: none` 时不会留下占位。

**验证**：
- `npm run build` 通过
- 折叠左栏/右栏，行为跟现在一致（窄条按钮出现、能展开）
- 浏览器实测：AI 生成中途进专注模式，生成不中断

---

### 任务 6：正文宽度变量

**改** `web/client/src/styles/theme.css`

```css
.ct-workspace {
  --ct-editor-width: 1000px;
}
.ct-workspace.is-focus {
  --ct-editor-width: 1160px;
}
.ct-editor-body {
  max-width: var(--ct-editor-width);
  ...
}
```

移动端那段 `@media` 里的 `.ct-editor-body { padding-left: 0; }` 不用动——`max-width` 在移动端也不适用（移动端是抽屉布局，没有 `.ct-workspace`）。

等等——移动端走的是 `.ct-workspace-mobile`，不含 `.ct-workspace` class，所以 `--ct-editor-width` 没有定义，`var()` 会回退到无效值 → `max-width` 变成 `none`（无效声明被忽略）。

**要处理**：在 `:root` 里定义默认值 `--ct-editor-width: 1000px;`，`.ct-workspace.is-focus` 再覆盖。这样移动端也拿得到 1000px（虽然移动端有别的规则覆盖 padding，但 max-width 生效也无害）。

**验证**：`npm run build` 通过。

---

### 任务 7：标题栏专注按钮

**改** `web/client/src/components/Editor/ChapterEditor.jsx`

在 `ct-editor-tools` 里加一个图标按钮：

```jsx
import { useFocus } from '../../store/focus';

const { focusMode, enterFocus, exitFocus } = useFocus();
```

```jsx
<Tooltip title={focusMode ? '退出专注模式（Esc）' : '专注模式（⌘.）'}>
  <Button
    size="small"
    type="text"
    icon={focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
    onClick={focusMode ? exitFocus : enterFocus}
  />
</Tooltip>
```

**放在哪**：工具区里 `ct-tool-sep` 之后、保存按钮之前？还是最右边？

倾向**最右边**（导出按钮之后）——它是「视图」类操作，跟「编辑」类操作（撤销/重做/保存/导出）分开。放在最右边也离正文近。

**移动端不渲染**：`isMobile` 时不显示（spec 6.4）。

**注意**：`ChapterEditor` 在 `!chapter` 时提前 return 渲染空状态——此时按钮也不渲染。但快捷键仍可用（FocusProvider 里），所以空章节视图也能进专注模式。

**验证**：`npm run build` 通过。

---

### 任务 8：Workspace 里的提示与切作品退出

**改** `web/client/src/pages/Workspace.jsx`

三件事：

**8.1 监听进入/退出请求事件，弹 toast**

```jsx
import { App as AntApp } from 'antd';
const { message: toast } = AntApp.useApp();
```

「去看看」按钮用 `message.info` 的 **content 传 React 节点**，而不是 `btn` 属性——项目里现有的 toast 用法全是字符串形式，`btn` 没被验证过，用节点更稳：

```jsx
const onExit = () => {
  const pending = pendingActions(messages);
  if (pending.length > 0) {
    toast.info({
      content: (
        <span>
          AI 有 {pending.length} 条建议还没处理
          <Button size="small" type="link" onClick={goToPending}>去看看</Button>
        </span>
      ),
      duration: 3,
    });
  } else if (sending) {
    toast.info('AI 还在写，完成后会留在右侧等你确认', 3);
  }
  setFocusMode(false);
};
```

**注意**：这个 effect 的依赖里有 `messages`——每次消息变化都会重新注册监听。这是可接受的（清理函数会先执行），但要注意别在回调里用旧的闭包值。

**8.2 「去看看」**

```jsx
const goToPending = useCallback(() => {
  if (collapsed.right) toggleRight();
  window.dispatchEvent(new CustomEvent('ct:scroll-to-pending'));
}, [collapsed.right, toggleRight]);
```

**问题**：`collapsed` 变化时 `goToPending` 重建 → 上面那个 effect 的依赖变化 → 重新注册监听。可接受。

**8.3 切作品退出专注**

```jsx
useEffect(() => {
  if (workId) setFocusMode(false);
}, [workId, setFocusMode]);
```

**注意**：这个 effect 会在首次挂载时也跑（workId 有值），把 localStorage 里读出来的专注状态清掉——这是对的（换了作品就该退出），但要注意 localStorage 也会被写回 `'0'`/删除。

**实现细节**：`setFocusMode(false)` 要触发 localStorage 写入。写入逻辑是「`focusMode` 为 false 时删除 key，为 true 时写 '1'」。

**8.4 读 messages**

`useWorkspace()` 要多解构 `messages` 和 `sending`。

**验证**：`npm run build` 通过。

---

### 任务 9：Sidebar 滚动到待确认卡片

**改** `web/client/src/components/Assistant/Sidebar.jsx` + `MessageList.jsx`

**9.1 MessageList 加 `data-msg-id`**

```jsx
<div key={msg.id} className={`ct-msg is-${msg.role}`} data-msg-id={msg.id}>
```

**9.2 Sidebar 监听滚动事件**

```jsx
import { pendingActions } from './pendingActions';

const scrollToPending = useCallback(() => {
  const pending = pendingActions(messages).pop();
  if (!pending) return;
  const el = listRef.current?.querySelector(`[data-msg-id="${pending.id}"]`);
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}, [messages]);

useEffect(() => {
  const onScroll = () => scrollToPending();
  window.addEventListener('ct:scroll-to-pending', onScroll);
  return () => window.removeEventListener('ct:scroll-to-pending', onScroll);
}, [scrollToPending]);
```

**验证**：`npm run build` 通过。

---

### 任务 10：整体验证

**构建**：

```bash
cd web/client && npm run build
```

**浏览器实测**（对照 spec 第七节的验收清单）：

| 项 | 怎么验 |
|---|---|
| 进出专注 | 点标题栏图标；三栏消失、顶栏只剩 logo |
| Esc 退出 | 焦点在 textarea 里按 Esc 也退 |
| Cmd+. | 进出都试 |
| 进入/退出 toast | 看提示文案 |
| 待确认提示 | 先让 AI 写一段（产生 action），进专注，再退出，看有没有「去看看」 |
| 「去看看」 | 点后右栏展开并滚到那张卡 |
| comment 不计入 | 让 AI 只给建议，看退出时提示的数量对不对 |
| 生成不中断 | AI 生成中途进专注，token 继续来 |
| 折叠偏好不被污染 | 先手动收起左栏 → 进专注 → 退出 → 左栏还是收着的 |
| 切作品退出 | 专注模式里切到另一个作品 |
| 刷新保持 | 专注模式里刷新页面，还是专注 |
| 宽度 | 普通 1000px / 专注 1160px |
| 格线不错位 | 正文中间点一下聚焦，切进切出，看格子 |
| 移动端 | 缩窄窗口，专注按钮不出现 |
| 块编辑器快捷键 | Cmd+Z 撤销、Cmd+Shift+Z 重做仍正常 |

---

## 风险点

| 风险 | 应对 |
|---|---|
| 三栏改常驻渲染后，折叠状态的面板仍在发请求 | 实现后看网络面板，若请求明显变多再考虑给折叠态加「懒挂载」 |
| `Workspace` 的事件监听 effect 依赖 `messages`，频繁重注册 | 清理函数会先执行，不会泄漏。但要注意回调里不用过期闭包 |
| `Cmd+.` 被 macOS 抢走 | Esc 始终可用，出口不断（spec 6.3） |
| 宽度切换时 textarea 高度重算的行为未实测 | spec 4.3 的验收方法：聚焦状态下切进切出看格子 |
| antd toast 的 `btn` 属性在 message.info 里是否可用 | 实现时确认；不可用就改用自定义内容 |

---

## 提交划分

| commit | 内容 |
|---|---|
| `feat(focus): 待确认判定纯函数` | 任务 1 |
| `feat(focus): FocusProvider 与快捷键` | 任务 2、3 |
| `feat(focus): 顶栏最小化与退出按钮` | 任务 4、7 |
| `feat(focus): 三栏常驻渲染与专注隐藏` | 任务 5 |
| `feat(focus): 正文宽度变量（A5）` | 任务 6 |
| `feat(focus): 退出提示与去看看` | 任务 8、9 |
| `docs(spec): 补正三栏渲染方式` | spec 的 4.4 修正 |

---

## 相关文件

| 用途 | 路径 |
|---|---|
| 设计文档 | `docs/superpowers/specs/2026-10-31-focus-mode-design.md` |
| 新建：专注状态 | `web/client/src/store/focus.jsx` |
| 新建：待确认判定 | `web/client/src/components/Assistant/pendingActions.js` |
| 应用外壳与顶栏 | `web/client/src/App.jsx` |
| 三栏布局 | `web/client/src/pages/Workspace.jsx` |
| 章节标题栏 | `web/client/src/components/Editor/ChapterEditor.jsx` |
| AI 侧边栏 | `web/client/src/components/Assistant/Sidebar.jsx` |
| 消息流 | `web/client/src/components/Assistant/MessageList.jsx` |
| 样式 | `web/client/src/styles/theme.css` |
| 折叠状态 | `web/client/src/hooks/useColumnWidths.js` |
