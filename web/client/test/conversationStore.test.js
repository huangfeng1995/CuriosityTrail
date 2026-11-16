import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readChapterConversation,
  readChapterEntry,
  saveChapterConversation,
  clearChapterConversation,
  mapConversationMessages,
} from '../src/components/Assistant/conversationStore.js';
import { restoreChapterConversation } from '../src/components/Assistant/conversationRestore.js';

/** 最小的 localStorage 替身：conversationStore 在调用时才读全局。 */
function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  return data;
}

test('不同作品、不同章节的会话指针互不影响', () => {
  installStorage();

  saveChapterConversation('w1', 'c1', 'conv-a');
  saveChapterConversation('w1', 'c2', 'conv-b');
  saveChapterConversation('w2', 'c1', 'conv-c');

  assert.equal(readChapterConversation('w1', 'c1'), 'conv-a');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-b');
  assert.equal(readChapterConversation('w2', 'c1'), 'conv-c');
  assert.equal(readChapterConversation('w2', 'c2'), '');
  assert.equal(readChapterConversation('', 'c1'), '');
});

test('清空某一章只删这一章，别的章还在', () => {
  installStorage();

  saveChapterConversation('w1', 'c1', 'conv-a');
  saveChapterConversation('w1', 'c2', 'conv-b');
  clearChapterConversation('w1', 'c1');

  assert.equal(readChapterConversation('w1', 'c1'), '');
  assert.equal(readChapterConversation('w1', 'c2'), 'conv-b');
});

test('清空后留下 cleared 标记：兜底恢复不能再把对话拉回来', () => {
  installStorage();

  saveChapterConversation('w1', 'c1', 'conv-a');
  clearChapterConversation('w1', 'c1');

  assert.deepEqual(readChapterEntry('w1', 'c1'), { id: '', cleared: true });
  assert.equal(readChapterEntry('w1', 'c2').cleared, false);
});

test('旧版本的字符串指针仍然读得出来', () => {
  installStorage();
  globalThis.localStorage.setItem(
    'ct.chat.chapter.v1',
    JSON.stringify({ w1: { c1: 'conv-legacy' } })
  );

  assert.equal(readChapterConversation('w1', 'c1'), 'conv-legacy');
  assert.deepEqual(readChapterEntry('w1', 'c1'), { id: 'conv-legacy', cleared: false });
});

test('存储里有脏数据时按「没有」处理，不抛错', () => {
  installStorage();
  globalThis.localStorage.setItem('ct.chat.chapter.v1', '{not json');

  assert.equal(readChapterConversation('w1', 'c1'), '');
  assert.doesNotThrow(() => saveChapterConversation('w1', 'c1', 'conv-a'));
  assert.equal(readChapterConversation('w1', 'c1'), 'conv-a');
});

test('服务端消息映射成消息流：补上章节、角色名与重新生成用的 prompt', () => {
  const roles = [{ key: 'writer', icon: '✎', name: '写手' }];
  const list = mapConversationMessages(
    [
      { id: 'm1', role: 'user', content: '把这段收一收' },
      {
        id: 'm2',
        role: 'assistant',
        roleKey: 'writer',
        content: '改好了',
        action: 'replace',
        findings: [{ id: 'f1' }],
        toolTrace: [{ tool: 'search' }],
      },
    ],
    roles,
    'c1'
  );

  assert.equal(list.length, 2);
  assert.equal(list[0].chapterId, 'c1');
  assert.equal(list[0].serverMessageId, 'm1');
  assert.equal(list[1].roleLabel, '✎ 写手');
  assert.equal(list[1].chapterId, 'c1');
  assert.equal(list[1].prompt, '把这段收一收');
  assert.equal(list[1].applied, false);
  assert.deepEqual(list[1].findings, [{ id: 'f1' }]);
  assert.deepEqual(list[1].toolTrace, [{ tool: 'search' }]);
});

// ---------------------------------------------------------------------------
// 恢复：指针优先，没指针按作品兜底
// ---------------------------------------------------------------------------

const MSG_SET = {
  id: 'conv-latest',
  messages: [
    { id: 'm1', role: 'user', content: '继续写' },
    { id: 'm2', role: 'assistant', roleKey: 'writer', content: '写好了' },
  ],
};

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) return { ok: false, json: async () => ({ error: 'not found' }) };
    return { ok: true, json: async () => routes[hit] };
  };
  impl.calls = calls;
  return impl;
}

