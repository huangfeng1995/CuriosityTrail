# 专注模式设计

日期：2026-10-31
状态：待实现
对应需求池条目：A2（专注模式）、A5（编辑区水平方向太窄）

---

## 一、要解决的问题

作者写长章节时，界面上的三个东西在抢注意力：左侧目录与资料面板、右侧 AI 对话栏、顶部导航栏。这三样都不影响写作本身，但它们占着视野。

A6 已经实现了「侧栏可收起」，技术上「单栏纯正文」是可达的。但它缺三样东西：

1. **一键进入**——手动点两次折叠按钮不是「进入专注模式」
2. **顶栏没有为专注模式做处理**——工作区顶栏（logo、主题切换、退出登录）原样占着 52px，写作时全是干扰
3. **正文宽度上限写死 960px**（A5）——收起侧栏后中栏变宽，但正文卡在 960px，剩下的空间白白浪费

本设计做的是：**一个按钮进入沉浸写作状态，Esc 随时退出，AI 的结果不会丢**。

### 非目标

- 不做「打字机效果」（光标固定在屏幕中央、滚动跟随）——那是另一个功能，会跟块编辑器的自动高度打架
- 不做「专注计时器」「白噪音」等环境音类功能
- 不改移动端布局——移动端本来就是单栏 + 抽屉，专注模式对它没有意义
- 不重构 streaming 状态（见第六节「已知代价」）

---

## 二、交互规格

### 2.1 进入

| 触发 | 说明 |
|---|---|
| 章节标题栏右侧「专注」图标 | 主入口。放在撤销/重做/保存/导出这一排按钮里 |
| `Cmd+.` | 快捷键（Windows/Linux 为 `Ctrl+.`） |

进入瞬间：

- 左栏、右栏隐藏，顶栏最小化（只留 logo 与「退出专注」，见 2.3）
- 正文宽度切到专注档（1160px）
- 弹出 toast：「已进入专注模式，Esc 退出」，1.5 秒，无按钮

为什么入口放章节标题栏而不是顶栏：从作品列表点进工作区时，顶栏的导航项是隐藏的（`AppShell` 里 `isWorkspace` 判断），只有 logo 和两个图标。专注模式的入口跟着工作区走更稳定，而且它跟「撤销/重做/保存」同属一组「编辑这一章」的动作，语义上更贴。

### 2.2 退出

| 触发 | 说明 |
|---|---|
| `Esc` | **任何时候都退出**，焦点在输入框里也一样 |
| `Cmd+.` | 同上 |
| 标题栏「退出专注」图标 | 鼠标操作 |

`Esc` 无条件退出的理由：这个编辑器里的 textarea 并没有绑定 `Esc`（块编辑器的键盘处理只有 `Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y`，见 `ChapterEditor.jsx`），选区清除也没绑。所以「焦点在输入框时不退出」是为一个不存在的冲突设置的规则，只会让作者觉得 Esc 失灵。

退出瞬间：

1. 三栏与顶栏恢复
2. 正文宽度切回普通档（1000px）
3. 若有未确认的 AI 结果，弹一条 3 秒的 toast（见 2.4）

### 2.3 顶栏：最小化保留，不是全藏

专注模式下顶栏**不整条隐藏**，而是最小化：

- 保留：品牌 logo（点击回作品列表）、右侧「退出专注」按钮
- 隐藏：导航项、主题切换、退出登录

理由：全藏顶栏等于切断导航。作者写完一段想去看看写作统计，得先退出专注再点导航，多一步且打断状态。而最小顶栏只占 52px，logo 本身就是回作品列表的入口——作者从作品列表点进工作区，切到专注模式，logo 点一下就回去了，路径是通的。

主题切换和退出登录在专注模式下没有意义（写作时不该顺手换肤或登出），藏掉。

**只对工作区路由生效**：`AppShell` 里的 `isWorkspace` 判断为真时才最小化。跳到统计页、素材库时顶栏是完整的——那些页面需要导航，削掉它们反而出不去。

### 2.3.1 退出登录按钮的处置

专注模式隐藏「退出登录」按钮。作者此时若要退出登录，路径是：退出专注模式 → 点顶栏的退出图标。

