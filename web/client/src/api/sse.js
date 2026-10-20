/**
 * SSE 消费工具。
 *
 * 后端 /api/ai/chat 返回 `data: {json}\n\n` 格式的事件流，
 * 这里把 ReadableStream 解成一个个事件对象交给回调。
 */

/**
 * @param {string} url
 * @param {Object} body POST 请求体
 * @param {(event: Object) => void} onEvent 每收到一个事件调用一次
 * @param {AbortSignal} [signal]
 */
export async function streamPost(url, body, onEvent, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      const data = await response.json();
      detail = data.error || detail;
    } catch (e) {
      // 响应体不是 JSON，用默认文案
    }
    throw new Error(detail);
  }

  if (!response.body) {
    throw new Error('浏览器不支持流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 事件之间用空行分隔
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEvent(chunk);
        if (event) onEvent(event);
        boundary = buffer.indexOf('\n\n');
      }
    }

    // 收尾时可能还剩半个事件
    const tail = parseEvent(buffer);
    if (tail) onEvent(tail);
  } finally {
    // 释放读锁：否则连接在浏览器看来仍处于 pending，
    // 控制台会刷 net::ERR_ABORTED
    try {
      reader.releaseLock();
    } catch (e) {
      // 流已关闭时会抛错，忽略
    }
  }
}

function parseEvent(chunk) {
  const lines = chunk.split('\n');
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (!dataLines.length) return null;

  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return { type: 'done' };

  try {
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}
