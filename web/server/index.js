'use strict';

/**
 * 服务入口。
 *
 * 只做启动相关的事：单实例校验、监听端口、素材索引重建、定时备份。
 * 路由装配在 app.js 里，这样测试能单独 require app 而不触发 listen。
 */

const config = require('./config');

const { checkSingleInstance } = require('./middleware/singleInstance');
const { ready, close: closeDatabase } = require('./database');
const localSearch = require('./services/search/local');
const backup = require('./services/backup');

// ---------------------------------------------------------------------------
// 单实例校验：多实例并发写 SQLite 会损坏数据库，稿子全丢
// ---------------------------------------------------------------------------
const instanceCheck = checkSingleInstance();
if (!instanceCheck.ok) {
  console.error('❌ 启动中止：' + instanceCheck.reason);
  process.exit(1);
}

const app = require('./app');
const drain = require('./services/drain');
const PORT = config.port;

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   环境: ${config.nodeEnv}`);
  console.log(`   数据目录: ${config.dataDir}`);
  console.log(
    `   DEEPSEEK_API_KEY: ${config.deepseekApiKey ? '已加载' : '未配置（将回退到本地 Ollama）'}`
  );
  if (config.smsFixedMode) {
    console.warn(
      `⚠️  固定验证码模式：${config.smsFixedPhones.join('、')} 的登录验证码固定为 ${config.smsFixedCode}（未发送短信）`
    );
  } else if (config.smsDevMode) {
    console.warn(
      `⚠️  短信开发模式：验证码固定为 ${config.smsDevCode}（仅非 production 生效）`
    );
  } else if (!config.smsConfigured) {
    console.warn(
      '⚠️  未配置阿里云短信（ALIYUN_SMS_ACCESS_KEY_ID / SECRET / SIGN_NAME / TEMPLATE_CODE），' +
        '生产环境下用户将无法收到验证码'
    );
  } else {
    console.log('   短信服务: 阿里云短信已配置');
  }
  if (config.jwtSecretIsFallback) {
    console.warn(
      '⚠️  未设置 JWT_SECRET 环境变量，已生成临时密钥并存入 ' +
        `${config.dataDir}/.session-secret —— 生产环境请用平台 secret 注入`
    );
  }
  if (config.backupOffsiteDir) {
    console.log(`   异地备份目录: ${config.backupOffsiteDir}`);
  }
});

// ---------------------------------------------------------------------------
// 优雅停机
// ---------------------------------------------------------------------------
//
// 部署重建容器时 Docker 会发 SIGTERM。默认行为是立刻退出，
// 在途的 SSE 生成被掐断——作者看到的是一句 network error。
//
// 这里的顺序：
//   1. 停止接收新连接
//   2. 新请求立刻被拒（作者知道要等，而不是干等）
//   3. 等在途请求自己收尾，最多 SHUTDOWN_GRACE_MS
//   4. 超时才硬退
//
// 收尾时间要略小于 Docker 的 stop_grace_period（compose 里设 210s），
// 否则 Docker 会先动手，我们的收尾就白做了。
//
// 180s 不是随便取的：一轮 AI 生成最长允许跑 300s（routes/ai.js），
// 写一章长文经常要一两分钟。收尾时间给不到这个量级，
// 停机照样会把作者的稿子掐在半路。
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS || 180000);

let shuttingDown = false;

/**
 * 收尾退出。
 *
 * 不直接 process.exit()：stdout 接到管道时（容器日志就是）写入是异步的，
 * process.exit 会把还没写出去的日志截断——停机日志会整段消失，
 * 事后没法判断排空到底有没有生效。
 *
 * 正确做法是关掉数据库、让事件循环自己排空，进程自然退出时
 * stdout 才算写完。兜底定时器用 unref：只有真有别的句柄吊着进程时
 * 它才会触发（那种情况日志丢一行也比进程吊死强）。
 */
function exitCleanly() {
  process.exitCode = 0;

  // 兜底：万一还有句柄吊着进程，5 秒后强制退。
  // unref 保证正常情况下它不影响进程自然退出。
  setTimeout(() => process.exit(0), 5000).unref();
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  const pending = drain.activeCount();
  console.log(`\n收到 ${signal}，开始优雅停机（在途请求 ${pending} 个）`);

  drain.beginDrain();

  // 不再接新连接（已建立的连接不受影响，让它们跑完）
  server.close();

  // 等在途请求收尾。AI 生成最长可能跑一分多钟，
  // 所以这里的等待时间要够——不够的话照样会打断作者。
  const result = await drain.waitForDrain(SHUTDOWN_GRACE_MS);
  if (!result.drained) {
    console.warn(`仍有 ${result.active} 个请求未收尾，强制退出`);
    server.closeAllConnections?.();
    exitCleanly();
    return;
  }

  console.log('在途请求已收尾，退出');

  // 空闲的 keep-alive 连接会吊着 server.close() 不返回，主动断掉
  server.closeIdleConnections?.();

  // 关掉定时备份的定时器与数据库连接，进程才能自然退出
  backup.stopScheduledBackup();
  await closeDatabase().catch(() => {});

  exitCleanly();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 素材全文索引：启动时全量重建一次，保证索引与业务表一致。
// 索引重建是应用层行为（bigram 化），所以放这里而不是触发器。
ready
  .then(() => localSearch.rebuildIndex())
  .then((count) => {
    if (count) console.log(`   素材索引: 已重建 ${count} 条`);
  })
  .catch((err) => console.error('素材索引重建失败：', err.message));

// 定时备份。BACKUP_HOUR 指定每天几点（0-23），默认凌晨 3 点；
// 设成 -1 可以关掉。
const backupHour = process.env.BACKUP_HOUR === undefined ? 3 : Number(process.env.BACKUP_HOUR);
if (Number.isInteger(backupHour) && backupHour >= 0 && backupHour <= 23) {
  backup.startScheduledBackup(backupHour);
}
