import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Space, message, Modal, Input, Tooltip, Dropdown, Spin } from 'antd';
import {
  SaveOutlined,
  UndoOutlined,
  RedoOutlined,
  HistoryOutlined,
  DownloadOutlined,
  MoreOutlined,
} from '@ant-design/icons';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { useFocus } from '../../store/focus';
import api from '../../api/client';
import { createBlock, countChars } from './blocks';
import { assessRewrite } from './writebackGuard';
import { collectCriticFindings, REASON_LABEL } from '../Assistant/findings';
import { countBlockWords, formatWords } from '../../utils/wordCount';
import Block from './Block';
import BlockPalette from './BlockPalette';
import BlockToolbar, { ACTIONS as INLINE_ACTIONS } from './BlockToolbar';
import VersionHistoryPanel from './VersionHistoryPanel';
import EmptyState from '../EmptyState';
import { useIsNarrow } from '../../hooks/useMediaQuery';
import {
  CARD_HIGHLIGHT_EVENT,
  emitCardHighlight,
} from '../Sidebar/useCardOccurrences';

// 这些动作的产出是正文，必须直接落笔；找茬不在其中。
const EDIT_ACTIONS = new Set([
  'rewrite',
  'expand',
  'shorten',
  'tone',
  'continue',
  'colloquialize',
]);

// 对照里的差异一次最多算多少格。超了就只并排显示原文与新版，不做逐字标色：
// 两千字的长段再逐字对齐会明显卡顿，而这么大的改动本来也看不清细差。
const DIFF_CELL_LIMIT = 240000;

