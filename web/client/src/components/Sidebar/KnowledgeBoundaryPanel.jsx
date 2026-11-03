import React, { useEffect, useState } from 'react';
import { Button, Empty, Spin, message } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

const BUCKETS = [
  { key: 'known', label: '已知' },
  { key: 'partial', label: '半知' },
  { key: 'suspects', label: '怀疑' },
  { key: 'unknown', label: '未知' },
];

/**
 * 本章知情边界（只读）。
 *
 * 给作者核对用：编辑第 N 章时，AI 看到的边界是「第 N 章开写前」的状态，
 * 也就是 chapter_seq <= N-1。这里不提供编辑，避免作者手改边界——
 * 要改就走待确认队列，或者回正文重写。
 */
export default function KnowledgeBoundaryPanel({ workId, chapter, templateEnabled }) {
  const navigate = useNavigate();
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!templateEnabled || !workId || !chapter?.id) {
      setView(null);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .get(`/pipeline/${workId}/knowledge/boundary`, {
        params: { chapterId: chapter.id },
      })
      .then((res) => {
        if (alive) setView(res.data);
      })
      .catch((e) => {
        if (alive) message.error(e.response?.data?.error || '知情边界加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workId, chapter?.id, templateEnabled]);

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  if (!templateEnabled) {
    return (
      <div className="ct-panel">
        <p className="ct-hint">
          未启用历史悬疑模板。到「作品」面板把创作模板设为「历史悬疑」后，这里会显示本章知情边界。
        </p>
      </div>
    );
  }

  if (!chapter) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一章" />;
  }

  return (
    <div className="ct-panel">
      <div className="ct-boundary-note">
        <EyeOutlined />
        <span>
          只读：第 {chapter.seq} 章开写前，AI 看到的边界（第 {chapter.seq - 1} 章结束时生效）
        </span>
      </div>

      {loading && (
        <div className="ct-loading">
          <Spin size="small" />
        </div>
      )}

      {!loading && view && view.characters.length === 0 && (
        <p className="ct-hint">还没有人物。先建人物卡，知情边界才有对象。</p>
      )}

      {!loading &&
        view?.characters.map((character) => (
          <div key={character.id} className="ct-boundary-card">
            <div className="ct-boundary-name">{character.name}</div>
            {BUCKETS.filter((bucket) => character[bucket.key].length > 0).map((bucket) => (
              <div key={bucket.key} className={`ct-boundary-line is-${bucket.key}`}>
                <span className="ct-boundary-label">{bucket.label}</span>
                <span className="ct-boundary-facts">
                  {character[bucket.key]
                    .map((fact) => `${fact.label}（${fact.title || '无标题'}）`)
                    .join('、')}
                </span>
              </div>
            ))}
            {BUCKETS.every((bucket) => character[bucket.key].length === 0) && (
              <p className="ct-hint">还没有事实单元。</p>
            )}
          </div>
        ))}

      <Button
        size="small"
        block
        onClick={() => navigate(`/works/${workId}/pipeline?tab=pending`)}
      >
        有待确认的知情变化？去确认
      </Button>
    </div>
  );
}