这符合「专注模式是一次沉浸会话」的定位——退出沉浸才回到常规操作界面。

### 2.4 退出时的 AI 提示

**核心前提：AI 的产出本来就不自动落正文。**

模型给出结构化 action 后，只渲染成 `ActionCard`，要作者点「应用到正文」才写进稿子（`Sidebar.jsx` 的 `applyAction`，注释明确写着「AI 不该擅自改稿」）。所以专注模式藏起右栏，**不会让作者的稿子被偷偷改掉**，也不会让生成结果消失——它一直在右栏的 store 里等着。

因此提示的职责只是**指个方向**，不是拦截。

**「待确认」的判定条件**：

```
msg.role === 'assistant'
&& ['replace', 'append', 'insert'].includes(msg.action)
&& !msg.applied
```

注意不能只用 `msg.action !== 'none'`——`comment`（建议）和 `none`（回复）类型的 ActionCard 没有「应用到正文」按钮（`ActionCard.jsx` 的 `isTextAction` 判断），它们只是讨论，不该算进「待处理」。

**提示形式**：toast，不是 Modal。

- 有 N 条待确认 → toast「AI 有 N 条建议还没处理」+「去看看」按钮，3 秒
- 点「去看看」→ 展开右栏（若已折叠）并滚动到最下面那张待确认的 ActionCard
- 作者不想现在处理 → toast 自己消失，结果留在右栏，下次进来还在（消息在 store 里，不会丢）

为什么用 toast 而不是 Modal：作者按 Esc 是因为「我想专注写」这个念头结束了，此刻弹一个需要点掉的模态框，是在打断他刚回到的状态。toast 只指方向，不强制立刻做决定。真正需要强制确认的场景（比如「删除作品」）才该用 Modal。

**AI 还在生成时退出**（`sending === true`）：不拦。SSE 是长连接，拦了反而把生成卡住。此时 toast 换成「AI 还在写，完成后会留在右侧等你确认」。

### 2.5 状态与切换规则

| 事件 | 专注模式 |
|---|---|
| 切换章节（同作品） | **保持** |
| 切换作品（`workId` 变） | **退出**（新作品是新的写作场景） |
| 跳到别的页面（统计、素材库…） | **保持**，因为最小顶栏的 logo 还能导航回来 |

「跳到别的页面保持」的前提是 2.3 的最小顶栏——若顶栏全藏，这条就不成立。

---

## 三、状态设计

### 3.1 放在哪

新增 `web/client/src/store/focus.jsx`，`FocusProvider` 包在 `AppShell` 之上（`App.jsx` 里 `AuthProvider` 之内）。

**为什么不能放 `workspace.jsx`**：`WorkspaceProvider` 只包了 `/works/:workId` 这一条路由（`App.jsx` 的路由表），而 `AppShell` 在它外面——顶栏要跟着隐藏，状态必须在 App 层可读。

**为什么不用 URL 参数（`?focus=1`）**：URL 与 localStorage 会变成两套真相（刷新后 query 还在、localStorage 也在，得写同步逻辑），而且专注模式是设备级的视图状态，不该被塞进书签和历史记录。

**为什么不用 `document.documentElement.dataset.focus`**：状态不可查。判断「现在是不是专注模式」「要不要记 localStorage」都得先读 DOM，逻辑会很别扭。

### 3.2 状态内容

FocusProvider 里的 state 只有一个：

```js
const [focusMode, setFocusMode] = useState(() => {
  try {
    return localStorage.getItem('ct.focus') === '1';
  } catch {
    return false;
  }
});
```

对外暴露（详见 5.2.2）：

```js
{
  focusMode,     // boolean
  setFocusMode,  // (bool) => void —— 直接改，用于切作品时静默退出
  enterFocus,    // () => void —— 广播进入请求（走提示逻辑）
  exitFocus,     // () => void —— 广播退出请求（走提示逻辑）
  toggleFocus,   // () => void —— Esc / Cmd+. 用
}
```

**没有「折叠快照」字段**——见 3.3：专注模式不修改 `collapsed` 本身，快照语义天然成立，不需要额外的状态。

