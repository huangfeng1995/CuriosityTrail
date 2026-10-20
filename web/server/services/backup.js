'use strict';

/**
 * 备份服务。
 *
 * 备份 = 一个 zip，里面是 SQLite 库 + 上传的图片 + 导入的原始文档。
 * 手动备份走 HTTP 下载，定时备份写到 DATA_DIR/backups/ 下并滚动保留。
 *
 * 定时用"算下一次触发时间 + setTimeout"实现，不用额外依赖：
 * 一天一次而已，node-cron 带来的收益抵不上多一个依赖的麻烦。
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const config = require('../config');

const BACKUP_DIR = path.join(config.dataDir, 'backups');

// 保留最近多少份。超出的删掉——磁盘是有限的。
const KEEP_COUNT = 7;

let timer = null;

/**
 * 生成本地时间戳，形如 2026-10-21-03-00-00。
 *
 * 不用 toISOString()：那是 UTC，跟界面上显示的本地时间差 8 小时，
 * 用户看文件名会以为备份时间不对。定宽格式还能让文件名按字典序 = 按时间序。
 */
function localStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`
  );
}

/**
 * 写一个备份 zip 到磁盘。
 * @param {string} [label] 文件名里的标记，默认按日期
 * @returns {Promise<{ok: boolean, file?: string, size?: number, reason?: string}>}
 */
async function createBackup(label) {
  const stamp = localStamp();
  const name = label ? `curiosity-backup-${label}-${stamp}.zip` : `curiosity-backup-${stamp}.zip`;
  const target = path.join(BACKUP_DIR, name);

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const output = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const done = new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });

    archive.pipe(output);

    const dbPath = path.join(config.dataDir, 'curiosity.db');
    if (fs.existsSync(dbPath)) {
      archive.file(dbPath, { name: 'curiosity.db' });
    }
    if (fs.existsSync(config.uploadsDir)) {
      archive.directory(config.uploadsDir, 'uploads');
    }
    if (fs.existsSync(config.docsDir)) {
      archive.directory(config.docsDir, 'documents');
    }

    await archive.finalize();
    await done;

    pruneOldBackups();
    return { ok: true, file: target, size: fs.statSync(target).size };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 删掉超出保留份数的旧备份。
 */
function pruneOldBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const filePath = path.join(BACKUP_DIR, f);
        return { name: f, path: filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      // 按修改时间倒序。不能用文件名字典序：名字里带 label
      // （auto/manual），字典序会把所有 auto 排到 manual 前面，
      // 清理时就可能先删掉更新的手动备份。
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of files.slice(KEEP_COUNT)) {
      fs.unlinkSync(file.path);
    }
  } catch (e) {
    // 清理失败不影响备份本身
  }
}

/**
 * 列出磁盘上的备份。
 */
function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch (e) {
    return [];
  }
}

/**
 * 下一次触发的时刻（每天 hour 点）。
 */
function nextRunAt(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * 启动定时备份。
 * @param {number} hour 每天几点（0-23）
 */
function startScheduledBackup(hour) {
  stopScheduledBackup();

  const schedule = () => {
    const at = nextRunAt(hour);
    const delay = at.getTime() - Date.now();
    console.log(`   定时备份: 每天 ${String(hour).padStart(2, '0')}:00，下次 ${at.toLocaleString('zh-CN')}`);

    timer = setTimeout(async () => {
      const result = await createBackup('auto');
      if (result.ok) {
        console.log(`   定时备份完成：${path.basename(result.file)}`);
      } else {
        console.error('   定时备份失败：' + result.reason);
      }
      schedule();
    }, delay);
    timer.unref();
  };

  schedule();
}

function stopScheduledBackup() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = {
  createBackup,
  listBackups,
  pruneOldBackups,
  startScheduledBackup,
  stopScheduledBackup,
  BACKUP_DIR,
};
