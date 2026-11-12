'use strict';

/**
 * 出现位置扫描 / 全文改名的接口测试。
 *
 * 走真服务、真鉴权：这两个接口碰的是正文，权限和落库都不能只靠纯函数测试保证。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR
const env = setupTempEnv();

const app = require('../app');
const { ready } = require('../database');

let server;

async function createWork(title) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function createChapter(workId, title, blocks) {
  const created = await server.request(`/api/works/${workId}/chapters`, {
    method: 'POST',
    body: { title },
  });
  assert.strictEqual(created.status, 200);
  const chapter = await created.json();

  const saved = await server.request(`/api/chapters/${chapter.id}`, {
    method: 'PUT',
    body: { blocks },
  });
  assert.strictEqual(saved.status, 200);
  return chapter;
}

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('scan：本名与别名都能统计到，按章返回', async () => {
  const work = await createWork('扫描测试');
  await createChapter(work.id, '第一章', [
    { id: 'b1', type: 'paragraph', content: '王二推门进来，老陈抬头。' },
    { id: 'b2', type: 'dialogue', speaker: '王二', content: '谁？' },
  ]);
  await createChapter(work.id, '第二章', [
    { id: 'b3', type: 'paragraph', content: '屋里没人。' },
  ]);

  const charRes = await server.request('/api/characters', {
    method: 'POST',
    body: { workId: work.id, name: '王二', aliases: '老陈' },
  });
  assert.strictEqual(charRes.status, 200);
  const character = await charRes.json();

  const res = await server.request('/api/occurrences/scan', {
    method: 'POST',
    body: {
      workId: work.id,
      items: [{ key: character.id, words: ['王二', '老陈'] }],
    },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  const stat = data[character.id];
  assert.strictEqual(stat.total, 3);
  assert.strictEqual(stat.chapters.length, 1);
  assert.strictEqual(stat.chapters[0].chapterTitle, '第一章');
  assert.strictEqual(stat.chapters[0].count, 3);
});

test('replace：改写正文、返回处数，且改名后不再命中旧名', async () => {
  const work = await createWork('改名测试');
  const chapter = await createChapter(work.id, '第一章', [
    { id: 'b1', type: 'paragraph', content: '王二走了，王二又回来了。' },
    { id: 'b2', type: 'dialogue', speaker: '王二', content: '别动' },
  ]);

  const before = await server.request('/api/occurrences/scan', {
    method: 'POST',
    body: { workId: work.id, items: [{ key: 'k', words: ['王二'] }] },
  });
  assert.strictEqual((await before.json()).k.total, 3);

  const res = await server.request('/api/occurrences/replace', {
    method: 'POST',
    body: { workId: work.id, words: ['王二'], replacement: '李四' },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.replaced, 3);
  assert.strictEqual(data.chapters[0].chapterId, chapter.id);

  // 落库结果
  const detail = await server.request(`/api/chapters/${chapter.id}`);
  const saved = await detail.json();
  const blocks = JSON.parse(saved.blocks);
  assert.strictEqual(blocks[0].content, '李四走了，李四又回来了。');
  assert.strictEqual(blocks[1].speaker, '李四');
  assert.ok(saved.content.includes('李四'));

  // 旧名已经不存在
  const after = await server.request('/api/occurrences/scan', {
    method: 'POST',
    body: { workId: work.id, items: [{ key: 'k', words: ['王二'] }] },
  });
  assert.strictEqual((await after.json()).k.total, 0);
});

test('replace：不误伤更长的其他人物名', async () => {
  const work = await createWork('保护名单测试');
  await createChapter(work.id, '第一章', [
    { id: 'b1', type: 'paragraph', content: '王二狗和王二一起走了' },
  ]);

  await server.request('/api/characters', {
    method: 'POST',
    body: { workId: work.id, name: '王二狗' },
  });

  const res = await server.request('/api/occurrences/replace', {
    method: 'POST',
    body: { workId: work.id, words: ['王二'], replacement: '李四' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).replaced, 1);
});

test('replace：缺参数返回 400', async () => {
  const work = await createWork('参数测试');
  const res = await server.request('/api/occurrences/replace', {
    method: 'POST',
    body: { workId: work.id, words: ['王二'] },
  });
  assert.strictEqual(res.status, 400);
});

test('scan / replace：别人的作品一律 404', async () => {
  const work = await createWork('隔离测试');
  await createChapter(work.id, '第一章', [
    { id: 'b1', type: 'paragraph', content: '王二在。' },
  ]);

  const otherCookie = await server.loginAs('13900000002');

  const scanRes = await server.requestAs(otherCookie, '/api/occurrences/scan', {
    method: 'POST',
    body: { workId: work.id, items: [{ key: 'k', words: ['王二'] }] },
  });
  assert.strictEqual(scanRes.status, 404);

  const replaceRes = await server.requestAs(otherCookie, '/api/occurrences/replace', {
    method: 'POST',
    body: { workId: work.id, words: ['王二'], replacement: '李四' },
  });
  assert.strictEqual(replaceRes.status, 404);
});
