import React, { useEffect, useState } from 'react';
import { Button, Spin } from 'antd';
import { Menu, PanelRight } from 'lucide-react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../store/workspace';
import ChapterEditor from '../components/Editor/ChapterEditor';
import AssistantSidebar from '../components/Assistant/Sidebar';
import EmptyState from '../components/EmptyState';
import Resizer from '../components/Resizer';
import useColumnWidths, { LIMITS } from '../hooks/useColumnWidths';
import WorkTree from '../components/Sidebar/WorkTree';
import CharacterPanel from '../components/Sidebar/CharacterPanel';
import SettingPanel from '../components/Sidebar/SettingPanel';
import WorkInfoPanel from '../components/Sidebar/WorkInfoPanel';
import InspirationPanel from '../components/Sidebar/InspirationPanel';
import PlotCardPanel from '../components/Sidebar/PlotCardPanel';
import ProgressPanel from '../components/Sidebar/ProgressPanel';
import ConsistencyPanel from '../components/Sidebar/ConsistencyPanel';
import PanelNav from '../components/Sidebar/PanelNav';

/**
 * 三栏工作区。
 *
 * 左：作品章节树 + 资料面板（人物/设定/情节/进度/检查/作品/灵感）
 * 中：块编辑器
 * 右：AI 侧边栏
 */
