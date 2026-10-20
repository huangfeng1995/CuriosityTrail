'use strict';

/**
 * 单实例校验。
 *
 * Fly.io 的 volume 一次只能挂载到一个 machine。若误操作 `fly scale count 2`，
 * 两个实例会并发写同一个 SQLite 文件，导致数据库损坏——这意味着全部小说稿丢失。
 *
 * 做法：在 DATA_DIR 下写一个带心跳的锁文件，格式 `host:pid:timestamp`。
 * 启动时判断：
 *   - 同主机且 PID 仍存活 → 另一个实例正在运行，拒绝启动
 *   - 同主机但 PID 已死   → 上次崩溃残留，立即接管
 *   - 不同主机且锁仍新鲜 → 另一台机器正在使用同一个卷，拒绝启动
 *   - 不同主机但锁已过期 → 旧机器已销毁，接管
 *
 * 进程每 10 秒刷新心跳，正常退出时删除锁文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const LOCK_FILE = path.join(config.dataDir, '.instance.lock');
const HEARTBEAT_INTERVAL_MS = 10 * 1000;
const LOCK_TTL_MS = 45 * 1000;

let heartbeatTimer = null;

/**
 * 检查当前进程是否可以独占数据目录。
 * @returns {{ok: boolean, reason?: string}}
 */
function checkSingleInstance() {
  // 显式允许多实例时跳过（仅用于将来迁移到有网络文件系统的场景）
  if (process.env.ALLOW_MULTI_INSTANCE === '1') {
    return { ok: true };
  }

  const instanceId = `${os.hostname()}:${process.pid}`;
  let existing = null;

  try {
    existing = fs.readFileSync(LOCK_FILE, 'utf8').trim();
  } catch (e) {
    // 锁文件不存在，说明是首次启动
  }

  if (existing) {
    const [host, pid, stamp] = existing.split(':');
    const age = Date.now() - Number(stamp || 0);

    if (host === os.hostname()) {
      // 同主机：PID 还活着就说明另一个实例在跑；进程没了就是崩溃残留，直接接管
      let alive = false;
      try {
        process.kill(Number(pid), 0);
        alive = true;
      } catch (e) {
        alive = false;
      }
      if (alive && pid !== String(process.pid)) {
        return {
          ok: false,
          reason:
            `检测到另一个实例正在运行（PID ${pid}）。` +
            '多个进程并发写同一个 SQLite 数据库会造成数据损坏。' +
            '请先停止旧进程，或设置 ALLOW_MULTI_INSTANCE=1 显式放行。',
        };
      }
    } else if (age < LOCK_TTL_MS) {
      // 不同主机：锁还在心跳有效期内，说明另一台机器正在使用同一个数据卷
      return {
        ok: false,
        reason:
          `检测到另一台机器正在使用同一个数据目录（${host}，心跳于 ${Math.round(age / 1000)} 秒前）。` +
          'Fly.io 的数据卷只能挂载到一个实例，多实例并发写入会损坏 SQLite 数据库。' +
          '请确认实例数为 1，或设置 ALLOW_MULTI_INSTANCE=1 显式放行。',
      };
    }
  }

  try {
    fs.writeFileSync(LOCK_FILE, `${instanceId}:${Date.now()}`, { mode: 0o600 });
  } catch (e) {
    return { ok: false, reason: `无法写入实例锁文件：${e.message}` };
  }

  startHeartbeat();
  registerCleanup();

  return { ok: true };
}

/** 定时刷新锁文件时间戳，表明本实例仍活着 */
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    try {
      fs.writeFileSync(
        LOCK_FILE,
        `${os.hostname()}:${process.pid}:${Date.now()}`,
        { mode: 0o600 }
      );
    } catch (e) {
      // 心跳写失败不致命：若因权限问题持续失败，锁会过期，其他实例可能接管
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

/** 进程正常退出时释放锁，避免下次启动需要等锁过期 */
function registerCleanup() {
  const release = () => {
    try {
      const current = fs.readFileSync(LOCK_FILE, 'utf8').trim();
      if (current.startsWith(`${os.hostname()}:${process.pid}:`)) {
        fs.unlinkSync(LOCK_FILE);
      }
    } catch (e) {
      // 文件可能已不存在
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    release();
    process.exit(0);
  });
}

module.exports = { checkSingleInstance };