`focusMode` 持久化到 `localStorage['ct.focus']`（值为 `'1'` / 不存在），设备级，跟着设备走。

### 3.3 与现有折叠状态的关系

现在 `useColumnWidths` 管着 `collapsed.left/right`，持久化在 `localStorage['ct.workspace.collapsed']`。这是**作者平时的折叠偏好**。

专注模式是**临时覆盖层**。

**实现上完全不碰 `collapsed`**——`Workspace` 渲染时用 `focusMode ||` 短路：

```jsx
const hideLeft = focusMode || collapsed.left;
const hideRight = focusMode || collapsed.right;
```

`collapsed` 本身一个字节都没动，所以：

- 退出专注模式后，作者的折叠偏好**原样回来**（之前收起的左栏还是收起，之前展开的还是展开）
- `localStorage['ct.workspace.collapsed']` 从头到尾没被专注模式写过——**不污染长期偏好**
- 不需要「快照」字段，不需要 restore 逻辑，不需要额外的 state

这比「记快照再恢复」少一套状态，也少一个能出错的时机。

---

## 四、布局与样式

### 4.1 宽度：保守档

正文容器 `.ct-editor-body` 的 `max-width` 提成 CSS 变量：

| 状态 | max-width | 实际文字宽 | 汉字/行 |
|---|---|---|---|
| 原来 | 960px（写死） | 916px | ≈55 |
| 普通三栏 | 1000px | 956px | ≈51 |
| 专注模式 | 1160px | 1116px | ≈59 |

算的依据：正文 16.5px 字号，`max-width` 里还要扣掉左侧 44px 的块按钮沟。

**为什么不更宽**：中文正文舒服的行长是 40–50 字/行。超过 60 字，眼睛回行容易跳行——那比「左右空着」更伤。960px 已经是 55 字/行，本来就偏长，所以这个功能只做保守档。

**为什么 1160 而不是 1440**：1160px 是 59 字/行，仍在可读范围；1440px 是 73 字/行，明显过头。

### 4.2 CSS 变量

```css
.ct-workspace {
  --ct-editor-width: 1000px;
}
.ct-workspace.is-focus {
  --ct-editor-width: 1160px;
}
.ct-editor-body {
  max-width: var(--ct-editor-width);
}
```

顶栏同理：`is-focus` 时 `.ct-topbar` 只保留 logo 与退出按钮，其余 `display: none`。

### 4.3 格线对齐的回归点（A5 的验收项）

稿纸格线是 `repeating-linear-gradient` + `--ruled-size: 34px`，**改宽度不影响垂直方向的对齐**。

真正要验的是**切换宽度后 textarea 的高度重算**：`Block.jsx` 的 `useAutoHeight` 用 `ResizeObserver` 观察自身宽度，宽度一变就重量一次（`onWidthChange`）。专注模式切换会改变 `.ct-editor-body` 的宽度 → 触发 observer → 重新计算高度。

但 `useAutoHeight` 里有一条「只增不减」的分支：聚焦时只加不減，避免「一打字就跳到最下面一行」。这条在宽度突变时的表现需要实测：切换专注模式的那一瞬间，如果光标正在某个块里，块高可能不立即收缩。

**验收方法**：在正文中间点一下（聚焦），切进切出专注模式，看格子是否错位、光标是否跳底。

### 4.4 隐藏方式：CSS 隐藏，不是条件渲染

左右栏用 CSS 隐藏（`display: none`），不卸载组件。

理由：`AssistantSidebar` 挂着 SSE 长连接（`/api/ai/chat`），卸载组件会断掉连接，正在生成的 token 就丢了。作者在专注模式下正要让 AI 写一章，不能因为他自己进了专注模式就把稿子弄丢。

同理，正文区不做条件渲染，只是外层加了 `is-focus` class。

---

## 五、组件改动清单

