import React, { useState, useEffect } from 'react';
import { Layout, Menu, theme, Typography, Button, Input, ConfigProvider } from 'antd';
import { 
  FileTextOutlined, 
  BookOutlined, 
  SettingOutlined,
  MoonOutlined,
  SunOutlined,
  SearchOutlined
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

  const { darkAlgorithm, defaultAlgorithm } = theme;

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
      label: '探索报告',
    },
    {
      key: 'documents',
      icon: <BookOutlined />,
      label: '文献库',
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '系统设置',
    },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: isDark ? darkAlgorithm : defaultAlgorithm,
        token: {
          colorPrimary: '#4A90D9',
        },
      }}
    >
      <Layout style={{ minHeight: '100vh' }}>
        <Sider theme={isDark ? 'dark' : 'light'} width={200}>
          <div style={{ padding: '20px', textAlign: 'center' }}>
            <Title level={4} style={{ margin: 0, color: isDark ? '#fff' : '#4A90D9' }}>
              🔬 Curiosity Trail
            </Title>
          </div>
          <Menu
            theme={isDark ? 'dark' : 'light'}
            mode="inline"
            selectedKeys={[current]}
            items={menuItems}
            onClick={({ key }) => setCurrent(key)}
          />
        </Sider>
        <Layout>
          <Header
            style={{
              padding: '0 24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: isDark ? '#141414' : '#fff',
            }}
          >
            <Input
              placeholder="搜索..."
              prefix={<SearchOutlined />}
              style={{ width: 300 }}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              allowClear
            />
            <Button
              type="text"
              icon={isDark ? <SunOutlined /> : <MoonOutlined />}
              onClick={() => setIsDark(!isDark)}
            />
          </Header>
          <Content
            style={{
              margin: '24px',
              padding: 24,
              minHeight: 280,
              background: isDark ? '#141414' : '#f5f5f5',
              borderRadius: '8px',
            }}
          >
            {current === 'reports' && <Reports searchText={searchText} />}
            {current === 'documents' && <Documents searchText={searchText} />}
            {current === 'settings' && <Settings />}
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}

export default App;
