'use strict';

/**
 * 素材 → 锚点：显式升格。
 *
 * 覆盖六件事：
 *   1. missing 素材只能降级为 inferable，并保留「证据不足」标记；
 *   2. sourced 素材必须能拆出书名 + 卷次，拆不出就降级；
 *   3. 规则推不出来退 manual_only，显式给对才保留；
 *   4. 升格落库是 pending，不直接 active；
 *   5. 确认前不注入上下文，确认后才注入；
 *   6. 同一素材重复升格不产生重复锚点（幂等）。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');
const env = setupTempEnv();

const app = require('../app');
const db = require('../database');
const store = require('../services/materials/store');
const context = require('../services/context');

let server;
let userId;
let workId;
let chapterId;

const ts = () => new Date().toISOString();

test.before(async () => {
  await db.ready;
  server = await startServer(app);
  const user = await db.get("SELECT id FROM users WHERE phone = '13900000001'");
  userId = user.id;

  workId = crypto.randomUUID();
  chapterId = crypto.randomUUID();
  const now = ts();
  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, template, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, 'history_thriller', ?, ?)`,
    [workId, userId, '升格测试作品', now, now]
  );
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第一章 夜渡', 1, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

/** 直接走机械约束层入库，返回素材行 */
async function saveMaterial(item) {
  const result = await store.saveBatch(userId, [item], { workId, createdBy: 'agent' });
  return result.created[0];
}

async function upgrade(ids, body = {}) {
  const res = await server.request(`/api/pipeline/${workId}/anchors/upgrade`, {
    method: 'POST',
    body: { materialIds: ids, ...body },
  });
  return res.json();
}

test('missing 素材升格降为 inferable，claim 保留证据不足标记', async () => {
  const material = await saveMaterial({
    title: '孙策生卒年（缺口）',
    body: '待补：孙策生卒年，各书记载互相矛盾，暂不可考',
    confidence: 'missing',
    provenance: '',
  });

  const body = await upgrade([material.id]);
  const created = body.created[0];
  assert.strictEqual(created.confidence, 'inferable');
  assert.ok(created.claim.startsWith('证据不足：'), `claim 应保留缺口标记：${created.claim}`);
  assert.deepStrictEqual(
    created.rules.map((rule) => rule.ruleType || rule.rule_type),
    ['manual_only']
  );
  console.log(
    `[missing] confidence=${created.confidence}；claim=${created.claim.slice(0, 24)}…；rules=${created.rules
      .map((r) => r.rule_type)
      .join('/')}`
  );
});

test('sourced 素材能拆出卷次才升为 sourced，拆不出降 inferable', async () => {
  const full = await saveMaterial({
    title: '官渡焚粮',
    body: '曹操亲率轻骑烧乌巢粮草，袁绍军心遂乱。',
    confidence: 'sourced',
    provenance: '《三国志·魏书·武帝纪》',
  });
  await store.confirmBatch(userId, [full.id]);

  const partial = await saveMaterial({
    title: '许都城防',
    body: '许都城防由丁氏族人把守。',
    confidence: 'sourced',
    provenance: '《三国志》',
  });
  await store.confirmBatch(userId, [partial.id]);

  const body = await upgrade([full.id, partial.id]);
  const byMaterial = Object.fromEntries(body.created.map((item) => [item.materialId, item]));

  assert.strictEqual(byMaterial[full.id].confidence, 'sourced');
  assert.strictEqual(byMaterial[full.id].sourceTitle, '三国志');
  assert.strictEqual(byMaterial[full.id].sourceLocator, '魏书·武帝纪');

  assert.strictEqual(byMaterial[partial.id].confidence, 'inferable');
  assert.ok(
    byMaterial[partial.id].degraded.some((line) => line.includes('卷次')),
    `缺少卷次时应记录降级原因：${byMaterial[partial.id].degraded.join('；')}`
  );
  console.log(
    `[provenance] full=${byMaterial[full.id].confidence}(${byMaterial[full.id].sourceTitle}·${byMaterial[full.id].sourceLocator})；partial=${byMaterial[partial.id].confidence}（${byMaterial[partial.id].degraded.join('；')}）`
  );
});

