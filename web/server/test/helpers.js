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
const crypto = require('crypto');

/** 测试环境固定验证码：开发模式下短信不会真发，用这个码登录。 */
const TEST_SMS_CODE = '246810';

/**
 * 准备一个隔离的测试环境。
 *
 * @returns {{dataDir: string, cleanup: Function}}
 */
function setupTempEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-test-'));

  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-for-ci-only';
  process.env.SMS_DEV_CODE = TEST_SMS_CODE;
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
 * 走完整的「发验证码 → 登录」流程，拿到会话 cookie。
 *
 * 短信在测试里是开发模式（SMS_DEV_CODE），不会真的调阿里云。
 *
 * @param {string} baseUrl
 * @param {string} phone
 * @returns {Promise<string>} Cookie 头
 */
async function loginWithPhone(baseUrl, phone) {
  const sendRes = await fetch(`${baseUrl}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });
  if (!sendRes.ok) {
    throw new Error(`发送验证码失败：${sendRes.status} ${await sendRes.text()}`);
  }

  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code: TEST_SMS_CODE }),
  });
  if (!loginRes.ok) {
    throw new Error(`登录失败：${loginRes.status} ${await loginRes.text()}`);
  }

  const setCookie = loginRes.headers.getSetCookie?.() || [];
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

/**
 * 直接往 users 表插一个用户（绕过短信）。
 *
 * 用于需要指定 role 的场景：管理员才能整库备份，
 * 而正常注册出来的用户都是普通用户。
 *
 * @param {{phone?: string, role?: string, nickname?: string}} [options]
 * @returns {Promise<{id: string, phone: string, role: string}>}
 */
async function createUser(options = {}) {
  const db = require('../database');
  await db.ready;

  const phone = options.phone || '138' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const id = crypto.randomUUID();
  const role = options.role || 'user';
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO users (id, phone, nickname, role, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, phone, options.nickname || null, role, now, now]
  );

  return { id, phone, role };
}

/**
 * 起一个真实的 HTTP 服务，测路由用。
 *
 * 直接把 express app 挂到随机端口，而不是 mock：
 * 鉴权中间件、限流、SSE 这些只有真跑一遍才算测到。
 *
 * 默认用一个固定手机号登录；跨用户隔离测试可以用 createUser
 * 造第二个账号，再调 loginAs 换一个 cookie 组织请求。
 *
 * @param {Function} app
 * @returns {Promise<Object>}
 */
async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const defaultPhone = '13900000001';
  const cookie = await loginWithPhone(baseUrl, defaultPhone);

  /**
   * 发一个带指定会话的请求。
   * @param {string} requestPath
   * @param {Object} [options]
   * @param {string} [sessionCookie]
   */
  function requestWith(sessionCookie, requestPath, options = {}) {
    const headers = {
      ...(options.headers || {}),
      Cookie: sessionCookie,
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(`${baseUrl}${requestPath}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  }

  return {
    baseUrl,
    cookie,
    phone: defaultPhone,
    server,
    /** 以另一个手机号登录，返回新的 cookie（首次登录会自动注册）。 */
    loginAs(phone) {
      return loginWithPhone(baseUrl, phone);
    },
    /** 用指定会话发请求。 */
    requestAs: requestWith,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    /**
     * 发一个带默认会话的请求。
     */
    async request(requestPath, options = {}) {
      return requestWith(cookie, requestPath, options);
    },
  };
}

module.exports = { setupTempEnv, startServer, createUser, TEST_SMS_CODE };
