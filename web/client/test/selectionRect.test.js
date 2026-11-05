import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOLBAR_EDGE,
  TOOLBAR_GAP,
  placeSelectionToolbar,
} from '../src/utils/selectionRect.js';

/**
 * 选区工具条的摆放规则。
 *
 * 产品约束（从用户视角反过来推）：
 *   - 工具条不许压在选中的字上；
 *   - 下方放得下就放下方，放不下翻到上方；
 *   - 上下都放不下必须夹在可视区内，绝不越界；
 *   - 选区已经滚出可视区时整条不显示，别贴在无关正文上。
 */

const viewport = { top: 0, bottom: 900, left: 0, right: 1200 };
const size = { width: 520, height: 33 };

test('默认放在选区下方，不压字', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 200, bottom: 234, left: 300 },
    viewport,
    size,
  });
  assert.equal(pos.visible, true);
  assert.equal(pos.clamped, false);
  // 下沿 + 间隙
  assert.ok(pos.top >= 234 + TOOLBAR_GAP);
  assert.ok(pos.top < 234 + TOOLBAR_GAP + 1);
  assert.equal(pos.left, 300);
});

test('下方放不下就翻到选区上方', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 820, bottom: 854, left: 300 },
    viewport,
    size,
  });
  assert.equal(pos.visible, true);
  assert.equal(pos.clamped, false);
  const bottomOfToolbar = pos.top + size.height;
  assert.ok(bottomOfToolbar <= 820 - TOOLBAR_GAP);
});

test('上下都放不下时夹在可视区内，不越界', () => {
  // 视口只有 100px 高，工具条 33px，选区占满中间 90px
  const shortViewport = { top: 300, bottom: 400, left: 0, right: 1200 };
  const pos = placeSelectionToolbar({
    selection: { top: 305, bottom: 395, left: 300 },
    viewport: shortViewport,
    size,
  });
  assert.equal(pos.clamped, true);
  assert.equal(pos.visible, true);
  assert.ok(pos.top >= shortViewport.top + TOOLBAR_EDGE);
  assert.ok(pos.top + size.height <= shortViewport.bottom - TOOLBAR_EDGE);
});

test('选区完全滚出可视区：不显示', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 950, bottom: 984, left: 300 },
    viewport,
    size,
  });
  assert.equal(pos.visible, false);
});

test('选区只露出一部分时按露出部分锚定', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 880, bottom: 940, left: 300 },
    viewport,
    size,
  });
  assert.equal(pos.visible, true);
  assert.ok(pos.top + size.height <= 900 - TOOLBAR_EDGE);
  assert.ok(pos.top >= 880 - TOOLBAR_GAP - size.height - 1);
});

test('横向：靠右的选区被夹回可视区', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 200, bottom: 234, left: 1000 },
    viewport,
    size,
  });
  assert.equal(pos.left, viewport.right - TOOLBAR_EDGE - size.width);
});

test('横向：工具条比可视区还宽时贴左边', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 200, bottom: 234, left: 300 },
    viewport,
    size: { width: 2000, height: 33 },
  });
  assert.equal(pos.left, viewport.left + TOOLBAR_EDGE);
});

test('尺寸还没量到：先按下方排，不报未就绪', () => {
  const pos = placeSelectionToolbar({
    selection: { top: 200, bottom: 234, left: 300 },
    viewport,
    size: { width: 0, height: 0 },
  });
  assert.equal(pos.visible, true);
  assert.equal(pos.top, 234 + TOOLBAR_GAP);
});
