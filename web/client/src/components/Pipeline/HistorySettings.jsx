import React, { useEffect, useMemo, useState } from 'react';
import { Empty, Select, Spin, Tabs, message } from 'antd';
import api from '../../api/client';
import AnchorLibrary from './AnchorLibrary';
import PendingQueue from './PendingQueue';
import KnowledgeBoundaryPanel from '../Sidebar/KnowledgeBoundaryPanel';

/**
 * 设置页里的「历史悬疑」分区。
 *
 * 锚点库、待确认、知情边界都收在这里：写作页不再挂任何常驻面板。
 * 页面本身只做三件事——看、确认、撤回。
 */
export default function HistorySettings({ initialWorkId }) {
  const [works, setWorks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workId, setWorkId] = useState(initialWorkId || '');
  const [chapters, setChapters] = useState([]);
  const [chapterId, setChapterId] = useState('');
  const [tab, setTab] = useState('anchors');

  useEffect(() => {
    let alive = true;
    api
      .get('/works')
      .then((res) => {
        if (!alive) return;
        const list = (res.data || []).filter((w) => w.template === 'history_thriller');
        setWorks(list);
        if (!initialWorkId && list.length) setWorkId(list[0].id);
      })
      .catch(() => message.error('作品列表加载失败'))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialWorkId]);

  useEffect(() => {
    if (!workId) {
      setChapters([]);
      setChapterId('');
      return;
    }
    let alive = true;
    api
      .get(`/works/${workId}`)
      .then((res) => {
        if (!alive) return;
        const list = res.data?.chapters || [];
        setChapters(list);
        // 默认看最新一章：作者最可能在这里核对边界
        setChapterId((prev) => {
          if (prev && list.some((c) => c.id === prev)) return prev;
          return list.length ? list[list.length - 1].id : '';
        });
      })
      .catch(() => message.error('章节加载失败'));
    return () => {
      alive = false;
    };
  }, [workId]);

  const chapter = useMemo(
    () => chapters.find((c) => c.id === chapterId) || null,
    [chapters, chapterId]
  );

  if (loading) {
    return (
      <div className="ct-loading">
        <Spin />
      </div>
    );
  }

  if (!works.length) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="还没有启用「历史悬疑」模板的作品。到作品面板开启后，锚点库、待确认与知情边界会出现在这里。"
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>作品</span>
        <Select
          value={workId}
          onChange={setWorkId}
          style={{ minWidth: 220 }}
          options={works.map((w) => ({ value: w.id, label: w.title }))}
        />
        <span className="ct-hint" style={{ margin: 0 }}>
          这些内容偶尔配置一次，所以放在设置里；写作页只留一行边界提示。
        </span>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'anchors',
            label: '锚点库',
            children: <AnchorLibrary workId={workId} />,
          },
          {
            key: 'pending',
            label: '待确认',
            children: <PendingQueue workId={workId} />,
          },
          {
            key: 'boundary',
            label: '知情边界',
            children: (
              <div style={{ maxWidth: 640 }}>
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>章节</span>
                  <Select
                    value={chapterId}
                    onChange={setChapterId}
                    style={{ minWidth: 240 }}
                    placeholder="选择章节"
                    options={chapters.map((c) => ({
                      value: c.id,
                      label: `第 ${c.seq} 章 · ${c.title || '未命名'}`,
                    }))}
                  />
                </div>
                <KnowledgeBoundaryPanel
                  workId={workId}
                  chapter={chapter}
                  templateEnabled
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
