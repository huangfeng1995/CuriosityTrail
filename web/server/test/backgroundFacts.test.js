'use strict';

/**
 * 主角背景事实（mustReveal）测试。
 *
 * 两态断言：
 *   - 缺背景事实：首次出场章 body 没有年龄/籍贯/寄养 → mustReveal 逐项报缺；
 *   - 补齐后：同一 body 加入对应句子 → missing 为空。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let server;
let backgroundFacts;

const PROTAGONIST = { id: 'c1', name: '杨平', aliases: '', role: '主角' };

const FACTS = [
  { id: 'f1', content: '杨平今年十四岁', keywords: '十四岁' },
  { id: 'f2', content: '杨平是河内获嘉人', keywords: '获嘉' },
  { id: 'f3', content: '杨平因战乱寄养在司马防家', keywords: '寄养' },
];

function factRows() {
  return FACTS.map((fact) => ({ ...fact, fact_type: 'background' }));
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  backgroundFacts = require('../services/pipeline/backgroundFacts');
  const app = require('../app');
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

async function seedWork(name) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: name, template: 'history_thriller' },
  });
  assert.strictEqual(res.status, 200);
  const work = await res.json();
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, role, created_at, modified_at)
     VALUES (?, ?, ?, '', '主角', ?, ?)`,
    [`c1-${work.id}`, work.id, '杨平', TS, TS]
  );
  return work;
}

test('没有任何背景事实：首次出场章标出「背景事实尚未入库」', () => {
  const check = backgroundFacts.checkMustReveal({ facts: [], body: '杨平跟着父亲上车。' });
  assert.strictEqual(check.total, 0);
  assert.deepStrictEqual(check.missing, []);

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: [],
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body: '杨平跟着父亲上车。',
  });
  assert.strictEqual(chapter.applicable, true, '首次出场章必须让作者看到缺失');
  assert.strictEqual(chapter.missing.length, 1);
  assert.strictEqual(chapter.missing[0].notIngested, true);
  assert.match(chapter.missing[0].content, /尚未入库/);
});

test('有背景事实但正文不交代：逐项报缺，触发 beatCheck 标出', () => {
  const check = backgroundFacts.checkMustReveal({
    facts: factRows(),
    body: '杨平跟着父亲上车，车队出了城门。',
  });
  assert.strictEqual(check.total, 3);
  assert.strictEqual(check.covered, 0);
  assert.deepStrictEqual(
    check.missing.map((item) => item.content),
    ['杨平今年十四岁', '杨平是河内获嘉人', '杨平因战乱寄养在司马防家']
  );

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body: '杨平跟着父亲上车，车队出了城门。',
  });
  assert.strictEqual(chapter.applicable, true, '主角首次出场且正文没交代 → 适用');
  assert.strictEqual(chapter.missing.length, 3);
});

test('补齐背景事实后：同一正文加句子 → missing 为空', () => {
  const body =
    '杨平今年十四岁，是河内获嘉人。三年前因战乱被寄养在司马防家，如今要跟着父亲回许都。';
  const check = backgroundFacts.checkMustReveal({ facts: factRows(), body });
  assert.strictEqual(check.total, 3);
  assert.strictEqual(check.covered, 3);
  assert.deepStrictEqual(check.missing, []);

  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: [],
    body,
  });
  assert.strictEqual(chapter.applicable, true);
  assert.deepStrictEqual(chapter.missing, []);
});

test('年龄必须出现年龄表述：十八了算交代，十八年不算', () => {
  const facts = [{ id: 'f1', content: '杨平今年十八岁', keywords: '十八岁,年龄', fact_type: 'background' }];

  const covered = backgroundFacts.checkMustReveal({
    facts,
    body: '司马懿嗤了一声：「十八了，还跟个妇人一样心软。」',
  });
  assert.strictEqual(covered.covered, 1, '「十八了」是年龄表述，应算交代');
  assert.deepStrictEqual(covered.missing, []);

  const yearOnly = backgroundFacts.checkMustReveal({
    facts,
    body: '他在温县住了十八年，日子过得不算差。',
  });
  assert.strictEqual(yearOnly.missing.length, 1, '「十八年」不是年龄，不能算交代');

  const wordOnly = backgroundFacts.checkMustReveal({
    facts,
    body: '他从不提自己的年龄。',
  });
  assert.strictEqual(wordOnly.missing.length, 1, '只出现「年龄」这个词不算交代');
});

test('非首次出场：更早章节已出现主角 → 不强制交代', () => {
  const chapter = backgroundFacts.mustRevealForChapter({
    facts: factRows(),
    characters: [PROTAGONIST],
    chapterText: '杨平随父亲离城。',
    priorBodies: ['上一章：杨平在县衙门口站了很久。'],
    body: '杨平跟着父亲上车。',
  });
  assert.strictEqual(chapter.applicable, false);
  assert.deepStrictEqual(chapter.missing, []);
});

test('素材升格：幂等 + missing 标记保留，重复升格不产生重复行', async () => {
  const work = await seedWork('背景事实升格');
  const userId = work.user_id;
  await db.run(
    `INSERT INTO materials
       (id, user_id, title, body, source, source_url, file_path, tags, work_id, provenance,
        confidence, origin, status, created_by, search_log, char_count, page_count, created_at, modified_at)
     VALUES ('m1', ?, '杨平身世', '杨平今年十四岁，河内获嘉人，幼年寄养司马家。', '', '', '', '年龄,籍贯', ?, '', 'missing', 'user', 'active', 'user', '', 0, 0, ?, ?)`,
    [userId, work.id, TS, TS]
  );

  const first = await backgroundFacts.upgradeBackgroundFacts({
    userId,
    workId: work.id,
    materialIds: ['m1'],
  });
  assert.strictEqual(first.created.length, 1);
  assert.ok(first.created[0].keywords.includes('证据不足'), 'missing 素材要留证据不足标记');

  const second = await backgroundFacts.upgradeBackgroundFacts({
    userId,
    workId: work.id,
    materialIds: ['m1'],
  });
  assert.strictEqual(second.created.length, 0, '同素材重复升格不能产生新行');
  assert.strictEqual(second.skipped.length, 1);

  const rows = await db.all(
    "SELECT * FROM story_facts WHERE work_id = ? AND fact_type = 'background'",
    [work.id]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].fact_type, 'background');
});

test('agent 抽取入库：同一内容幂等，接口可一次写入多条', async () => {
  const work = await seedWork('背景事实抽取');
  const body = {
    facts: [
      { content: '杨平今年十四岁', keywords: ['十四岁'] },
      { content: '杨平是河内获嘉人', keywords: ['获嘉'] },
    ],
  };

  const first = await server.request(`/api/pipeline/${work.id}/facts/background`, {
    method: 'POST',
    body,
  });
  assert.strictEqual(first.status, 200);
  const out = await first.json();
  assert.strictEqual(out.created.length, 2);

  const second = await server.request(`/api/pipeline/${work.id}/facts/background`, {
    method: 'POST',
    body,
  });
  const out2 = await second.json();
  assert.strictEqual(out2.created.length, 0);
  assert.strictEqual(out2.skipped.length, 2);

  const rows = await db.all("SELECT * FROM story_facts WHERE work_id = ? AND fact_type = 'background'", [work.id]);
  assert.strictEqual(rows.length, 2);
});