export default function Workspace() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const { work, chapters, chapter, loadWork, loadChapter } = useWorkspace();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [panelKey, setPanelKey] = useState('characters');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 992);
  const { widths, collapsed, setLeft, setRight, reset, toggleLeft, toggleRight } = useColumnWidths();

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 992);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 作品加载结果：loading / ready / failed
  //
  // 光看 work 是不是 null 分不清"还在加载"和"加载失败"——两种情况
  // 都渲染成同一个转圈。作品被删、链接里的 id 不对、登录过期，
  // 作者就会一直等下去，还看不到任何原因。
  const [loadState, setLoadState] = useState('loading');
  // 点「重试」时加一，用作重新拉取的触发键
  const [reloadKey, setReloadKey] = useState(0);

  // 作品切换时加载作品与章节
  useEffect(() => {
    if (!workId) return;
    let alive = true;
    setLoadState('loading');
    loadWork(workId).then((loaded) => {
      if (!alive) return;
      setLoadState(loaded ? 'ready' : 'failed');
    });
    return () => {
      alive = false;
    };
  }, [workId, loadWork, reloadKey]);

  // 作品加载完自动选中第一章
  useEffect(() => {
    if (!workId) return;
    if (!chapter && chapters.length) {
      loadChapter(chapters[0].id);
    }
  }, [workId, chapters, chapter, loadChapter]);

  // 当前面板内容。key 变化时用 key 强制重挂载，配合 CSS 做淡入过渡。
  const panelContent = {
    characters: <CharacterPanel workId={work?.id} />,
    settings: <SettingPanel workId={work?.id} />,
    plot: <PlotCardPanel workId={work?.id} chapters={chapters} />,
    progress: (
      <ProgressPanel workId={work?.id} work={work} onWorkChanged={() => loadWork(work.id)} />
    ),
    check: <ConsistencyPanel workId={work?.id} />,
    work: <WorkInfoPanel work={work} onSaved={() => loadWork(work.id)} />,
    inspirations: <InspirationPanel />,
  }[panelKey];

  const leftPanel = (
    <div className="ct-left-inner">
      <WorkTree currentWorkId={work?.id} currentChapterId={chapter?.id} />
      <div className="ct-divider" />
      <PanelNav activeKey={panelKey} onChange={setPanelKey} />
      <div className="ct-panel-body ct-panel-enter" key={panelKey}>
        {panelContent}
      </div>
    </div>
  );

  if (!workId) {
    return (
      <EmptyState
        className="ct-empty-fill"
        text="从左侧选一个作品，或新建一个开始写"
        action={
          <Button type="primary" onClick={() => navigate('/works')}>
            查看作品列表
          </Button>
        }
      />
    );
  }

  // 手里还没有这个作品：可能还在加载，也可能加载失败了。
  // 地址栏里的 id 和已加载的作品不一致时，也当没加载——否则从作品 A
  // 点进一个坏链接，页面上还会显示 A 的内容，看不出走错了。
  if (!work || work.id !== workId) {
    // 失败要说清楚为什么。作品被删、链接里的 id 不对、登录过期，
    // 这三种情况都只能等作者自己猜，不如直接给他两个出口。
    if (loadState === 'failed') {
      return (
        <EmptyState
          className="ct-empty-fill"
          text="这个作品打不开：可能已被删除，或链接里的地址不对"
          action={
            <>
              <Button type="primary" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </Button>
              <Button type="text" onClick={() => navigate('/works')}>
                返回作品列表
              </Button>
            </>
          }
        />
      );
    }

    return (
      <div className="ct-empty-stage">
        <Spin size="large" />
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="ct-workspace-mobile">
        <div className="ct-mobile-bar">
          <Button size="small" icon={<Menu size={14} />} onClick={() => setLeftOpen(true)}>
            目录
          </Button>
          <span className="ct-mobile-title">
            {work.title}
            {chapter ? ` · ${chapter.title}` : ''}
          </span>
          <Button size="small" icon={<PanelRight size={14} />} onClick={() => setRightOpen(true)}>
            AI
          </Button>
        </div>

        <div className="ct-mobile-editor">
          <ChapterEditor />
        </div>

        <div className="ct-drawer-host" data-open={leftOpen}>
          <div className="ct-drawer-scrim" onClick={() => setLeftOpen(false)} />
          <aside className="ct-drawer ct-drawer-left">
            <div className="ct-drawer-head">
              <span>目录与资料</span>
              <Button type="text" size="small" onClick={() => setLeftOpen(false)}>
                关闭
              </Button>
            </div>
            <div className="ct-drawer-body">{leftPanel}</div>
          </aside>
        </div>

        <div className="ct-drawer-host" data-open={rightOpen}>
          <div className="ct-drawer-scrim" onClick={() => setRightOpen(false)} />
          <aside className="ct-drawer ct-drawer-right">
            <div className="ct-drawer-head">
              <span>AI 助手</span>
              <Button type="text" size="small" onClick={() => setRightOpen(false)}>
                关闭
              </Button>
            </div>
            <div className="ct-drawer-body">
              <AssistantSidebar />
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="ct-workspace">
      {!collapsed.left ? (
        <>
          <aside className="ct-col-left" style={{ width: widths.left }}>
            {leftPanel}
          </aside>

          <Resizer
            side="left"
            value={widths.left}
            min={LIMITS.left.min}
            max={LIMITS.left.max}
            onChange={setLeft}
            onReset={() => reset('left')}
            onCollapse={toggleLeft}
          />
        </>
      ) : (
        <button
          type="button"
          className="ct-col-toggle is-left"
          onClick={toggleLeft}
          title="展开左栏（目录与资料）"
          aria-label="展开左栏"
        >
          ›
        </button>
      )}

      <main className="ct-col-center">
        <ChapterEditor />
      </main>

      {!collapsed.right ? (
        <>
          <Resizer
            side="right"
            value={widths.right}
            min={LIMITS.right.min}
            max={LIMITS.right.max}
            onChange={setRight}
            onReset={() => reset('right')}
            onCollapse={toggleRight}
          />

          <aside
            className={`ct-col-right${widths.right < 344 ? ' is-narrow' : ''}`}
            style={{ width: widths.right }}
          >
            <AssistantSidebar />
          </aside>
        </>
      ) : (
        <button
          type="button"
          className="ct-col-toggle is-right"
          onClick={toggleRight}
          title="展开右栏（AI 助手）"
          aria-label="展开右栏"
        >
          ‹
        </button>
      )}
    </div>
  );
}
