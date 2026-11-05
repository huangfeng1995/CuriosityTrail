/**
 * 量出 textarea 里某段选区的屏幕矩形。
 *
 * textarea 的内容不在 DOM 树里（它是浏览器自绘的影子根），
 * 没有 Range、没有 getClientRects，能拿到的只有 selectionStart/End 两个字符下标。
 * 想知道「选区落在第几行、行的哪个位置」，只能照着 textarea 的排版
 * 复制一份到隐藏的镜像 div 里，用镜像的排版结果反推。
 *
 * 镜像必须跟 textarea 逐项对齐：字体、字号、行高、字距、首行缩进、
 * 折行规则、可用宽度。差一项，换行点就会错位，量出来的行也就错了。
 */

/** 镜像只建一次，反复复用：每次选区变化都新建会拖慢交互。 */
let mirrorEl = null;

function getMirror() {
  if (mirrorEl && mirrorEl.isConnected) return mirrorEl;
  mirrorEl = document.createElement('div');
  mirrorEl.setAttribute('aria-hidden', 'true');
  // fixed + 不可见：不参与文档流，也就不会把页面撑出滚动条
  // （镜像里装的是整段文字，段落一长就能撑出上万像素高）。
  mirrorEl.style.cssText =
    'position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;';
  document.body.appendChild(mirrorEl);
  return mirrorEl;
}

/**
 * 把 textarea 的排版参数抄到镜像上。
 *
 * 只抄影响「文字怎么排」的属性。抄多了（比如 overflow、resize）没有意义，
 * 抄漏了（比如 text-indent、letter-spacing）会让镜像的换行点和正文对不上。
 */
function syncStyle(mirror, ta, cs) {
  const contentWidth = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);

  mirror.style.width = `${contentWidth}px`;
  mirror.style.boxSizing = 'content-box';
  mirror.style.padding = '0';
  mirror.style.border = '0';

  mirror.style.fontFamily = cs.fontFamily;
  mirror.style.fontSize = cs.fontSize;
  mirror.style.fontWeight = cs.fontWeight;
  mirror.style.fontStyle = cs.fontStyle;
  mirror.style.fontStretch = cs.fontStretch;
  mirror.style.fontVariant = cs.fontVariant;
  mirror.style.letterSpacing = cs.letterSpacing;
  mirror.style.lineHeight = cs.lineHeight;
  mirror.style.textIndent = cs.textIndent;
  mirror.style.textTransform = cs.textTransform;
  mirror.style.direction = cs.direction;

  // textarea 默认 white-space: pre-wrap、overflow-wrap: break-word，
  // 折行规则跟普通 div 不一样——这里照抄，不能用默认值。
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.wordBreak = cs.wordBreak;
  mirror.style.overflowWrap = 'break-word';
}

/**
 * 量出「镜像里第 offset 个字符之后」的光标位置。
 *
 * 用 Range 收缩到该处，而不是塞一个零宽字符进去：
 * 零宽字符（U+200B）本身是换行机会，会让镜像的折行位置和真实正文不一致，
 * 选区正好落在换行点时就会量错一行。
 * Range 的光标位置由浏览器自己算，和真实输入框里的光标一致。
 */
function caretAt(mirror, text, offset) {
  mirror.textContent = '';
  const node = document.createTextNode(text);
  mirror.appendChild(node);

  const range = document.createRange();
  if (offset < text.length) {
    // 量「offset 那个字」本身：它落在哪一行，那个字就在哪一行。
    // 比量光标稳——光标正好停在折行点时，浏览器报的行号有歧义。
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
  } else {
    // 选区结束在文末：没有下一个字可量，量光标。
    range.setStart(node, text.length);
    range.collapse(true);
  }

  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return { top: rect.top, left: rect.left, bottom: rect.bottom };
}

/**
 * 量出 textarea 中一段选区的屏幕矩形（视口坐标）。
 *
 * @param {HTMLTextAreaElement} ta
 * @param {number} start 选区起点字符下标
 * @param {number} end 选区终点字符下标
 * @returns {{top:number,bottom:number,left:number,right:number}|null}
 */
