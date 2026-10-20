import axios from 'axios';

/**
 * 统一 API 客户端。
 *
 * 会话通过 HttpOnly Cookie 维持，因此必须带 credentials。
 * 遇到 401 时广播一个事件，由 auth store 统一处理（跳登录页 / 清状态）。
 */
const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    if (status === 401) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    return Promise.reject(error);
  }
);

export default api;
