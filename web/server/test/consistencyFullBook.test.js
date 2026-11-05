'use strict';

/**
 * 全书 AI 检查：切批、定位、汇总。
 *
 * 盯住三件事：
 *   1. 正文必须**读完**——长书要切批，不能只取每章开头几百字；
 *   2. 每条问题都要能落回某一章的某一段（chapterId + blockId）；
 *   3. 某一批失败不能吞掉其它批的结果，也不能静默少读。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好：config.js 在加载时就定死了这些值
const env = setupTempEnv();
process.env.CONSISTENCY_CHUNK_CHARS = '2000';
process.env.CONSISTENCY_MAX_CHARS = '300000';

const db = require('../database');
const app = require('../app');
const aiConfig = require('../services/aiConfig');
const consistency = require('../services/consistency');

let server;
let fakeModel;
let originalConfig;

// 每章都超过单批上限（单批 2000 字），保证一章一批
const FILLER = '雨落在瓦上，声音连成一片。'.repeat(160);

const CHAPTERS = [
  { id: 'c1', seq: 1, title: '雨夜', opening: '十点整，雨落下来。' },
  { id: 'c2', seq: 2, title: '伞', opening: '陈默把伞收了。' },
  { id: 'c3', seq: 3, title: '门外', opening: '门外有人喊了一声。' },
];

async function seedWork(ownerId) {
  const userId = ownerId || (await createUser()).id;
  const suffix = Math.random().toString(36).slice(2, 8);
  const workId = `work-${suffix}`;
  const now = new Date().toISOString();
  const chapterIds = {};

  await db.run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, target_words, created_at, modified_at)
     VALUES (?, ?, ?, '', '', '', 0, ?, ?)`,
    [workId, userId, '雨夜追踪', now, now]
  );

  for (const chapter of CHAPTERS) {
    const id = `${chapter.id}-${suffix}`;
    chapterIds[chapter.seq] = id;
    const text = chapter.opening + FILLER;
    await db.run(
      `INSERT INTO chapters
        (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
       VALUES (?, ?, ?, ?, '', 'draft', ?, ?, '', 0, ?, ?)`,
      [
        id,
        workId,
        chapter.title,
        chapter.seq,
        text,
        JSON.stringify([{ id: 'b1', type: 'paragraph', content: text }]),
        now,
        now,
      ]
    );
  }

  await db.run(
    `INSERT INTO characters (id, work_id, name, role, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`ch1-${suffix}`, workId, '陈默', '侦探', now, now]
  );

  return { userId, workId, chapterIds };
}

/** 假模型：按 user 消息里的章号返回固定问题，最后一批返回跨章问题。 */
function makeProvider(overrides = {}) {
  const calls = [];
  return {
    calls,
    async chat(options) {
      calls.push(options);
      const system = options.messages[0].content;
      const user = options.messages[1].content;

      if (overrides.onCall && overrides.onCall(calls.length, user)) {
        throw new Error(overrides.onCall(calls.length, user));
      }
      if (overrides.content) {
        const custom = overrides.content(calls.length, user);
        if (custom !== undefined) return { content: custom };
      }

      if (user.startsWith('以下是第 1–1 章')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                chapterSeq: 1,
                severity: 'high',
                title: '开场拖沓',
                detail: '第一段铺陈过长。',
                quote: '十点整，雨落下来。',
              },
            ],
          }),
        };
      }
      if (user.startsWith('以下是第 2–2 章')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                chapterSeq: 2,
                severity: 'medium',
                title: '动作交代太急',
                detail: '收伞到进门之间缺一步。',
                quote: '陈默把伞收了。',
              },
            ],
          }),
        };
      }
      if (user.startsWith('以下是第 3–3 章')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                chapterSeq: 3,
                severity: 'low',
                title: '对白缺少回应',
                detail: '喊了一声没有人接。',
                quote: '门外有人喊了一声。',
              },
            ],
          }),
        };
      }

      // 跨章总检：故意重复第一条，验证去重
      assert.ok(system.includes('全书跨章总检'), '最后一批应当是跨章总检');
      return {
        content: JSON.stringify({
          issues: [
            {
              chapterSeq: 1,
              severity: 'high',
              title: '开场拖沓',
              detail: '第一段铺陈过长。',
              quote: '十点整，雨落下来。',
            },
            {
              chapterSeq: 2,
              severity: 'high',
              title: '跨章时间线冲突',
              detail: '第 1 章说是夜里十点，第 2 章又写成清晨。',
              quote: '陈默把伞收了。',
            },
          ],
        }),
      };
    },
  };
}

test.before(async () => {
  await db.ready;

  fakeModel = await startFakeModel({
    defaultBehavior: {
      content: JSON.stringify({
        issues: [
          {
            chapterSeq: 1,
            severity: 'high',
            title: '开场拖沓',
            detail: '第一段铺陈过长。',
            quote: '十点整，雨落下来。',
          },
        ],
      }),
    },
  });
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

test('parseAiIssues: 容忍 markdown 代码块与前后废话', () => {
  const text = [
    '好的，问题如下：',
    '```json',
    JSON.stringify({
      issues: [
        { chapterSeq: 2, severity: 'high', title: '标题', detail: '说明', quote: '片段' },
      ],
    }),
    '```',
  ].join('\n');

  const issues = consistency.parseAiIssues(text);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].chapterSeq, 2);
  assert.equal(issues[0].severity, 'high');
});