test('规则推不出来退 manual_only，显式给出才保留', async () => {
  const plain = await saveMaterial({
    title: '建安官制',
    body: '建安年间置司直，掌监察。',
    confidence: 'inferable',
    provenance: '《后汉书》',
  });

  const body = await upgrade([plain.id]);
  const plainAnchor = body.created[0];
  assert.deepStrictEqual(
    plainAnchor.rules.map((rule) => rule.rule_type),
    ['manual_only']
  );
  assert.ok(plainAnchor.degraded.some((line) => line.includes('manual_only')));

  const timed = await saveMaterial({
    title: '官渡时间线',
    body: '建安五年二月，袁绍进军黎阳。',
    confidence: 'sourced',
    provenance: '《三国志·魏书·武帝纪》',
  });
  await store.confirmBatch(userId, [timed.id]);

  const explicit = await upgrade([timed.id], {
    rulesByMaterial: {
      [timed.id]: [{ rule_type: 'chronology', params: { not_before: '建安五年', not_after: '建安五年' } }],
    },
  });
  assert.deepStrictEqual(
    explicit.created[0].rules.map((rule) => rule.rule_type),
    ['chronology']
  );
  console.log(
    `[rules] 推断=${plainAnchor.rules.map((r) => r.rule_type).join('/')}；显式=${explicit.created[0].rules
      .map((r) => r.rule_type)
      .join('/')}`
  );
});

test('升格落库是 pending，不直接 active', async () => {
  const material = await saveMaterial({
    title: '许都城门',
    body: '许都南门名宣阳门。',
    confidence: 'inferable',
    provenance: '《后汉书》',
  });
  const body = await upgrade([material.id]);
  const anchorId = body.created[0].id;
  const row = await db.get('SELECT status FROM work_anchors WHERE id = ?', [anchorId]);
  assert.strictEqual(row.status, 'pending');

  const activeList = await (await server.request(`/api/pipeline/${workId}/anchors?status=active`)).json();
  assert.ok(!activeList.some((item) => item.id === anchorId));
  console.log(`[status] 升格后=${row.status}；active 列表包含该条=false`);
});

test('确认前不注入上下文，确认后才注入', async () => {
  const material = await saveMaterial({
    title: '黎阳仓',
    body: '黎阳有仓，袁绍据此转运军粮。',
    confidence: 'inferable',
    provenance: '《三国志》',
  });
  const body = await upgrade([material.id]);
  const anchorId = body.created[0].id;

  const before = await context.assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    userId,
  });
  assert.strictEqual(before.meta.anchorCount, 0, '确认前不应注入任何锚点');

  const res = await server.request(`/api/pipeline/${workId}/anchors/${anchorId}/activate`, {
    method: 'POST',
  });
  assert.ok(res.ok);

  const after = await context.assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    userId,
  });
  assert.ok(after.meta.anchorCount >= 1, '确认后应注入锚点');
  console.log(`[inject] 确认前 anchorCount=${before.meta.anchorCount}；确认后=${after.meta.anchorCount}`);
});

test('同一素材重复升格不产生重复锚点（幂等）', async () => {
  const material = await saveMaterial({
    title: '乌巢守将',
    body: '乌巢守将为淳于琼。',
    confidence: 'inferable',
    provenance: '《三国志》',
  });

  const first = await upgrade([material.id]);
  const second = await upgrade([material.id]);
  const rows = await db.all('SELECT * FROM work_anchors WHERE work_id = ? AND source_material_id = ?', [
    workId,
    material.id,
  ]);

  assert.strictEqual(first.created.length, 1);
  assert.strictEqual(second.created.length, 0);
  assert.strictEqual(second.skipped.length, 1);
  assert.strictEqual(rows.length, 1);
  console.log(
    `[idempotent] 第一次 created=${first.created.length}；第二次 created=${second.created.length}；skip=${second.skipped[0]?.reason}；库内行数=${rows.length}`
  );
});
