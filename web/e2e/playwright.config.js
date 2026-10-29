'use strict';

/**
 * E2E 测试配置。
 *
 * 跑的是真服务：Playwright 先起一个 Node 服务（web/server），再让浏览器打它。
 * 前端资源由同一个服务托管（web/client/dist），所以整个测试是同源的，
 * 不需要起 vite dev server，也不用配 CORS。
 *
 * 环境变量按"测试环境"给：
 *   NODE_ENV=test   → cookie 不带 secure 标记，http 下也能用
 *   独立 DATA_DIR   → 每次跑都是干净的库，不碰作者的真实稿件
 *   ALLOW_MULTI_INSTANCE=1 → 跳过单实例锁（测试期间可能已有开发服务在跑）
 *   BACKUP_HOUR=-1  → 不启定时备份
 */

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3457);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** 每次跑测试都用独立的库，测完可以整个删掉 */
const DATA_DIR = path.join(__dirname, '.tmp', 'data');

/** 登录态：globalSetup 登录一次写下来，所有用例复用 */
const STATE_FILE = path.join(__dirname, '.tmp', 'storage-state.json');

/** 短信验证码在测试环境用固定值（SMS_DEV_CODE），不会真的发短信 */
const SMS_CODE = process.env.E2E_SMS_CODE || '135790';

module.exports = defineConfig({
  testDir: './specs',
  globalSetup: require.resolve('./global-setup.js'),
  // 本地跑默认不重试，CI 上重试一次兜住偶发的时序问题
  retries: process.env.CI ? 1 : 0,
  // 串行跑：所有用例打同一个服务，共用 IP 与数据库，并行会互相干扰
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    storageState: STATE_FILE,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    // 先清空测试数据目录再起服务，保证每次跑的库是干净的
    command:
      'node -e "require(\'fs\').rmSync(process.env.DATA_DIR,{recursive:true,force:true})" && node index.js',
    cwd: path.join(__dirname, '..', 'server'),
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'test',
      DATA_DIR,
      SMS_DEV_CODE: SMS_CODE,
      JWT_SECRET: 'e2e-jwt-secret-for-ci-only',
      ALLOW_MULTI_INSTANCE: '1',
      BACKUP_HOUR: '-1',
    },
  },
});
