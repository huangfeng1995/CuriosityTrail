import React, { useState } from 'react';
import { Button, Input, Form, Checkbox, Alert, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';

const { Text } = Typography;

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

  return (
    <div className="ct-login">
      <div className="ct-login-card ct-fade-in">
        <div className="ct-login-head">
          <span className="ct-login-mark" aria-hidden="true">
            寻
          </span>
          <h1 className="ct-login-title font-serif">寻迹</h1>
          <p className="ct-login-sub">Curiosity Trail · AI 辅助小说创作</p>
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
            style={{ marginBottom: 16 }}
          >
            <Input.Password
              size="large"
              prefix={<LockOutlined />}
              placeholder="访问密码"
              autoFocus
            />
          </Form.Item>

          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 22 }}>
            <Checkbox>在此设备上保持登录（90 天）</Checkbox>
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            进入书房
          </Button>
        </Form>

        <Text className="ct-login-foot">全部稿件只保存在你自己的服务器上</Text>
      </div>
    </div>
  );
}
