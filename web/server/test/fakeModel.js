'use strict';

/**
 * 假的 OpenAI 兼容端点。
 *
 * 起一个真的 HTTP 服务，把它当成真正的 DeepSeek 端点用——
 * 好处是 finish_reason 的捕获、SSE 的解析、路由的兜底逻辑全都在测试射程内。
 *
 * 行为由外部注入：每轮请求取一个 behavior。
 * 支持按次序返回不同响应（队列），用来测多步循环。
 */

const http = require('http');

/**
 * @param {Object} [options]
 * @param {Array} [options.queue] 按次序返回的响应。取完就用 defaultBehavior。
 * @param {Object} [options.defaultBehavior]
 * @returns {Promise<{server, close, setQueue, setDefault, calls}>}
 */
function startFakeModel(options = {}) {
  return new Promise((resolve) => {
    const sockets = new Set();
    let queue = Array.isArray(options.queue) ? [...options.queue] : [];
    let defaultBehavior = options.defaultBehavior || { content: '', finishReason: 'stop' };
    const calls = [];

    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch (e) {
          body = {};
        }

        calls.push(body);

        const b = queue.length ? queue.shift() : defaultBehavior;

        // 模拟供应商直接报错（限流、鉴权失败等）
        if (b.httpStatus) {
          res.writeHead(b.httpStatus, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: b.errorMessage || '供应商出错了' } }));
          return;
        }

        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: b.content || '',
                    reasoning_content: b.reasoning || '',
                  },
                  finish_reason: b.finishReason || 'stop',
                },
              ],
            })
          );
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (b.reasoning) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { reasoning_content: b.reasoning }, finish_reason: null }],
            })}\n\n`
          );
        }
        if (b.content) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: b.content }, finish_reason: null }],
            })}\n\n`
          );
        }
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: b.finishReason || 'stop' }],
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    // 记住连接：测试结束时必须主动断开。
    // 只调 close() 是不够的——keep-alive 的空闲连接会让 close 一直等下去，
    // 子进程迟迟不退出，测试运行器那边就会冒出莫名的 IPC 反序列化失败。
    srv.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    srv.listen(0, '127.0.0.1', () =>
      resolve({
        server: srv,
        calls,
        setQueue(next) {
          queue = [...next];
        },
        setDefault(next) {
          defaultBehavior = next;
        },
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => srv.close(done));
        },
      })
    );
  });
}

module.exports = { startFakeModel };
