import React, { useEffect, useState } from 'react';
import { Tabs, Drawer, Button, Spin } from 'antd';
import { useParams, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../store/workspace';
import ChapterEditor from '../components/Editor/ChapterEditor';
import AssistantSidebar from '../components/Assistant/Sidebar';
import WorkTree from '../components/Sidebar/WorkTree';
import CharacterPanel from '../components/Sidebar/CharacterPanel';
import SettingPanel from '../components/Sidebar/SettingPanel';
import WorkInfoPanel from '../components/Sidebar/WorkInfoPanel';
import InspirationPanel from '../components/Sidebar/InspirationPanel';
import PlotCardPanel from '../components/Sidebar/PlotCardPanel';
import ProgressPanel from '../components/Sidebar/ProgressPanel';
import ConsistencyPanel from '../components/Sidebar/ConsistencyPanel';

/**
 * 三栏工作区。
 *
 * 左：作品章节树 + 人物卡 + 设定
 * 中：块编辑器
 * 右：AI 侧边栏
 */
export default function Workspace() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { work, chapters, chapter, loadWork, loadChapter } = useWorkspace();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 992);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 作品切换时加载作品与章节
  useEffect(() => {
    if (!workId) return;
    loadWork(workId);
  }, [workId, loadWork]);

  // 作品加载完自动选中第一章
  useEffect(() => {
    if (!workId) return;
    if (!chapter && chapters.length) {
      loadChapter(chapters[0].id);
    }
  }, [workId, chapters, chapter, loadChapter]);

  const leftPanel = (
    <>
      <WorkTree
        currentWorkId={work?.id}
        currentChapterId={chapter?.id}
      />
      <div style={{ height: 1, background: 'rgba(128,128,128,0.15)', margin: '4px 0' }} />
      <Tabs
        size="small"
        defaultActiveKey="characters"
        items={[
          {
            key: 'characters',
            label: '人物',
            children: <CharacterPanel workId={work?.id} />,
          },
          {
            key: 'settings',
            label: '设定',
            children: <SettingPanel workId={work?.id} />,
          },
          {
            key: 'plot',
            label: '情节',
            children: <PlotCardPanel workId={work?.id} chapters={chapters} />,
          },
          {
            key: 'progress',
            label: '进度',
            children: (
              <ProgressPanel
                workId={work?.id}
                work={work}
                onWorkChanged={() => loadWork(work.id)}
              />
            ),
          },
          {
            key: 'check',
            label: '检查',
            children: <ConsistencyPanel workId={work?.id} />,
          },
          {
            key: 'work',
            label: '作品',
            children: (
              <WorkInfoPanel
                work={work}
                onSaved={() => loadWork(work.id)}
              />
            ),
          },
          {
            key: 'inspirations',
            label: '灵感',
            children: <InspirationPanel />,
          },
        ]}
      />
    </>
  );

  if (!workId) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <span style={{ fontSize: 40, opacity: 0.3 }}>📖</span>
        <span style={{ opacity: 0.6 }}>从左侧选一个作品，或新建一个开始写</span>
        <Button type="primary" onClick={() => navigate('/works')}>
          查看作品列表
        </Button>
      </div>
    );
  }

  if (!work) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (isMobile) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid rgba(128,128,128,0.15)',
          }}
        >
          <Button size="small" onClick={() => setLeftOpen(true)}>
            目录
          </Button>
          <span style={{ flex: 1, fontSize: 13, opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {work.title}
            {chapter ? ` · ${chapter.title}` : ''}
          </span>
          <Button size="small" onClick={() => setRightOpen(true)}>
            AI
          </Button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          <ChapterEditor />
        </div>

        <Drawer
          open={leftOpen}
          onClose={() => setLeftOpen(false)}
          placement="left"
          width={280}
          title="目录"
        >
          {leftPanel}
        </Drawer>

        <Drawer
          open={rightOpen}
          onClose={() => setRightOpen(false)}
          placement="right"
          width={340}
          title="AI 助手"
        >
          <div style={{ height: '100%' }}>
            <AssistantSidebar />
          </div>
        </Drawer>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        gridTemplateColumns: '260px minmax(0, 1fr) 340px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          borderRight: '1px solid rgba(128,128,128,0.15)',
          overflowY: 'auto',
        }}
      >
        {leftPanel}
      </div>

      <div style={{ overflow: 'hidden', minWidth: 0 }}>
        <ChapterEditor />
      </div>

      <div
        style={{
          borderLeft: '1px solid rgba(128,128,128,0.15)',
          overflow: 'hidden',
        }}
      >
        <AssistantSidebar />
      </div>
    </div>
  );
}
