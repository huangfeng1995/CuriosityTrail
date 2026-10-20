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
  const [checking, setChecking] = useState(true);

  const checkSession = useCallback(async () => {
    try {
      const res = await api.get('/auth/session');
      setAuthenticated(Boolean(res.data?.authenticated));
    } catch (e) {
      setAuthenticated(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // 任一 API 返回 401 时，立即切回未登录态
  useEffect(() => {
    const onUnauthorized = () => setAuthenticated(false);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  const login = useCallback(async (password, remember) => {
    const res = await api.post('/auth/login', { password, remember });
    setAuthenticated(true);
    return res.data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      setAuthenticated(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ authenticated, checking, login, logout, checkSession }}>
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
