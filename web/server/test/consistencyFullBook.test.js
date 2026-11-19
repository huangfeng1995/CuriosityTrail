'use strict';

/**
 * 一致性检查：跨章总检 + 结论生命周期。
 *
 * 盯住四件事：
 *   1. 不再逐批精读全文：请求里只有章节摘要，长度远小于正文；
 *   2. 跨章问题能落回章节；定位不到块时明确标成不可跳转；
 *   3. 规则层已经报过的问题，AI 结果里不会重复出现；
 *   4. 忽略（dismissed）过的结论重跑不再报，已采纳（adopted）的保留状态。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, createUser, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

// 必须在 require 业务模块之前设好：config.js 在加载时就定死了这些值
const env = setupTempEnv();
process.env.CONSISTENCY_DIGEST_CHARS = '800';

const db = require('../database');
const app = require('../app');
const aiConfig = require('../services/aiConfig');
const consistency = require('../services/consistency');

let server;
let fakeModel;
let originalConfig;

/** 正文里的大段填充：用来证明请求里没有整章正文。 */
const DEEP_FILLER = '沉在水底的一段旧事，谁也没有再提起。'.repeat(400);

const CHAPTERS = [
  {
    id: 'c1',
    seq: 1,
    title: '雨夜',
    opening: '十点整，雨落下来。',
    ending: '巷口没有一个人。',
  },
  {
    id: 'c2',
    seq: 2,
    title: '伞',
    opening: '陈默把伞收了。',
    ending: '他推门进了屋里。',
  },
  {
    id: 'c3',
    seq: 3,
    title: '门外',
    opening: '门外有人喊了一声。',
    ending: '没有人应他。',
  },
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
    const blocks = [
      { id: 'b1', type: 'paragraph', content: chapter.opening + '雨声连成一片。'.repeat(30) },
      { id: 'b2', type: 'paragraph', content: DEEP_FILLER },
      { id: 'b3', type: 'paragraph', content: chapter.ending },
    ];
    const text = blocks.map((b) => b.content).join('\n\n');

    await db.run(
      `INSERT INTO chapters
        (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
       VALUES (?, ?, ?, ?, '', 'draft', ?, ?, ?, 0, ?, ?)`,
      [
        id,
        workId,
        chapter.title,
        chapter.seq,
        text,
        JSON.stringify(blocks),
        `第 ${chapter.seq} 章大纲：${chapter.title}这一章交代了关键一步。`,
        now,
        now,
      ]
    );
  }

  // 规则层会报「从未出场」：正文里没有林霜，用来验证 AI 去重
  await db.run(
    `INSERT INTO characters (id, work_id, name, role, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`ch1-${suffix}`, workId, '林霜', '医生', now, now]
  );

  return { userId, workId, chapterIds };
}

/** 假 provider：分组调用返回跨章问题，汇总调用再补一条。 */
function makeProvider() {
  const calls = [];
  return {
    calls,
    async chat(options) {
      calls.push(options);
      const system = options.messages[0].content;
      const user = options.messages[1].content;

      if (system.includes('全书跨章总检（汇总）')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                chapterSeq: 2,
                severity: 'high',
                title: '跨章时间线冲突',
                detail: '第 1 章是夜里十点，第 2 章却写成清晨。',
                quote: '陈默把伞收了。',
              },
              {
                chapterSeq: 3,
                severity: 'medium',
                title: '跨章伏笔没有结果',
                detail: '第 3 章的喊声后面没有任何回应。',
                quote: '',
              },
            ],
          }),
        };
      }

      return {
        content: JSON.stringify({
          issues: [
            {
              chapterSeq: 1,
              severity: 'high',
              title: '开场时间与后文冲突',
              detail: '第一章说十点整，后文又说是清晨。',
              quote: '十点整，雨落下来。',
            },
            // 规则层已报的同一问题：必须被滤掉
            {
              chapterSeq: 1,
              severity: 'low',
              title: '人物「林霜」从未在正文中出现',
              detail: '林霜没有登场。',
              quote: '',
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
            title: '跨章时间线冲突',
            detail: '第一章说十点整，后文时间对不上。',
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

test('planAiCheck: 按摘要分组，不把整章正文算进去', async () => {
  const { workId } = await seedWork();
  const plan = await consistency.planAiCheck(workId);

  assert.ok(plan);
  assert.equal(plan.chapters.length, 3);
  assert.ok(plan.digests.length >= 2, '摘要超过一组上限时应分组');
  assert.equal(
    plan.calls,
    plan.digests.length + (plan.digests.length > 1 ? 1 : 0),
    '调用次数 = 分组数 + 一次汇总'
  );

  for (const chapter of plan.chapters) {
    assert.ok(chapter.opening.length <= 220, '开头只取关键段');
    assert.ok(chapter.ending.length <= 180, '结尾只取关键段');
    assert.ok(chapter.text.includes(DEEP_FILLER), '全文只用于 quote 定位');
  }
});

test('executeAiCheck: 请求只带摘要，跨章问题能落回章与块，规则层问题不重复', async () => {
  const { workId, chapterIds } = await seedWork();
  const plan = await consistency.planAiCheck(workId);
  const provider = makeProvider();
  const progress = [];

  const ruleIssues = await consistency.runRuleChecks(workId);
  assert.ok(
    ruleIssues.some((i) => i.type === 'unused_character'),
    '前置：规则层应能报出林霜未出场'
  );

  const result = await consistency.executeAiCheck(plan, {
    provider,
    providerName: 'deepseek',
    role: { temperature: 0.4 },
    excludeIssues: ruleIssues,
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.equal(provider.calls.length, plan.calls, '调用次数应与规划一致');
  assert.ok(provider.calls.length <= 4, '三次分组 + 一次汇总，个位数');

  // 每个请求里都只有摘要：正文有 7000 字以上，请求远小于它
  for (const call of provider.calls) {
    const user = call.messages[1].content;
    assert.ok(user.length < 4000, '请求里不能出现整章正文');
    assert.ok(!user.includes(DEEP_FILLER), '大段正文不应进入提示词');
    assert.ok(call.messages[0].content.includes('【林霜】'), '每批都带人物卡');
  }

  const byTitle = new Map(result.issues.map((issue) => [issue.title, issue]));
  assert.ok(!byTitle.has('人物「林霜」从未在正文中出现'), '规则层已报的问题不应重复');

  const cross = byTitle.get('跨章时间线冲突');
  assert.ok(cross, '汇总阶段的跨章问题要保留');
  assert.equal(cross.chapterId, chapterIds[2]);
  assert.equal(cross.chapterTitle, '伞');
  assert.equal(cross.blockId, 'b1', 'quote 能定位到块');

  const vague = byTitle.get('跨章伏笔没有结果');
  assert.ok(vague);
  assert.equal(vague.chapterId, chapterIds[3], '没有 quote 时仍按 chapterSeq 归属章节');
  assert.equal(vague.blockId, '');
  assert.equal(vague.locatable, false, '定位不到块时明确不可跳正文');

  assert.equal(progress[progress.length - 1][0], progress[progress.length - 1][1]);
  assert.deepEqual(progress.map((p) => p[1]), new Array(progress.length).fill(plan.calls));
});

test('executeAiCheck: 某一组失败时保留其它组结果并留下说明', async () => {
  const { workId } = await seedWork();
  const plan = await consistency.planAiCheck(workId);

  const provider = makeProvider();
  const failing = {
    async chat(options) {
      const user = options.messages[1].content;
      if (user.includes('第 2 章')) throw new Error('模型超时');
      return provider.chat(options);
    },
  };

  const result = await consistency.executeAiCheck(plan, {
    provider: failing,
    providerName: 'deepseek',
  });

  assert.ok(
    result.notices.some((notice) => notice.includes('没有检查完')),
    '失败的那一组要说清楚，不能静默漏检'
  );
});

test('HTTP: 忽略过的跨章结论重跑不再报，已采纳的保留状态', async () => {
  const user = await db.get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  const { workId } = await seedWork(user.id);

  const first = await runJob(workId);
  const cross = first.issues.find((issue) => issue.title === '跨章时间线冲突');
  assert.ok(cross, '第一次检查应报出跨章问题');
  assert.ok(cross.id, '结论应落库并带 id');
  assert.equal(cross.status, 'open');
  assert.equal(cross.source, 'cross_chapter');

  const dismissRes = await server.request(
    `/api/consistency/${workId}/findings/${cross.id}/dismiss`,
    { method: 'POST' }
  );
  assert.equal(dismissRes.status, 200);
  assert.equal((await dismissRes.json()).finding.status, 'dismissed');

  // 换一条（规则层的未登场人物）标记采纳
  const ruleIssue = first.issues.find((issue) => issue.type === 'unused_character');
  assert.ok(ruleIssue, '规则层问题也应带 id');
  const adoptRes = await server.request(
    `/api/consistency/${workId}/findings/${ruleIssue.id}/adopt`,
    { method: 'POST' }
  );
  assert.equal(adoptRes.status, 200);

  const second = await runJob(workId);
  const titles = second.issues.map((issue) => issue.title);
  assert.ok(!titles.includes('跨章时间线冲突'), '忽略过的问题重跑不应再报');

  const adopted = second.issues.find((issue) => issue.type === 'unused_character');
  assert.ok(adopted, '已采纳的规则问题仍保留，便于面板标记');
  assert.equal(adopted.status, 'adopted');

  // 规则层 GET 也要遵守同一套生命周期
  const listRes = await server.request(`/api/consistency/${workId}`);
  const list = (await listRes.json()).issues;
  assert.ok(
    !list.some((issue) => issue.title === '跨章时间线冲突'),
    '规则层列表不应混入跨章结论'
  );
  assert.equal(
    list.find((issue) => issue.type === 'unused_character')?.status,
    'adopted'
  );
});

test('HTTP: 结论只能在自己的作品下改状态', async () => {
  const user = await db.get('SELECT id FROM users WHERE phone = ?', [server.phone]);
  const { workId } = await seedWork(user.id);
  const other = await seedWork(user.id);

  const first = await runJob(workId);
  const finding = first.issues[0];
  assert.ok(finding);

  const res = await server.request(
    `/api/consistency/${other.workId}/findings/${finding.id}/dismiss`,
    { method: 'POST' }
  );
  assert.equal(res.status, 404, '换个作品 id 不能改别人的结论');
});

/** 启动一次跨章总检并轮询到结束。 */
async function runJob(workId) {
  const startRes = await server.request(`/api/consistency/${workId}/ai`, { method: 'POST' });
  assert.equal(startRes.status, 202, '应返回任务号');
  const { jobId, total } = await startRes.json();
  assert.ok(jobId);
  assert.ok(total > 0 && total <= 4, '调用次数应是个位数');

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
  return body;
}
