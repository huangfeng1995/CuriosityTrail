'use strict';

/**
 * 服务入口。
 *
 * 只做启动相关的事：单实例校验、监听端口、素材索引重建、定时备份。
 * 路由装配在 app.js 里，这样测试能单独 require app 而不触发 listen。
 */

const config = require('./config');

const { checkSingleInstance } = require('./middleware/singleInstance');
const { ready } = require('./database');
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
const PORT = config.port;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`   环境: ${config.nodeEnv}`);
  console.log(`   数据目录: ${config.dataDir}`);
  console.log(
    `   DEEPSEEK_API_KEY: ${config.deepseekApiKey ? '已加载' : '未配置（将回退到本地 Ollama）'}`
  );
  if (config.smsDevMode) {
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
