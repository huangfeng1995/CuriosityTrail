import React, { useState, useEffect } from 'react';
import { Layout, theme, Button, Input, ConfigProvider, Switch, Typography } from 'antd';
import {
  FileTextOutlined,
  BookOutlined,
  SettingOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import Reports from './components/Reports';
import Documents from './components/Documents';
import Settings from './components/Settings';

const { Header, Sider, Content } = Layout;
const { Title } = Typography;

// 新的配色主题
const lightTheme = {
  token: {
    colorPrimary: '#6366f1', // 柔和的靛蓝色
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorText: '#1f2937',
    colorTextSecondary: '#6b7280',
    colorBorder: '#e5e7eb',
    colorBorderSecondary: '#f3f4f6',
    borderRadius: 12,
    borderRadiusSM: 8,
    colorBgLayout: '#fafafa',
  },
};

const darkTheme = {
  token: {
    colorPrimary: '#818cf8', // 深色下的柔和蓝色
    colorBgBase: '#0f172a',
    colorBgContainer: '#0f172a',
    colorBgElevated: '#1e293b',
    colorText: '#f1f5f9',
    colorTextSecondary: '#94a3b8',
    colorBorder: '#334155',
    colorBorderSecondary: '#1e293b',
    borderRadius: 12,
    borderRadiusSM: 8,
    colorBgLayout: '#020617',
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
    { key: 'reports', icon: <FileTextOutlined />, label: '探索报告' },
    { key: 'documents', icon: <BookOutlined />, label: '文献库' },
    { key: 'settings', icon: <SettingOutlined />, label: '设置' },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        ...(isDark ? darkTheme : lightTheme),
      }}
    >
      <Layout style={{ minHeight: '100vh', backgroundColor: isDark ? '#020617' : '#fafafa' }}>
        {isMobile ? (
          // 手机端设计 - 参考苹果笔记风格
          <>
            {/* 顶部栏 */}
            <Header
              style={{
                padding: '0 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: isDark ? '#0f172a' : '#ffffff',
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                height: 60,
                boxShadow: isDark ? '0 1px 3px rgba(0,0,0,0.4)' : '0 1px 3px rgba(0,0,0,0.08)',
              }}
            >
              <Title level={4} style={{ 
                margin: 0, 
                color: isDark ? '#f1f5f9' : '#1f2937',
                fontSize: 18,
                fontWeight: 700,
              }}>
                🔬 Curiosity
              </Title>
              <Switch
                checked={isDark}
                onChange={setIsDark}
                checkedChildren="🌙"
                unCheckedChildren="☀️"
                size="small"
              />
            </Header>

            {/* 内容区 */}
            <Content
              style={{
                marginTop: 60,
                marginBottom: 70,
                padding: 16,
                background: isDark ? '#020617' : '#fafafa',
                minHeight: 'calc(100vh - 130px)',
              }}
            >
              {current === 'reports' && <Reports searchText={searchText} />}
              {current === 'documents' && <Documents searchText={searchText} />}
              {current === 'settings' && <Settings />}
            </Content>

            {/* 底部导航 */}
            <div
              style={{
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                background: isDark ? '#0f172a' : '#ffffff',
                borderTop: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
                display: 'flex',
                justifyContent: 'space-around',
                padding: '10px 0',
                zIndex: 100,
              }}
            >
              {menuItems.map((item, index) => (
                <div
                  key={item.key}
                  onClick={() => setCurrent(item.key)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '4px 20px',
                    color: current === item.key ? (isDark ? '#818cf8' : '#6366f1') : (isDark ? '#64748b' : '#9ca3af'),
                    transition: 'all 0.2s ease',
                    transform: current === item.key ? 'scale(1.05)' : 'scale(1)',
                  }}
                >
                  <div style={{ fontSize: 22 }}>{item.icon}</div>
                  <div style={{ fontSize: 11, marginTop: 5, fontWeight: current === item.key ? 700 : 500 }}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          // 电脑端设计 - 参考 Notion 风格
          <>
            <Sider
              theme={isDark ? 'dark' : 'light'}
              width={260}
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                bottom: 0,
                background: isDark ? '#0f172a' : '#ffffff',
                borderRight: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
              }}
            >
              {/* 品牌区 */}
              <div style={{ 
                padding: '28px 24px', 
                borderBottom: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
              }}>
                <Title level={4} style={{ 
                  margin: 0, 
                  color: isDark ? '#f1f5f9' : '#1f2937',
                  fontSize: 20,
                  fontWeight: 700,
                }}>
                  🔬 Curiosity
                </Title>
                <div style={{ 
                  color: isDark ? '#64748b' : '#9ca3af', 
                  fontSize: 13, 
                  marginTop: 6,
                }}>
                  科学探索记录工具
                </div>
              </div>

              {/* 菜单区 */}
              <div style={{ padding: '16px 12px' }}>
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
                      background: current === item.key ? (isDark ? '#1e293b' : '#f3f4f6') : 'transparent',
                      color: current === item.key ? (isDark ? '#818cf8' : '#6366f1') : (isDark ? '#cbd5e1' : '#4b5563'),
                      fontWeight: current === item.key ? 600 : 400,
                    }}
                  >
                    <span style={{ fontSize: 18, marginRight: 12 }}>{item.icon}</span>
                    <span style={{ fontSize: 14 }}>{item.label}</span>
                  </div>
                ))}
              </div>

              {/* 底部主题切换 */}
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
                }}>
                  <span style={{
                    color: isDark ? '#64748b' : '#9ca3af',
                    fontSize: 13,
                  }}>
                    {isDark ? '🌙 深色模式' : '☀️ 浅色模式'}
                  </span>
                  <Switch
                    checked={isDark}
                    onChange={setIsDark}
                    size="small"
                  />
                </div>
              </div>
            </Sider>

            {/* 主内容区 */}
            <Layout style={{ marginLeft: 260 }}>
              <Header
                style={{
                  padding: '0 40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-start',
                  background: isDark ? '#0f172a' : '#ffffff',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  borderBottom: `1px solid ${isDark ? '#334155' : '#e5e7eb'}`,
                  height: 70,
                }}
              >
                <Input
                  placeholder="搜索..."
                  prefix={<span style={{ color: isDark ? '#64748b' : '#9ca3af' }}>🔍</span>}
                  style={{ 
                    width: 400,
                    borderRadius: 10,
                  }}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  allowClear
                />
              </Header>

              <Content
                style={{
                  margin: 0,
                  padding: '40px',
                  minHeight: 280,
                  background: isDark ? '#020617' : '#fafafa',
                }}
              >
                {current === 'reports' && <Reports searchText={searchText} />}
                {current === 'documents' && <Documents searchText={searchText} />}
                {current === 'settings' && <Settings />}
              </Content>
            </Layout>
          </>
        )}
      </Layout>
    </ConfigProvider>
  );
}

export default App;