/** 逐字对照：返回原文/新版各自的片段，供上下两行分别标删改与新增。 */
function diffInline(before, after) {
  if (before === after) return null;
  const n = before.length;
  const m = after.length;
  if (n * m > DIFF_CELL_LIMIT) return null;

  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        before[i] === after[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const beforeSegs = [];
  const afterSegs = [];
  const push = (arr, type, ch) => {
    const last = arr[arr.length - 1];
    if (last && last.type === type) last.text += ch;
    else arr.push({ type, text: ch });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push(beforeSegs, 'same', before[i]);
      push(afterSegs, 'same', after[j]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      push(beforeSegs, 'del', before[i]);
      i += 1;
    } else {
      push(afterSegs, 'add', after[j]);
      j += 1;
    }
  }
  while (i < n) {
    push(beforeSegs, 'del', before[i]);
    i += 1;
  }
  while (j < m) {
    push(afterSegs, 'add', after[j]);
    j += 1;
  }
  return { beforeSegs, afterSegs };
}

/** 把对照片段渲染出来：变化的那一侧用删/增标记，未变的保持普通文字。 */
function renderDiff(segs, changed) {
  return segs.map((seg, i) => {
    if (seg.type !== changed) return <React.Fragment key={i}>{seg.text}</React.Fragment>;
    return changed === 'del' ? <del key={i}>{seg.text}</del> : <ins key={i}>{seg.text}</ins>;
  });
}

// 保存状态对应的提示文案。状态来自 store，与真实落库进度一致。
const SAVE_LABEL = {
  idle: '已保存',
  dirty: '编辑中…',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};

// 导出格式。章节头的「⋯」里按作品 / 本章两个范围各列一遍。
const EXPORT_FORMATS = [
  { ext: 'docx', label: 'Word 文档（.docx）' },
  { ext: 'md', label: 'Markdown（.md）' },
  { ext: 'txt', label: '纯文本（.txt）' },
];

/**
 * 章节块编辑器。
 *
 * 数据流：store.blocks 是唯一权威 → 本地编辑即时反映 → 800ms 防抖落库。
 */
export default function ChapterEditor() {
  const {
    chapter,
    blocks,
    messages,
    selection,
    work,
    chapters,
    updateBlock,
    insertBlock,
    removeBlock,
    convertBlock,
    moveBlock,
    undo,
    redo,
    past,
    future,
    saveStatus,
    dispatch,
    renameChapter,
    loadWork,
    loadChapter,
  } = useWorkspace();

  const [activeBlockId, setActiveBlockId] = useState(null);
  const [activeFindingKey, setActiveFindingKey] = useState('');
  // 侧栏采纳成功后，回执里带着这一批的 key。正文据此把对应序号收成已验证，
  // 避免"已经改过"的段落还挂着待办的黄底与高亮序号。纯视图状态，不落库。
  const [adoptedFindingKeys, setAdoptedFindingKeys] = useState(() => new Set());
  // 上一次行内改写写在哪儿。保留「再来一次」用，不靠当前选区：
  // 改完正文后选区已失效，若还拿旧偏移量重跑就会改错地方。
  const [lastInline, setLastInline] = useState(null);
  const [retrying, setRetrying] = useState(false);
  // 对照默认折起，作者要看全文再展开；换一次改写就回到折起状态。
  const [compareOpen, setCompareOpen] = useState(false);
  const [creatingChapter, setCreatingChapter] = useState(false);
  // 同一块意见被反复点击时，key 不变但作者仍然期望「再滚一次」。
  // 用递增序号触发块内的定位副作用，不把滚动逻辑塞进事件回调里。
  const [findingFocusSeq, setFindingFocusSeq] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 侧栏选了某张人物卡 / 设定卡时，正文里命中的块整块标黄。
  // 纯视图状态：换章、关面板、换作品都靠事件清掉，不落库。
  const [cardHighlight, setCardHighlight] = useState(null);
  const pendingCardBlockRef = useRef(null);
  const editorRef = useRef(null);
  // 新章自动补的那一段：记下是哪一章补过，作者主动删光时不再偷偷加回来。
  const blankChapterRef = useRef('');
  // 段落刚插进 store 时 DOM 还没挂上，等下一次 blocks 更新再聚焦。
  const pendingFocusRef = useRef('');
  // 动作条显示的字数：只报选中的字数。没选中时动作条置灰，不显示数字。
  const selectedChars = countChars(selection?.text || '');
  // 放不下三栏时（工作区改成抽屉布局）没有侧栏可藏，专注模式不成立。
  const isNarrow = useIsNarrow();
  const { focusMode, enterFocus, exitFocus } = useFocus();

  // 审稿意见的锚点每次渲染按当前正文实时算，不落库。
  // 只把可定位的挂到块上；未定位的留在侧栏标「全章建议」。
  const criticFindings = useMemo(
    () => collectCriticFindings(messages, blocks),
    [messages, blocks]
  );

  const findingsByBlock = useMemo(() => {
    const map = new Map();
    criticFindings.forEach((finding) => {
      if (finding.status !== 'located') return;
      // 采纳过的意见仍留在沟槽里（号码要跟侧栏对得上），
      // 但标记成已验证，正文不再整块标黄——改完的段落不该继续像待办。
      const item = { ...finding, adopted: adoptedFindingKeys.has(finding.key) };
      if (!map.has(finding.blockId)) map.set(finding.blockId, []);
      map.get(finding.blockId).push(item);
    });
    return map;
  }, [criticFindings, adoptedFindingKeys]);

  // 当前正在核对的那条意见。章节头的定位条靠它常驻显示，
  // 这样正文滚走以后，作者仍然知道刚才看的是哪一句。
  const activeFinding = useMemo(
    () => criticFindings.find((finding) => finding.key === activeFindingKey) || null,
    [criticFindings, activeFindingKey]
  );

  // 侧栏点一条意见 → 滚到正文对应句并高亮。
  // 滚动交给 Block 里的镜像层：那里才知道句子落在块内第几行。
  useEffect(() => {
    const onFocusBlock = (e) => {
      const detail = e.detail || {};
      setActiveFindingKey(detail.findingKey || '');
      setFindingFocusSeq((n) => n + 1);
    };
    window.addEventListener('ct:focus-block', onFocusBlock);
    return () => window.removeEventListener('ct:focus-block', onFocusBlock);
  }, []);

  // 采纳回执：侧栏（对话卡片、检查面板）改完正文后会广播这一批的 key。
  // 只有成功才收，失败那批保持待办模样。
  useEffect(() => {
    const onAdoptResult = (e) => {
      const detail = e.detail || {};
      if (!detail.ok) return;
      const keys = Array.isArray(detail.keys) ? detail.keys : [];
      if (!keys.length) return;
      setAdoptedFindingKeys((prev) => {
        const next = new Set(prev);
        keys.forEach((key) => next.add(key));
        return next;
      });
    };
    window.addEventListener('ct:adopt-result', onAdoptResult);
    return () => window.removeEventListener('ct:adopt-result', onAdoptResult);
  }, []);

  /** 正文沟槽点序号 → 选中该条意见并让侧栏滚过去。 */
  const focusFinding = useCallback((finding) => {
    setActiveFindingKey(finding.key);
    setFindingFocusSeq((n) => n + 1);
    window.dispatchEvent(
      new CustomEvent('ct:focus-finding', {
        detail: { messageId: finding.messageId, findingKey: finding.key },
      })
    );
  }, []);

  const refocusFinding = useCallback(() => {
    setFindingFocusSeq((n) => n + 1);
  }, []);

  // 侧栏选中/取消某张卡片：按命中的词给正文标黄。
  // 事件里带 blockId 时说明作者是从「出现位置」里点了某一章，
  // 要滚到那一块去——但切章是异步的，所以先记下来，等 blocks 到位再滚。
  useEffect(() => {
    const onCardHighlight = (e) => {
      const detail = e.detail || {};
      if (!detail.words || !detail.words.length) {
        setCardHighlight(null);
        pendingCardBlockRef.current = null;
        return;
      }
      setCardHighlight({ words: detail.words, label: detail.label || '' });
      if (detail.blockId) pendingCardBlockRef.current = detail.blockId;
    };
    window.addEventListener(CARD_HIGHLIGHT_EVENT, onCardHighlight);
    return () => window.removeEventListener(CARD_HIGHLIGHT_EVENT, onCardHighlight);
  }, []);

  useEffect(() => {
    const blockId = pendingCardBlockRef.current;
    if (!blockId || !cardHighlight) return;
    pendingCardBlockRef.current = null;
    const el = editorRef.current?.querySelector(`[data-block-id="${blockId}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [blocks, cardHighlight]);

  // 当前章命中的块数。块级统计，与正文的标黄粒度保持一致。
  const cardHitBlocks = useMemo(() => {
    if (!cardHighlight?.words?.length) return 0;
    return blocks.filter((block) => {
      if (!block) return false;
      const texts = [block.content, block.speaker].filter((t) => typeof t === 'string' && t);
      return cardHighlight.words.some((w) => w && texts.some((t) => t.includes(w)));
    }).length;
  }, [blocks, cardHighlight]);

  // 选中的块被删掉（删除、撤销、换章）时，选区跟着作废，不留陈旧状态。
  useEffect(() => {
    if (selection && !blocks.some((b) => b.id === selection.blockId)) {
      dispatch({ type: 'selection/set', selection: null });
    }
  }, [blocks, selection, dispatch]);

  // 空章：补一个空段落，让第一屏就是能写的正文，而不是一排"添加内容块"。
  // 只补一次；作者把这一段删掉是明确意图，不再替他加回来。
  useEffect(() => {
    if (!chapter || blocks.length || blankChapterRef.current === chapter.id) return;
    blankChapterRef.current = chapter.id;
    const block = createBlock('paragraph');
    pendingFocusRef.current = block.id;
    insertBlock(0, block);
    setActiveBlockId(block.id);
  }, [chapter, blocks, insertBlock]);

  // 等新段落进了 DOM 再把光标放进去，作者点完入口就能敲第一句。
  useEffect(() => {
    const id = pendingFocusRef.current;
    if (!id) return;
    const el = editorRef.current?.querySelector(`[data-block-id="${id}"] textarea`);
    if (!el) return;
    pendingFocusRef.current = '';
    el.focus();
  }, [blocks]);

  // 点击正文以外的位置收起选区。
  //
  // 工具条固定在章节头里，不在正文滚动器内部：点它时必须单独豁免，
  // 否则 mousedown 会先清空选区，按钮的 click 来不及执行。
  useEffect(() => {
    const onMouseDown = (e) => {
      if (e.target.closest?.('.ct-inline-toolbar')) return;
      if (editorRef.current && !editorRef.current.contains(e.target)) {
        dispatch({ type: 'selection/set', selection: null });
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [dispatch]);

  const handleBlockChange = useCallback(
    (id, patch) => {
      updateBlock(id, patch);
    },
    [updateBlock]
  );

  const handleDelete = useCallback(
    (id) => {
      removeBlock(id);
    },
    [removeBlock]
  );

  const handleMove = useCallback(
    (id, offset) => {
      moveBlock(id, offset);
    },
    [moveBlock]
  );

  const handleConvert = useCallback(
    (id, type) => {
      convertBlock(id, type);
    },
    [convertBlock]
  );

  const handleAdd = useCallback(
    (type, index) => {
      const block = createBlock(type);
      const at = index ?? blocks.length;
      insertBlock(at, block);
      setActiveBlockId(block.id);
    },
    [blocks.length, insertBlock]
  );

  /**
   * 选区上报。除了「选中了哪一段」，还要处理「选区没了」：
   * 光标落回原处、焦点移走时都把状态收回，章节头那条动作栏才不会
   * 挂着上一段的字数继续可用。
   */
  const handleSelect = useCallback(
    (sel) => {
      if (sel) {
        dispatch({ type: 'selection/set', selection: sel });
        return;
      }
      if (selection) dispatch({ type: 'selection/set', selection: null });
    },
    [selection, dispatch]
  );

  /**
   * 行内 AI：拿回结构化结果后写回块内。
   * replace 替换选区，append 追加到块尾，其余按 comment 只展示不改稿。
   *
   * 动作条固定在章节头，不再由它自己关闭；改完稿后这里收起选区，
   * 免得「已选 N 字」还挂着旧偏移量，下一按就作用到错的位置。
   *
   * sel 可以显式传入：「再来一次」要在没有选区的情况下重跑同一个范围。
   */
  const runInline = useCallback(
    async (action, instruction, sel) => {
      const target0 = sel || selection;
      if (!target0 || !chapter) return;
      const target = blocks.find((b) => b.id === target0.blockId);
      if (!target) return;

      const post = async (extra) => {
        const res = await fetch('/api/ai/inline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action,
            instruction: [instruction, extra].filter(Boolean).join('；'),
            selection: target0.text,
            blockId: target0.blockId,
            blocks,
            workId: chapter.work_id,
            chapterId: chapter.id,
            roleKey: action === 'critique' ? 'critic' : 'editor',
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      };

      try {
        let data = await post('');

        // 模型偶尔不写正文，只回一段说明（action=comment）。
        // 改写类动作要的是直接落笔：自动再要一次，明确不要建议；
        // 还是只给说明就按失败处理——原文不动，也不再弹建议框让作者确认。
        if (
          EDIT_ACTIONS.has(action) &&
          data.action !== 'replace' &&
          data.action !== 'append'
        ) {
          data = await post('直接输出改写后的正文，不要给建议、解释或说明。');
        }

        if (data.action === 'replace' && data.content) {
          const next =
            target.content.slice(0, target0.start) +
            data.content +
            target.content.slice(target0.end);

          // 模型被长度上限截断时只回一句，这里会把整段压成那一句。
          // 缩写是作者明确要求变短，其余动作都要过长度闸。
          const guard = assessRewrite(target.content, next, { action });
          if (!guard.ok) {
            // 被拦下时原文没动，选区也留着，作者可以直接再点一次或缩小选区。
            message.warning(guard.reason);
            return;
          }

          updateBlock(target.id, { content: next });
          // 记住写回后的区间、改写前的原句与模式：
          // 「再来一次」只在这段文字仍然原样时出现，「撤回」按原区间精确还原，
          // 不碰作者在别处顺手改的字。
          setLastInline({
            mode: 'replace',
            action,
            instruction,
            blockId: target.id,
            start: target0.start,
            end: target0.start + data.content.length,
            text: data.content,
            beforeText: target0.text,
          });
        } else if (
          data.action === 'append' &&
          data.content &&
          // 模型没按格式返回时服务端也会塞成 append，那种文本只有续写才敢直接落笔。
          (action === 'continue' || !data.parseFailed)
        ) {
          updateBlock(target.id, {
            content: target.content + data.content,
          });
          setLastInline({
            mode: 'append',
            action,
            instruction,
            blockId: target.id,
            start: target.content.length,
            end: target.content.length + data.content.length,
            text: data.content,
          });
        } else if (action === 'critique') {
          // 找茬本来就只要建议，不动稿。
          setLastInline(null);
          Modal.info({
            title: data.reason || 'AI 的建议',
            content: (
              <div style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
                {data.content}
              </div>
            ),
            okText: '知道了',
          });
          dispatch({ type: 'selection/set', selection: null });
          return;
        } else {
          // 没拿到正文：原文保留，选区留着，作者可以直接再点一次。
          message.warning('这次没有改出来，原文已保留');
          return;
        }

        dispatch({ type: 'selection/set', selection: null });
      } catch (e) {
        message.error(e.message || 'AI 调用失败');
      }
    },
    [blocks, chapter, selection, updateBlock, dispatch]
  );

  // 写回后的那段文字被改动（或块被删）：入口自动失效，避免在别的内容上重跑。
  const retryable = useMemo(() => {
    if (!lastInline) return null;
    const block = blocks.find((b) => b.id === lastInline.blockId);
    if (!block) return null;
    if (block.content.slice(lastInline.start, lastInline.end) !== lastInline.text) return null;
    return lastInline;
  }, [lastInline, blocks]);

  const retryLabel =
    INLINE_ACTIONS.find((a) => a.key === retryable?.action)?.label || '改写';

  // 对照内容：替换类逐字标出删改与新增；续写只展示新增的那一段。
  const inlineDiff = useMemo(() => {
    if (!retryable || retryable.mode === 'append') return null;
    return diffInline(retryable.beforeText || '', retryable.text || '');
  }, [retryable]);

  // 一行放不下才给「展开」，短句不额外挂一个没用的按钮。
  const compareLong =
    !!retryable &&
    Math.max((retryable.beforeText || '').length, (retryable.text || '').length) > 44;

  useEffect(() => {
    setCompareOpen(false);
  }, [lastInline]);

  // 撤回这一步改写：按写回时记下的区间精确还原，不依赖编辑器 undo 栈
  // （跨块写回后那个栈对不上位置）。改法：
  //   replace —— 把区间换回原句；append —— 把追加的那段切掉。
  // 区间外的字一律不碰。撤过一次，撤回与再来一次一起收起。
  const undoInline = useCallback(() => {
    if (!retryable) return;
    const block = blocks.find((b) => b.id === retryable.blockId);
    if (!block) return;
    const { content } = block;
    const next =
      retryable.mode === 'append'
        ? content.slice(0, retryable.start) + content.slice(retryable.end)
        : content.slice(0, retryable.start) +
          retryable.beforeText +
          content.slice(retryable.end);
    updateBlock(block.id, { content: next });
    setLastInline(null);
  }, [retryable, blocks, updateBlock]);

  const retryInline = useCallback(async () => {
    if (!retryable || retrying) return;
    const sel = {
      blockId: retryable.blockId,
      start: retryable.start,
      end: retryable.end,
      text: retryable.text,
    };
    setRetrying(true);
    try {
      await runInline(retryable.action, retryable.instruction, sel);
    } finally {
      setRetrying(false);
    }
  }, [retryable, retrying, runInline]);

  // 换章后上一次改写的位置不再有意义。
  useEffect(() => {
    setLastInline(null);
  }, [chapter?.id]);

  // 撤销/重做快捷键。Cmd+Z 撤销，Cmd+Shift+Z 与 Cmd+Y 重做。
  useEffect(() => {
    const onKeyDown = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

  const handleSaveNow = useCallback(async () => {
    if (!chapter) return;
    try {
      const res = await fetch(`/api/chapters/${chapter.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ blocks }),
      });
      if (!res.ok) throw new Error('保存失败');
      message.success('已保存');
    } catch (e) {
      message.error(e.message);
    }
  }, [blocks, chapter]);

  // 空作品的第一屏：直接建第一章并载入，作者点完就能写，
  // 不必先去左栏找那行小字。
  const createFirstChapter = useCallback(async () => {
    if (!work || creatingChapter) return;
    setCreatingChapter(true);
    try {
      const res = await api.post(`/works/${work.id}/chapters`, {});
      await loadWork(work.id);
      await loadChapter(res.data.id);
    } catch (e) {
      message.error(e.response?.data?.error || '新建章节失败');
    } finally {
      setCreatingChapter(false);
    }
  }, [work, creatingChapter, loadWork, loadChapter]);

  // 导出范围：整部作品 + 本章。放在「⋯」的子菜单里，章节头只留一个入口。
  const exportMenuItems = useMemo(() => {
    if (!chapter) return [];
    return [
      { scope: 'work', id: chapter.work_id, prefix: '整部作品' },
      { scope: 'chapter', id: chapter.id, prefix: '本章' },
    ]
      .filter((s) => s.id)
      .map((s) => ({
        key: s.scope,
        label: s.prefix,
        children: EXPORT_FORMATS.map((f) => ({
          key: `${s.scope}:${f.ext}`,
          label: f.label,
          onClick: () =>
            window.open(`/api/export/${s.scope}/${s.id}/${f.ext}`, '_blank'),
        })),
      }));
  }, [chapter]);

  if (!chapter) {
    const hasChapters = (chapters || []).some((c) => c.work_id === work?.id);
    // 一本还没章节的书：第一屏就放一个能点的开始，不必去左栏找那行小字。
    const canCreate = Boolean(work) && !hasChapters;
    return (
      <EmptyState
        className="ct-empty-fill"
        text={canCreate ? '这本书还没有章节' : '从左侧选择一个章节开始写作'}
        action={
          canCreate ? (
            <Button type="primary" loading={creatingChapter} onClick={createFirstChapter}>
              新建第一章
            </Button>
          ) : null
        }
      />
    );
  }

  const wordCount = countBlockWords(blocks);

  return (
    <div className="ct-editor">
      {/* 章节头 */}
      <header className="ct-editor-head">
        <div className="ct-editor-head-row">
          <Input
            variant="borderless"
            className="ct-chapter-title"
            defaultValue={chapter.title}
            // 标题是非受控输入（打字时不回写 state，避免每次按键重渲染）。
            // key 里带上标题：从章节树改名后 store 里的标题变了，
            // 这里若不重挂载，屏幕上还是旧字，直到切章才刷新。
            key={`${chapter.id}:${chapter.title}`}
            onBlur={(e) => {
              const title = e.target.value.trim();
              if (!title || title === chapter.title) return;
              // 走 store：章节树与标题栏读同一份状态，改完两边一起变
              renameChapter(chapter.id, title);
            }}
          />

          <Space size={6} wrap className="ct-editor-tools">
            <span className="ct-wordcount">
              <b className="ct-wordcount-num">{wordCount}</b>{' '}
              <em>字</em>
              {wordCount >= 10000 ? <em>（{formatWords(wordCount)}）</em> : null}
            </span>
            <span className={`ct-save-state is-${saveStatus || 'idle'}`}>
              {SAVE_LABEL[saveStatus] || SAVE_LABEL.idle}
            </span>
            <span className="ct-tool-sep" />
            <Tooltip title="撤销（⌘Z）">
              <Button
                size="small"
                type="text"
                icon={<UndoOutlined />}
                disabled={!past.length}
                onClick={undo}
              />
            </Tooltip>
            <Tooltip title="重做（⌘⇧Z）">
              <Button
                size="small"
                type="text"
                icon={<RedoOutlined />}
                disabled={!future.length}
                onClick={redo}
              />
            </Tooltip>

            {/* 历史版本、保存、导出都是偶尔用一次的动作，收进「⋯」；
                章节头只留「保存态」这行文字常驻，作者随时知道稿子落没落库。 */}
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: [
                  {
                    key: 'history',
                    icon: <HistoryOutlined />,
                    label: '历史版本',
                    onClick: () => setHistoryOpen(true),
                  },
                  {
                    key: 'save',
                    icon: <SaveOutlined />,
                    label: '立即保存',
                    onClick: handleSaveNow,
                  },
                  {
                    key: 'export',
                    icon: <DownloadOutlined />,
                    label: '导出',
                    children: exportMenuItems,
                  },
                ],
              }}
            >
              <Button
                size="small"
                type="text"
                icon={<MoreOutlined />}
                title="更多（历史版本 / 保存 / 导出）"
                aria-label="更多章节操作"
              />
            </Dropdown>

            {/* 专注模式入口。
                放在最右：它属于「视图」类动作，跟「编辑」类动作
                （撤销/重做/保存/导出）分开。 */}
            {!isNarrow && (
              <Tooltip title={focusMode ? '退出专注模式（Esc）' : '专注模式（⌘.）'}>
                <Button
                  size="small"
                  type="text"
                  icon={focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                  onClick={focusMode ? exitFocus : enterFocus}
                  aria-label={focusMode ? '退出专注模式' : '进入专注模式'}
                />
              </Tooltip>
            )}
          </Space>
        </div>

        {/* 动作条固定在章节头：不再跟着光标飘、不压正文。
            没选中文字时连槽位内容一起不渲染；槽位本身保留高度，
            出现/消失时章节头不伸缩，正文第一行不会上下跳。 */}
        <div className="ct-editor-actions">
          {selectedChars > 0 ? (
            <BlockToolbar
              selectedChars={selectedChars}
              onRun={runInline}
              onClose={() => dispatch({ type: 'selection/set', selection: null })}
            />
          ) : retryable ? (
            /* 改写对照：新版已经落进正文，这里并排留一份原文供比对。
               默认原文/新版各折一行（共两行），长文可展开；
               入口只认写回后那段文字，正文一改或换章就自己消失。 */
            <div className="ct-compare" role="group" aria-label="改写对照">
              <div className="ct-compare-body">
                {retryable.mode !== 'append' && (
                  <div className="ct-compare-row">
                    <span className="ct-compare-tag">原文</span>
                    <span className={`ct-compare-text${compareOpen ? ' is-open' : ''}`}>
                      {inlineDiff
                        ? renderDiff(inlineDiff.beforeSegs, 'del')
                        : retryable.beforeText}
                    </span>
                  </div>
                )}
                <div className="ct-compare-row">
                  <span className="ct-compare-tag is-new">
                    {retryable.mode === 'append' ? '新增' : '新版'}
                  </span>
                  <span className={`ct-compare-text${compareOpen ? ' is-open' : ''}`}>
                    {inlineDiff ? renderDiff(inlineDiff.afterSegs, 'add') : retryable.text}
                  </span>
                </div>
              </div>

              <div className="ct-compare-acts">
                {compareLong && (
                  <button
                    type="button"
                    className="ct-inline-btn is-quiet"
                    onClick={() => setCompareOpen((v) => !v)}
                  >
                    {compareOpen ? '收起' : '展开'}
                  </button>
                )}
                <button
                  type="button"
                  className="ct-inline-btn"
                  onClick={undoInline}
                  title="还原改写前的原文"
                >
                  还原原文
                </button>
                <button
                  type="button"
                  className={`ct-inline-btn${retrying ? ' is-busy' : ''}`}
                  onClick={retryInline}
                  disabled={retrying}
                  title={`再用「${retryLabel}」改一次`}
                >
                  <span className="ct-inline-label">再来一次</span>
                  {retrying && (
                    <span className="ct-inline-loading" aria-hidden="true">
                      <Spin size="small" />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="ct-inline-btn"
                  onClick={() => setLastInline(null)}
                  title="保留新版，收起对照"
                >
                  用新版
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {/* 审稿定位条：正文滚走以后，这条仍然告诉作者
          「现在核对的是第几条、落在哪一句」，点一下能再滚回去。
          整段级意见（原文对不上、退化成整段）在这里明确标注。 */}
      {activeFinding && (
        <div
          className={`ct-finding-focus-bar${
            activeFinding.precision === 'block' ? ' is-block-level' : ''
          }`}
        >
          <span className="ct-finding-focus-no">{activeFinding.marker}</span>
          <span className="ct-finding-focus-text">
            {activeFinding.precision === 'block' ? (
              <>
                整段级意见
                {activeFinding.reason
                  ? ` · ${REASON_LABEL[activeFinding.reason] || activeFinding.reason}`
                  : ''}
                {activeFinding.quote ? `：${activeFinding.quote}` : ''}
              </>
            ) : (
              <>原文：{activeFinding.quote}</>
            )}
          </span>
          <button
            type="button"
            className="ct-finding-focus-action"
            onClick={refocusFinding}
          >
            回到该句
          </button>
          <button
            type="button"
            className="ct-finding-focus-close"
            onClick={() => setActiveFindingKey('')}
            aria-label="关闭审稿定位"
            title="关闭定位"
          >
            ×
          </button>
        </div>
      )}

      {/* 卡片定位提示条。作者从左侧点了某张卡后，得知道"现在标的是谁、
          本章有没有"，否则正文突然一片黄会让人莫名其妙。 */}
      {cardHighlight && (
        <div className="ct-card-highlight-bar">
          <span>
            正在标出「{cardHighlight.label || cardHighlight.words.join('、')}」
            {cardHitBlocks > 0 && `　本章 ${cardHitBlocks} 段`}
          </span>
          <button
            type="button"
            className="ct-card-highlight-close"
            onClick={() => emitCardHighlight({ words: [] })}
          >
            取消标黄
          </button>
        </div>
      )}

      {/* 正文区。
          格线只画在内容块这一层：块高都是 34px 的整数倍，格线正好收在
          最后一行下面。挂在滚动容器上时，格子会一直铺到容器边缘，
          最后一条被裁在半格中间，就成了一条时有时无、位置随内容浮动的横线。 */}
      <div ref={editorRef} className="ct-editor-scroll">
        <div className="ct-editor-body">
          <div className="ct-editor-blocks ct-ruled">
            {blocks.map((block, index) => (
              <Block
                key={block.id}
                block={block}
                index={index}
                total={blocks.length}
                isActive={activeBlockId === block.id}
                highlightWords={cardHighlight?.words || null}
                findings={findingsByBlock.get(block.id) || []}
                activeFindingKey={activeFindingKey}
                focusSeq={findingFocusSeq}
                onFindingClick={focusFinding}
                onFocus={() => setActiveBlockId(block.id)}
                onChange={(patch) => handleBlockChange(block.id, patch)}
                onSelect={handleSelect}
                onDelete={() => handleDelete(block.id)}
                onMove={(offset) => handleMove(block.id, offset)}
                onConvert={(id, type) => handleConvert(id, type)}
              />
            ))}
          </div>

          <BlockPalette onAdd={(type) => handleAdd(type)} />
        </div>
      </div>

      <VersionHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}
