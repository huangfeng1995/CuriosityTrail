import React, { useState, useRef, useEffect } from 'react';
import { Button, Input, Form, Checkbox, Alert } from 'antd';
import { MobileOutlined, SafetyOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../store/auth';
import BrandLogo from '../components/BrandLogo';

/**
 * 登录页。
 *
 * 手机号 + 短信验证码，参考 flomo 的极简形式：
 * 一个手机号输入框、一个验证码输入框，首次登录自动注册。
 * 没有密码、没有邮箱、没有注册页。
 */

/** 手机号规则与后端保持一致 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

export default function Login({ isDark = false }) {
  const { login, sendCode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const timerRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCountdown = (seconds) => {
    setCountdown(seconds);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          clearInterval(timerRef.current);
          timerRef.current = null;
          return 0;
        }
        return n - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    setError('');
    setNotice('');
    let phone;
    try {
      phone = await form.validateFields(['phone']);
    } catch (e) {
      return;
    }

    setSending(true);
    try {
      const result = await sendCode(phone.phone);
      startCountdown(60);
      if (result?.devMode) {
        setNotice(`开发模式：验证码为 ${result.devCode}，未真正发送短信`);
      }
    } catch (e) {
      const status = e.response?.status;
      if (status === 429) {
        setError('发送太频繁了，请稍后再试');
      } else {
        setError(e.response?.data?.error || '验证码发送失败');
      }
    } finally {
      setSending(false);
    }
  };

  const handleFinish = async (values) => {
    setLoading(true);
    setError('');
    try {
      await login(values.phone, values.code, values.remember);
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
          <BrandLogo size={46} className="ct-login-logo" />
          <h1 className="ct-login-title font-serif">寻迹</h1>
        </div>

        {error && (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 20 }} />
        )}
        {!error && notice && (
          <Alert type="info" message={notice} showIcon style={{ marginBottom: 20 }} />
        )}

        <Form form={form} onFinish={handleFinish} layout="vertical" requiredMark={false}>
          <Form.Item
            name="phone"
            rules={[
              { required: true, message: '请输入手机号' },
              { pattern: PHONE_PATTERN, message: '手机号格式不正确' },
            ]}
            style={{ marginBottom: 16 }}
          >
            <Input
              size="large"
              prefix={<MobileOutlined />}
              placeholder="手机号"
              maxLength={11}
              autoFocus
            />
          </Form.Item>

          <Form.Item style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <Form.Item
                name="code"
                noStyle
                rules={[
                  { required: true, message: '请输入验证码' },
                  { len: 6, message: '验证码为 6 位数字' },
                ]}
              >
                <Input
                  size="large"
                  prefix={<SafetyOutlined />}
                  placeholder="验证码"
                  maxLength={6}
                  inputMode="numeric"
                />
              </Form.Item>
              <Button
                size="large"
                onClick={handleSendCode}
                loading={sending}
                disabled={countdown > 0}
                style={{ flexShrink: 0 }}
              >
                {countdown > 0 ? `${countdown} 秒后重发` : '获取验证码'}
              </Button>
            </div>
          </Form.Item>

          <Form.Item name="remember" valuePropName="checked" style={{ marginBottom: 22 }}>
            <Checkbox>在此设备上保持登录（90 天）</Checkbox>
          </Form.Item>

          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            进入书房
          </Button>
        </Form>
      </div>
    </div>
  );
}
