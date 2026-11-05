import test from 'node:test';
import assert from 'node:assert/strict';

import { panelCollapseSide } from '../src/utils/shortcuts.js';

/**
 * 侧栏折叠快捷键的判定。
 *
 * 背景：原先只看 `e.key === '\\'`，但 Shift+\ 在多数布局上产出的是 `'|'`，
 * 真实键盘按 ⌘⇧\ 收左栏会直接 return，快捷键形同虚设。
 * 这里覆盖 Shift+\ 的两种 key 值，以及不该触发的组合。
 */

const key = (patch) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  key: '',
  code: '',
  ...patch,
});

test('⌘/Ctrl + \\ 收右栏', () => {
  assert.equal(panelCollapseSide(key({ metaKey: true, key: '\\', code: 'Backslash' })), 'right');
  assert.equal(panelCollapseSide(key({ ctrlKey: true, key: '\\', code: 'Backslash' })), 'right');
});

test('⌘⇧\\ 收左栏：Shift+\\ 的两种 key 值都能命中', () => {
  // 大多数键盘布局：Shift+\ 产出的 key 是 '|'
  assert.equal(
    panelCollapseSide(key({ metaKey: true, shiftKey: true, key: '|', code: 'Backslash' })),
    'left'
  );
  // 少数布局 / 合成事件仍给 '\\'，或者干脆没有 code
  assert.equal(
    panelCollapseSide(key({ ctrlKey: true, shiftKey: true, key: '\\', code: 'Backslash' })),
    'left'
  );
  assert.equal(
    panelCollapseSide(key({ metaKey: true, shiftKey: true, key: '|', code: '' })),
    'left'
  );
});

test('没有修饰键、或不是反斜杠时不触发', () => {
  assert.equal(panelCollapseSide(key({ key: '\\', code: 'Backslash' })), '');
  assert.equal(panelCollapseSide(key({ metaKey: true, key: 'z', code: 'KeyZ' })), '');
  assert.equal(panelCollapseSide(key({ metaKey: true, key: '|', code: 'KeyZ' })), '');
  assert.equal(panelCollapseSide(null), '');
});
