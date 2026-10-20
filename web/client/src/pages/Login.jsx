import React, { useState } from 'react';
import { Button, Input, Form, Checkbox, Alert, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';

const { Title, Text } = Typography;

/**
 * 登录页。
 *
 * 平台部署在公网，单一密码保护全部稿件。
 */
export default function Login({ isDark = false }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleFinish = async (values) => {
    setLoading(true);
    setError('');
    try {
      await login(values.password, values.remember);
      const from = location.state?.from;
      navigate(from && from !== '/login' ? from : '/works', { replace: true });
    } catch (e) {
      const status = e.response?.status;
      if (status === 429) {
        setError('尝试次数过多，请 15 分钟后再试');
      } else {
        setError(e.response?.data?.error || '登录失败');
      }
    } finally {
      setLoading(false);
    }
  };

  const bg = isDark ? '#0f172a' : '#f8f9fa';
  const card = isDark ? '#1f2937' : '#ffffff';
  const border = isDark ? '#374151' : '#e5e7eb';
  const primary = isDark ? '#60a5fa' : '#1e3a5f';

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: bg,
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: card,
          borderRadius: 12,
          border: `1px solid ${border}`,
          padding: '40px 32px',
          boxShadow: isDark
            ? '0 8px 24px rgba(0,0,0,0.4)'
            : '0 4px 16px rgba(0,0,0,0.06)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: isDark ? '#1e3a5f' : '#eef2ff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
            }}
          >
            <span style={{ fontSize: 26 }}>✍️</span>
          </div>
          <Title
            level={3}
            style={{
              margin: 0,
              color: isDark ? '#f9fafb' : '#111827',
              fontFamily: 'Noto Serif SC, serif',
            }}
          >
            Curiosity
          </Title>
          <Text style={{ color: isDark ? '#9ca3af' : '#6b7280', fontSize: 13 }}>
            AI 辅助小说创作平台
          </Text>
        </div>

        {error && (
          <Alert
            type="error"
            message={error}
            showIcon
            style={{ marginBottom: 20 }}
          />
        )}

        <Form onFinish={handleFinish} layout="vertical" requiredMark={false}>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              size="large"
              prefix={<LockOutlined />}
              placeholder="访问密码"
              autoFocus
            />
          </Form.Item>

          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 20 }}>
            <Checkbox>在此设备上保持登录（90 天）</Checkbox>
          </Form.Item>

          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={loading}
            style={{ background: primary, borderColor: primary }}
          >
            登录
          </Button>
        </Form>
      </div>
    </div>
  );
}
