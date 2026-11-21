'use strict';

/**
 * 灵感方向生成测试。
 *
 * 重点不是模型文采，而是三条底线：
 *   1. 六维清单稳定且互不重复；
 *   2. 与当前作品无关的提示被丢弃；
 *   3. 生成阶段只读，绝不写灵感 / 设定 / 情节卡。
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();

const service = require('../services/inspirationPrompts');
const { ready, run, get, all } = require('../database');

const now = () => new Date().toISOString();

let userId;
let work;
let chapter;

async function seed() {
  userId = crypto.randomUUID();
  await run(
    'INSERT INTO users (id, phone, nickname, role, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, '13900000001', '测试作者', 'user', now(), now()]
  );

  const workId = crypto.randomUUID();
  await run(
    `INSERT INTO works (id, user_id, title, genre, synopsis, outline, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workId,
      userId,
      '雾港',
      '悬疑',
      '林砚回到雾港查父亲的死因，沈书白掌握着唯一能销掉通缉令的渠道。',
      '第一卷：林砚回港，发现账册；第二卷：沈书白反目。',
      now(),
      now(),
    ]
  );
  work = await get('SELECT * FROM works WHERE id = ?', [workId]);

  const chapterId = crypto.randomUUID();
  await run(
    `INSERT INTO chapters (id, work_id, title, seq, volume, status, content, blocks, outline, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      chapterId,
      workId,
      '第 12 章 码头',
      12,
      '第二卷',
      'draft',
      '林砚在码头等沈书白，雾很大，他没看见来人腰上的铜钥匙。',
      JSON.stringify([
        { id: 'b1', type: 'paragraph', content: '林砚在码头等沈书白，雾很大，他没看见来人腰上的铜钥匙。' },
      ]),
      '林砚与沈书白在码头交接账册，冲突升级。',
      now(),
      now(),
    ]
  );
  chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);

  const chars = [
    { name: '林砚', role: '前警探', goal: '查清父亲死因', arc: '从逃避到直面' },
    { name: '沈书白', role: '走私商', goal: '拿回账册', arc: '从盟友到对手' },
  ];
  for (const c of chars) {
    await run(
      `INSERT INTO characters (id, work_id, name, role, goal, arc, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), workId, c.name, c.role, c.goal, c.arc, now(), now()]
    );
  }

  await run(
    `INSERT INTO settings (id, work_id, category, name, content, importance, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), workId, '物品', '铜钥匙', '沈书白从不离身的铜钥匙，能打开港务局旧档案室。', 5, now(), now()]
  );

  await run(
    `INSERT INTO plot_cards (id, work_id, chapter_id, title, kind, content, seq, status, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), workId, chapterId, '沈书白袖口的墨迹', 'foreshadow', '第二次出现，还没有解释。', 1, 'todo', now(), now()]
  );

  // 另一部作品的人物，绝不能混进本次上下文。
  const otherWorkId = crypto.randomUUID();
  await run(
    `INSERT INTO works (id, user_id, title, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?)`,
    [otherWorkId, userId, '另一部作品', now(), now()]
  );
  await run(
    `INSERT INTO characters (id, work_id, name, role, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), otherWorkId, '无关人物', '路人', now(), now()]
  );
}

test.before(async () => {
  await ready;
  await seed();
});

test.after(() => env.cleanup());

test('六维清单稳定、键唯一、描述不为空', () => {
  const dimensions = service.listDimensions();
  assert.strictEqual(dimensions.length, 6);
  assert.strictEqual(new Set(dimensions.map((d) => d.key)).size, 6);
  for (const d of dimensions) {
    assert.ok(d.label);
    assert.ok(d.description);
    assert.ok(d.example.length > 20);
  }
});

test('buildContext 只取本作品资料，并给出可校验的实体锚点', async () => {
  const context = await service.buildContext({ work, chapter, userId });

  assert.match(context.text, /林砚/);
  assert.match(context.text, /沈书白/);
  assert.match(context.text, /铜钥匙/);
  assert.match(context.text, /沈书白袖口的墨迹/);
  assert.match(context.text, /码头/);
  assert.ok(!context.text.includes('无关人物'));
  assert.ok(context.knownAnchors.includes('林砚'));
  assert.ok(context.knownAnchors.includes('铜钥匙'));
});

test('parseSuggestions 丢弃未知锚点、空话、重复和超出条数的提示', () => {
  const text =
    '让林砚在码头把账册交给沈书白之前，先发现铜钥匙能打开档案室；他必须在父亲的名誉和活命之间选一个。';
  const raw = JSON.stringify({
    groups: [
      {
        dimension: 'conflict',
        prompts: [
          { text, anchor: '林砚', reason: '接第 12 章交接' },
          { text, anchor: '林砚', reason: '重复条' },
          {
            text: '让一个陌生人突然冲进来把所有人打一顿，然后离开。',
            anchor: '陌生人',
            reason: '无关',
          },
          { text: '加强冲突，多写细节。', anchor: '林砚', reason: '空话' },
          {
            text: '让沈书白在码头当众撕掉林砚的船票，林砚要么动手，要么低头去捡。只写周围人的反应。',
            anchor: '沈书白',
            reason: '把分歧推过不可撤回的一步',
          },
        ],
      },
    ],
  });

  const groups = service.parseSuggestions(raw, {
    dimension: 'conflict',
    count: 2,
    knownAnchors: ['林砚', '沈书白', '码头', '铜钥匙'],
  });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].prompts.length, 2);
  assert.ok(groups[0].prompts.every((p) => p.text.length >= service.MIN_PROMPT_LENGTH));
  assert.ok(groups[0].prompts.every((p) => p.id));
});

test('parseSuggestions 会过滤掉 exclude 里已经出现的提示', () => {
  const text =
    '让林砚在码头把账册交给沈书白之前，先发现铜钥匙能打开档案室；他必须在父亲的名誉和活命之间选一个。';
  const raw = JSON.stringify({
    groups: [
      {
        dimension: 'conflict',
        prompts: [{ text, anchor: '林砚', reason: '接第 12 章交接' }],
      },
    ],
  });

  const groups = service.parseSuggestions(raw, {
    dimension: 'conflict',
    count: 2,
    knownAnchors: ['林砚', '沈书白', '码头', '铜钥匙'],
    exclude: [text],
  });

  assert.deepStrictEqual(groups, []);
});

test('parseSuggestions 在新作品资料很少时放宽锚点，但不接受空文本', () => {
  const raw = JSON.stringify({
    groups: [
      {
        dimension: 'image',
        prompts: [
          {
            text: '让雾在本章出现三次：第一次遮住来人的脸，第二次让主角认错人，第三次散开时露出他不想看见的东西。',
            anchor: '',
            reason: '延续作品的雾港意象',
          },
        ],
      },
    ],
  });

  const groups = service.parseSuggestions(raw, { count: 2, knownAnchors: [] });
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].prompts.length, 1);
  assert.ok(groups[0].prompts[0].anchor);
});

test('parseSuggestions 指定维度时不会混入其它维度', () => {
  const raw = JSON.stringify({
    groups: [
      {
        dimension: 'conflict',
        prompts: [
          {
            text: '让沈书白在码头当众撕掉林砚的船票，林砚要么动手，要么低头去捡。只写周围人的反应。',
            anchor: '沈书白',
            reason: '把分歧推过不可撤回的一步',
          },
        ],
      },
      {
        dimension: 'image',
        prompts: [
          {
            text: '让雾在本章出现三次：第一次遮住来人的脸，第二次让林砚认错人，第三次散开时露出他不想看见的东西。',
            anchor: '林砚',
            reason: '延续雾港意象',
          },
        ],
      },
    ],
  });

  const groups = service.parseSuggestions(raw, {
    dimension: 'conflict',
    count: 2,
    knownAnchors: ['林砚', '沈书白', '码头', '铜钥匙'],
  });

  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].dimension, 'conflict');
});

test('suggest 成功时把上下文和维度要求交给模型', async () => {
  const provider = {
    name: 'fake',
    calls: [],
    async chat(payload) {
      this.calls.push(payload.messages);
      return {
        content: JSON.stringify({
          groups: [
            {
              dimension: 'conflict',
              prompts: [
                {
                  text: '让沈书白在码头当众撕掉林砚的船票，林砚要么动手，要么低头去捡。只写周围人的反应。',
                  anchor: '沈书白',
                  reason: '把分歧推过不可撤回的一步',
                },
              ],
            },
          ],
        }),
      };
    },
  };

  const result = await service.suggest({
    work,
    chapter,
    userId,
    dimension: 'conflict',
    count: 1,
    provider,
    timeoutMs: 1000,
  });

  assert.strictEqual(result.degraded, false);
  assert.strictEqual(result.groups.length, 1);
  assert.strictEqual(result.groups[0].dimension, 'conflict');
  assert.strictEqual(provider.calls.length, 1);
  const userMessage = provider.calls[0].find((m) => m.role === 'user').content;
  assert.match(userMessage, /林砚/);
  assert.match(userMessage, /conflict/);
  assert.match(userMessage, /每个维度 1 条/);
});

test('suggest 在 provider 报错或超时时返回 degraded，不抛异常', async () => {
  const broken = {
    name: 'broken',
    async chat() {
      throw new Error('down');
    },
  };
  const failed = await service.suggest({
    work,
    chapter,
    userId,
    dimension: 'conflict',
    provider: broken,
    timeoutMs: 1000,
  });
  assert.strictEqual(failed.degraded, true);
  assert.deepStrictEqual(failed.groups, []);

  const hanging = {
    name: 'hanging',
    chat() {
      return new Promise(() => {});
    },
  };
  const timedOut = await service.suggest({
    work,
    chapter,
    userId,
    dimension: 'conflict',
    provider: hanging,
    timeoutMs: 20,
  });
  assert.strictEqual(timedOut.degraded, true);
  assert.deepStrictEqual(timedOut.groups, []);
});

test('suggest 只读：生成前后灵感 / 设定 / 情节卡数量不变', async () => {
  const provider = {
    name: 'fake',
    async chat() {
      return {
        content: JSON.stringify({
          groups: [
            {
              dimension: 'conflict',
              prompts: [
                {
                  text: '让沈书白在码头当众撕掉林砚的船票，林砚要么动手，要么低头去捡。只写周围人的反应。',
                  anchor: '沈书白',
                  reason: '把分歧推过不可撤回的一步',
                },
              ],
            },
          ],
        }),
      };
    },
  };

  const before = await Promise.all([
    get('SELECT COUNT(*) AS n FROM inspirations'),
    get('SELECT COUNT(*) AS n FROM settings'),
    get('SELECT COUNT(*) AS n FROM plot_cards'),
  ]);

  await service.suggest({
    work,
    chapter,
    userId,
    dimension: 'conflict',
    provider,
    timeoutMs: 1000,
  });

  const after = await Promise.all([
    get('SELECT COUNT(*) AS n FROM inspirations'),
    get('SELECT COUNT(*) AS n FROM settings'),
    get('SELECT COUNT(*) AS n FROM plot_cards'),
  ]);

  assert.deepStrictEqual(
    after.map((row) => row.n),
    before.map((row) => row.n)
  );
});
