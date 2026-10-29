import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/client';

/**
 * 登录态管理。
 *
 * 会话本身在 HttpOnly Cookie 里，前端不持有 token，只知道"是否已登录"。
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  const checkSession = useCallback(async () => {
    try {
      const res = await api.get('/auth/session');
      setAuthenticated(Boolean(res.data?.authenticated));
      setUser(res.data?.user || null);
    } catch (e) {
      setAuthenticated(false);
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // 任一 API 返回 401 时，立即切回未登录态
  useEffect(() => {
    const onUnauthorized = () => {
      setAuthenticated(false);
      setUser(null);
    };
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  /** 发送短信验证码。返回 { ok, devMode, devCode }。 */
  const sendCode = useCallback(async (phone) => {
    const res = await api.post('/auth/send-code', { phone });
    return res.data;
  }, []);

  /** 验证码登录（首次登录自动注册）。 */
  const login = useCallback(async (phone, code, remember) => {
    const res = await api.post('/auth/login', { phone, code, remember });
    setAuthenticated(true);
    setUser(res.data?.user || null);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAuthenticated(false);
      setUser(null);
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{ authenticated, checking, user, sendCode, login, logout, checkSession }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth 必须在 AuthProvider 内使用');
  }
  return ctx;
}
