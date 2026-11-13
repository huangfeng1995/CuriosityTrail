import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readChapterConversation,
  saveChapterConversation,
  clearChapterConversation,
  mapConversationMessages,
} from '../src/components/Assistant/conversationStore.js';

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
