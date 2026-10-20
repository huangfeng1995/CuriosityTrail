import React, { useEffect, useState } from 'react';
import {
  Layout,
  theme,
  Button,
  ConfigProvider,
  Typography,
  Spin,
  App as AntApp,
} from 'antd';
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  LogOut,
  Library,
  Feather,
} from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/auth';
import { WorkspaceProvider } from './store/workspace';
import Login from './pages/Login';
import Works from './pages/Works';
import Workspace from './pages/Workspace';
import Materials from './pages/Materials';
import SettingsPage from './pages/SettingsPage';

const { Header, Content } = Layout;
const { Title } = Typography;

const scholarlyLightTheme = {
  token: {
    colorPrimary: '#3b6ea5',
    colorPrimaryHover: '#4d80b7',
    colorPrimaryActive: '#2d5888',
    colorBgBase: '#fefefe',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f7f8fa',
    colorText: '#111827',
    colorTextSecondary: '#6b7280',
    colorTextPlaceholder: '#9ca3af',
    colorBorder: '#e5e7eb',
    colorBorderSecondary: '#f3f4f6',
    borderRadius: 8,
    borderRadiusSM: 6,
    borderRadiusLG: 12,
    colorSuccess: '#10b981',
    colorWarning: '#d97706',
    colorError: '#ef4444',
    colorInfo: '#3b82f6',
  },
};

const scholarlyDarkTheme = {
  token: {
    colorPrimary: '#60a5fa',
    colorPrimaryHover: '#93c5fd',
    colorPrimaryActive: '#3b82f6',
    colorBgBase: '#111827',
    colorBgContainer: '#1f2937',
    colorBgElevated: '#374151',
    colorBgLayout: '#0f172a',
    colorText: '#f9fafb',
    colorTextSecondary: '#9ca3af',
    colorTextPlaceholder: '#6b7280',
    colorBorder: '#374151',
    colorBorderSecondary: '#1f2937',
    borderRadius: 8,
    borderRadiusSM: 6,
    borderRadiusLG: 12,
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',
    colorInfo: '#60a5fa',
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

  const navItems = [
    { key: '/works', icon: <Feather size={16} />, label: '作品' },
    { key: '/materials', icon: <Library size={16} />, label: '素材库' },
    { key: '/settings', icon: <SettingsIcon size={16} />, label: '设置' },
  ];

  // 工作区自己占满整屏，不需要顶部导航
  const isWorkspace = location.pathname.startsWith('/works/');

  if (checking) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDark ? '#0f172a' : '#f7f8fa',
        }}
      >
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
    <Layout style={{ minHeight: '100vh', background: isDark ? '#0f172a' : '#f7f8fa' }}>
      <Header
        style={{
          padding: '0 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          background: isDark ? '#1f2937' : '#ffffff',
          borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
          height: 56,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            cursor: 'pointer',
            flex: 1,
            minWidth: 0,
          }}
          onClick={() => navigate('/works')}
        >
          <span style={{ fontSize: 20 }}>✍️</span>
          <Title
            level={4}
            style={{
              margin: 0,
              color: isDark ? '#f9fafb' : '#111827',
              fontSize: 17,
              fontWeight: 700,
              fontFamily: 'Noto Serif SC, serif',
            }}
          >
            Curiosity
          </Title>
        </div>

        {!isWorkspace && (
          <div style={{ display: 'flex', gap: 4 }}>
            {navItems.map((item) => (
              <Button
                key={item.key}
                type="text"
                size="small"
                icon={item.icon}
                onClick={() => navigate(item.key)}
                style={{
                  color:
                    location.pathname === item.key
                      ? isDark
                        ? '#60a5fa'
                        : '#3b6ea5'
                      : isDark
                        ? '#9ca3af'
                        : '#6b7280',
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
        )}

        <Button
          type="text"
          icon={isDark ? <Sun size={16} /> : <Moon size={16} />}
          onClick={() => setIsDark(!isDark)}
          style={{ color: isDark ? '#9ca3af' : '#6b7280' }}
        />
        <Button
          type="text"
          icon={<LogOut size={16} />}
          onClick={logout}
          style={{ color: isDark ? '#9ca3af' : '#6b7280' }}
        />
      </Header>

      <Content style={{ height: 'calc(100vh - 56px)', overflow: 'auto' }}>
        <Routes>
          <Route
            path="/works"
            element={
              <div style={{ padding: '28px 24px' }}>
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
              <div style={{ padding: '28px 24px' }}>
                <Materials />
              </div>
            }
          />
          <Route
            path="/settings"
            element={
              <div style={{ padding: '28px 24px' }}>
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
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        ...(isDark ? scholarlyDarkTheme : scholarlyLightTheme),
      }}
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