test('parseAiIssues: 不是 JSON 时按行拆成问题，不整段丢掉', () => {
  const issues = consistency.parseAiIssues('1. 第一处不对\n2. 第二处也不对', 3);
  assert.equal(issues.length, 2);
  assert.equal(issues[0].chapterSeq, 3);
  assert.match(issues[0].title, /第一处不对/);
});

test('planAiCheck: 长书按章切批，每章全文都在', async () => {
  const { workId } = await seedWork();
  const plan = await consistency.planAiCheck(workId);

  assert.ok(plan);
  assert.equal(plan.chapters.length, 3);
  assert.equal(plan.batches.length, 3, '每章都超过单批上限，应各成一批');
  assert.ok(
    plan.batches.every((batch) => batch.chapters.length === 1),
    '不把一章切成两半'
  );
  assert.ok(plan.chapters[0].text.includes(FILLER), '整章正文都要读，不是只取开头');
  assert.equal(plan.notices.length, 0);
});

test('executeAiCheck: 每批都带人物卡，结果能落到章与块', async () => {
  const { workId, chapterIds } = await seedWork();
  const plan = await consistency.planAiCheck(workId);
  const provider = makeProvider();
  const progress = [];

  const result = await consistency.executeAiCheck(plan, {
    provider,
    providerName: 'deepseek',
    role: { temperature: 0.4 },
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.equal(provider.calls.length, 4, '3 批正文 + 1 次跨章总检');
  assert.deepEqual(progress, [
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ]);

  for (const call of provider.calls) {
    assert.ok(call.messages[0].content.includes('【陈默】'), '每批都要带人物卡');
  }

  const byTitle = new Map(result.issues.map((issue) => [issue.title, issue]));
  assert.equal(byTitle.size, 4, '重复的第一条应被去掉');

  const first = byTitle.get('开场拖沓');
  assert.equal(first.chapterId, chapterIds[1]);
  assert.equal(first.blockId, 'b1');
  assert.equal(first.type, 'ai');

  const cross = byTitle.get('跨章时间线冲突');
  assert.equal(cross.chapterId, chapterIds[2]);
  assert.equal(cross.chapterTitle, '伞');
  assert.equal(cross.blockId, 'b1');

  assert.equal(result.notices.length, 0);
});

test('executeAiCheck: 模型报错章号时按 quote 改判到正确的章', async () => {
  const { workId, chapterIds } = await seedWork();
  const plan = await consistency.planAiCheck(workId);

  const provider = makeProvider({
    content: (index, user) => {
      if (!user.startsWith('以下是第 1–1 章')) return undefined;
      return JSON.stringify({
        issues: [
          {
            chapterSeq: 2,
            severity: 'medium',
            title: '章号报错了',
            detail: '片段其实在第三章。',
            quote: '门外有人喊了一声。',
          },
        ],
      });
    },
  });

  const result = await consistency.executeAiCheck(plan, { provider, providerName: 'deepseek' });
  const issue = result.issues.find((item) => item.title === '章号报错了');
  assert.equal(issue.chapterSeq, 3);
  assert.equal(issue.chapterId, chapterIds[3]);
});

test('executeAiCheck: 某一批失败时保留其它批结果并留下说明', async () => {
  const { workId } = await seedWork();
  const plan = await consistency.planAiCheck(workId);

  const provider = makeProvider({
    onCall: (index, user) =>
      user.startsWith('以下是第 2–2 章') ? '模型超时' : '',
  });

  const result = await consistency.executeAiCheck(plan, {
    provider,
    providerName: 'deepseek',
  });

  assert.ok(
    result.notices.some((notice) => notice.includes('第 2 章没有读完')),
    '失败的那一批要说清楚，不能静默少读'
  );

  const titles = result.issues.map((issue) => issue.title);
  assert.ok(titles.includes('开场拖沓'), '第 1 批结果要保留');
  assert.ok(titles.includes('对白缺少回应'), '第 3 批结果要保留');
  assert.ok(!titles.includes('动作交代太急'), '失败那批没有结果');
});

test('HTTP: 启动全书检查后能轮询到结果', async () => {
  const user = await db.get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  const { workId } = await seedWork(user.id);

  const startRes = await server.request(`/api/consistency/${workId}/ai`, { method: 'POST' });
  assert.equal(startRes.status, 202, '长任务不能同步等，要先返回任务号');

  const { jobId, total } = await startRes.json();
  assert.ok(jobId);
  assert.equal(total, 4, '3 批正文 + 1 次跨章总检');

  let body = null;
  for (let i = 0; i < 100; i += 1) {
    const res = await server.request(`/api/consistency/${workId}/ai/${jobId}`);
    assert.equal(res.status, 200);
    body = await res.json();
    if (body.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(body.status, 'done');
  assert.equal(body.done, body.total);
  assert.ok(
    body.issues.some((issue) => issue.title === '开场拖沓'),
    '结果要能回到前端'
  );
  assert.ok(
    body.issues.every((issue) => issue.type !== 'ai' || issue.chapterId),
    'AI 发现的问题都要指明章节'
  );

  const missing = await server.request(`/api/consistency/${workId}/ai/not-a-job`);
  assert.equal(missing.status, 404);
});
