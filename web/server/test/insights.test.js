'use strict';

/**
 * 写作洞察测试。
 *
 * 覆盖聚合统计（日/周/月/年）、写作指纹、荣誉徽章、用户反馈。
 * 指纹与徽章是给作者看的东西，数字算错比没有更糟，
 * 所以这里逐项断言具体数值。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();

const app = require('../app');
const { ready, run } = require('../database');

let server;

test.before(async () => {
  await ready;
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

/**
 * 建一部作品，带 n 个章节。
 */
async function seedWork(title, chapterCount = 1) {
  const workRes = await server.request('/api/works', {
    method: 'POST',
    body: { title, targetWords: 100000 },
  });
  const work = await workRes.json();

  const chapters = [];
  for (let i = 0; i < chapterCount; i += 1) {
    const res = await server.request(`/api/works/${work.id}/chapters`, {
      method: 'POST',
      body: { title: `第 ${i + 1} 章` },
    });
    chapters.push(await res.json());
  }
  return { work, chapters };
}

/**
 * 往章节里写正文。blocks 是权威数据，content 是派生快照。
 */
async function writeChapter(chapterId, text, status = 'draft') {
  const res = await server.request(`/api/chapters/${chapterId}`, {
    method: 'PUT',
    body: {
      blocks: [{ id: 'b1', type: 'paragraph', content: text }],
      status,
    },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

/**
 * 往 writing_events 里塞一条历史记录。
 * 聚合统计靠这张表，直接写比"改系统时间保存"可控得多。
 */
async function seedEvent(workId, day, words) {
  await run(
    `INSERT INTO writing_events (id, work_id, chapter_id, day, words_added, created_at)
     VALUES (?, ?, NULL, ?, ?, ?)`,
    [require('crypto').randomUUID(), workId, day, words, `${day}T10:00:00.000Z`]
  );
}

test('聚合统计：按周聚合跨作品的写作量', async () => {
  const { work } = await seedWork('周统计');

  // 造三天连续记录：昨天、前天、大前天
  const today = new Date();
  const day = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  // 周桶对齐自然周（周一起），所以"往前 3 天"在周一那天会跨到上一周。
  // 这里只造本周以内的日子，期望值跟着实际造了几天算，用例才不会在周一失效。
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const seeded = [1000];
  await seedEvent(work.id, day(0), seeded[0]);
  if (daysSinceMonday >= 1) {
    seeded.push(500);
    await seedEvent(work.id, day(1), 500);
  }
  if (daysSinceMonday >= 2) {
    seeded.push(300);
    await seedEvent(work.id, day(2), 300);
  }
  const expected = seeded.reduce((a, b) => a + b, 0);

  const res = await server.request('/api/insights/stats?period=week');
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  assert.strictEqual(data.period, 'week');
  assert.ok(data.timeline.length > 0, '要有时间线');

  const last = data.timeline[data.timeline.length - 1];
  assert.strictEqual(last.words, expected, `本周应统计到 ${expected} 字`);
  assert.strictEqual(data.totalAdded, expected);
  assert.ok(data.activeDays >= seeded.length, '有产出的天数要对得上');
});

test('聚合统计：周桶对齐自然周，同一份数据不会来回跳', async () => {
  const cookie = await server.loginAs('13900000006');
  const workRes = await server.requestAs(cookie, '/api/works', {
    method: 'POST',
    body: { title: '周对齐' },
  });
  const work = await workRes.json();

  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  await seedEvent(work.id, key, 700);

  const first = await (await server.requestAs(cookie, '/api/insights/stats?period=week')).json();
  const second = await (await server.requestAs(cookie, '/api/insights/stats?period=week')).json();

  // 两次请求结果必须一致：滚动窗口会随请求时刻漂移，自然周不会
  assert.deepStrictEqual(
    first.timeline.map((d) => d.key),
    second.timeline.map((d) => d.key),
    '周桶 key 两次请求要一样'
  );
  assert.strictEqual(first.timeline[first.timeline.length - 1].words, 700);
  // 桶标签要写得清楚："第 44 周"，不是会读成"44 个星期"的"44 周"
  assert.match(first.timeline[first.timeline.length - 1].label, /^第 \d+ 周$/);
});

test('聚合统计：日粒度补齐空白日期', async () => {
  // 独立账号：今天的字数会被前面用例的种子数据累加，用默认账号断言就对不上了
  const cookie = await server.loginAs('13900000007');
  const workRes = await server.requestAs(cookie, '/api/works', {
    method: 'POST',
    body: { title: '日粒度' },
  });
  const work = await workRes.json();

  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  await seedEvent(work.id, key, 800);

  const res = await server.requestAs(cookie, '/api/insights/stats?period=day&buckets=7');
  const data = await res.json();

  assert.strictEqual(data.timeline.length, 7, '7 个桶');
  assert.strictEqual(data.timeline[data.timeline.length - 1].words, 800, '今天有 800 字');
  // 空白日期必须是 0，不能缺项——缺了折线图会跳过，看起来像连着写
  assert.strictEqual(data.timeline[0].words, 0);
  assert.ok(data.timeline.every((d) => typeof d.words === 'number'), '每桶都要有数值');
});

test('聚合统计：连续写作天数能算出来', async () => {
  // 独立账号：连续天数是全库口径，用默认账号会数上前一个用例留下的记录
  const cookie = await server.loginAs('13900000005');

  const workRes = await server.requestAs(cookie, '/api/works', {
    method: 'POST',
    body: { title: '连续天数' },
  });
  const work = await workRes.json();

  const today = new Date();
  const day = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  await seedEvent(work.id, day(1), 500);
  await seedEvent(work.id, day(2), 500);
  await seedEvent(work.id, day(3), 500);

  const res = await server.requestAs(cookie, '/api/insights/stats?period=day');
  const data = await res.json();
  assert.strictEqual(data.longestStreak, 3, '最长连续 3 天');
  assert.ok(data.streak >= 3, '当前连续至少 3 天');
});

test('聚合统计：别人的数据不混进来', async () => {
  const otherCookie = await server.loginAs('13900000002');

  const { work } = await seedWork('隔离测试');
  const today = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const key = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  await seedEvent(work.id, key, 5000);

  // 另一个账号看不到上面这 5000 字
  const res = await server.requestAs(otherCookie, '/api/insights/stats?period=day');
  const data = await res.json();
  assert.strictEqual(data.totalAdded, 0, '别人的写作量不能出现');
  assert.strictEqual(data.workCount, 0);
});

test('写作指纹：句长、段长与对白占比算得出来', async () => {
  const { chapters } = await seedWork('指纹测试', 1);
  await writeChapter(
    chapters[0].id,
    '他推开门。屋里没人。\n桌上的碗底蹭得发亮。\n"你回来了。"她说。\n他没说话，把伞靠在门后。'
  );

  const res = await server.request('/api/insights/fingerprint');
  assert.strictEqual(res.status, 200);
  const fp = await res.json();

  assert.ok(fp.sampleWords > 0, '要有样本字数');
  assert.ok(fp.sentenceCount >= 4, '句子数应至少 4');
  assert.ok(fp.paragraphCount >= 3, '段落数应至少 3');
  assert.ok(fp.avgSentenceLength > 0, '平均句长要大于 0');
  assert.ok(fp.dialogueRatio > 0, '有引号内容，对白占比要大于 0');
  assert.ok(Array.isArray(fp.labels), '要有文字标签');
});

test('写作指纹：没有正文时返回空结构而不是报错', async () => {
  const otherCookie = await server.loginAs('13900000003');
  const res = await server.requestAs(otherCookie, '/api/insights/fingerprint');
  assert.strictEqual(res.status, 200);
  const fp = await res.json();
  assert.strictEqual(fp.sampleWords, 0);
  assert.strictEqual(fp.sentenceCount, 0);
  assert.deepStrictEqual(fp.topWords, []);
});

test('写作指纹：标签里的百分比是整数，不带小数尾巴', async () => {
  const { chapters } = await seedWork('标签取整', 1);
  await writeChapter(chapters[0].id, '他推开门。屋里没人。\n"你回来了。"她说。');

  const res = await server.request('/api/insights/fingerprint');
  const fp = await res.json();

  assert.ok(Number.isInteger(fp.dialogueRatio), '对白占比要是整数');
  // 标签里出现的小数百分比是 bug：作者看到"0.0689%"会以为算错了
  for (const label of fp.labels) {
    assert.ok(
      !/\d+\.\d+/.test(label.text),
      `标签里不该出现小数：${label.text}`
    );
  }
});

test('写作指纹：样本少时也能列出高频词', async () => {
  const { chapters } = await seedWork('高频词', 1);
  await writeChapter(chapters[0].id, '雨水顺着指缝淌下去。雨水是凉的。雨水敲着窗。');

  const res = await server.request('/api/insights/fingerprint');
  const fp = await res.json();
  assert.ok(fp.topWords.length > 0, '小样本也要能列高频词');
  assert.ok(fp.topWords.some((w) => w.word.includes('雨水')), '应能抓到"雨水"');
});

test('荣誉徽章：达标才解锁，未达标给进度', async () => {
  const { chapters } = await seedWork('徽章测试', 1);
  await writeChapter(chapters[0].id, '短。');

  const res = await server.request('/api/insights/badges');
  const data = await res.json();

  assert.ok(data.badges.length > 0, '要有徽章列表');
  assert.ok('unlocked' in data.badges[0]);
  assert.ok('percent' in data.badges[0], '未达标的徽章也要给进度');

  // 落笔徽章（1000 字）此刻不该解锁
  const firstWords = data.badges.find((b) => b.id === 'first_words');
  assert.strictEqual(firstWords.unlocked, false);
  assert.ok(firstWords.percent > 0 && firstWords.percent < 100, '要有中间进度');
});

test('用户反馈：提交后能看到自己的反馈', async () => {
  const res = await server.request('/api/feedback', {
    method: 'POST',
    body: { category: 'feature', content: '希望能导出全书为 TXT', contact: 'a@b.com' },
  });
  assert.strictEqual(res.status, 200);
  const item = await res.json();
  assert.strictEqual(item.category, 'feature');
  assert.strictEqual(item.status, 'new');

  const listRes = await server.request('/api/feedback');
  const list = await listRes.json();
  assert.ok(Array.isArray(list.categories));
  assert.ok(list.items.length >= 1);
  assert.ok(list.items.some((i) => i.content.includes('导出全书')));
});

test('用户反馈：空内容被拒', async () => {
  const res = await server.request('/api/feedback', {
    method: 'POST',
    body: { category: 'other', content: '   ' },
  });
  assert.strictEqual(res.status, 400);
});

test('用户反馈：只看得到自己的反馈', async () => {
  const otherCookie = await server.loginAs('13900000004');
  await server.requestAs(otherCookie, '/api/feedback', {
    method: 'POST',
    body: { category: 'bug', content: '这是别人的反馈内容' },
  });

  const res = await server.request('/api/feedback');
  const list = await res.json();
  assert.ok(
    !list.items.some((i) => i.content.includes('别人的反馈')),
    '别人的反馈不能出现在我的列表里'
  );
});
