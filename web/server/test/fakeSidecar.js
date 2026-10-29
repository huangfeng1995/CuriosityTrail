'use strict';

/**
 * 假 sidecar：用内存 Map 实现 /index、/query、/delete、/health。
 *
 * 存在的唯一理由是让 Node 侧的集成测试不依赖 Python。
 * CI 环境没有 openviking 也不该装——但"sidecar 挂了对话还能用"
 * "跨用户隔离"这类逻辑必须被测到，就只能自己起一个。
 *
 * 它按真实 sidecar 的契约实现，包括：
 *  - 写入同一个 URI 会覆盖（真实 sidecar 是"先删后写"，这里直接覆盖）
 *  - 查询只返回 targetUri 前缀下的条目（真实 sidecar 用 prefix 过滤）
 *  - 打分是简单的字符重合度，够用来验证排序与阈值逻辑
 *  - 可以被注入故障：500、超时、进程未启动
 */

const http = require('http');

/**
 * 起一个假 sidecar。
 *
 * @param {object} [options]
 * @param {string} [options.model] health 返回的模型名
 * @param {number} [options.dim] health 返回的维度
 * @returns {Promise<{url: string, store: Map, setFault: Function, close: Function}>}
 */
async function startFakeSidecar(options = {}) {
  /** uri -> text */
  const store = new Map();

  /** 写入次数。用来验证"重建真的重新向量化了一遍"，而不只是重排了队列。 */
  let indexCalls = 0;

  /** 注入的故障：null | 'error' | 'badrequest' | 'timeout' | 'unavailable' */
  let fault = null;

  const model = options.model || 'fake-embedding-model';
  const dim = options.dim || 2048;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (fault === 'unavailable') {
        req.socket.destroy();
        return;
      }
      if (fault === 'timeout') {
        // 永不响应，交给调用方的超时处理
        return;
      }
      if (fault === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: '假 sidecar 故障' }));
        return;
      }
      if (fault === 'badrequest') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'URI 不合法' }));
        return;
      }

      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch (e) {
        body = {};
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, model, dim }));
        return;
      }

      if (req.method === 'POST' && req.url === '/index') {
        if (!body.uri || !body.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'uri 与 text 必填' }));
          return;
        }
        store.set(body.uri, String(body.text));
        indexCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rootUri: body.uri }));
        return;
      }

      if (req.method === 'DELETE' && req.url === '/index') {
        if (!body.uri) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ detail: 'uri 必填' }));
          return;
        }
        // 真实 sidecar 删除目录是递归的，这里把同前缀的都删掉
        for (const key of [...store.keys()]) {
          if (key === body.uri || key.startsWith(body.uri)) {
            store.delete(key);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && req.url === '/query') {
        const { query = '', targetUri = '', limit = 16, minScore = 0 } = body;
        const results = [];
        for (const [uri, text] of store.entries()) {
          if (targetUri && !uri.startsWith(targetUri)) continue;
          const score = similarity(query, text);
          if (score < minScore) continue;
          results.push({ uri, fileUri: `${uri}/0.md`, score, text });
        }
        results.sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results: results.slice(0, limit) }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'not found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    store,
    /** 累计写入次数。 */
    get indexCalls() {
      return indexCalls;
    },
    /**
     * 注入故障。传 null 恢复正常。
     * @param {null|'error'|'timeout'|'unavailable'} next
     */
    setFault(next) {
      fault = next;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * 极简相似度：查询里有多少比例的字符出现在正文里。
 *
 * 不追求真实语义，只要能区分"沾边的"和"完全无关的"，
 * 让去重、权重、阈值这些逻辑可以被确定性地测到。
 *
 * @param {string} query
 * @param {string} text
 * @returns {number}
 */
function similarity(query, text) {
  const q = String(query || '').trim();
  if (!q) return 0;
  const chars = [...new Set([...q])];
  if (!chars.length) return 0;
  let hit = 0;
  for (const ch of chars) {
    if (String(text).includes(ch)) hit += 1;
  }
  return Number((hit / chars.length).toFixed(6));
}

module.exports = { startFakeSidecar, similarity };
