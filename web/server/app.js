'use strict';

/**
 * Express 应用装配。
 *
 * 与 index.js 分开是为了让测试能直接拿到 app 实例：
 * 测试要在随机端口上起一个真服务跑路由断言，
 * 而 index.js 一被 require 就 app.listen 了，端口和数据目录都控制不住。
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
const versionsRouter = require('./routes/versions');
const plotCardsRouter = require('./routes/plotCards');
const progressRouter = require('./routes/progress');
const consistencyRouter = require('./routes/consistency');
const memoryRouter = require('./routes/memory');

const app = express();

// Fly.io 等平台在反代后面，需信任代理才能拿到真实客户端 IP（限流依赖）
app.set('trust proxy', 1);

// 基本安全响应头。
//   nosniff —— 别让浏览器按内容猜类型，配合 /uploads 只存图片的约束，
//              上传的东西不会被当成 HTML 执行
//   DENY    —— 禁止被别的站点套 iframe，挡点击劫持
//   referrer 略紧一点，少往外漏路径
// HTTPS 强制由 fly.toml 的 force_https 负责，这里不用重复设 HSTS。
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// 生产环境前后端同域，不需要 CORS；开发环境放开供 vite dev server 直连
if (config.enableCors) {
  const cors = require('cors');
  app.use(cors({ origin: config.appOrigin, credentials: true }));
}

app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

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
app.use('/api/versions', versionsRouter);
app.use('/api/plot-cards', plotCardsRouter);
app.use('/api/progress', progressRouter);
app.use('/api/consistency', consistencyRouter);
app.use('/api/memory', memoryRouter);

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

// 统一错误处理。
// Express 默认的错误页会把整个堆栈（含服务器绝对路径）吐给浏览器，
// 上传被拒之类的错误也走这条路。堆栈只进服务端日志，前端只拿一句人话。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(`请求出错 ${req.method} ${req.path}：`, err.message);

  let status = Number(err.status) || 500;
  let message = '服务器内部错误';
  if (err.code === 'LIMIT_FILE_SIZE') {
    status = 413;
    message = '文件太大';
  } else if (err.name === 'MulterError') {
    status = 400;
    message = '上传参数有误';
  } else if (status >= 400 && status < 500) {
    // 各路由显式构造的客户端错误（带 status），message 是给用户看的
    message = err.message;
  }
  res.status(status).json({ error: message });
});

module.exports = app;
