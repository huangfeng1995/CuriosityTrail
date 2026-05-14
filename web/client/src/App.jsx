import React, { useState, useEffect } from 'react';
import { Layout, Menu, theme, Typography, Button, Input, ConfigProvider } from 'antd';
import {
  FileTextOutlined,
  BookOutlined,
  SettingOutlined,
  MoonOutlined,
  SunOutlined,
} from '@ant-design/icons';
import Reports from './components/Reports';
import Documents from './components/Documents';
import Settings from './components/Settings';

const { Header, Sider, Content } = Layout;
const { Title } = Typography;

function App() {
  const [current, setCurrent] = useState('reports');
  const [isDark, setIsDark] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [isMobile, setIsMobile] = useState(false);

  const { darkAlgorithm, defaultAlgorithm } = theme;

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
    {
      key: 'reports',
      icon: <FileTextOutlined />,
      label: '报告',
    },
    {
      key: 'documents',
      icon: <BookOutlined />,
      label: '文献',
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '设置',
    },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? darkAlgorithm : defaultAlgorithm,
        token: {
          colorPrimary: '#4A90D9',
          borderRadius: 8,
        },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        {isMobile ? (
          <>
            <Header
              style={{
                padding: '0 16px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: isDark ? '#1f1f1f' : '#fff',
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                zIndex: 100,
                height: 56,
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              }}
            >
              <Title level={4} style={{ margin: 0, color: isDark ? '#fff' : '#4A90D9' }}>
                🔬 寻迹
              </Title>
              <Button
                type="text"
                icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                onClick={() => setIsDark(!isDark)}
                style={{ color: isDark ? '#fff' : '#333' }}
              />
            </Header>

            <Content
              style={{
                marginTop: 56,
                marginBottom: 70,
                padding: 16,
                background: isDark ? '#1a1a1a' : '#f0f2f5',
                minHeight: 'calc(100vh - 126px)',
              }}
            >
              {current === 'reports' && <Reports searchText={searchText} />}
              {current === 'documents' && <Documents searchText={searchText} />}
              {current === 'settings' && <Settings />}
            </Content>

            <div
              style={{
                position: 'fixed',
                bottom: 0,
                left: 0,
                right: 0,
                background: isDark ? '#1f1f1f' : '#fff',
                borderTop: `1px solid ${isDark ? '#404040' : '#e8e8e8'}`,
                display: 'flex',
                justifyContent: 'space-around',
                padding: '8px 0',
                zIndex: 100,
              }}
            >
              {menuItems.map(item => (
                <div
                  key={item.key}
                  onClick={() => setCurrent(item.key)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    cursor: 'pointer',
                    padding: '4px 20px',
                    color: current === item.key ? '#4A90D9' : (isDark ? '#888' : '#999'),
                    transition: 'all 0.3s',
                  }}
                >
                  <div style={{ fontSize: 24 }}>{item.icon}</div>
                  <div style={{ fontSize: 11, marginTop: 4, fontWeight: current === item.key ? 600 : 400 }}>
                    {item.label}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <Sider
              theme={isDark ? 'dark' : 'light'}
              width={240}
              style={{
                position: 'fixed',
                left: 0,
                top: 0,
                bottom: 0,
                boxShadow: '2px 0 12px rgba(0,0,0,0.08)',
              }}
            >
              <div style={{ padding: '28px 20px', textAlign: 'center', borderBottom: `1px solid ${isDark ? '#404040' : '#e8e8e8'}` }}>
                <Title level={4} style={{ margin: 0, color: isDark ? '#fff' : '#4A90D9' }}>
                  🔬 Curiosity Trail
                </Title>
                <div style={{ color: isDark ? '#888' : '#999', fontSize: 12, marginTop: 6 }}>
                  寻迹 - 科学探索记录
                </div>
              </div>
              <Menu
                theme={isDark ? 'dark' : 'light'}
                mode="inline"
                selectedKeys={[current]}
                items={menuItems}
                onClick={({ key }) => setCurrent(key)}
                style={{ border: 'none', marginTop: 12 }}
              />
            </Sider>

            <Layout style={{ marginLeft: 240 }}>
              <Header
                style={{
                  padding: '0 32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: isDark ? '#1f1f1f' : '#fff',
                  position: 'sticky',
                  top: 0,
                  zIndex: 10,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                }}
              >
                <Input
                  placeholder="🔍 全局搜索..."
                  style={{ width: 360 }}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  allowClear
                />
                <Button
                  type="text"
                  icon={isDark ? <SunOutlined /> : <MoonOutlined />}
                  onClick={() => setIsDark(!isDark)}
                  size="large"
                  style={{ fontSize: 18 }}
                />
              </Header>

              <Content
                style={{
                  margin: 28,
                  padding: 28,
                  minHeight: 280,
                  background: isDark ? '#1a1a1a' : '#f0f2f5',
                  borderRadius: 16,
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
