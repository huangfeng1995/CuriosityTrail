'use strict';

/**
 * 服务入口。
 *
 * 注意：config 必须最先加载——它负责加载 .env 并统一运行时路径，
 * 后续模块都依赖 process.env 已被正确读取。
 */
const config = require('./config');

const express = require('express');
const path = require('path');
const fs = require('fs');

const { requireAuth } = require('./middleware/auth');
const { aiLimiter, apiLimiter } = require('./middleware/rateLimit');
const { checkSingleInstance } = require('./middleware/singleInstance');
const { ready } = require('./database');
const localSearch = require('./services/search/local');

// ---------------------------------------------------------------------------
// 单实例校验：多实例并发写 SQLite 会损坏数据库，稿子全丢
// ---------------------------------------------------------------------------
const instanceCheck = checkSingleInstance();
if (!instanceCheck.ok) {
  console.error('❌ 启动中止：' + instanceCheck.reason);
  process.exit(1);
}

const app = express();
const PORT = config.port;

// Fly.io 等平台在反代后面，需信任代理才能拿到真实客户端 IP（限流依赖）
app.set('trust proxy', 1);

// 生产环境前后端同域，不需要 CORS；开发环境放开供 vite dev server 直连
if (config.enableCors) {
  const cors = require('cors');
  app.use(cors({ origin: config.appOrigin, credentials: true }));
}

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
const authRouter = require('./routes/auth');
const worksRouter = require('./routes/works');
const chaptersRouter = require('./routes/chapters');
const charactersRouter = require('./routes/characters');
const settingsRouter = require('./routes/settings');
const materialsRouter = require('./routes/materials');
const inspirationsRouter = require('./routes/inspirations');
const aiRouter = require('./routes/ai');
const configRouter = require('./routes/config');
const exportRouter = require('./routes/export');
const uploadRouter = require('./routes/upload');
const searchRouter = require('./routes/search');

// 公开路由：健康检查与登录（登录自带限流）
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.use('/api/auth', authRouter);

// 其余 API 一律要求登录
app.use('/api', apiLimiter, requireAuth);

app.use('/api/works', worksRouter);
app.use('/api/chapters', chaptersRouter);
app.use('/api/characters', charactersRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/inspirations', inspirationsRouter);
app.use('/api/ai', aiLimiter, aiRouter);
app.use('/api/config', aiLimiter, configRouter);
app.use('/api/export', exportRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/search', searchRouter);

// 图片目录同样纳入鉴权
app.use('/uploads', requireAuth, express.static(config.uploadsDir));

// 静态前端
const staticPath = path.join(__dirname, 'public');
const fallbackPath = path.join(__dirname, '../client/dist');
const staticRoot = fs.existsSync(staticPath) ? staticPath : fallbackPath;

app.use(express.static(staticRoot));

// SPA 回退
app.get('*', (req, res) => {
  res.sendFile(path.join(staticRoot, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   环境: ${config.nodeEnv}`);
  console.log(`   数据目录: ${config.dataDir}`);
  console.log(
    `   DEEPSEEK_API_KEY: ${config.deepseekApiKey ? '已加载' : '未配置（将回退到本地 Ollama）'}`
  );
  if (config.appPasswordIsFallback) {
    console.warn(
      '⚠️  未设置 APP_PASSWORD 环境变量，已生成临时密码并存入 ' +
        `${config.dataDir}/.app-password —— 生产环境请用平台 secret 注入`
    );
  }
  if (config.jwtSecretIsFallback) {
    console.warn(
      '⚠️  未设置 JWT_SECRET 环境变量，已生成临时密钥并存入 ' +
        `${config.dataDir}/.session-secret —— 生产环境请用平台 secret 注入`
    );
  }
});

// 素材全文索引：启动时全量重建一次，保证索引与业务表一致。
// 索引重建是应用层行为（bigram 化），所以放这里而不是触发器。
ready
  .then(() => localSearch.rebuildIndex())
  .then((count) => {
    if (count) console.log(`   素材索引: 已重建 ${count} 条`);
  })
  .catch((err) => console.error('素材索引重建失败：', err.message));