| 文件 | 改动 |
|---|---|
| `web/client/src/store/focus.jsx` | **新建**。FocusProvider + `focusMode` / `enterFocus` / `exitFocus` / `toggleFocus`；内部挂 `Esc` / `Cmd+.` 监听 |
| `web/client/src/App.jsx` | AppShell 外包 FocusProvider；顶栏按 `focusMode` 加 class |
| `web/client/src/pages/Workspace.jsx` | 栏的显隐判断改成 `focusMode \|\| collapsed.*`；切作品时退出专注 |
| `web/client/src/components/Editor/ChapterEditor.jsx` | 标题栏加「专注 / 退出专注」图标按钮 |
| `web/client/src/components/Assistant/Sidebar.jsx` | 暴露「待确认数量」与「滚动到待确认卡片」的方法 |
| `web/client/src/styles/theme.css` | `--ct-editor-width` 变量；`.is-focus` 下的顶栏最小化样式 |

### 5.1 快捷键归属：挂在 FocusProvider，不挂在 ChapterEditor

`Esc` 和 `Cmd+.` 由 `FocusProvider` 内部统一监听 `document` 的 keydown。

理由：

- **不必依赖 ChapterEditor 渲染**——`ChapterEditor` 在没有选中章节时会提前 return 渲染空状态，快捷键会跟着失效。作者可能正想在空章节视图里进专注模式（写新章节）。
- **不必在两个组件里各写一份**——`ChapterEditor` 已经有一个 document 级 keydown 监听（`Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y`），再加一个 `Esc` 分支进去会让「编辑器快捷键」和「专注模式快捷键」混在一个监听器里，各自的目的互相干扰。
- **`Cmd+.` 是全局的**——它属于「视图模式」，不属于「编辑这一章」。

判定条件：

```js
// Esc：任何时候都退出专注模式
if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) { ... }
// Cmd+.：进出切换
if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); ... }
```

`Esc` 要在 `focusMode` 为 false 时**什么都不做**——不能 `preventDefault`，免得影响别的组件（`HistoryPanel` 的抽屉、antd 的 Modal 都用 Esc 关闭）。

### 5.2 分工：FocusProvider 管开关，Workspace 管提示

**数据可得性决定了分工。**

| 组件 | 能读到 `focusMode` | 能读到 `messages` |
|---|---|---|
| `FocusProvider`（包在 App 层） | ✅ 自己提供 | ❌ 在 `WorkspaceProvider` 之内，读不到 |
| `Workspace` | ✅ 从 FocusProvider 读 | ✅ 从 `useWorkspace()` 读 |
| `Sidebar` | ✅ 从 FocusProvider 读 | ✅ 从 `useWorkspace()` 读 |

所以：**「有多少条待确认」这个判断只能放在 `Workspace`**（它同时拿得到两边）。

职责划分：

- `FocusProvider`：只管 `focusMode` 开关 + `Esc` / `Cmd+.` 快捷键。它**不读**任何业务数据，也**不直接弹 toast**。
- `Workspace`：监听「进入 / 退出请求」→ 算待确认数 → 弹 toast → 调 `exitFocus()`。

### 5.2.1 所有进入 / 退出路径都走事件

有三条路径会进出专注模式：

1. `Esc` / `Cmd+.` 快捷键（在 `FocusProvider` 里）
2. 标题栏「专注 / 退出专注」图标（在 `ChapterEditor` 里）
3. 切作品时自动退出（在 `Workspace` 里）

**三条路径统一广播事件**，由 `Workspace` 统一处理提示。否则会出现「图标退出不弹 toast、快捷键退出弹 toast」的不一致——作者会以为是 bug。

```js
// FocusProvider 导出的动作
const enterFocus = () => {
  window.dispatchEvent(new CustomEvent('ct:request-enter-focus'));
};
const exitFocus = () => {
  window.dispatchEvent(new CustomEvent('ct:request-exit-focus'));
};
```

`FocusProvider` 内部只维护 `focusMode` 这个 state，收到事件时真正改 state。

```js
// Workspace：统一处理
useEffect(() => {
  const onEnter = () => {
    setFocusMode(true);
    message.info('已进入专注模式，Esc 退出', 1.5);
  };
  const onExit = () => {
    const pending = pendingActions(messages);
    if (pending.length > 0) {
      message.info({
        content: `AI 有 ${pending.length} 条建议还没处理`,
        duration: 3,
        btn: <Button size="small" onClick={goToPending}>去看看</Button>,
      });
    } else if (sending) {
      message.info('AI 还在写，完成后会留在右侧等你确认', 3);
    }
    setFocusMode(false);
  };
  window.addEventListener('ct:request-enter-focus', onEnter);
  window.addEventListener('ct:request-exit-focus', onExit);
  return () => {
    window.removeEventListener('ct:request-enter-focus', onEnter);
    window.removeEventListener('ct:request-exit-focus', onExit);
  };
}, [messages, sending, goToPending]);
```

