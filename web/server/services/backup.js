'use strict';

/**
 * 备份服务。
 *
 * 备份 = 一个 zip，里面是 SQLite 库 + 上传的图片 + 导入的原始文档。
 * 手动备份走 HTTP 下载，定时备份写到 DATA_DIR/backups/ 下并滚动保留。
 *
 * 异地备份：本地备份跟数据库在同一个卷上，卷坏了备份一起没。
 * 配了 BACKUP_OFFSITE_DIR 之后，每份备份会额外复制一份到那个目录，
 * 并在那里按自己的保留份数滚动清理（默认 30 份，比本地多）。
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

    // 异地复制失败不算备份失败：本地这份已经写好了，
    // 只是没多一份保险。分开报告，作者才知道到底存没存上。
    let offsite = null;
    if (config.backupOffsiteDir) {
      offsite = await copyOffsite(target);
    }

    return { ok: true, file: target, size: fs.statSync(target).size, offsite };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 把备份复制到异地目录，并清理旧档。
 *
 * @param {string} source 本地备份文件路径
 * @returns {Promise<{ok: boolean, file?: string, reason?: string}>}
 */
async function copyOffsite(source) {
  const dir = config.backupOffsiteDir;
  if (!dir) return { ok: false, reason: '未配置异地备份目录' };

  try {
    fs.mkdirSync(dir, { recursive: true });

    const target = path.join(dir, path.basename(source));
    // copyFile 不用 rename：源和目标可能在不同卷上，rename 会报 EXDEV
    fs.copyFileSync(source, target);

    pruneOffsiteBackups();

    return { ok: true, file: target };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/**
 * 清理异地目录里超出保留份数的旧备份。
 */
function pruneOffsiteBackups() {
  const dir = config.backupOffsiteDir;
  if (!dir) return 0;

  try {
    if (!fs.existsSync(dir)) return 0;
    const keep = Number(config.backupOffsiteKeep) || 30;

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const filePath = path.join(dir, f);
        return { path: filePath, mtime: fs.statSync(filePath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    let removed = 0;
    for (const file of files.slice(keep)) {
      fs.unlinkSync(file.path);
      removed += 1;
    }
    return removed;
  } catch (e) {
    return 0;
  }
}

/**
 * 列出异地目录里的备份。
 */
function listOffsiteBackups() {
  const dir = config.backupOffsiteDir;
  if (!dir) return [];
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch (e) {
    return [];
  }
}

/**
 * 异地备份的总体状态。给设置页显示用。
 */
function offsiteStatus() {
  const dir = config.backupOffsiteDir;
  if (!dir) {
    return { enabled: false, dir: '', keep: 0, count: 0, latest: null };
  }
  const list = listOffsiteBackups();
  return {
    enabled: true,
    dir,
    keep: Number(config.backupOffsiteKeep) || 30,
    count: list.length,
    latest: list[0] || null,
  };
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
  copyOffsite,
  listOffsiteBackups,
  offsiteStatus,
  BACKUP_DIR,
};
