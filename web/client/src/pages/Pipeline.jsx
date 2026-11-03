import React, { useEffect, useState } from 'react';
import { Button, Empty, Spin } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/client';
import AnchorLibrary from '../components/Pipeline/AnchorLibrary';
import PendingQueue from '../components/Pipeline/PendingQueue';

/**
 * 历史悬疑流水线的作者页。
 *
 * 锚点库放在独立页面而不是左栏：候选卡片要同时展示出处、卷次与原文摘录，
 * 260px 的侧栏放不下，作者也就没法核对「这条到底有没有出处」。
 */
export default function Pipeline() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(searchParams.get('tab') === 'pending' ? 'pending' : 'anchors');
  const [work, setWork] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    api
      .get(`/works/${workId}`)
      .then((res) => {
        if (alive) setWork(res.data);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workId]);

  const back = () => navigate(`/works/${workId}`);

  if (loading) {
    return (
      <div className="ct-loading">
        <Spin size="large" />
      </div>
    );
  }

  if (failed || !work) {
    return (
      <Empty description="作品打不开：可能已被删除，或链接不对">
        <Button onClick={() => navigate('/works')}>返回作品列表</Button>
      </Empty>
    );
  }

  if (work.template !== 'history_thriller') {
    return (
      <div className="ct-pipeline">
        <div className="ct-page-head">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={back}>
            返回工作区
          </Button>
        </div>
        <Empty description="这部作品没有启用历史悬疑模板">
          <Button type="primary" onClick={back}>
            去「作品」面板开启
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div className="ct-pipeline">
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">{work.title} · 锚点库</h2>
          <p className="ct-page-sub">整理史实候选，逐条核对后入库；锚点启用后才会进入正文约束</p>
        </div>
        <span style={{ flex: 1 }} />
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={back}>
          返回工作区
        </Button>
      </div>

      <div className="ct-pipeline-tabs" role="tablist" aria-label="历史悬疑工具">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'anchors'}
          className={`ct-pipeline-tab${tab === 'anchors' ? ' is-active' : ''}`}
          onClick={() => setTab('anchors')}
        >
          锚点库
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pending'}
          className={`ct-pipeline-tab${tab === 'pending' ? ' is-active' : ''}`}
          onClick={() => setTab('pending')}
        >
          待确认
        </button>
      </div>

      {tab === 'anchors' ? (
        <AnchorLibrary workId={work.id} />
      ) : (
        <PendingQueue workId={work.id} />
      )}
    </div>
  );
}
