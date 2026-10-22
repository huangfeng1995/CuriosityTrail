'use strict';

/**
 * 测试辅助。
 *
 * 每个测试文件跑在独立的临时数据目录里，互不干扰。
 * 关键点：**必须在 require 业务模块之前设好环境变量**——
 * config.js 在加载时就把 DATA_DIR 解析成绝对路径并建好目录，
 * 之后再改 process.env 已经太晚了。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 准备一个隔离的测试环境。
 *
 * @returns {{dataDir: string, cleanup: Function}}
 */
function setupTempEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));

  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  process.env.APP_PASSWORD = 'test-password-123';
  process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
  process.env.ALLOW_MULTI_INSTANCE = '1';
  // 备份不要在测试里真的写定时任务
  process.env.BACKUP_HOUR = '-1';

  return {
    dataDir,
    cleanup() {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch (e) {
        // 清理失败无所谓，但不能因此让测试失败
      }
    },
  };
}

/**
 * 起一个真实的 HTTP 服务，测路由用。
 *
 * 直接把 express app 挂到随机端口，而不是 mock：
 * 鉴权中间件、限流、SSE 这些只有真跑一遍才算测到。
 *
 * @param {Function} app
 * @returns {Promise<{baseUrl: string, close: Function, cookie: string}>}
 */
async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 登录拿会话 cookie
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: process.env.APP_PASSWORD }),
  });

  const setCookie = res.headers.getSetCookie?.() || [];
  const cookie = setCookie
    .map((c) => c.split(';')[0])
    .join('; ');

  return {
    baseUrl,
    cookie,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    /**
     * 发一个带会话的请求。
     */
    async request(path, options = {}) {
      const headers = {
        ...(options.headers || {}),
        Cookie: cookie,
      };
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      return fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    },
  };
}

module.exports = { setupTempEnv, startServer };
