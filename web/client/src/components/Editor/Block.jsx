import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Upload, Button, Dropdown, message } from 'antd';
import {
  DeleteOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
  PictureOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { BLOCK_TYPES, BLOCK_TYPE_MAP } from './blocks';
import { useIsMobile } from '../../hooks/useMediaQuery';

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
  onConvert,
}) {
  const textRef = useAutoHeight(block.content);
  const [uploading, setUploading] = useState(false);
  const isMobile = useIsMobile();

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

  /**
   * 插图上传。图片落在服务器 data/uploads 下，块里只存相对 URL。
   */
  const uploadImage = async (file) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch('/api/upload/image', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '上传失败');
      onChange({ url: data.url, fileName: data.filename });
      message.success('插图已插入');
    } catch (e) {
      message.error(e.message || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const renderBody = () => {
    switch (block.type) {
      case 'scene_break':
        return (
          <div className="ct-scene-break">
            <span className="ct-scene-break-line" />
            <span className="ct-scene-break-mark">※　※　※</span>
            <span className="ct-scene-break-line" />
          </div>
        );

      case 'dialogue':
        return (
          <div className="ct-dialogue">
            <input
              value={block.speaker || ''}
              placeholder="说话人"
              onChange={(e) => onChange({ speaker: e.target.value })}
              onFocus={onFocus}
              className="ct-speaker"
            />
            <textarea
              ref={textRef}
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              onSelect={handleSelect}
              placeholder="台词…"
              className="ct-block-text ct-block-dialogue"
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
            className="ct-block-text ct-block-inner"
          />
        );

      case 'image':
        return (
          <div>
            {block.url ? (
              <div className="ct-figure">
                <img src={block.url} alt={block.content || block.fileName || '插图'} className="ct-figure-img" />
                <div className="ct-figure-actions">
                  <Upload
                    accept="image/*"
                    showUploadList={false}
                    withCredentials
                    customRequest={async ({ file, onSuccess, onError }) => {
                      try {
                        await uploadImage(file);
                        onSuccess?.();
                      } catch (e) {
                        onError?.(e);
                      }
                    }}
                  >
                    <Button size="small" icon={<SwapOutlined />} loading={uploading}>
                      换图
                    </Button>
                  </Upload>
                  <Button
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => onChange({ url: '', fileName: '' })}
                  >
                    移除
                  </Button>
                </div>
              </div>
            ) : (
              <Upload.Dragger
                accept="image/*"
                showUploadList={false}
                withCredentials
                disabled={uploading}
                customRequest={async ({ file, onSuccess, onError }) => {
                  try {
                    await uploadImage(file);
                    onSuccess?.();
                  } catch (e) {
                    onError?.(e);
                  }
                }}
                className="ct-upload-dragger"
              >
                <PictureOutlined style={{ fontSize: 22, opacity: 0.45 }} />
                <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
                  点击或拖拽图片到此处插入插图
                </div>
              </Upload.Dragger>
            )}
            <textarea
              ref={textRef}
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              placeholder="图注…"
              className="ct-block-text ct-block-caption"
            />
          </div>
        );

      case 'setting_ref':
        return (
          <div className="ct-setting-ref">
            <span className="ct-setting-ref-tag">设定</span>
            <input
              value={block.content}
              onChange={(e) => onChange({ content: e.target.value })}
              onFocus={onFocus}
              placeholder="引用的设定名"
              className="ct-setting-ref-input"
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
            className="ct-block-text ct-block-paragraph"
          />
        );
    }
  };

  const actions = (
    <>
      <Dropdown
        trigger={['click']}
        menu={{
          items: BLOCK_TYPES.map((t) => ({
            key: t.type,
            label: t.label,
            disabled: t.type === block.type,
            onClick: () => onConvert?.(block.id, t.type),
          })),
        }}
      >
        <button title="转为其他块类型" className="ct-block-btn" style={{ width: 32, fontSize: 11 }}>
          {BLOCK_TYPE_MAP.get(block.type)?.label || '?'}
        </button>
      </Dropdown>
      <button
        title="上移"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        className="ct-block-btn"
      >
        <ArrowUpOutlined style={{ fontSize: 12 }} />
      </button>
      <button
        title="下移"
        disabled={index === total - 1}
        onClick={() => onMove(1)}
        className="ct-block-btn"
      >
        <ArrowDownOutlined style={{ fontSize: 12 }} />
      </button>
      <button title="删除" onClick={onDelete} className="ct-block-btn is-danger">
        <DeleteOutlined style={{ fontSize: 12 }} />
      </button>
    </>
  );

  return (
    <div
      data-block-id={block.id}
      className={`ct-block${isActive ? ' is-active' : ''}`}
    >
      {renderBody()}

      {/* 块操作按钮。
          之前浮在正文右侧（right: -76px），会压到字、也会溢出到右栏。
          现在固定在正文栏左侧的预留沟里：hover 整块才出现，不占正文宽度。 */}
      {isMobile ? (
        <div className="ct-block-actions is-inline">{actions}</div>
      ) : (
        <div className="ct-block-actions">{actions}</div>
      )}
    </div>
  );
}
