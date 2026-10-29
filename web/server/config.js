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

// 登录已改为手机号 + 短信验证码（见 services/sms.js），不再有共享密码。
// JWT 签名密钥。缺失时落到 DATA_DIR 内的持久化文件，避免重启后所有会话失效。
const jwtSecretFromEnv = (process.env.JWT_SECRET || '').trim();
const jwtSecret = jwtSecretFromEnv || readOrCreate('.session-secret', 32);
const jwtSecretIsFallback = !jwtSecretFromEnv;

const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 30);
const sessionRememberTtlDays = Number(process.env.SESSION_REMEMBER_TTL_DAYS || 90);
const sessionCookieName = 'ct_session';

// ---------------------------------------------------------------------------
// 3.1 阿里云短信
// ---------------------------------------------------------------------------
// AccessKey 走环境变量注入，不落库、不写日志。
const aliyunSmsAccessKeyId = (process.env.ALIYUN_SMS_ACCESS_KEY_ID || '').trim();
const aliyunSmsAccessKeySecret = (process.env.ALIYUN_SMS_ACCESS_KEY_SECRET || '').trim();
const aliyunSmsSignName = (process.env.ALIYUN_SMS_SIGN_NAME || '').trim();
const aliyunSmsTemplateCode = (process.env.ALIYUN_SMS_TEMPLATE_CODE || '').trim();

const smsConfigured = Boolean(
  aliyunSmsAccessKeyId && aliyunSmsAccessKeySecret && aliyunSmsSignName && aliyunSmsTemplateCode
);

// 开发/测试用固定验证码。
// 仅非生产环境生效——生产环境即使误配了也不会被当成万能码，
// 这样本地调试不必真发短信，上线也不会留下后门。
const smsDevCode = (process.env.SMS_DEV_CODE || '').trim();
const smsDevMode = !isProduction && Boolean(smsDevCode);

// 生产环境固定验证码（临时方案）。
//
// 用途：阿里云短信还没配好时，先让站点能登录。
// 必须显式配置 SMS_FIXED_CODE 才生效——线上留万能码是后门，
// 所以它跟 SMS_DEV_CODE 分开：那个自动在生产失效，这个要人主动写。
// 只对 SMS_FIXED_PHONE 这一个手机号有效：码再固定，也不能让别人登进来烧 AI 额度。
// 短信配好后把这两个环境变量删掉、容器重启，后门就没了。
const smsFixedCode = (process.env.SMS_FIXED_CODE || '').trim();
const smsFixedPhone = (process.env.SMS_FIXED_PHONE || '').trim();
const smsFixedMode = Boolean(smsFixedCode && smsFixedPhone);

const smsCodeTtlMinutes = Number(process.env.SMS_CODE_TTL_MINUTES || 5);
const smsResendSeconds = Number(process.env.SMS_RESEND_SECONDS || 60);
const smsDailyLimit = Number(process.env.SMS_DAILY_LIMIT || 10);

// ---------------------------------------------------------------------------
// 4. AI / 服务商
// ---------------------------------------------------------------------------
const deepseekApiKey = (process.env.DEEPSEEK_API_KEY || '').trim();
const ollamaBaseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const ollamaModel = (process.env.OLLAMA_MODEL || 'qwen2.5:7b').trim();

// ---------------------------------------------------------------------------
// 4.1 长期记忆（viking sidecar）
// ---------------------------------------------------------------------------
//
// 记忆服务是一个跑在 127.0.0.1 的 Python sidecar（web/memory-service）。
// 它没启动时整个记忆层关闭，对话与写作照常——所以这里没有"必须可达"的校验。
//
// Ark key 只存在于 sidecar 的环境变量里，Node 不读取、不下发。
const memoryEnabled = (process.env.MEMORY_ENABLED || 'true').trim() !== 'false';
const vikingBaseUrl = (process.env.VIKING_BASE_URL || 'http://127.0.0.1:8019').replace(/\/$/, '');
const vikingTimeoutMs = Number(process.env.VIKING_TIMEOUT_MS || 800);
// 写入超时必须**长于** sidecar 的 VIKING_INDEX_TIMEOUT_SECONDS（默认 8 秒）。
//
// 谁先超时很重要：sidecar 先超时 → 它返回 503，Node 拿到明确失败，
// 台账记 failed，两边状态一致；Node 先放弃 → sidecar 还在后台写向量，
// 变成「台账说失败、向量已经写进去」。
const vikingIndexTimeoutMs = Number(process.env.VIKING_INDEX_TIMEOUT_MS || 10000);
const memoryIndexConcurrency = Number(process.env.MEMORY_INDEX_CONCURRENCY || 2);
const memoryTopK = Number(process.env.MEMORY_TOP_K || 16);
const memoryMaxRefs = Number(process.env.MEMORY_MAX_REFS || 8);
const memoryMaxChars = Number(process.env.MEMORY_MAX_CHARS || 3000);
// 召回门槛的基准值。分类型门槛是它的倍数，见 retriever.js 的 TYPE_THRESHOLD_FACTORS。
// 0.24 来自标定实测（30 章 / 92 块，安全区间 (0.13, 0.34) 的中点）。
const memoryMinScore = Number(process.env.MEMORY_MIN_SCORE || 0.24);
const memoryExtractEnabled =
  (process.env.MEMORY_EXTRACT_ENABLED || 'true').trim() !== 'false';
// 索引失败后的首次退避时长，后面的重试按 2 的幂往上翻。
const memoryRetryBaseMs = Number(process.env.MEMORY_RETRY_BASE_MS || 1000);

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
  jwtSecret,
  jwtSecretIsFallback,
  sessionTtlDays,
  sessionRememberTtlDays,
  sessionCookieName,
  cookieSecure,
  // 短信
  aliyunSmsAccessKeyId,
  aliyunSmsAccessKeySecret,
  aliyunSmsSignName,
  aliyunSmsTemplateCode,
  smsConfigured,
  smsDevCode,
  smsDevMode,
  smsFixedCode,
  smsFixedPhone,
  smsFixedMode,
  smsCodeTtlMinutes,
  smsResendSeconds,
  smsDailyLimit,
  // AI
  deepseekApiKey,
  ollamaBaseUrl,
  ollamaModel,
  // 长期记忆
  memoryEnabled,
  vikingBaseUrl,
  vikingTimeoutMs,
  vikingIndexTimeoutMs,
  memoryIndexConcurrency,
  memoryTopK,
  memoryMaxRefs,
  memoryMaxChars,
  memoryMinScore,
  memoryExtractEnabled,
  memoryRetryBaseMs,
  // 异地备份
  backupOffsiteDir,
  backupOffsiteKeep,
  // 运行环境
  port,
  nodeEnv,
  appOrigin,
  enableCors,
};
