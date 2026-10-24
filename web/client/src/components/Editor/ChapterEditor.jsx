import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Space, message, Modal, Input, Tooltip } from 'antd';
import { SaveOutlined, UndoOutlined, RedoOutlined, HistoryOutlined } from '@ant-design/icons';
import { useWorkspace } from '../../store/workspace';
import { createBlock } from './blocks';
import { countBlockWords, formatWords } from '../../utils/wordCount';
import Block from './Block';
import BlockPalette from './BlockPalette';
import BlockToolbar from './BlockToolbar';
import VersionHistoryPanel from './VersionHistoryPanel';
import ExportButton from '../ExportButton';
import EmptyState from '../EmptyState';
import { useIsMobile } from '../../hooks/useMediaQuery';

// 保存状态对应的提示文案。状态来自 store，与真实落库进度一致。
const SAVE_LABEL = {
  idle: '已保存',
  dirty: '编辑中…',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
};

/**
 * 章节块编辑器。
 *
 * 数据流：store.blocks 是唯一权威 → 本地编辑即时反映 → 800ms 防抖落库。
 */
export default function ChapterEditor() {
  const {
    chapter,
    blocks,
    selection,
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
  } = useWorkspace();

  const [activeBlockId, setActiveBlockId] = useState(null);
  const [toolbarPos, setToolbarPos] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef(null);
  const isMobile = useIsMobile();

  // 选区变化时，计算工具条的浮层位置
  useEffect(() => {
    if (!selection) {
      setToolbarPos(null);
      return;
    }
    const el = document.querySelector(`[data-block-id="${selection.blockId}"]`);
    if (!el) {
      setToolbarPos(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const host = editorRef.current?.getBoundingClientRect();
    if (!host) return;

    setToolbarPos({
      top: rect.top - host.top - 40,
      left: Math.max(0, rect.left - host.left + 40),
    });
  }, [selection]);

  // 点击编辑区空白处收起工具条
  useEffect(() => {
    const onClick = (e) => {
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
    <div className="ct-editor">
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

        {toolbarPos && (
          <BlockToolbar
            selection={selection}
            position={toolbarPos}
            onRun={runInline}
            onClose={() => dispatch({ type: 'selection/set', selection: null })}
          />
        )}
      </div>

      <VersionHistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </div>
  );
}
