'use strict';

/**
 * API 集成测试。
 *
 * 起一个真服务在随机端口上跑，走真实鉴权中间件。
 * 覆盖：作品/章节 CRUD、版本历史、情节卡、写作进度、一致性检查、引用定位。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

// 必须在 require 业务模块之前设好 DATA_DIR——config.js 在加载时就把它定死了
const env = setupTempEnv();

const app = require('../app');
const { ready } = require('../database');

let server;

/** 建一部带章节的作品，返回 work 与 chapter */
async function seedWork() {
  const workRes = await server.request('/api/works', {
    method: 'POST',
    body: { title: '雨夜追踪', genre: '悬疑', synopsis: '一场雨夜的追逐', targetWords: 100000 },
  });
  assert.strictEqual(workRes.status, 200);
  const work = await workRes.json();
  assert.strictEqual(work.title, '雨夜追踪');
  assert.strictEqual(work.target_words, 100000);

  const chapterRes = await server.request(`/api/works/${work.id}/chapters`, {
    method: 'POST',
    body: { title: '第一章 巷口' },
  });
  assert.strictEqual(chapterRes.status, 200);
  const chapter = await chapterRes.json();

  return { work, chapter };
}

/** 写一段正文进章节 */
async function writeChapter(chapterId, text) {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: text },
    { id: 'b2', type: 'dialogue', speaker: '陈默', content: '别动。' },
  ];
  const res = await server.request(`/api/chapters/${chapterId}`, {
    method: 'PUT',
    body: { blocks },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

test('未登录访问业务 API 返回 401', async () => {
  const res = await fetch(`${server.baseUrl}/api/works`);
  assert.strictEqual(res.status, 401);
});

test('健康检查公开可访问', async () => {
  const res = await fetch(`${server.baseUrl}/api/health`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.status, 'ok');
});

test('错误密码不发放会话', async () => {
  const res = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '错误密码' }),
  });
  assert.strictEqual(res.status, 401);
});

// ---------------------------------------------------------------------------
// 作品与章节
// ---------------------------------------------------------------------------

test('创建作品与章节', async () => {
  const { work, chapter } = await seedWork();
  assert.ok(work.id);
  assert.strictEqual(chapter.work_id, work.id);
  assert.strictEqual(chapter.seq, 1);
});

test('保存章节会派生 content 快照并统计字数', async () => {
  const { chapter } = await seedWork();
  const saved = await writeChapter(chapter.id, '雨夜的巷子里只剩下脚步声。');
  assert.ok(saved.content.includes('雨夜的巷子里只剩下脚步声'));
  assert.ok(saved.word_count > 0);
});

test('作品详情包含章节列表', async () => {
  const { work } = await seedWork();
  const res = await server.request(`/api/works/${work.id}`);
  const body = await res.json();
  assert.ok(Array.isArray(body.chapters));
  assert.ok(body.chapters.length >= 1);
});

// ---------------------------------------------------------------------------
// 版本历史
// ---------------------------------------------------------------------------

test('内容变更后自动留下版本快照', async () => {
  const { chapter } = await seedWork();

  // 第一次写入：旧内容为空，不会产生快照（空内容不值得存）
  await writeChapter(chapter.id, '第一版内容。');
  // 第二次写入：旧内容被覆盖，应该留下一份快照
  await writeChapter(chapter.id, '第二版内容，改过了。');

  const res = await server.request(`/api/versions/chapter/${chapter.id}`);
  const list = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(list.length >= 1, '应当至少有一条自动快照');
  assert.strictEqual(list[0].manual, 0);
});

test('手动快照带标签且不会被自动清理', async () => {
  const { chapter } = await seedWork();
  await writeChapter(chapter.id, '正文。');

  const res = await server.request(`/api/versions/chapter/${chapter.id}`, {
    method: 'POST',
    body: { label: '第三章定稿' },
  });
  assert.strictEqual(res.status, 200);
  const version = await res.json();
  assert.strictEqual(version.label, '第三章定稿');
  assert.strictEqual(version.manual, 1);
  assert.ok(version.word_count > 0);
});

