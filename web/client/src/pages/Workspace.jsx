import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spin, App as AntApp } from 'antd';
import { Menu, PanelRight } from 'lucide-react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../store/workspace';
import { useFocus, ENTER_FOCUS_EVENT, EXIT_FOCUS_EVENT } from '../store/focus';
import ChapterEditor from '../components/Editor/ChapterEditor';
import AssistantSidebar from '../components/Assistant/Sidebar';
import EmptyState from '../components/EmptyState';
import Resizer from '../components/Resizer';
import { useIsNarrow } from '../hooks/useMediaQuery';
import useColumnWidths, { LIMITS } from '../hooks/useColumnWidths';
import { pendingActions } from '../components/Assistant/pendingActions';
import WorkTree from '../components/Sidebar/WorkTree';
import CharacterPanel from '../components/Sidebar/CharacterPanel';
import SettingPanel from '../components/Sidebar/SettingPanel';
import WorkInfoPanel from '../components/Sidebar/WorkInfoPanel';
import InspirationPanel from '../components/Sidebar/InspirationPanel';
import PlotCardPanel from '../components/Sidebar/PlotCardPanel';
import ProgressPanel from '../components/Sidebar/ProgressPanel';
import ConsistencyPanel from '../components/Sidebar/ConsistencyPanel';
import PanelNav from '../components/Sidebar/PanelNav';
import KnowledgeBoundaryPanel from '../components/Sidebar/KnowledgeBoundaryPanel';

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
  const [searchParams] = useSearchParams();
  const { work, chapters, chapter, messages, sending, loadWork, loadChapter } = useWorkspace();
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [panelKey, setPanelKey] = useState('characters');
  const isMobile = useIsNarrow();
  const { widths, collapsed, setLeft, setRight, reset, toggleLeft, toggleRight } = useColumnWidths();
  const { focusMode, setFocusMode, setCurrentWorkId } = useFocus();
  const { message: toast } = AntApp.useApp();

  // 专注模式是覆盖层，不碰 collapsed。
  // collapsed 是作者平时的折叠偏好（持久化在 localStorage），
  // 专注模式进出不该污染它——退出后作者自己的折叠状态原样回来。
  const hideLeft = focusMode || collapsed.left;
  const hideRight = focusMode || collapsed.right;

  // 「去看看」：展开右栏，再让侧栏滚到那张待确认的卡片。
  const goToPending = useCallback(() => {
    if (collapsed.right) toggleRight();
    window.dispatchEvent(new CustomEvent('ct:scroll-to-pending'));
  }, [collapsed.right, toggleRight]);

  // 进入 / 退出专注模式的提示。
  //
  // 提示放在这里而不是 FocusProvider：判断「有几条 AI 建议还没确认」
  // 需要 messages，而 messages 在 workspace context 里——
  // FocusProvider 包在它外面，读不到。
  useEffect(() => {
    const onEnter = () => {
      setFocusMode(true);
      toast.info('已进入专注模式，Esc 退出', 1.5);
    };

    const onExit = () => {
      const pending = pendingActions(messages);
      if (pending.length > 0) {
        toast.info({
          content: (
            <span>
              AI 有 {pending.length} 条建议还没处理
              <Button size="small" type="link" onClick={goToPending}>
                去看看
              </Button>
            </span>
          ),
          duration: 3,
        });
      } else if (sending) {
        toast.info('AI 还在写，完成后会留在右侧等你确认', 3);
      }
      setFocusMode(false);
    };

    window.addEventListener(ENTER_FOCUS_EVENT, onEnter);
    window.addEventListener(EXIT_FOCUS_EVENT, onExit);
    return () => {
      window.removeEventListener(ENTER_FOCUS_EVENT, onEnter);
      window.removeEventListener(EXIT_FOCUS_EVENT, onExit);
    };
  }, [messages, sending, goToPending, setFocusMode, toast]);

  // 桌面端折叠快捷键：⌘/Ctrl + \ 收右栏，⌘/Ctrl + Shift + \ 收左栏。
  // 移动端是抽屉布局，没有可收的两栏；专注模式里两栏已被盖住，
  // 这时按键不该顺手改掉作者平时的折叠偏好。
  useEffect(() => {
    if (isMobile || focusMode) return;
    const onKeyDown = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '\\') return;
      e.preventDefault();
      if (e.shiftKey) toggleLeft();
      else toggleRight();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobile, focusMode, toggleLeft, toggleRight]);

  // 登记当前作品，让 FocusProvider 能判断「是不是换作品了」。
  //
  // 「换作品就退出专注模式」这个判断放在 FocusProvider 里：
  // 它在路由之上，工作区卸载重挂都不会丢状态。
  // 放在这里用组件内的 ref 记上次作品 id 是没用的——
  // 离开工作区再进来是全新挂载，ref 的初值就是新作品 id，永远「没变过」。
  useEffect(() => {
    setCurrentWorkId(workId || null);
    return () => setCurrentWorkId(null);
  }, [workId, setCurrentWorkId]);

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

  // 从待确认列表「定位」过来时带 ?chapter=<id>：只认第一次，
  // 之后作者自己点章节树不能被这个参数拽回去。
  const deepLinkChapter = searchParams.get('chapter');
  const deepLinkApplied = useRef(false);
  useEffect(() => {
    deepLinkApplied.current = false;
  }, [workId]);

  // 作品加载完自动选中第一章
  useEffect(() => {
    if (!workId) return;
    if (!deepLinkApplied.current && deepLinkChapter) {
      if (chapters.some((c) => c.id === deepLinkChapter)) {
        deepLinkApplied.current = true;
        if (chapter?.id !== deepLinkChapter) loadChapter(deepLinkChapter);
        return;
      }
    }
    if (!chapter && chapters.length) {
      loadChapter(chapters[0].id);
    }
  }, [workId, chapters, chapter, loadChapter, deepLinkChapter]);

  // 当前面板内容。key 变化时用 key 强制重挂载，配合 CSS 做淡入过渡。
  const panelContent = {
    characters: <CharacterPanel workId={work?.id} />,
    settings: <SettingPanel workId={work?.id} />,
    plot: <PlotCardPanel workId={work?.id} chapters={chapters} />,
    progress: (
      <ProgressPanel workId={work?.id} work={work} onWorkChanged={() => loadWork(work.id)} />
    ),
    check: <ConsistencyPanel workId={work?.id} />,
    knowledge: (
      <KnowledgeBoundaryPanel
        workId={work?.id}
        chapter={chapter}
        templateEnabled={work?.template === 'history_thriller'}
      />
    ),
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
    <div className={`ct-workspace${focusMode ? ' is-focus' : ''}`}>
      {/*
        三栏一直渲染，用 data-hidden 控制显隐。
        不能用条件渲染（collapsed ? null : <aside>）——那会卸载
        AssistantSidebar，而它挂着 SSE 长连接，一卸载正在生成的 token 就丢了。
        作者正要让 AI 写一章，不能因为他自己进了专注模式把稿子弄丢。
      */}
      <aside
        className="ct-col-left"
        style={{ width: widths.left }}
        data-hidden={hideLeft ? 'true' : undefined}
      >
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
        hidden={hideLeft}
      />

      <main className="ct-col-center">
        <ChapterEditor />
      </main>

      <Resizer
        side="right"
        value={widths.right}
        min={LIMITS.right.min}
        max={LIMITS.right.max}
        onChange={setRight}
        onReset={() => reset('right')}
        onCollapse={toggleRight}
        hidden={hideRight}
      />

      <aside
        className={`ct-col-right${widths.right < 344 ? ' is-narrow' : ''}`}
        style={{ width: widths.right }}
        data-hidden={hideRight ? 'true' : undefined}
      >
        <AssistantSidebar />
      </aside>

      {/* 展开条：栏收起时露出来。专注模式里藏掉——
          它本来就是「这里能展开侧栏」的入口，专注模式不该有。 */}
      <button
        type="button"
        className="ct-col-toggle is-left"
        data-hidden={!collapsed.left || focusMode ? 'true' : undefined}
        onClick={toggleLeft}
        title={'展开左栏（目录与资料） · ⌘/Ctrl+Shift+\\'}
        aria-label="展开左栏"
      >
        ›
      </button>

      <button
        type="button"
        className="ct-col-toggle is-right"
        data-hidden={!collapsed.right || focusMode ? 'true' : undefined}
        onClick={toggleRight}
        title={'展开右栏（AI 助手） · ⌘/Ctrl+\\'}
        aria-label="展开右栏"
      >
        ‹
      </button>
    </div>
  );
}