test('没有指针时按作品兜底：恢复最近一条会话，并绑定到当前章', async () => {
  installStorage();

  const fetchImpl = fakeFetch({
    '/api/ai/conversations?workId=w1': [{ id: 'conv-latest', messageCount: 2 }],
    '/api/ai/conversations/conv-latest/messages': MSG_SET,
  });

  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'latest');
  assert.equal(restored.conversationId, 'conv-latest');
  assert.equal(restored.messages.length, 2);
  assert.equal(restored.lastRoleKey, 'writer');
  // 兜底之后要落指针，否则下次进来又会跳到别处更新的会话
  assert.equal(readChapterConversation('w1', 'c1'), 'conv-latest');
});

test('有指针时按章恢复，不去请求作品会话列表', async () => {
  installStorage();
  saveChapterConversation('w1', 'c1', 'conv-mine');

  const fetchImpl = fakeFetch({
    '/api/ai/conversations/conv-mine/messages': { id: 'conv-mine', messages: MSG_SET.messages },
  });

  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'pointer');
  assert.equal(restored.conversationId, 'conv-mine');
  assert.equal(fetchImpl.calls.length, 1);
});

test('指针指向的会话已不存在时继续兜底', async () => {
  installStorage();
  saveChapterConversation('w1', 'c1', 'conv-gone');

  const fetchImpl = fakeFetch({
    '/api/ai/conversations/conv-gone/messages': null,
    '/api/ai/conversations?workId=w1': [{ id: 'conv-latest' }],
    '/api/ai/conversations/conv-latest/messages': MSG_SET,
  });

  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'latest');
  assert.equal(restored.conversationId, 'conv-latest');
});

test('作者点过清空就不再兜底，也不发任何请求', async () => {
  installStorage();
  clearChapterConversation('w1', 'c1');

  const fetchImpl = fakeFetch({});
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'cleared');
  assert.equal(restored.conversationId, null);
  assert.equal(restored.messages.length, 0);
  assert.deepEqual(fetchImpl.calls, []);
});

test('别的章已有指针时，这一章不兜底、也不请求会话列表', async () => {
  installStorage();
  saveChapterConversation('w1', 'c1', 'conv-a');

  // c2 没有任何指针：不能借用 c1 的会话
  const fetchImpl = fakeFetch({
    '/api/ai/conversations?workId=w1': [{ id: 'conv-a' }],
    '/api/ai/conversations/conv-a/messages': MSG_SET,
  });
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c2',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'isolated');
  assert.equal(restored.messages.length, 0);
  assert.deepEqual(fetchImpl.calls, []);
  assert.equal(readChapterConversation('w1', 'c2'), '');
});

test('别的章只是清空过，也不把它的旧会话借过来', async () => {
  installStorage();
  clearChapterConversation('w1', 'c1');

  const fetchImpl = fakeFetch({
    '/api/ai/conversations?workId=w1': [{ id: 'conv-a' }],
  });
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c2',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'isolated');
  assert.deepEqual(fetchImpl.calls, []);
});

test('指针失效时，别的章有指针就不再兜底', async () => {
  installStorage();
  saveChapterConversation('w1', 'c1', 'conv-gone');
  saveChapterConversation('w1', 'c2', 'conv-b');

  const fetchImpl = fakeFetch({
    '/api/ai/conversations/conv-gone/messages': null,
    '/api/ai/conversations?workId=w1': [{ id: 'conv-b' }],
  });
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'isolated');
  assert.equal(restored.messages.length, 0);
  assert.equal(readChapterConversation('w1', 'c1'), 'conv-gone');
});

test('指针失效且整部作品没有别的章指针时才兜底', async () => {
  installStorage();
  saveChapterConversation('w1', 'c1', 'conv-gone');

  const fetchImpl = fakeFetch({
    '/api/ai/conversations/conv-gone/messages': null,
    '/api/ai/conversations?workId=w1': [{ id: 'conv-latest' }],
    '/api/ai/conversations/conv-latest/messages': MSG_SET,
  });
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'latest');
  assert.equal(restored.conversationId, 'conv-latest');
  assert.equal(readChapterConversation('w1', 'c1'), 'conv-latest');
});

test('作品没有任何会话时安静返回空', async () => {
  installStorage();

  const fetchImpl = fakeFetch({ '/api/ai/conversations?workId=w1': [] });
  const restored = await restoreChapterConversation({
    workId: 'w1',
    chapterId: 'c1',
    roles: [],
    fetchImpl,
  });

  assert.equal(restored.source, 'none');
  assert.equal(restored.messages.length, 0);
  assert.equal(readChapterConversation('w1', 'c1'), '');
});
