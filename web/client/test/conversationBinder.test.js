import assert from 'node:assert/strict';
import test from 'node:test';

import { createConversationBinding } from '../src/components/Assistant/conversationBinder.js';
import {
  readChapterConversation,
  saveChapterConversation,
  clearChapterConversation,
  readChapterEntry,
} from '../src/components/Assistant/conversationStore.js';

function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

/**
 * 一个可控时序的服务端替身：
 * - 会话列表按 updated_at 倒序返回；
 * - send 开始时还没有新会话（服务端在收到请求后才建）。
 */
function makeServer() {
  const conversations = [
    { id: 'conv-ch1', messageCount: 2, updated_at: 1 },
  ];
  let created = null;
  return {
    conversations,
    createOnSend(id) {
      created = { id, messageCount: 0, updated_at: 2 };
      conversations.unshift(created);
      return created;
    },
    fetch: async (url) => {
      if (url.includes('/api/ai/conversations?workId=')) {
        return { ok: true, json: async () => conversations.slice() };
      }
      return { ok: false, json: async () => ({}) };
    },
  };
}

test('钉住：发问后立刻切章（done 还没到）也要把指针落到发起的章', async () => {
  installStorage();
  const server = makeServer();

  // 第 2 章第一次发问：客户端手上还没有 conversationId
  const binding = createConversationBinding({
    workId: 'w1',
    chapterId: 'c2',
    conversationId: '',
    fetchImpl: server.fetch,
  });

  await binding.start(); // 发送前记下作品现有会话
  server.createOnSend('conv-c2'); // 服务端建好新会话，开始流式返回

  // 作者看到消息刚落就切到第 1 章；此时 done 还没来
  binding.onEvent({ type: 'token' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(readChapterConversation('w1', 'c2'), 'conv-c2');
  // 不能写到当前所在的第 1 章
  assert.equal(readChapterConversation('w1', 'c1'), '');
  binding.dispose();
});

test('钉住：流被刷新打断（永远没有 done）也要留下指针', async () => {
  installStorage();
  const server = makeServer();

  const binding = createConversationBinding({
    workId: 'w1',
    chapterId: 'c2',
    conversationId: '',
    fetchImpl: server.fetch,
  });

  await binding.start();
  server.createOnSend('conv-c2');

  binding.onEvent({ type: 'action' }); // 消息已经出现在界面上
  await new Promise((r) => setTimeout(r, 0));

  // 模拟刷新：binder 不会再收到任何事件，也没有 done
  binding.dispose();

  assert.equal(readChapterConversation('w1', 'c2'), 'conv-c2');
});

test('done 晚到（发问后已切走）时用精确 id 校正指针，仍写发起章', async () => {
  installStorage();
  const server = makeServer();

  const binding = createConversationBinding({
    workId: 'w1',
    chapterId: 'c2',
    conversationId: '',
    fetchImpl: server.fetch,
  });

  await binding.start();
  server.createOnSend('conv-guess');
  binding.onEvent({ type: 'token' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-guess');

  // 作者这时已经在第 1 章了；done 仍然写在发起的第 2 章
  binding.finish('conv-real');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-real');
  assert.equal(readChapterConversation('w1', 'c1'), '');
  binding.dispose();
});

test('继续已有会话：一开始就落指针，不依赖事件', async () => {
  installStorage();
  const server = makeServer();

  const binding = createConversationBinding({
    workId: 'w1',
    chapterId: 'c2',
    conversationId: 'conv-c2',
    fetchImpl: server.fetch,
  });

  await binding.start();
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-c2');
  binding.dispose();
});

test('同一作品同时有两条发送在跑时，谁都不抢认，等 done 各自落', async () => {
  installStorage();
  const server = makeServer();

  const a = createConversationBinding({
    workId: 'w1', chapterId: 'c1', conversationId: '', fetchImpl: server.fetch,
  });
  const b = createConversationBinding({
    workId: 'w1', chapterId: 'c2', conversationId: '', fetchImpl: server.fetch,
  });

  await a.start();
  await b.start();
  server.createOnSend('conv-b');
  a.onEvent({ type: 'token' });
  b.onEvent({ type: 'token' });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(readChapterConversation('w1', 'c1'), '');
  assert.equal(readChapterConversation('w1', 'c2'), '');

  a.finish('conv-a');
  b.finish('conv-b');
  assert.equal(readChapterConversation('w1', 'c1'), 'conv-a');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-b');
});

test('同一次发送里出现多条新会话（其它标签页）时不猜，等 done 精确落', async () => {
  installStorage();
  const server = makeServer();

  const binding = createConversationBinding({
    workId: 'w1', chapterId: 'c2', conversationId: '', fetchImpl: server.fetch,
  });

  await binding.start();
  server.createOnSend('conv-other-tab');
  server.conversations.unshift({ id: 'conv-mine', messageCount: 0, updated_at: 3 });

  binding.onEvent({ type: 'token' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(readChapterConversation('w1', 'c2'), '');

  binding.finish('conv-mine');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-mine');
  binding.dispose();
});

test('清空过的章不会被发送流程复活成旧指针', async () => {
  installStorage();
  clearChapterConversation('w1', 'c2');
  assert.equal(readChapterEntry('w1', 'c2').cleared, true);

  saveChapterConversation('w1', 'c2', 'conv-new');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-new');
  assert.equal(readChapterEntry('w1', 'c2').cleared, false);
});
