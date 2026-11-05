'use strict';

/**
 * 知情扫描确定性（任务四）。
 *
 * 盯住三件事：
 *   1. 同一正文、同一状态快照连跑 3 次，逐条一致；
 *   2. 候选为空时完全不调模型（省钱，也不让模型臆造）；
 *   3. 角色说出未达 knows 的事实内容 → pending 标 possible_leak，不判违规。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let server;
let scanKnowledge;
let collectCandidates;
let knowledgeAt;

const BODY =
  '司马懿见过密诏，脸色骤变。杨平知道令牌在县衙。';

function deterministicProvider() {
  return {
    calls: 0,
    messages: [],
    async chat(options) {
      this.calls += 1;
      this.messages.push(options.messages);
      return {
        content: JSON.stringify({
          transitions: [
            { candidate: 'C1', toState: 'suspects' },
            { candidate: 'C2', toState: 'suspects' },
          ],
        }),
      };
    },
  };
}

function emptyProvider() {
  return {
    calls: 0,
    async chat() {
      this.calls += 1;
      return { content: '{"transitions":[]}' };
    },
  };
}

async function seedWork(name, seq = 1) {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title: name, template: 'history_thriller' },
  });
  assert.strictEqual(res.status, 200);
  const work = await res.json();
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', '', '[]', '', 0, ?, ?)`,
    [`ch-${work.id}`, work.id, `第 ${seq} 章`, seq, TS, TS]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, '司马懿', '', ?, ?)`,
    [`c1-${work.id}`, work.id, TS, TS]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, '杨平', '', ?, ?)`,
    [`c2-${work.id}`, work.id, TS, TS]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '司马懿见过密诏', '密诏', ?, ?)`,
    [`f1-${work.id}`, work.id, TS, TS]
  );
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '杨平知道令牌在县衙', '令牌', ?, ?)`,
    [`f2-${work.id}`, work.id, TS, TS]
  );
  return {
    workId: work.id,
    chapterId: `ch-${work.id}`,
    c1: `c1-${work.id}`,
    f1: `f1-${work.id}`,
  };
}

async function resetKnowledge(workId) {
  await db.run('DELETE FROM knowledge_matrix WHERE work_id = ?', [workId]);
  await db.run('DELETE FROM knowledge_pending WHERE work_id = ?', [workId]);
}

function signature(rows) {
  return rows
    .map((row) => `${row.characterName}|${row.factLabel}|${row.fromState}|${row.toState}|${row.evidence}|${row.reason || ''}`)
    .sort();
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  ({ scanKnowledge, collectCandidates } = require('../services/pipeline/knowledgeScan'));
  ({ knowledgeAt } = require('../services/pipeline/knowledge'));
  const app = require('../app');
  server = await startServer(app);
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

test('规则层候选：同正文连跑 3 次完全一致', async () => {
  const work = await seedWork('确定性候选');
  const characters = await db.all('SELECT * FROM characters WHERE work_id = ? ORDER BY name', [work.workId]);
  const facts = await db.all('SELECT * FROM story_facts WHERE work_id = ? ORDER BY created_at ASC, id ASC', [work.workId]);

  const runs = [];
  for (let i = 0; i < 3; i++) {
    runs.push(collectCandidates({ characters, facts, text: BODY }));
  }
  assert.deepStrictEqual(
    runs[0].map((x) => `${x.id}|${x.character.name}|${x.fact.id}|${x.evidence}`),
    runs[1].map((x) => `${x.id}|${x.character.name}|${x.fact.id}|${x.evidence}`)
  );
  assert.deepStrictEqual(runs[1], runs[2]);
  assert.strictEqual(runs[0].length, 2, '两个角色各命中一条候选');
});

test('模型层只看候选：同一正文、同一状态快照连跑 3 次，结果集合相等', async () => {
  const work = await seedWork('确定性扫描');
  const provider = deterministicProvider();
  const results = [];

  for (let i = 0; i < 3; i++) {
    await resetKnowledge(work.workId);
    const result = await scanKnowledge({
      workId: work.workId,
      chapterId: work.chapterId,
      text: BODY,
      provider,
    });
    results.push({
      applied: signature(result.applied),
      pending: signature(result.pending),
      skippedModel: result.skippedModel,
    });
  }

  assert.deepStrictEqual(results[0], results[1]);
  assert.deepStrictEqual(results[1], results[2]);
  assert.strictEqual(results[0].applied.length, 2);
  assert.ok(results[0].applied.some((row) => row.includes('司马懿|F1|unknown|suspects|司马懿见过密诏')));
  assert.ok(results[0].applied.some((row) => row.includes('杨平|F2|unknown|suspects|杨平知道令牌在县衙')));
  assert.deepStrictEqual(results[0].pending, []);

  // 模型输入只有候选与状态，不塞整章正文。
  assert.strictEqual(provider.calls, 3);
  assert.match(String(provider.messages[0][0].content), /C1｜角色：司马懿/);
  assert.ok(!String(provider.messages[0][1].content).includes('司马懿见过密诏'));
});

test('候选为空：不调用模型，直接返回', async () => {
  const work = await seedWork('空候选不调模型');
  const provider = emptyProvider();
  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '今日天晴，县衙无事，众人都散了。',
    provider,
  });

  assert.strictEqual(provider.calls, 0, '候选为空时模型调用必须是 0');
  assert.strictEqual(result.skippedModel, true);
  assert.strictEqual(result.failed, false);
  assert.deepStrictEqual(result.applied, []);
  assert.deepStrictEqual(result.pending, []);
  assert.strictEqual((await db.all('SELECT * FROM knowledge_pending WHERE work_id = ?', [work.workId])).length, 0);
});

test('文本越界：说出未达 knows 的事实 → pending 标 possible_leak，不直接判违规', async () => {
  const work = await seedWork('越界粗筛', 2);
  // 前一章只到 suspects：司马懿知道「司空府」这个词，但未达 knows。
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '杨平是司空府的人', '司空府', ?, ?)`,
    [`f3-${work.workId}`, work.workId, TS, TS]
  );
  await db.run(
    `INSERT INTO knowledge_matrix (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, 1, 'suspects', ?)`,
    [`k-${work.workId}`, work.workId, work.c1, `f3-${work.workId}`, TS]
  );

  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '司马懿说：“你爹是司空府的人。”',
    provider: emptyProvider(),
  });

  const leak = result.pending.find((row) => row.reason === 'possible_leak');
  assert.ok(leak, '命中越界粗筛后必须进 pending');
  assert.strictEqual(leak.characterName, '司马懿');
  assert.strictEqual(leak.fromState, 'suspects');
  assert.strictEqual(leak.toState, 'partial');
  assert.match(leak.evidence, /司空府/);
  assert.strictEqual(result.applied.length, 0, '越界只进 pending，不直接判违规');

  const rows = await db.all(
    "SELECT * FROM knowledge_pending WHERE work_id = ? AND status = 'pending' AND reason = 'possible_leak'",
    [work.workId]
  );
  assert.strictEqual(rows.length, 1);
});

test('文本越界：说话人写在引号后面，同段共现也能命中', async () => {
  const work = await seedWork('越界后置说话人', 2);
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '杨平是司空府的人', '司空府', ?, ?)`,
    [`f4-${work.workId}`, work.workId, TS, TS]
  );
  await db.run(
    `INSERT INTO knowledge_matrix (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, 1, 'suspects', ?)`,
    [`k2-${work.workId}`, work.workId, work.c1, `f4-${work.workId}`, TS]
  );

  // 中文常把说话人放在引号之后：按句会漏，按段才抓得到。
  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '「你爹是司空府的人。」司马懿说。',
    provider: emptyProvider(),
  });

  const leak = result.pending.find((row) => row.reason === 'possible_leak');
  assert.ok(leak, '说话人后置时也必须进 pending');
  assert.strictEqual(leak.characterName, '司马懿');
  assert.match(leak.evidence, /司空府/);
  assert.strictEqual(result.applied.length, 0);
});

test('同一行重复扫描不重复堆积 pending', async () => {
  const work = await seedWork('pending 幂等');
  const provider = {
    async chat() {
      return {
        content: JSON.stringify({ transitions: [{ candidate: 'C1', toState: 'knows' }] }),
      };
    },
  };

  const first = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '司马懿见过密诏，脸色骤变。',
    provider,
  });
  assert.strictEqual(first.pending.length, 1);
  const second = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '司马懿见过密诏，脸色骤变。',
    provider,
  });
  assert.strictEqual(second.pending.length, 1);
  const rows = await db.all('SELECT * FROM knowledge_pending WHERE work_id = ?', [work.workId]);
  assert.strictEqual(rows.length, 1, '同键 pending 不重复插入');
});

test('model_only：候选之外但证据逐字存在 → 进 pending，低可信且不自动落库', async () => {
  const work = await seedWork('模型单独提出');
  // f3 的关键词（征辟）不在正文里，候选层不会产出这一条。
  await db.run(
    `INSERT INTO story_facts (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, '杨俊被曹操征辟为掾属', '征辟', ?, ?)`,
    [`f3-${work.workId}`, work.workId, TS, TS]
  );

  const provider = {
    calls: 0,
    async chat() {
      this.calls += 1;
      return {
        content: JSON.stringify({
          transitions: [
            { candidate: 'C1', toState: 'suspects' },
            {
              character: '杨平',
              factId: 'F3',
              evidence: '杨平知道令牌在县衙',
              toState: 'knows',
            },
          ],
        }),
      };
    },
  };

  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: BODY,
    provider,
  });

  const row = result.pending.find((item) => item.source === 'model_only');
  assert.ok(row, '候选之外逐字证据必须进 pending');
  assert.strictEqual(row.characterName, '杨平');
  assert.strictEqual(row.fromState, 'unknown');
  assert.strictEqual(row.toState, 'knows');
  assert.strictEqual(row.reason, '跳级', 'reason 保留等级语义，不因为来路而改写');
  assert.strictEqual(result.applied.length, 1, '只有候选命中的 C1 自动落库');

  const dbRow = await db.get(
    "SELECT * FROM knowledge_pending WHERE work_id = ? AND source = 'model_only'",
    [work.workId]
  );
  assert.ok(dbRow, 'source 必须持久化，前端才能标记低可信');
  assert.strictEqual(dbRow.reason, '跳级');

  const matrix = await db.all('SELECT * FROM knowledge_matrix WHERE work_id = ? AND fact_id = ?', [
    work.workId,
    `f3-${work.workId}`,
  ]);
  assert.strictEqual(matrix.length, 0, 'model_only 确认前不落库');
  const visible = await knowledgeAt(work.workId, 2);
  assert.ok(
    !visible.some((item) => item.fact_id === `f3-${work.workId}`),
    'model_only 确认前不参与注入'
  );
});

test('model_only：证据不在正文逐字出现 → 丢弃，不进 pending', async () => {
  const work = await seedWork('模型证据不存在');
  const provider = {
    async chat() {
      return {
        content: JSON.stringify({
          transitions: [
            { candidate: 'C1', toState: 'suspects' },
            {
              character: '杨平',
              factId: 'F2',
              evidence: '杨平在许都见过曹操',
              toState: 'knows',
            },
          ],
        }),
      };
    },
  };

  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: BODY,
    provider,
  });

  assert.strictEqual(
    result.pending.filter((item) => item.source === 'model_only').length,
    0,
    '证据不在正文里，哪怕像模像样也必须丢弃'
  );
  const rows = await db.all(
    "SELECT * FROM knowledge_pending WHERE work_id = ? AND source = 'model_only'",
    [work.workId]
  );
  assert.strictEqual(rows.length, 0);
});

test('同一 transition 同时被候选与模型返回：只留一条 pending，候选优先', async () => {
  const work = await seedWork('候选优先去重');
  const provider = {
    async chat() {
      return {
        content: JSON.stringify({
          transitions: [
            { candidate: 'C1', toState: 'knows' },
            {
              character: '司马懿',
              factId: 'F1',
              evidence: '司马懿见过密诏',
              toState: 'knows',
            },
          ],
        }),
      };
    },
  };

  const result = await scanKnowledge({
    workId: work.workId,
    chapterId: work.chapterId,
    text: '司马懿见过密诏，脸色骤变。',
    provider,
  });

  assert.strictEqual(result.pending.length, 1, '同一条 transition 不能重复堆积');
  assert.strictEqual(result.pending[0].source, 'candidate', '候选路径优先');

  const rows = await db.all('SELECT * FROM knowledge_pending WHERE work_id = ?', [work.workId]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'candidate');
});