export function getTextareaSelectionRect(ta, start, end) {
  if (!ta || typeof ta.value !== 'string') return null;

  const text = ta.value;
  const from = Math.max(0, Math.min(start ?? 0, text.length));
  const to = Math.max(from, Math.min(end ?? from, text.length));

  const cs = window.getComputedStyle(ta);
  const mirror = getMirror();
  syncStyle(mirror, ta, cs);

  const taRect = ta.getBoundingClientRect();
  const mirrorRect = mirror.getBoundingClientRect();

  // textarea 的内容区原点（去掉边框和内边距）
  const taContentLeft = taRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const taContentTop = taRect.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);

  // 镜像的内容区原点。镜像自己的边框和内边距都是 0，
  // 所以就是它的 rect 原点——别拿 textarea 的 border/padding 加上去，
  // 那是另一个元素的边距。
  const mirrorContentLeft = mirrorRect.left;
  const mirrorContentTop = mirrorRect.top;

  const startMark = caretAt(mirror, text, from);
  if (!startMark) return null;
  const endMark = caretAt(mirror, text, to) || startMark;

  const startTop = taContentTop + (startMark.top - mirrorContentTop);
  const startLeft = taContentLeft + (startMark.left - mirrorContentLeft);
  const endTop = taContentTop + (endMark.top - mirrorContentTop);
  const endLeft = taContentLeft + (endMark.left - mirrorContentLeft);

  // 选区可能跨行。终点落在下一行时，底边取终点那一行的底。
  const lineHeight = parseFloat(cs.lineHeight) || startMark.bottom - startMark.top;
  const bottom = Math.max(startTop + lineHeight, endTop + lineHeight);

  return {
    top: startTop,
    bottom,
    left: Math.min(startLeft, endLeft),
    right: Math.max(startLeft, endLeft),
  };
}

/** 工具条与选区之间的间隙。 */
export const TOOLBAR_GAP = 8;

/** 工具条与滚动区可视边缘之间至少保留的空白。 */
export const TOOLBAR_EDGE = 8;

/**
 * 算工具条的浮层位置。
 *
 * 工具条挂在 .ct-editor（不滚动）上，坐标以 .ct-editor 的左上角为原点；
 * selection / viewport 都传已经换算成这套坐标的矩形。
 * viewport 是正文滚动区在 .ct-editor 里的可见范围。
 *
 * 摆放优先级：
 *   1. 选区不在可视范围里 → visible=false，整条不显示（别飘在没有选区的地方）；
 *   2. 默认浮在选区下方，不压住选中的字；
 *   3. 下方空间不够（选区贴近可视区下沿）就翻到选区上方；
 *   4. 上下都不够（视口特别矮）就贴边夹取，保证整条不越出可视区；
 *   5. 夹取后若仍压住选区，往空间更大的一侧贴边。
 *
 * 横向：贴着选区排，超出可视区就夹回来；窄屏下由 CSS 限制宽度并折行，
 * 这里拿到的 size 已经是折行后的实际尺寸。
 *
 * @param {object} p
 * @param {{top:number,bottom:number,left:number}} p.selection 选区矩形（.ct-editor 坐标）
 * @param {{top:number,bottom:number,left:number,right:number}} p.viewport 可视范围（.ct-editor 坐标）
 * @param {{width:number,height:number}} p.size 工具条实际尺寸（未量到时为 0）
 * @returns {{top:number,left:number,clamped:boolean,visible:boolean}}
 */
export function placeSelectionToolbar({ selection, viewport, size }) {
  const width = Math.max(0, Number(size?.width) || 0);
  const height = Math.max(0, Number(size?.height) || 0);

  const edge = TOOLBAR_EDGE;
  const gap = TOOLBAR_GAP;
  const minTop = viewport.top + edge;
  const maxTop = viewport.bottom - edge - height;

  // 选区完全滚出可视区：不显示，避免工具条贴边飘在无关正文上。
  const visible = selection.bottom > minTop && selection.top < viewport.bottom - edge;
  if (!visible) {
    return { top: minTop, left: viewport.left + edge, clamped: false, visible: false };
  }

  // 部分露出时只按露出的部分锚定，避免把工具条推到屏幕外。
  const selTop = Math.max(selection.top, minTop);
  const selBottom = Math.min(selection.bottom, viewport.bottom - edge);

  const aboveTop = selTop - gap - height;
  const belowTop = selBottom + gap;

  let clamped = false;
  let top;

  if (height === 0) {
    // 尺寸还没量到：先按选区下方排，父组件会在量到尺寸后重排。
    top = belowTop;
  } else if (belowTop + height <= viewport.bottom - edge) {
    top = belowTop;
  } else if (aboveTop >= minTop) {
    top = aboveTop;
  } else {
    // 上下都不够：贴边夹取。
    clamped = true;
    top = maxTop < minTop ? minTop : Math.min(Math.max(aboveTop, minTop), maxTop);

    // 夹取后仍压着选中的字，就往空间更大的一侧贴边。
    if (top < selBottom && top + height > selTop) {
      const roomAbove = selTop - viewport.top;
      const roomBelow = viewport.bottom - selBottom;
      const pinned = roomAbove >= roomBelow ? minTop : maxTop;
      if (pinned >= minTop && pinned + height <= viewport.bottom) top = pinned;
    }
  }

  // 横向：贴着选区左端排，再夹回可视区。
  let left = selection.left;
  if (width === 0) {
    left = Math.max(viewport.left, left);
  } else if (width + edge * 2 <= viewport.right - viewport.left) {
    left = Math.min(Math.max(viewport.left + edge, left), viewport.right - edge - width);
  } else {
    // 比可视区还宽：靠左贴边，宽度交给 CSS 折行。
    left = viewport.left + edge;
  }

  return { top, left, clamped, visible: true };
}
