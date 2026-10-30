import React, { useEffect, useState } from 'react';
import {
  Layout,
  theme,
  Button,
  ConfigProvider,
  Spin,
  App as AntApp,
} from 'antd';
import { Sun, Moon, Settings as SettingsIcon, LogOut, Library, Feather, Palette } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/auth';
import { WorkspaceProvider } from './store/workspace';
import { useIsMobile } from './hooks/useMediaQuery';
import Login from './pages/Login';
import Works from './pages/Works';
import Workspace from './pages/Workspace';
import Materials from './pages/Materials';
import StylePage from './pages/Style';
import SettingsPage from './pages/SettingsPage';
import BrandLogo from './components/BrandLogo';

const { Header, Content } = Layout;

/**
 * antd 主题 token。
 *
 * 颜色一律引用 theme.css 里的语义变量（CSS 变量能穿透 antd 的主题计算，
 * 换肤时只改一处）。这里只定义 antd 特有的形状类 token。
 */
const baseTheme = {
  token: {
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
    borderRadius: 6,
    borderRadiusSM: 4,
    borderRadiusLG: 8,
    controlHeight: 32,
    fontSize: 14,
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: 'transparent',
      bodyBg: 'transparent',
      headerHeight: 52,
      headerPadding: '0 16px',
    },
    Card: {
      headerBg: 'transparent',
    },
    Tabs: {
      titleFontSize: 13,
      horizontalItemPadding: '8px 0',
      horizontalItemGutter: 18,
    },
    Button: {
      fontWeight: 500,
      defaultShadow: 'none',
      primaryShadow: 'none',
    },
    Modal: {
      titleFontSize: 16,
    },
    Input: {
      paddingBlock: 5,
    },
  },
};

/**
 * 未登录时把当前路径记下来，登录后跳回去。
 */
function RedirectToLogin() {
  const location = useLocation();
  return <Navigate to="/login" state={{ from: location.pathname }} replace />;
}

/**
 * 已登录后的应用外壳。
 */
function AppShell({ isDark, setIsDark }) {
  const { authenticated, checking, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();

  const navItems = [
    { key: '/works', icon: <Feather size={15} />, label: '作品' },
    { key: '/materials', icon: <Library size={15} />, label: '素材库' },
    { key: '/style', icon: <Palette size={15} />, label: '文风' },
    { key: '/settings', icon: <SettingsIcon size={15} />, label: '设置' },
  ];

  // 工作区自己占满整屏，不需要顶部导航
  const isWorkspace = location.pathname.startsWith('/works/');

  useEffect(() => {
    // 主题写到 html 上，theme.css 里的变量才能切
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }, [isDark]);

  if (checking) {
    return (
      <div className="ct-boot">
        <Spin size="large" />
      </div>
    );
  }

  // 未登录时不显示应用外壳，登录页自带整屏布局
  if (!authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<Login isDark={isDark} />} />
        <Route path="*" element={<RedirectToLogin />} />
      </Routes>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--bg-layout)' }}>
      <Header className="ct-topbar">
        <div className="ct-brand" onClick={() => navigate('/works')}>
          <BrandLogo size={26} />
          <span className="ct-brand-name font-serif">寻迹</span>
        </div>

        {!isWorkspace && (
          <nav className="ct-nav">
            {navItems.map((item) => (
              <button
                key={item.key}
                className={`ct-nav-item${location.pathname === item.key ? ' is-active' : ''}`}
                onClick={() => navigate(item.key)}
              >
                {item.icon}
                {!isMobile && <span>{item.label}</span>}
              </button>
            ))}
          </nav>
        )}

        <div className="ct-topbar-right">
          <Button
            type="text"
            className="ct-icon-btn"
            icon={isDark ? <Sun size={16} /> : <Moon size={16} />}
            onClick={() => setIsDark(!isDark)}
            title={isDark ? '切到日间' : '切到夜间'}
          />
          <Button
            type="text"
            className="ct-icon-btn"
            icon={<LogOut size={16} />}
            onClick={logout}
            title="退出登录"
          />
        </div>
      </Header>

      <Content style={{ height: 'calc(100vh - 52px)', overflow: 'auto' }}>
        <Routes>
          <Route
            path="/works"
            element={
              <div className="ct-page">
                <Works />
              </div>
            }
          />
          <Route
            path="/works/:workId"
            element={
              <WorkspaceProvider>
                <Workspace />
              </WorkspaceProvider>
            }
          />
          <Route
            path="/materials"
            element={
              <div className="ct-page">
                <Materials />
              </div>
            }
          />
          <Route
            path="/style"
            element={
              <div className="ct-page">
                <StylePage />
              </div>
            }
          />
          <Route
            path="/settings"
            element={
              <div className="ct-page">
                <SettingsPage />
              </div>
            }
          />
          <Route path="*" element={<Navigate to="/works" replace />} />
        </Routes>
      </Content>
    </Layout>
  );
}

function App() {
  // 默认宣纸浅色：长时间写作浅底更省眼
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    if (saved) setIsDark(saved === 'dark');
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <ConfigProvider
      // 关掉 antd 的「两字按钮自动插空格」：它会把「保存」渲染成「保 存」，
      // 中文字体里这个空格让字距突变，视觉上像两个字挤在一起。
      button={{ autoInsertSpace: false }}
      theme={{ ...baseTheme, algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <AntApp>
        <BrowserRouter>
          <AuthProvider>
            <AppShell isDark={isDark} setIsDark={setIsDark} />
          </AuthProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  );
}

export default App;
