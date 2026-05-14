import React, { useState, useEffect } from 'react';
import { Layout, theme, Button, Input, ConfigProvider, Switch, Typography } from 'antd';
import { Sun, Moon, BookOpen, Settings as SettingsIcon } from 'lucide-react';
import {
  FileTextOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import Reports from './components/Reports';
import Documents from './components/Documents';
import Settings from './components/Settings';
import SearchBar from './components/SearchBar';

const { Header, Sider, Content } = Layout;
const { Title } = Typography;

const scholarlyLightTheme = {
  token: {
    colorPrimary: '#1e3a5f',
    colorPrimaryHover: '#2d4a6f',
    colorPrimaryActive: '#152c46',
    colorBgBase: '#fefefe',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBgLayout: '#f8f9fa',
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

function App() {
  const [current, setCurrent] = useState('reports');
  const [isDark, setIsDark] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 992);
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setIsDark(savedTheme === 'dark');
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  const menuItems = [
    { key: 'reports', icon: <FileTextOutlined size={20} />, label: '探索报告' },
    { key: 'documents', icon: <BookOpen size={20} />, label: '文献库' },
    { key: 'settings', icon: <SettingsIcon size={20} />, label: '系统设置' },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        ...(isDark ? scholarlyDarkTheme : scholarlyLightTheme),
      }}
    >
      <Layout style={{ minHeight: '100vh', backgroundColor: isDark ? '#0f172a' : '#f8f9fa' }}>
        {isMobile ? (
          <>
            <Header
              style={{
                padding: '0 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: isDark ? '#1f2937' : '#ffffff',
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                height: 64,
                boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(0,0,0,0.08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: isDark ? '#1e3a5f' : '#eef2ff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <span style={{ fontSize: 18 }}>🔬</span>
                </div>
                <div>
                  <Title level={4} style={{ 
                    margin: 0, 
                    color: isDark ? '#f9fafb' : '#111827',
                    fontSize: 18,
                    fontWeight: 700,
                    fontFamily: 'Noto Serif SC, serif',
                  }}>
                    Curiosity
                  </Title>
                  <div style={{ fontSize: 11, color: isDark ? '#6b7280' : '#9ca3af' }}>
                    科学探索记录
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <SearchBar 
                  value={searchText} 
                  onChange={setSearchText}
                  isDark={isDark}
                  mobile
                />
                <Button
                  type="text"
                  icon={isDark ? <Sun size={18} /> : <Moon size={18} />}
                  onClick={() => setIsDark(!isDark)}
                  style={{ color: isDark ? '#9ca3af' : '#6b7280' }}
                />
              </div>
            </Header>

            <Content
              style={{
                marginTop: 64,
                marginBottom: 70,
                padding: 16,
                background: isDark ? '#0f172a' : '#f8f9fa',
                minHeight: 'calc(100vh - 134px)',
              }}
            >
              {current === 'reports' && <Reports searchText={searchText} isDark={isDark} />}
              {current === 'documents' && <Documents searchText={searchText} isDark={isDark} />}
              {current === 'settings' && <Settings isDark={isDark} />}
            </Content>

            <div
              style={{
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                background: isDark ? '#1f2937' : '#ffffff',
                borderTop: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                display: 'flex',
                justifyContent: 'space-around',
                padding: '8px 0',
                zIndex: 100,
              }}
            >
              {menuItems.map((item) => (
                <div
                  key={item.key}
                  onClick={() => setCurrent(item.key)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '6px 16px',
                    color: current === item.key ? (isDark ? '#60a5fa' : '#1e3a5f') : (isDark ? '#6b7280' : '#9ca3af'),
                    transition: 'all 0.2s ease',
                    transform: current === item.key ? 'scale(1.05)' : 'scale(1)',
                  }}
                >
                  <div style={{ marginBottom: 4 }}>{item.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: current === item.key ? 600 : 400 }}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <Sider
              width={260}
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                bottom: 0,
                background: isDark ? '#1f2937' : '#ffffff',
                borderRight: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              }}
            >
              <div style={{ 
                padding: '24px', 
                borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{
                    width: 42,
                    height: 42,
                    borderRadius: 12,
                    background: isDark ? '#1e3a5f' : '#eef2ff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    <span style={{ fontSize: 22 }}>🔬</span>
                  </div>
                  <div>
                    <Title level={4} style={{ 
                      margin: 0, 
                      color: isDark ? '#f9fafb' : '#111827',
                      fontSize: 22,
                      fontWeight: 700,
                      fontFamily: 'Noto Serif SC, serif',
                    }}>
                      Curiosity
                    </Title>
                    <div style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 4 }}>
                      科学探索记录工具
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ padding: '12px' }}>
                {menuItems.map((item) => (
                  <div
                    key={item.key}
                    onClick={() => setCurrent(item.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '12px 16px',
                      marginBottom: 4,
                      borderRadius: 8,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      background: current === item.key ? (isDark ? '#1e3a5f' : '#eef2ff') : 'transparent',
                      color: current === item.key ? (isDark ? '#f9fafb' : '#1e3a5f') : (isDark ? '#d1d5db' : '#4b5563'),
                      fontWeight: current === item.key ? 600 : 400,
                    }}
                  >
                    <span style={{ marginRight: 12 }}>{item.icon}</span>
                    <span style={{ fontSize: 14 }}>{item.label}</span>
                  </div>
                ))}
              </div>

              <div style={{
                position: 'absolute',
                bottom: 24,
                left: 0,
                right: 0,
                padding: '0 24px',
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  background: isDark ? '#111827' : '#f8f9fa',
                  borderRadius: 8,
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isDark ? <Moon size={16} /> : <Sun size={16} />}
                    <span style={{
                      color: isDark ? '#9ca3af' : '#6b7280',
                      fontSize: 13,
                    }}>
                      {isDark ? '深色模式' : '浅色模式'}
                    </span>
                  </div>
                  <Switch
                    checked={isDark}
                    onChange={setIsDark}
                    size="small"
                  />
                </div>
              </div>
            </Sider>

            <Layout style={{ marginLeft: 260 }}>
              <Header
                style={{
                  padding: '0 32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: isDark ? '#1f2937' : '#ffffff',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  borderBottom: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  height: 64,
                }}
              >
                <SearchBar 
                  value={searchText} 
                  onChange={setSearchText}
                  isDark={isDark}
                />
                {current === 'reports' && (
                  <Button 
                    type="primary" 
                    size="large" 
                    icon={<PlusOutlined size={18} />}
                    onClick={() => {
                      const createBtn = document.querySelector('[data-create-report]');
                      if (createBtn) createBtn.click();
                    }}
                    style={{ 
                      borderRadius: 8,
                      fontWeight: 600,
                    }}
                  >
                    新建报告
                  </Button>
                )}
              </Header>

              <Content
                style={{
                  margin: 0,
                  padding: '32px',
                  background: isDark ? '#0f172a' : '#f8f9fa',
                  minHeight: 'calc(100vh - 64px)',
                }}
              >
                {current === 'reports' && <Reports searchText={searchText} isDark={isDark} />}
                {current === 'documents' && <Documents searchText={searchText} isDark={isDark} />}
                {current === 'settings' && <Settings isDark={isDark} />}
              </Content>
            </Layout>
          </>
        )}
      </Layout>
    </ConfigProvider>
  );
}

export default App;
