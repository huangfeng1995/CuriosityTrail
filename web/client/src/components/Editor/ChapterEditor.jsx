import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Space, message, Modal, Input, Tooltip, Dropdown } from 'antd';
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
import { createBlock, countChars } from './blocks';
import { collectCriticFindings } from '../Assistant/findings';
import { countBlockWords, formatWords } from '../../utils/wordCount';
import Block from './Block';
import BlockPalette from './BlockPalette';
import BlockToolbar from './BlockToolbar';
import VersionHistoryPanel from './VersionHistoryPanel';
import EmptyState from '../EmptyState';
import { useIsNarrow } from '../../hooks/useMediaQuery';
import {
  CARD_HIGHLIGHT_EVENT,
  emitCardHighlight,
} from '../Sidebar/useCardOccurrences';

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
    renameChapter,
  } = useWorkspace();

  const [activeBlockId, setActiveBlockId] = useState(null);
  const [activeFindingKey, setActiveFindingKey] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  // 侧栏选了某张人物卡 / 设定卡时，正文里命中的块整块标黄。
  // 纯视图状态：换章、关面板、换作品都靠事件清掉，不落库。
  const [cardHighlight, setCardHighlight] = useState(null);
  const pendingCardBlockRef = useRef(null);
  const editorRef = useRef(null);
  // 选区所在块的类型：工具条据此决定「标记」能不能用、当前类型那一项是否置灰。
  const selectedBlockType = selection
    ? blocks.find((b) => b.id === selection.blockId)?.type
    : '';
  // 动作条显示的字数：只报选中的字数。没选中时动作条置灰，不显示数字。
  const selectedChars = countChars(selection?.text || '');
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

        dispatch({ type: 'selection/set', selection: null });
      } catch (e) {
        message.error(e.message || 'AI 调用失败');
      }
    },
    [blocks, chapter, selection, updateBlock, dispatch]
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
    return (
      <EmptyState className="ct-empty-fill" text="从左侧选择一个章节开始写作" />
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
            没选中文字时整条置灰；选中后显示「已选 N 字」并只作用于那一段。 */}
        <div className="ct-editor-actions">
          <BlockToolbar
            hasSelection={selectedChars > 0}
            selectedChars={selectedChars}
            blockType={selectedBlockType}
            onRun={runInline}
            onMark={handleMark}
            onClose={() => dispatch({ type: 'selection/set', selection: null })}
          />
        </div>
      </header>

      {/* 卡片定位提示条。作者从左侧点了某张卡后，得知道"现在标的是谁、
          本章有没有"，否则正文突然一片黄会让人莫名其妙。 */}
      {cardHighlight && (
        <div className="ct-card-highlight-bar">
          <span>
            正在标出「{cardHighlight.label || cardHighlight.words.join('、')}」
            {cardHitBlocks > 0 ? `　本章 ${cardHitBlocks} 段` : '　本章没有出现'}
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
              highlightWords={cardHighlight?.words || null}
              findings={findingsByBlock.get(block.id) || []}
              activeFindingKey={activeFindingKey}
              onFindingClick={focusFinding}
              onFocus={() => setActiveBlockId(block.id)}
              onChange={(patch) => handleBlockChange(block.id, patch)}
              onSelect={handleSelect}
              onDelete={() => handleDelete(block.id)}
              onMove={(offset) => handleMove(block.id, offset)}
              onConvert={(id, type) => handleConvert(id, type)}
            />
          ))}

          <BlockPalette onAdd={(type) => handleAdd(type)} />
        </div>
      </div>

      <VersionHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}
