import React, { useEffect, useRef, useCallback } from 'react';
import { Typography } from 'antd';
import { DeleteOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons';

const { Text } = Typography;

/**
 * 单个块。
 *
 * 编辑用 textarea 而非 contentEditable：选区位置（selectionStart/selectionEnd）
 * 拿得到，行内 AI 工具条才好定位；contentEditable 拿不到稳定的字符偏移。
 */

/**
 * textarea 随内容自动增高。
 */
function useAutoHeight(value) {
  const ref = useRef(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  return ref;
}

export default function Block({
  block,
  index,
  total,
  isActive,
  onChange,
  onFocus,
  onSelect,
  onDelete,
  onMove,
}) {
  const textRef = useAutoHeight(block.content);

  const handleSelect = (e) => {
    const el = e.target;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) return;
    onSelect({
      blockId: block.id,
      start,
      end,
      text: el.value.slice(start, end),
    });
  };

  const renderBody = () => {
    switch (block.type) {
      case 'scene_break':
        return (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 0',
              cursor: 'default',
            }}
          >
            <div style={{ flex: 1, height: 1, background: 'currentColor', opacity: 0.2 }} />
            <Text style={{ letterSpacing: 6, opacity: 0.5, fontSize: 13 }}>※　※　※</Text>
            <div style={{ flex: 1, height: 1, background: 'currentColor', opacity: 0.2 }} />
          </div>
        );

      case 'dialogue':
        return (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <input
              value={block.speaker || ''}
              placeholder="说话人"
              onChange={(e) => onChange({ speaker: e.target.value })}
              onFocus={onFocus}
              style={{
                flex: '0 0 96px',
                border: '1px solid rgba(128,128,128,0.25)',
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 14,
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
              }}
            />
            <textarea
              ref={textRef}
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              onSelect={handleSelect}
              placeholder="台词…"
              style={{
                flex: 1,
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                fontSize: 16,
                lineHeight: 1.9,
                fontFamily: 'Noto Serif SC, serif',
                minHeight: 32,
                padding: 0,
              }}
            />
          </div>
        );

      case 'inner':
        return (
          <textarea
            ref={textRef}
            value={block.content}
            onChange={(e) => onChange({ content: e.target.value })}
            onFocus={onFocus}
            onSelect={handleSelect}
            placeholder="心理描写…"
            style={{
              width: '100%',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              outline: 'none',
              resize: 'none',
              fontSize: 15,
              lineHeight: 1.9,
              fontStyle: 'italic',
              opacity: 0.92,
              fontFamily: 'Noto Serif SC, serif',
              minHeight: 32,
              padding: 0,
            }}
          />
        );

      case 'image':
        return (
          <div>
            {block.url && (
              <img
                src={block.url}
                alt={block.content || block.fileName || '插图'}
                style={{
                  maxWidth: '100%',
                  borderRadius: 8,
                  marginBottom: 8,
                  display: 'block',
                }}
              />
            )}
            <textarea
              ref={textRef}
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              placeholder="图注，或用工具栏上传插图…"
              style={{
                width: '100%',
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
                resize: 'none',
                fontSize: 14,
                lineHeight: 1.7,
                minHeight: 28,
                padding: 0,
              }}
            />
          </div>
        );

      case 'setting_ref':
        return (
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px dashed rgba(128,128,128,0.4)',
              fontSize: 14,
            }}
          >
            <span style={{ opacity: 0.55 }}>设定</span>
            <input
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              placeholder="引用的设定名"
              style={{
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
                fontSize: 14,
                flex: 1,
                minWidth: 120,
              }}
            />
          </div>
        );

      default:
        return (
          <textarea
            ref={textRef}
            value={block.content}
            onChange={(e) => onChange({ content: e.target.value })}
            onFocus={onFocus}
            onSelect={handleSelect}
            placeholder="正文…"
            style={{
              width: '100%',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              outline: 'none',
              resize: 'none',
              fontSize: 16,
              lineHeight: 1.95,
              fontFamily: 'Noto Serif SC, serif',
              minHeight: 32,
              padding: 0,
            }}
          />
        );
    }
  };

  return (
    <div
      data-block-id={block.id}
      style={{
        position: 'relative',
        padding: '6px 0',
        borderRadius: 6,
        background: isActive ? 'rgba(59,110,165,0.05)' : 'transparent',
        transition: 'background 0.15s ease',
      }}
    >
      {renderBody()}

      {/* 悬停时出现的管理按钮 */}
      <div
        style={{
          position: 'absolute',
          top: 2,
          right: -76,
          display: 'flex',
          gap: 2,
          opacity: 0.35,
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = 1)}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = 0.35)}
      >
        <button
          title="上移"
          disabled={index === 0}
          onClick={() => onMove(-1)}
          style={iconButtonStyle(index === 0)}
        >
          <ArrowUpOutlined style={{ fontSize: 12 }} />
        </button>
        <button
          title="下移"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
          style={iconButtonStyle(index === total - 1)}
        >
          <ArrowDownOutlined style={{ fontSize: 12 }} />
        </button>
        <button title="删除" onClick={onDelete} style={iconButtonStyle(false)}>
          <DeleteOutlined style={{ fontSize: 12 }} />
        </button>
      </div>
    </div>
  );
}

function iconButtonStyle(disabled) {
  return {
    border: '1px solid rgba(128,128,128,0.25)',
    background: 'transparent',
    color: 'inherit',
    borderRadius: 4,
    width: 24,
    height: 24,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.3 : 1,
    padding: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  };
}
