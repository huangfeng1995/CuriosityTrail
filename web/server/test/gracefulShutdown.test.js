'use strict';

/**
 * 优雅停机回归测试。
 *
 * 盯的是一件具体的事：**收到 SIGTERM 之后，进程到底做了什么**。
 *
 * 曾经踩的坑：
 * 单实例锁（middleware/singleInstance.js）自己也监听了 SIGTERM，
 * 而且它注册得比 index.js 的优雅停机早。Node 按注册顺序调用监听器，
 * 于是锁文件的 handler 先跑、直接 process.exit(0)——进程当场死掉，
 * 优雅停机（在途请求收尾、停机记录落盘）一次都没执行。
 *
 * 症状很隐蔽：退出码是 0（看着像正常退），日志和记录全都没有。
 * 单元测试也测不出来，因为测试环境设了 ALLOW_MULTI_INSTANCE=1，
 * 根本不注册锁文件的清理逻辑。
 *
 * 所以这个文件用**真子进程**测：起一个真的 index.js，给它发真的 SIGTERM，
 * 看它是不是真的把停机记录写了。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const SERVER_DIR = path.join(__dirname, '..');
const INDEX_JS = path.join(SERVER_DIR, 'index.js');

/**
 * 找一个空闲端口。
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 起一个真的服务器子进程。
 *
 * 注意：这里**不设** ALLOW_MULTI_INSTANCE——正是要覆盖
 * 「单实例锁注册了 SIGTERM 清理」这条真实生产路径。
 *
 * @param {Object} [options]
 * @returns {Promise<{child: Object, dataDir: string, port: number, stop: Function}>}
 */
async function startServerProcess(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-shutdown-'));
  const port = options.port || (await freePort());

  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      PORT: String(port),
      JWT_SECRET: 'test-jwt-secret-for-shutdown-test',
      SMS_DEV_CODE: '246810',
      BACKUP_HOUR: '-1',
      ALLOW_MULTI_INSTANCE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  // 等它起来
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`服务器没能在 20 秒内起来。输出：\n${output}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        await res.json();
        break;
      }
    } catch (e) {
      // 还没监听，再等
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    child,
    dataDir,
    port,
    getOutput: () => output,
    /**
     * 发 SIGTERM 并等进程退出。
     * @returns {Promise<{code: number|null, signal: string|null}>}
     */
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const exited = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      child.kill('SIGTERM');
      return exited;
    },
    cleanup() {
      try { child.kill('SIGKILL'); } catch (e) { /* 已经死了 */ }
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 无所谓 */ }
    },
  };
}

test('优雅停机：收到 SIGTERM 会把停机记录写进数据目录', async () => {
  const srv = await startServerProcess();
  try {
    const result = await srv.stop();

    assert.strictEqual(result.code, 0, `进程应以 0 退出，实际：${JSON.stringify(result)}`);

    const recordFile = path.join(srv.dataDir, 'last-shutdown.json');
    assert.ok(
      fs.existsSync(recordFile),
      `停机记录没写出来。进程输出：\n${srv.getOutput()}`
    );

    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.strictEqual(record.signal, 'SIGTERM');
    assert.strictEqual(record.drained, true, '没有在途请求，应该排空成功');
    assert.strictEqual(record.pendingRequests, 0);
    assert.strictEqual(record.remaining, 0);
    assert.ok(record.startedAt, '要有开始时间');
    assert.ok(record.finishedAt, '要有结束时间');
  } finally {
    srv.cleanup();
  }
});

test('优雅停机：日志里能看到停机过程', async () => {
  const srv = await startServerProcess();
  try {
    await srv.stop();
    const output = srv.getOutput();

    assert.ok(
      output.includes('优雅停机'),
      `日志里没有停机提示，说明 shutdown 根本没跑。输出：\n${output}`
    );
    assert.ok(
      output.includes('收尾'),
      `日志里没有收尾结果。输出：\n${output}`
    );
  } finally {
    srv.cleanup();
  }
});

test('单实例锁：不自己抢 SIGTERM，把退出交给统一流程', async () => {
  // 这条锁一旦自己监听 SIGTERM 并 process.exit(0)，
  // 就会排在 index.js 的优雅停机前面把进程掐死。
  // 断言它只挂 'exit'，不碰 SIGTERM/SIGINT。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-lock-'));
  const script = `
    process.env.DATA_DIR = ${JSON.stringify(dataDir)};
    process.env.ALLOW_MULTI_INSTANCE = '';
    const { checkSingleInstance } = require(${JSON.stringify(
      path.join(SERVER_DIR, 'middleware', 'singleInstance.js')
    )});
    const result = checkSingleInstance();
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      exitHooks: process.listenerCount('exit'),
    }));
    process.exit(0);
  `;

  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: SERVER_DIR,
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d.toString(); });
    child.on('error', reject);
    child.on('exit', () => resolve(buf));
  });

  try {
    const info = JSON.parse(out);
    assert.strictEqual(info.ok, true, '单实例检查应该通过');
    assert.strictEqual(info.sigterm, 0, '单实例锁不能监听 SIGTERM，否则会抢在优雅停机前面');
    assert.strictEqual(info.sigint, 0, '单实例锁不能监听 SIGINT');
    assert.ok(info.exitHooks >= 1, '退出时还是要释放锁文件');
  } finally {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* 无所谓 */ }
  }
});
