import React, { useEffect, useState } from 'react';
import { Button, Card, Empty, Input, message, Spin, Modal } from 'antd';
import { PlusOutlined, BookOutlined, DownloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';

/**
 * 作品列表页。
 */
export default function Works() {
  const navigate = useNavigate();
  const [works, setWorks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/works');
      setWorks(res.data);
    } catch (e) {
      message.error('作品列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!title.trim()) return;
    try {
      const res = await api.post('/works', { title: title.trim() });
      setCreating(false);
      setTitle('');
      navigate(`/works/${res.data.id}`);
    } catch (e) {
      message.error(e.response?.data?.error || '创建失败');
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: 24,
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontFamily: 'Noto Serif SC, serif' }}>我的作品</h2>
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
            选择一部作品开始写作
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          新建作品
        </Button>
      </div>

      {works.length === 0 ? (
        <Empty description="还没有作品。点右上角新建一个。" />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 16,
          }}
        >
          {works.map((work) => (
            <Card
              key={work.id}
              hoverable
              onClick={() => navigate(`/works/${work.id}`)}
              styles={{ body: { padding: 18 } }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <BookOutlined style={{ fontSize: 18, opacity: 0.5 }} />
                <span style={{ fontSize: 16, fontWeight: 600, fontFamily: 'Noto Serif SC, serif' }}>
                  {work.title}
                </span>
              </div>
              {work.synopsis && (
                <div
                  style={{
                    fontSize: 13,
                    opacity: 0.7,
                    lineHeight: 1.7,
                    marginBottom: 10,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {work.synopsis}
                </div>
              )}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 12,
                  opacity: 0.5,
                }}
              >
                {work.chapter_count} 章
                {work.genre ? ` · ${work.genre}` : ''}
                <span style={{ flex: 1 }} />
                <Button
                  type="text"
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(`/api/export/work/${work.id}/markdown`, '_blank');
                  }}
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        title="新建作品"
        okText="创建"
        cancelText="取消"
        onOk={create}
        onCancel={() => setCreating(false)}
      >
        <Input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onPressEnter={create}
          placeholder="书名"
        />
      </Modal>
    </div>
  );
}
