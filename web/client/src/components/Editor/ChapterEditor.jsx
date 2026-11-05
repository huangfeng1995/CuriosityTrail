import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button, Space, message, Modal, Input, Tooltip } from 'antd';
import { SaveOutlined, UndoOutlined, RedoOutlined, HistoryOutlined } from '@ant-design/icons';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { useFocus } from '../../store/focus';
import { createBlock } from './blocks';
import { collectCriticFindings } from '../Assistant/findings';
import { countBlockWords, formatWords } from '../../utils/wordCount';
import { getTextareaSelectionRect, placeSelectionToolbar } from '../../utils/selectionRect';
import Block from './Block';
import BlockPalette from './BlockPalette';
import BlockToolbar from './BlockToolbar';
import VersionHistoryPanel from './VersionHistoryPanel';
import ExportButton from '../ExportButton';
import EmptyState from '../EmptyState';
import { useIsNarrow } from '../../hooks/useMediaQuery';

// 保存状态对应的提示文案。状态来自 store，与真实落库进度一致。
const SAVE_LABEL = {
  idle: '已保存',
  dirty: '编辑中…',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};

// 位置没变就不要 setState，否则滚动时每一帧都重渲染整段正文。
function sameToolbarPos(a, b) {
  if (!a || !b) return a === b;
  return (
    a.top === b.top &&
    a.left === b.left &&
    a.clamped === b.clamped &&
    a.ready === b.ready &&
    a.visible === b.visible &&
    a.menuUp === b.menuUp
  );
}

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
    updateBlock,
    insertBlock,
    removeBlock,
    convertBlock,
    markBlock,
    moveBlock,
    undo,
    redo,
    past,
    future,
    saveStatus,
    dispatch,
  } = useWorkspace();

  const [activeBlockId, setActiveBlockId] = useState(null);
  const [activeFindingKey, setActiveFindingKey] = useState('');
  const [toolbarPos, setToolbarPos] = useState(null);
  // 工具条的实际尺寸：按钮增减、窄屏折行都会变，位置要按真实尺寸算。
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 0 });
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef(null);
  // 工具条挂在 .ct-editor 上（不随正文滚动），坐标以它为原点。
  const frameRef = useRef(null);
  const toolbarRef = useRef(null);
  const toolbarRoRef = useRef(null);
  // 选区所在块的类型：工具条据此决定「标记」能不能用、当前类型那一项是否置灰。
  const selectedBlockType = selection
    ? blocks.find((b) => b.id === selection.blockId)?.type
    : '';
  // 放不下三栏时（工作区改成抽屉布局）没有侧栏可藏，专注模式不成立。
  const isNarrow = useIsNarrow();
  const { focusMode, enterFocus, exitFocus } = useFocus();

  // 审稿意见的锚点每次渲染按当前正文实时算，不落库。
  // 只把可定位的挂到块上；未定位的留在侧栏标「全章建议」。
  const findingsByBlock = useMemo(() => {
    const map = new Map();
    collectCriticFindings(messages, blocks).forEach((finding) => {
      if (finding.status !== 'located') return;
      if (!map.has(finding.blockId)) map.set(finding.blockId, []);
      map.get(finding.blockId).push(finding);
    });
    return map;
  }, [messages, blocks]);

  // 侧栏点一条意见 → 滚到正文对应块并高亮。
  useEffect(() => {
    const onFocusBlock = (e) => {
      const detail = e.detail || {};
      setActiveFindingKey(detail.findingKey || '');
      const el = editorRef.current?.querySelector(`[data-block-id="${detail.blockId}"]`);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    window.addEventListener('ct:focus-block', onFocusBlock);
    return () => window.removeEventListener('ct:focus-block', onFocusBlock);
  }, []);

  /** 正文沟槽点序号 → 选中该条意见并让侧栏滚过去。 */
  const focusFinding = useCallback((finding) => {
    setActiveFindingKey(finding.key);
    window.dispatchEvent(
      new CustomEvent('ct:focus-finding', {
        detail: { messageId: finding.messageId, findingKey: finding.key },
      })
    );
  }, []);

  // 量工具条自身的实际尺寸。窄屏折行、块类型变化导致「标记」按钮增减时，
  // 高度都会变；定位必须按真实尺寸算，不能假设固定 33px。
  // 用回调 ref：工具条是按需挂载的，effect 依赖 selection 时会在「已选中但还没挂载」
  // 的那一帧错过它，导致尺寸一直是 0、工具条永远不显示。
  const bindToolbar = useCallback((el) => {
    if (toolbarRoRef.current) {
      toolbarRoRef.current.disconnect();
      toolbarRoRef.current = null;
    }
    toolbarRef.current = el;
    if (!el) return;
    const sync = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight };
      setToolbarSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    toolbarRoRef.current = ro;
  }, []);

  useEffect(
    () => () => {
      if (toolbarRoRef.current) toolbarRoRef.current.disconnect();
    },
    []
  );

  // 选区变化时，计算工具条的浮层位置
  //
  // 三件事必须对齐，否则工具条会「看着没反应」：
  //
  // 1) 贴的是选区，不是整块。工具条要浮在作者刚选中的那几行上方；
  //    贴整块的话，长段落里选中间几句，工具条会飘到段首，压住不相干的正文。
  //
  // 2) 工具条挂在 .ct-editor 上，而不是 .ct-editor-scroll 里。
  //    挂在滚动容器里看似省事，但绝对定位元素会一起被滚动，还会把自己
  //    算进 scrollHeight（工具条越靠下，滚动条越长），造成位置反馈漂移；
  //    挂在不滚动的外层，坐标只跟「可见窗口」有关，滚动时重算一次即可。
  //
  // 3) 选区滚出可视区就不显示，别贴边飘在无关正文上。
  //    上下都放不下时贴边夹取（见 placeSelectionToolbar）。
  const placeToolbar = useCallback(() => {
    if (!selection) return null;
    const host = editorRef.current;
    const frame = frameRef.current;
    const el = host?.querySelector(`[data-block-id="${selection.blockId}"]`);
    if (!host || !frame || !el) return null;

    const ta = el.querySelector('textarea');
    const selRect = ta
      ? getTextareaSelectionRect(ta, selection.start, selection.end)
      : null;

    // 量不到选区（少数字体/结构）就退回整块的位置，至少别不显示。
    const rect = selRect || el.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();

    // 统一换算成 .ct-editor 坐标：选区矩形、滚动区可见范围都在同一套坐标里。
    const viewport = {
      top: hostRect.top - frameRect.top,
      bottom: hostRect.bottom - frameRect.top,
      left: hostRect.left - frameRect.left,
      right: hostRect.right - frameRect.left,
    };
    const local = {
      top: rect.top - frameRect.top,
      bottom: rect.bottom - frameRect.top,
      left: rect.left - frameRect.left,
    };

    const pos = placeSelectionToolbar({
      selection: local,
      viewport,
      size: toolbarSize,
    });

    return {
      ...pos,
      ready: toolbarSize.height > 0,
      // 工具条离可视区下沿不足一个二级菜单的高度时，菜单改为向上展开，
      // 否则「换语气 / 标记」里的小菜单会被遮住，看得到点不到。
      menuUp:
        pos.visible &&
        toolbarSize.height > 0 &&
        pos.top + toolbarSize.height + 180 > viewport.bottom,
    };
  }, [selection, toolbarSize.width, toolbarSize.height]);

  const applyToolbarPos = useCallback(() => {
    const next = placeToolbar();
    setToolbarPos((prev) => (sameToolbarPos(prev, next) ? prev : next));
  }, [placeToolbar]);

  // 布局阶段算，赶在绘制之前落位；尺寸还没量到时先隐藏，避免露出一帧错误位置。
  useLayoutEffect(() => {
    if (!selection) {
      setToolbarPos(null);
      return;
    }
    applyToolbarPos();
  }, [applyToolbarPos, selection]);

  // 工具条不随内容滚动，正文一滚就要重算：选区跟着正文走，工具条跟着选区走。
  useEffect(() => {
    if (!selection) return undefined;
    const host = editorRef.current;
    if (!host) return undefined;
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(applyToolbarPos);
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener('scroll', onScroll);
    };
  }, [selection, applyToolbarPos]);

  // 窗口或栏宽变化：重新夹取，避免工具条被挤出可视区。
  useEffect(() => {
    if (!selection) return undefined;
    const host = editorRef.current;
    if (!host) return undefined;
    const ro = new ResizeObserver(applyToolbarPos);
    ro.observe(host);
    window.addEventListener('resize', applyToolbarPos);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', applyToolbarPos);
    };
  }, [selection, applyToolbarPos]);

  // 点击编辑区空白处收起工具条
  useEffect(() => {
    const onClick = (e) => {
      // 工具条已经挪到 .ct-editor 外层（不再被正文滚动带走），
      // 点它时必须单独豁免，否则 mousedown 会先清空选区、按钮的 click 来不及执行。
      if (toolbarRef.current && toolbarRef.current.contains(e.target)) return;
      if (editorRef.current && !editorRef.current.contains(e.target)) {
        dispatch({ type: 'selection/set', selection: null });
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
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
   * 行内标记：把选区标成正文 / 对白 / 独白。
   *
   * 拆块逻辑在 store 里，这里只负责把选区坐标递过去再收起工具条——
   * 标记完选区就失效了，留着工具条会让作者以为还能对旧选区继续操作。
   */
  const handleMark = useCallback(
    (type) => {
      if (!selection) return;
      markBlock(selection.blockId, selection.start, selection.end, type);
      dispatch({ type: 'selection/set', selection: null });
    },
    [selection, markBlock, dispatch]
  );

  /**
   * 行内 AI：拿回结构化结果后写回块内。
   * replace 替换选区，append 追加到块尾，其余按 comment 只展示不改稿。
   */
  const runInline = useCallback(
    async (action, instruction) => {
      if (!selection || !chapter) return;
      const target = blocks.find((b) => b.id === selection.blockId);
      if (!target) return;

      try {
        const res = await fetch('/api/ai/inline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action,
            instruction,
            selection: selection.text,
            blockId: selection.blockId,
            blocks,
            workId: chapter.work_id,
            chapterId: chapter.id,
            roleKey: action === 'critique' ? 'critic' : 'editor',
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');

        if (data.action === 'replace' && data.content) {
          const next =
            target.content.slice(0, selection.start) +
            data.content +
            target.content.slice(selection.end);
          updateBlock(target.id, { content: next });
        } else if (data.action === 'append' && data.content) {
          updateBlock(target.id, {
            content: target.content + data.content,
          });
        } else {
          // 建议类输出：只展示，不动稿
          Modal.info({
            title: data.reason || 'AI 的建议',
            content: (
              <div style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>
                {data.content}
              </div>
            ),
            okText: '知道了',
          });
        }
      } catch (e) {
        message.error(e.message || 'AI 调用失败');
      }
    },
    [blocks, chapter, selection, updateBlock]
  );

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

  if (!chapter) {
    return (
      <EmptyState className="ct-empty-fill" text="从左侧选择一个章节开始写作" />
    );
  }

  const wordCount = countBlockWords(blocks);

  return (
    <div ref={frameRef} className="ct-editor">
      {/* 章节头 */}
      <header className="ct-editor-head">
        <div className="ct-editor-head-row">
          <Input
            variant="borderless"
            className="ct-chapter-title"
            defaultValue={chapter.title}
            key={chapter.id}
            onBlur={(e) => {
              const title = e.target.value.trim();
              if (!title || title === chapter.title) return;
              fetch(`/api/chapters/${chapter.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ title }),
              });
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
            <Tooltip title="历史版本">
              <Button
                size="small"
                type="text"
                icon={<HistoryOutlined />}
                onClick={() => setHistoryOpen(true)}
              />
            </Tooltip>
            <Button size="small" icon={<SaveOutlined />} onClick={handleSaveNow}>
              保存
            </Button>
            <ExportButton scope="chapter" id={chapter.id} size="small" />

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
      </header>

      {/* 正文区 */}
      <div ref={editorRef} className="ct-editor-scroll ct-ruled">
        <div className="ct-editor-body">
          {blocks.map((block, index) => (
            <Block
              key={block.id}
              block={block}
              index={index}
              total={blocks.length}
              isActive={activeBlockId === block.id}
              findings={findingsByBlock.get(block.id) || []}
              activeFindingKey={activeFindingKey}
              onFindingClick={focusFinding}
              onFocus={() => setActiveBlockId(block.id)}
              onChange={(patch) => handleBlockChange(block.id, patch)}
              onSelect={(sel) => dispatch({ type: 'selection/set', selection: sel })}
              onDelete={() => handleDelete(block.id)}
              onMove={(offset) => handleMove(block.id, offset)}
              onConvert={(id, type) => handleConvert(id, type)}
            />
          ))}

          <BlockPalette onAdd={(type) => handleAdd(type)} />
        </div>
      </div>

      {/* 选区工具条挂在编辑器外层，不随正文滚动，也不进文档流、不占高度 */}
      {selection && toolbarPos && (
        <BlockToolbar
          selection={selection}
          blockType={selectedBlockType}
          position={toolbarPos}
          menuUp={toolbarPos?.menuUp}
          toolbarRef={bindToolbar}
          onRun={runInline}
          onMark={handleMark}
          onClose={() => dispatch({ type: 'selection/set', selection: null })}
        />
      )}

      <VersionHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}