test('回滚到历史版本能恢复正文', async () => {
  const { chapter } = await seedWork();

  await writeChapter(chapter.id, '原始内容，别丢。');
  // 建一个手动快照锁住这份内容
  const snapRes = await server.request(`/api/versions/chapter/${chapter.id}`, {
    method: 'POST',
    body: { label: '存档' },
  });
  const snapshot = await snapRes.json();

  // 改坏
  await writeChapter(chapter.id, '改坏了的内容。');
  let current = await (await server.request(`/api/chapters/${chapter.id}`)).json();
  assert.ok(current.content.includes('改坏了的内容'));

  // 回滚
  const restoreRes = await server.request(
    `/api/versions/chapter/${chapter.id}/${snapshot.id}/restore`,
    { method: 'POST' }
  );
  assert.strictEqual(restoreRes.status, 200);
  current = await restoreRes.json();
  assert.ok(current.content.includes('原始内容，别丢。'));
  assert.ok(!current.content.includes('改坏了的内容'));
});

test('回滚不存在的版本返回 404', async () => {
  const { chapter } = await seedWork();
  const res = await server.request(
    `/api/versions/chapter/${chapter.id}/不存在的版本/restore`,
    { method: 'POST' }
  );
  assert.strictEqual(res.status, 404);
});

test('版本详情包含完整正文', async () => {
  const { chapter } = await seedWork();
  await writeChapter(chapter.id, '需要保留的正文。');

  const snapRes = await server.request(`/api/versions/chapter/${chapter.id}`, {
    method: 'POST',
    body: { label: '查看用' },
  });
  const snapshot = await snapRes.json();

  const res = await server.request(`/api/versions/chapter/${chapter.id}/${snapshot.id}`);
  const version = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(version.content.includes('需要保留的正文'));
  assert.ok(Array.isArray(JSON.parse(version.blocks)));
});

// ---------------------------------------------------------------------------
// 情节卡
// ---------------------------------------------------------------------------

test('情节卡增删改查', async () => {
  const { work, chapter } = await seedWork();

  const createRes = await server.request(`/api/plot-cards/work/${work.id}`, {
    method: 'POST',
    body: {
      title: '雨夜追杀',
      chapterId: chapter.id,
      kind: 'plot',
      content: '主角在巷子里被追',
    },
  });
  assert.strictEqual(createRes.status, 200);
  const card = await createRes.json();
  assert.strictEqual(card.title, '雨夜追杀');
  assert.strictEqual(card.chapter_id, chapter.id);
  assert.strictEqual(card.chapter_title, '第一章 巷口');

  // 按章查询能查到
  const byChapter = await server.request(`/api/plot-cards/chapter/${chapter.id}`);
  const chapterCards = await byChapter.json();
  assert.ok(chapterCards.some((c) => c.id === card.id));

  // 改
  const updateRes = await server.request(`/api/plot-cards/${card.id}`, {
    method: 'PUT',
    body: { status: 'done', title: '雨夜追杀（改）' },
  });
  assert.strictEqual(updateRes.status, 200);
  const updated = await updateRes.json();
  assert.strictEqual(updated.status, 'done');
  assert.strictEqual(updated.title, '雨夜追杀（改）');

  // 删
  const deleteRes = await server.request(`/api/plot-cards/${card.id}`, { method: 'DELETE' });
  assert.strictEqual(deleteRes.status, 200);
});

test('情节卡挂到不属于该作品的章节会被拒绝', async () => {
  const { work } = await seedWork();
  const other = await seedWork();

  const res = await server.request(`/api/plot-cards/work/${work.id}`, {
    method: 'POST',
    body: { title: '越界卡片', chapterId: other.chapter.id },
  });
  assert.strictEqual(res.status, 400);
});

