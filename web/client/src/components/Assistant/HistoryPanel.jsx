import React, { useCallback, useEffect, useState } from 'react';
import { Drawer, Button, Spin } from 'antd';
import { History, Plus } from 'lucide-react';
import EmptyState from '../EmptyState';

/**
 * 历史对话。
 *
 * 只负责「列出 / 选中」：消息的加载与状态切换放在侧边栏里做，
 * 这里不碰 workspace，免得一个展示组件掌握会话切换的副作用。
 */
export default function HistoryPanel({
  open,
  onClose,
  workId,
  currentId,
  busy,
  onSelect,
  onNew,
}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!workId) {
      setItems([]);
      return;
    }

    setLoading(true);
    setError('');
    try {
      const res = await fetch(
        `/api/ai/conversations?workId=${encodeURIComponent(workId)}`,
        { credentials: 'include' }
      );
      const data = await res.json().catch(() => []);
      if (!res.ok) {
        throw new Error(data.error || '加载失败');
      }
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message || '加载失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [workId]);

  // 每次打开都重新拉：抽屉关着的时候作者还在对话，列表必须是最新的
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const formatTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={420}
      title={
        <span className="ct-history-title">
          <History size={15} />
          历史对话
        </span>
      }
      extra={
        <Button
          size="small"
          icon={<Plus size={13} />}
          onClick={onNew}
        >
          新对话
        </Button>
      }
    >
      {loading ? (
        <div className="ct-loading">
          <Spin />
        </div>
      ) : error ? (
        <EmptyState className="ct-empty-pad" text={`加载失败：${error}`} />
      ) : !items.length ? (
        <EmptyState
          className="ct-empty-pad"
          text="还没有历史对话。和 AI 说过的话会出现在这里。"
        />
      ) : (
        <div className="ct-history-list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`ct-history-item${item.id === currentId ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => onSelect(item.id)}
            >
              <div className="ct-history-item-head">
                <span className="ct-history-item-title">{item.title}</span>
                <span className="ct-history-item-time">{formatTime(item.updatedAt)}</span>
              </div>
              {item.preview && (
                <div className="ct-history-item-preview">{item.preview}</div>
              )}
              <div className="ct-history-item-meta">{item.messageCount} 条消息</div>
            </button>
          ))}
        </div>
      )}
    </Drawer>
  );
}
