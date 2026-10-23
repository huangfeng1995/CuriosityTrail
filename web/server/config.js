'use strict';

/**
 * 中心配置模块。
 *
 * 职责：
 *  1. 加载 .env（此前 dotenv 未安装，.env 从未被读取）
 *  2. 统一所有运行时写入路径到 DATA_DIR（容器可替换，容器内路径不持久）
 *  3. 读取鉴权与 AI 相关的环境变量
 *
 * 所有依赖配置的服务都应 require 本模块，保证 dotenv 只加载一次且先于任何
 * process.env 读取。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 1. 加载 .env（幂等）
// ---------------------------------------------------------------------------
// dotenv.config 不会覆盖已存在的环境变量，因此本地 .env 优先于平台注入的变量。
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: path.join(__dirname, '..', '.env') });
  dotenv.config({ path: path.join(__dirname, '../../.env') });
} catch (e) {
  // 生产环境通过平台 secrets 注入，没有 .env 属正常情况
}

// ---------------------------------------------------------------------------
// 2. 路径
// ---------------------------------------------------------------------------
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data'));
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(dataDir, 'uploads'));
const docsDir = path.resolve(process.env.DOCS_DIR || path.join(dataDir, 'documents'));
const tempDir = path.resolve(process.env.TEMP_DIR || path.join(dataDir, 'temp'));
const dbPath = path.join(dataDir, 'curiosity.db');
const aiConfigPath = path.join(dataDir, 'ai-config.json');

for (const dir of [dataDir, uploadsDir, docsDir, tempDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 3. 鉴权
// ---------------------------------------------------------------------------
const isProduction = process.env.NODE_ENV === 'production';

function readOrCreate(fileName, bytes) {
  const filePath = path.join(dataDir, fileName);
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (value) return value;
  } catch (e) {
    // 文件不存在，走生成流程
  }
  const value = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(filePath, value + '\n', { mode: 0o600 });
  return value;
}

// APP_PASSWORD 优先取平台注入的 secret；缺失时落到 DATA_DIR 内的持久化文件，
// 保证容器重建后密码不变（仅在 platform 未注入时使用，会在启动日志中警告）。
const appPasswordFromEnv = (process.env.APP_PASSWORD || '').trim();
const appPassword = appPasswordFromEnv || readOrCreate('.app-password', 24);
const appPasswordIsFallback = !appPasswordFromEnv;

// scrypt salt。用于派生登录校验值，两次计算必须同盐。
const appPasswordSalt =
  (process.env.APP_PASSWORD_SALT || '').trim() || readOrCreate('.app-password-salt', 16);

// JWT 签名密钥。缺失时落到 DATA_DIR 内的持久化文件，避免重启后所有会话失效。
const jwtSecretFromEnv = (process.env.JWT_SECRET || '').trim();
const jwtSecret = jwtSecretFromEnv || readOrCreate('.session-secret', 32);
const jwtSecretIsFallback = !jwtSecretFromEnv;

const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 30);
const sessionRememberTtlDays = Number(process.env.SESSION_REMEMBER_TTL_DAYS || 90);
const sessionCookieName = 'ct_session';

// ---------------------------------------------------------------------------
// 4. AI / 服务商
// ---------------------------------------------------------------------------
const deepseekApiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const ollamaModel = (process.env.OLLAMA_MODEL || 'qwen2.5:7b').trim();

// ---------------------------------------------------------------------------
// 5. 运行环境
// ---------------------------------------------------------------------------
const port = Number(process.env.PORT || 3001);
const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

// ---------------------------------------------------------------------------
// 6. 异地备份
// ---------------------------------------------------------------------------
//
// 定时备份写在 DATA_DIR/backups/，跟数据库在同一个卷上——卷坏了备份一起没。
// BACKUP_OFFSITE_DIR 指向另一个位置（Fly.io 的第二个卷、云盘同步目录、
// NAS 挂载点……），备份会额外复制一份过去。
//
// 不做对象存储直传：那要引入 SDK 并处理签名/密钥管理，
// 收益不如"指向一个已经在同步的目录"来得实际。
const backupOffsiteDir = (process.env.BACKUP_OFFSITE_DIR || '').trim()
  ? path.resolve(process.env.BACKUP_OFFSITE_DIR.trim())
  : '';

// 异地保留多少份。比本地多——本地只有 7 份滚动，
// 异地这份才是"卷炸了还能救回来"的最后一道保险。
const backupOffsiteKeep = Number(process.env.BACKUP_OFFSITE_KEEP || 30);

// 生产环境前后端同域（Node 同时提供静态前端与 API），不需要 CORS。
// 仅开发环境放开，供 vite dev server (localhost:3000) 直连后端。
const appOrigin = (process.env.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');
const enableCors = !isProd;

// Cookie 的 secure 标记。
//
// secure cookie 只在 HTTPS 下才会被浏览器存下。但本地版跑的是 http://127.0.0.1,
// 照样得能记住登录——所以做成可覆盖的开关，而不是死绑 NODE_ENV。
//
// 用「显式设置才生效」而不是「非 production 就为 false」：
// 服务器部署（走 Caddy 反代到 HTTPS）必须保持 secure，
// 只有明确写了 COOKIE_SECURE=false 的本地场景才关掉。
const cookieSecure =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE !== 'false' && process.env.COOKIE_SECURE !== '0'
    : isProd;

module.exports = {
  // 路径
  dataDir,
  uploadsDir,
  docsDir,
  tempDir,
  dbPath,
  aiConfigPath,
  // 鉴权
  isProd,
  appPassword,
  appPasswordIsFallback,
  appPasswordSalt,
  jwtSecret,
  jwtSecretIsFallback,
  sessionTtlDays,
  sessionRememberTtlDays,
  sessionCookieName,
  cookieSecure,
  // AI
  deepseekApiKey,
  ollamaBaseUrl,
  ollamaModel,
  // 异地备份
  backupOffsiteDir,
  backupOffsiteKeep,
  // 运行环境
  port,
  nodeEnv,
  appOrigin,
  enableCors,
};
