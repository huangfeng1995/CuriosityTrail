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
 *
 * 缩小高度必须先把高度归零再量 scrollHeight：高度留在原处时，
 * scrollHeight 至少等于当前高度，量不出"变小"的那部分。
 *
 * 但**光标在框里时绝不能归零**。元素瞬间变成 0 高，光标被裁掉，
 * 浏览器为了让光标可见会把可滚动祖先滚到底部——用户看到的就是
 * 「一打字就跳到最下面一行」。所以聚焦时只增不减：用 scrollHeight
 * 判断内容有没有超出当前高度，超出就长；收缩留到失焦后再做。
 *
 * 另外，换行数会随宽度和字体变化（拉分隔条、字体晚到），
 * 只在 value 变化时量一次的话，框会一直停留在旧高度。
 * 所以宽度一变也重量一次。
 */
function useAutoHeight(value) {
  const ref = useRef(null);

  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    if (el === document.activeElement) {
      // 只增不减：不归零，就不会惊动浏览器的"滚动到光标"。
      const needed = el.scrollHeight;
      if (needed > el.clientHeight) el.style.height = `${needed}px`;
      return;
    }

    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let lastWidth = el.clientWidth;
    const onWidthChange = () => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      resize();
    };

    // 观察自身宽度：分栏拖动、窗口缩放都会走到这里。
    // 高度变化不算——那是我们自己设的，不算"内容变了"。
    const ro = new ResizeObserver(onWidthChange);
    ro.observe(el);
    window.addEventListener('resize', onWidthChange);

    // 失焦时做一次完整测量，把聚焦期间"只增不减"留下的多余高度收掉。
    el.addEventListener('blur', resize);

    // 字体加载完成后换行数会变，重算一次
    document.fonts?.ready?.then(resize).catch(() => {});

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onWidthChange);
      el.removeEventListener('blur', resize);
    };
  }, [resize]);

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
              rows={1}
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
            rows={1}
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
              rows={1}
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
            rows={1}
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
