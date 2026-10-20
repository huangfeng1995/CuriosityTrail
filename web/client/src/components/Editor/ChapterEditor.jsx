import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Typography, Button, Space, message, Modal, Input } from 'antd';
import { DownloadOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { useWorkspace } from '../../store/workspace';
import { createBlock, countChars } from './blocks';
import Block from './Block';
import BlockPalette from './BlockPalette';
import BlockToolbar from './BlockToolbar';

const { Title, Text } = Typography;

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
    setBlocks,
    updateBlock,
    insertBlock,
    removeBlock,
    convertBlock,
    moveBlock,
    dispatch,
  } = useWorkspace();

  const [activeBlockId, setActiveBlockId] = useState(null);
  const [toolbarPos, setToolbarPos] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [saveHint, setSaveHint] = useState('');
  const editorRef = useRef(null);

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

  const pushUndo = useCallback(() => {
    setUndoStack((stack) => [...stack.slice(-9), blocks.map((b) => ({ ...b }))]);
  }, [blocks]);

  const handleBlockChange = useCallback(
    (id, patch) => {
      updateBlock(id, patch);
      setSaveHint('编辑中…');
    },
    [updateBlock]
  );

  const handleDelete = useCallback(
    (id) => {
      pushUndo();
      removeBlock(id);
    },
    [pushUndo, removeBlock]
  );

  const handleMove = useCallback(
    (id, offset) => {
      pushUndo();
      moveBlock(id, offset);
    },
    [pushUndo, moveBlock]
  );

  const handleConvert = useCallback(
    (id, type) => {
      pushUndo();
      convertBlock(id, type);
      setSaveHint('已转换');
    },
    [pushUndo, convertBlock]
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
          pushUndo();
          const next =
            target.content.slice(0, selection.start) +
            data.content +
            target.content.slice(selection.end);
          updateBlock(target.id, { content: next });
          setSaveHint('已改写');
        } else if (data.action === 'append' && data.content) {
          pushUndo();
          updateBlock(target.id, {
            content: target.content + data.content,
          });
          setSaveHint('已续写');
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
    [blocks, chapter, pushUndo, selection, updateBlock]
  );

  const handleUndo = useCallback(() => {
    setUndoStack((stack) => {
      if (!stack.length) return stack;
      const prev = stack[stack.length - 1];
      setBlocks(prev);
      return stack.slice(0, -1);
    });
  }, [setBlocks]);

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
      setSaveHint('已保存');
    } catch (e) {
      message.error(e.message);
    }
  }, [blocks, chapter]);

  if (!chapter) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.5,
        }}
      >
        <Text type="secondary">从左侧选择一个章节开始写作</Text>
      </div>
    );
  }

  const wordCount = countChars(
    blocks.map((b) => b.content).join('')
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* 章节头 */}
      <div
        style={{
          padding: '20px 40px 0',
          borderBottom: '1px solid rgba(128,128,128,0.15)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            marginBottom: 12,
          }}
        >
          <Input
            variant="borderless"
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
            style={{
              fontSize: 20,
              fontWeight: 600,
              padding: 0,
              fontFamily: 'Noto Serif SC, serif',
            }}
          />

          <Space size={8}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {wordCount} 字{saveHint ? ` · ${saveHint}` : ''}
            </Text>
            <Button
              size="small"
              icon={<UndoOutlined />}
              disabled={!undoStack.length}
              onClick={handleUndo}
            >
              撤销
            </Button>
            <Button size="small" icon={<SaveOutlined />} onClick={handleSaveNow}>
              保存
            </Button>
            <Button
              size="small"
              icon={<DownloadOutlined />}
              href={`/api/export/chapter/${chapter.id}/markdown`}
            >
              导出
            </Button>
          </Space>
        </div>
      </div>

      {/* 正文区 */}
      <div
        ref={editorRef}
        style={{ flex: 1, overflowY: 'auto', position: 'relative', padding: '24px 40px 80px' }}
      >
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
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
    </div>
  );
}
