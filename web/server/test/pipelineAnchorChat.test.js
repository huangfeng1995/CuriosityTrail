'use strict';

/**
 * HP4 写后接入：正文产出后，模板启用的作品必须跑本地锚点断言，
 * 并把结果同时写进 anchor_violations 与 SSE 的 done 事件。
 *
 * 这里走完整的 /api/ai/chat 路径（真 SSE + 假 provider），
 * 确认前端即使不读 anchorViolations 也不会坏，且字段形状稳定。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

const app = require('../app');
const { ready, get, all, run } = require('../database');
const aiConfig = require('../services/aiConfig');

let server;
let fakeModel;
let originalConfig;

const BODY = '庭中鼓噪。曹操端坐堂上，众客屏息。';

async function chat(message, extra = {}) {
  const res = await server.request('/api/ai/chat', {
    method: 'POST',
    body: { message, roleKey: 'writer', ...extra },
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().startsWith('data:'))
    .map((chunk) => {
      const payload = chunk.slice(5).trim();
      return payload === '[DONE]' ? { type: 'done' } : JSON.parse(payload);
    });
}

test.before(async () => {
  await ready;
  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();

  originalConfig = JSON.parse(JSON.stringify(aiConfig.getConfig()));
  aiConfig.updateConfig({
    provider: 'deepseek',
    deepseek: {
      apiKey: 'test-key',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'deepseek-flash',
      thinking: false,
    },
  });

  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) aiConfig.updateConfig(originalConfig);
  env.cleanup();
});

test('写后断言：模板启用时命中写入 anchor_violations，done 带回 anchorViolations', async () => {
  const user = await get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  const workId = 'work-anchor-chat';
  const chapterId = 'chapter-anchor-chat';
  const now = new Date().toISOString();

  await run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, template, target_words, created_at, modified_at)
     VALUES (?, ?, '锚点断言作品', '', '', '', 'history_thriller', 0, ?, ?)`,
    [workId, user.id, now, now]
  );
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, '第45章', 45, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [chapterId, workId, now, now]
  );
  await run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, source_title, source_locator,
        source_quote, rules, immutable, status, created_at, modified_at)
     VALUES (?, ?, 'person', '曹操', '曹操卒于建安二十五年正月', 'sourced',
             '三国志', '武帝纪', '', ?, 1, 'active', ?, ?)`,
    [
      'anchor-chat-caocao',
      workId,
      JSON.stringify([
        { rule_type: 'presence_forbidden', params: { persons: ['曹操'], from_seq: 40 } },
      ]),
      now,
      now,
    ]
  );

  fakeModel.setDefault({
    content: JSON.stringify({ action: 'append', content: BODY }),
    finishReason: 'stop',
  });

  const events = await chat('写这一章', { workId, chapterId });

  const done = events.filter((e) => e.type === 'done').pop();
  assert.ok(done, '必须有 done 事件');
  assert.ok(Array.isArray(done.anchorViolations), 'done 必须带 anchorViolations 数组');
  assert.strictEqual(done.anchorViolations.length, 1);

  const hit = done.anchorViolations[0];
  assert.deepStrictEqual(
    Object.keys(hit).sort(),
    ['anchorId', 'blockId', 'offset', 'quote', 'ruleType', 'severity'],
    '字段形状必须稳定'
  );
  assert.strictEqual(hit.anchorId, 'anchor-chat-caocao');
  assert.strictEqual(hit.ruleType, 'presence_forbidden');
  assert.strictEqual(hit.severity, 'block', 'sourced + immutable 应为 block 级');
  assert.strictEqual(
    BODY.slice(hit.offset, hit.offset + hit.quote.length),
    hit.quote,
    'offset 必须能 slice 回原句'
  );

  // 独立事件：前端不读也不影响主流程，但可观测
  const violationEvent = events.find((e) => e.type === 'anchor_violation');
  assert.ok(violationEvent, '命中时要有 anchor_violation 事件');
  assert.deepStrictEqual(violationEvent.violations, done.anchorViolations);

  // 落库
  const rows = await all(
    'SELECT * FROM anchor_violations WHERE work_id = ? ORDER BY created_at',
    [workId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].anchor_id, 'anchor-chat-caocao');
  assert.strictEqual(rows[0].severity, 'block');
  assert.strictEqual(rows[0].quote, hit.quote);
});

test('一致性报告：锚点作为第 6 类规则走既有 issues 出口', async () => {
  await run('UPDATE chapters SET content = ? WHERE id = ?', [BODY, 'chapter-anchor-chat']);

  const consistency = require('../services/consistency');
  const issues = await consistency.runRuleChecks('work-anchor-chat');
  const anchorIssues = issues.filter((i) => i.type === 'anchor_violation');

  assert.strictEqual(anchorIssues.length, 1);
  assert.ok(anchorIssues[0].title.includes('第 45 章'));
  assert.ok(anchorIssues[0].detail.includes('曹操端坐堂上'));
  assert.strictEqual(anchorIssues[0].target, '曹操');
});
