/**
 * 侧栏折叠快捷键的判定。
 *
 * ⌘/Ctrl + \ 收右栏，⌘/Ctrl + Shift + \ 收左栏。
 *
 * 必须用 `e.code` 做主判断：Shift+\ 在多数键盘布局上产出的 `e.key` 是 `'|'`，
 * 只看 `e.key === '\\'` 会让左栏快捷键在真实键盘上按不动。
 * `e.code` 与布局、修饰键都无关，始终是 `'Backslash'`。
 *
 * 合成事件、老浏览器可能没有 `code`，这时退回 `key` 的两个可能值。
 * 有 `code` 就只认 `code`：code 是别的键时不能再按 key 猜，
 * 否则把 '|' 这种拾取不当的键值也算成快捷键。
 *
 * @param {KeyboardEvent} e
 * @returns {'left'|'right'|''} 要收起/展开哪一栏；不是本快捷键时返回空串
 */
export function panelCollapseSide(e) {
  if (!e || !(e.metaKey || e.ctrlKey)) return '';
  const isBackslash = e.code
    ? e.code === 'Backslash'
    : e.key === '\\' || e.key === '|';
  if (!isBackslash) return '';
  return e.shiftKey ? 'left' : 'right';
}
