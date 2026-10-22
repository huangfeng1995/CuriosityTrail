import React, { useEffect, useState } from 'react';
import { Button, Empty, Input, message, Spin, Modal } from 'antd';
import { PlusOutlined, BookOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import ExportButton from '../components/ExportButton';
import { useIsMobile } from '../hooks/useMediaQuery';

/**
 * 作品列表页。
 */
export default function Works() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
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
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">我的作品</h2>
          <p className="ct-page-sub">选择一部作品开始写作</p>
        </div>
        <span style={{ flex: 1 }} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          新建作品
        </Button>
      </div>

      {works.length === 0 ? (
        <div className="ct-empty-stage" style={{ height: 'auto', paddingTop: 72 }}>
          <span className="ct-empty-mark font-serif" aria-hidden="true">
            寻
          </span>
          <p className="ct-empty-text">还没有作品。点右上角新建一个，开始你的第一本书。</p>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新建作品
          </Button>
        </div>
      ) : (
        <div className="ct-shelf">
          {works.map((work) => (
            <article
              key={work.id}
              className="ct-book"
              onClick={() => navigate(`/works/${work.id}`)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate(`/works/${work.id}`);
                }
              }}
            >
              {/* 书脊 */}
              <span className="ct-book-spine" aria-hidden="true" />

              <div className="ct-book-body">
                <div className="ct-book-title font-serif">{work.title}</div>
                {work.synopsis && (
                  <p className="ct-book-synopsis">{work.synopsis}</p>
                )}
                <div className="ct-book-meta">
                  <BookOutlined aria-hidden="true" />
                  <span>{work.chapter_count} 章</span>
                  {work.genre && <span>· {work.genre}</span>}
                  <span style={{ flex: 1 }} />
                  <span onClick={(e) => e.stopPropagation()}>
                    <ExportButton scope="work" id={work.id} size="small" />
                  </span>
                </div>
              </div>
            </article>
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