test('情节卡标题为空返回 400', async () => {
  const { work } = await seedWork();
  const res = await server.request(`/api/plot-cards/work/${work.id}`, {
    method: 'POST',
    body: { title: '   ' },
  });
  assert.strictEqual(res.status, 400);
});

// ---------------------------------------------------------------------------
// 写作进度
// ---------------------------------------------------------------------------

test('写作进度统计总字数与完成比例', async () => {
  const { work, chapter } = await seedWork();
  await writeChapter(chapter.id, '雨夜的巷子。'.repeat(10));

  const res = await server.request(`/api/progress/${work.id}`);
  const stats = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(stats.totalWords > 0);
  assert.strictEqual(stats.targetWords, 100000);
  assert.strictEqual(stats.chapterCount, 1);
  assert.ok(stats.percent >= 0 && stats.percent <= 100);
  assert.ok(Array.isArray(stats.timeline));
});

test('写作进度曲线补齐没有写作的日子', async () => {
  const { work } = await seedWork();
  const res = await server.request(`/api/progress/${work.id}?days=7`);
  const stats = await res.json();
  assert.strictEqual(stats.timeline.length, 7);
  // 最后一天是今天
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const expected = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  assert.strictEqual(stats.timeline[stats.timeline.length - 1].day, expected);
});

test('全部作品进度汇总', async () => {
  const res = await server.request('/api/progress');
  const list = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
});

// ---------------------------------------------------------------------------
// 一致性检查
// ---------------------------------------------------------------------------

test('规则层一致性检查能发现未登场的人物', async () => {
  const { work, chapter } = await seedWork();
  await writeChapter(chapter.id, '陈默走进了雨里。');

  // 造一个从没出现的人物
  const charRes = await server.request('/api/characters', {
    method: 'POST',
    body: { workId: work.id, name: '林霜' },
  });
  assert.strictEqual(charRes.status, 200);

  const res = await server.request(`/api/consistency/${work.id}`);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(
    body.issues.some((i) => i.type === 'unused_character' && i.title.includes('林霜')),
    '应当报出未登场人物'
  );
});

test('规则层一致性检查能发现人物别名重名', async () => {
  const { work } = await seedWork();
  await server.request('/api/characters', {
    method: 'POST',
    body: { workId: work.id, name: '陈默' },
  });
  await server.request('/api/characters', {
    method: 'POST',
    body: { workId: work.id, name: '老陈', aliases: '陈默' },
  });

  const res = await server.request(`/api/consistency/${work.id}`);
  const body = await res.json();
  assert.ok(
    body.issues.some((i) => i.type === 'duplicate_name'),
    '应当报出重名'
  );
});

test('作品不存在时一致性检查返回 404', async () => {
  const res = await server.request('/api/consistency/不存在');
  assert.strictEqual(res.status, 404);
});

// ---------------------------------------------------------------------------
// 引用定位
// ---------------------------------------------------------------------------

test('引用片段能定位到素材原文位置', async () => {
  const createRes = await server.request('/api/materials', {
    method: 'POST',
    body: {
      title: '雨夜巷子描写',
      body: '第一段无关内容。\n[[PAGE 2]]第二页开始。巷子深处传来脚步声，雨点打在伞骨上。',
      source: '手记',
    },
  });
  assert.strictEqual(createRes.status, 200);
  const material = await createRes.json();

  const res = await server.request(
    `/api/materials/${material.id}/locate?snippet=${encodeURIComponent('巷子深处传来脚步声')}`
  );
  const located = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(located.found, true);
  assert.strictEqual(located.page, 2);
  assert.ok(located.context.includes('巷子深处传来脚步声'));
});

test('素材不存在时定位返回 404', async () => {
  const res = await server.request('/api/materials/不存在/locate?snippet=x');
  assert.strictEqual(res.status, 404);
});

// ---------------------------------------------------------------------------
// 安全头
// ---------------------------------------------------------------------------

test('响应带安全头', async () => {
  const res = await server.request('/api/works');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('referrer-policy'), 'same-origin');
});