「切作品自动退出」这条路径**不弹 toast**——切作品时弹一句「AI 有 N 条建议还没处理」会让人困惑（那是上一个作品的事）。所以切作品直接调 `setFocusMode(false)`，绕过事件。

localStorage 的写入由 `FocusProvider` 在 `focusMode` 变化时统一做，不依赖事件。

### 5.2.2 FocusProvider 的导出

```js
{
  focusMode,           // boolean
  setFocusMode,        // (bool) => void —— 供 Workspace 直接改（切作品时用）
  enterFocus,          // () => void —— 广播进入请求
  exitFocus,           // () => void —— 广播退出请求
  toggleFocus,         // () => void —— Esc / Cmd+. 用
}
```

`enterFocus` / `exitFocus` 广播事件（走 `Workspace` 的提示逻辑），`setFocusMode` 直接改（用于不需要提示的场景：切作品）。

`ChapterEditor` 的图标按钮调 `enterFocus()` / `exitFocus()`，所以它拿得到 context。

`FocusProvider` 内部监听自己的事件来改 state——但这样绕了一圈。更直接的做法：**`FocusProvider` 内部监听事件改 state，`Workspace` 也监听事件做提示**。两者都监听同一个事件，互不干扰。

```js
// FocusProvider 内部
useEffect(() => {
  const onEnter = () => setFocusMode(true);
  const onExit = () => setFocusMode(false);
  window.addEventListener('ct:request-enter-focus', onEnter);
  window.addEventListener('ct:request-exit-focus', onExit);
  return () => {
    window.removeEventListener('ct:request-enter-focus', onEnter);
    window.removeEventListener('ct:request-exit-focus', onExit);
  };
}, []);
```

这样 `FocusProvider` 不导出 `enterFocus` / `exitFocus` 也能工作——但 `ChapterEditor` 需要触发入口，所以还是导出这两个函数（它们只负责 dispatch 事件）。

### 5.3 待确认的判定

判定逻辑抽成纯函数，放 `web/client/src/components/Assistant/pendingActions.js`：

```js
/** 会写进正文、需要作者确认的 action 类型 */
const TEXT_ACTIONS = ['replace', 'append', 'insert'];

/**
 * 待确认的 AI 结果。
 *
 * 只算 replace/append/insert —— comment（建议）和 none（回复）
 * 本来就没有「应用到正文」按钮，它们只是讨论，不该算进待处理。
 *
 * @param {Array} messages 消息流
 * @returns {Array} 待确认的消息，按时间顺序
 */
export function pendingActions(messages = []) {
  return messages.filter(
    (m) => m.role === 'assistant'
      && TEXT_ACTIONS.includes(m.action)
      && !m.applied
  );
}
```

`Workspace` 用它算数量，`Sidebar` 用它定位要滚到哪张卡。

### 5.4 「去看看」的两个动作

点「去看看」要：

1. 展开右栏（若 `collapsed.right` 为 true）
2. 滚到最下面那张待确认的 ActionCard

**第 1 步：`collapsed` 在 `Workspace` 的局部 state 里**（`useColumnWidths` 的返回值），`Workspace` 自己就能改——但 toast 的「去看看」按钮由 antd 渲染，在 `Workspace` 的 JSX 里，所以可以直接闭包捕获 `toggleRight`，不需要事件：

```js
const goToPending = useCallback(() => {
  if (collapsed.right) toggleRight();       // 展开右栏
  window.dispatchEvent(new CustomEvent('ct:scroll-to-pending'));  // 通知 Sidebar 滚动
}, [collapsed.right, toggleRight]);
```

**第 2 步：`Sidebar` 监听事件并滚动。**

`Sidebar` 的 `listRef` 是消息流滚动容器。加一个方法：

```js
const scrollToPending = useCallback(() => {
  const pending = pendingActions(messages).pop();  // 最后一条
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

给消息容器加 `data-msg-id={msg.id}`（`MessageList.jsx` 里的 `.ct-msg` 那一层），按这个属性定位。

这里用事件而不是 context，理由与 5.2 一致：这是「从工作区外壳回到侧栏内部」的一次性动作，不是需要被 React 树持续追踪的状态。

---

## 六、已知代价与风险

### 6.1 streaming 会触发全局重渲染

专注模式下 AI 正在生成时，`Sidebar` 每个 token 都 `dispatch({type:'streaming/set'})` → workspace context 的 `value` 变了 → 正在编辑的 `ChapterEditor` 重渲染。

**这是现状，不是新问题**（三栏模式下右栏一样在跑）。但专注模式下它是唯一的干扰源。

优化手段（把 streaming 状态拆出 workspace context）是一次独立重构，风险大于收益。本设计**不做**，先测量，真卡了再说。

### 6.2 右栏在后台渲染

专注模式下右栏组件还挂载着，token 进来时它照常重渲染。白烧一点 CPU，不出错。

### 6.3 `Cmd+.` 可能被系统抢

macOS 上 `Cmd+.` 是「显示/隐藏 Dock」的默认快捷键，部分情况下浏览器收不到。

需求池原文写的就是「`Esc` / `Cmd+.`」，按原文保留。`Esc` 始终可用，出口不会断。

### 6.4 移动端不做

`isMobile`（< 992px）时工作区本来就是单栏 + 抽屉，专注模式没有意义。专注模式入口在移动端不渲染。

---

## 七、验收标准

### 功能

- [ ] 点标题栏图标进入专注：三栏与顶栏隐藏，logo 与「退出专注」保留
- [ ] `Esc` 退出（焦点在 textarea 里也退）
- [ ] `Cmd+.` 进出
- [ ] 切换章节保持专注；切换作品退出专注
- [ ] 专注状态刷新后仍是专注（localStorage）
- [ ] 进入时 toast「已进入专注模式，Esc 退出」
- [ ] 退出时若有 N 条待确认 AI 结果，toast 提示 + 「去看看」可用
- [ ] 「去看看」能展开右栏并滚到待确认的 ActionCard
- [ ] `comment` / `none` 类型的 AI 回复**不**计入待确认数量
- [ ] AI 正在生成时退出不被拦截，toast 文案是「AI 还在写…」
- [ ] 作者手动折叠的左栏，在专注模式进出后仍保持折叠（localStorage 未被污染）
- [ ] 移动端不出现专注模式入口

### 视觉

- [ ] 普通模式正文宽 1000px，专注模式 1160px
- [ ] 切换宽度后格线不错位（34px 整数倍）
- [ ] **在正文中间聚焦状态下切进切出专注模式，格子不错位、光标不跳底**

### 回归

- [ ] 专注模式下 AI 生成不中断（SSE 连接保持）
- [ ] 现有块编辑器快捷键不受影响（`Cmd+Z` / `Cmd+Shift+Z` / `Cmd+Y`）
- [ ] 侧栏折叠功能（A6）行为不变
- [ ] 前端构建通过

---

## 八、相关文件索引

| 用途 | 路径 |
|---|---|
| 三栏布局 | `web/client/src/pages/Workspace.jsx` |
| 栏宽与折叠状态 | `web/client/src/hooks/useColumnWidths.js` |
| 章节标题栏 | `web/client/src/components/Editor/ChapterEditor.jsx` |
| AI 侧边栏与 SSE | `web/client/src/components/Assistant/Sidebar.jsx` |
| ActionCard（待确认判定） | `web/client/src/components/Assistant/ActionCard.jsx` |
| 消息流 | `web/client/src/components/Assistant/MessageList.jsx` |
| textarea 自动高度 | `web/client/src/components/Editor/Block.jsx` |
| 正文宽度与格线 | `web/client/src/styles/theme.css` |
| 应用外壳与顶栏 | `web/client/src/App.jsx` |
| 需求池 | `docs/superpowers/requirements/2026-10-30-requirements-inventory.md` |
