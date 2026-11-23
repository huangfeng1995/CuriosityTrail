'use strict';

/**
 * HP9：设定压力测试。
 *
 * 验收口径（PV11）：
 *   - 四类（制度/证据/时间/人）各至少一条；
 *   - earliest_break_chapter 必须是整数；写成「第十章」的条目被丢弃，其余照常返回；
 *   - detail 只写空话的条目被丢弃，不返回半成品；
 *   - 压力测试只提案，不改设定；作者显式采纳才写设定卡/情节卡。
 */

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv, startServer } = require('./helpers');
const { startFakeModel } = require('./fakeModel');

const env = setupTempEnv();

let db;
let app;
let server;
let fakeModel;
let originalConfig;
let workId;

const RISK_RESPONSE = JSON.stringify({
  risks: [
    {
      category: 'institution',
      title: '司空府抄检流程与密诏藏匿冲突',
      detail:
        '设定写司空府进出必须验符传，但密诏藏在司空府；第 3 章若让主角不验符传就进府取诏，会因为制度设定导致流程不可能成立。',
      earliest_break_chapter: 3,
      fix: ['补一张可夜入的令牌', '把取诏改到府外'],
      severity: 'block',
    },
    {
      category: 'evidence',
      title: '密诏的物证链断在谁手上',
      detail:
        '密诏由内侍交给司空府，但 evidence_items 没有记录交接人；一旦正文让主角直接知道密诏在府中，就会暴露知情链断裂，读者无法接受。',
      earliest_break_chapter: 2,
      fix: ['补一条内侍交接证据', '让主角先怀疑再确认'],
    },
    {
      category: 'time',
      title: '三日内往返两地的路程不成立',
      detail:
        '第一章到第三章只有三天，但设定写两地车程需七日；一旦主角按期赶回，就会与时间设定冲突。',
      earliest_break_chapter: 4,
      fix: ['延长章内时间', '改成快马加急'],
    },
    {
      category: 'human',
      title: '杨平保密的动机不足',
      detail:
        '人物卡写杨平以家族为先，但他却自愿替司马懿藏密诏；一旦没有给出家族受益的具体理由，就会与人物底线冲突。',
      earliest_break_chapter: 5,
      fix: ['补家族受威胁的场面'],
      severity: 'warn',
    },
    {
      category: 'time',
      title: '章序写成中文数字',
      detail: '时间线与人物年龄存在明显冲突，需要重新核对全书章节顺序与年龄。',
      earliest_break_chapter: '第十章',
      fix: ['重排时间线'],
    },
    {
      category: 'institution',
      title: '空话条目',
      detail: '可能有制度问题',
      earliest_break_chapter: 2,
      fix: ['再看看'],
    },
  ],
});

async function insertChapter(id, seq, title, outline) {
  const ts = new Date().toISOString();
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline,
        word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '第一卷', 'draft', '', '[]', ?, 0, ?, ?)`,
    [id, workId, title, seq, outline, ts, ts]
  );
}

test.before(async () => {
  await dbReady();
  fakeModel = await startFakeModel();
  const { port } = fakeModel.server.address();

  const aiConfig = require('../services/aiConfig');
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
  const created = await server.request('/api/works', {
    method: 'POST',
    body: { title: '压力测试作品', template: 'history_thriller' },
  });
  assert.strictEqual(created.status, 200);
  workId = (await created.json()).id;

  const ts = new Date().toISOString();
  await db.run(
    `INSERT INTO settings (id, work_id, category, name, content, importance, created_at, modified_at)
     VALUES ('s1', ?, '制度', '符传制度', '司空府进出必须验符传。', 4, ?, ?)`,
    [workId, ts, ts]
  );
  await db.run(
    `INSERT INTO characters (id, work_id, name, role, identity, goal, bottom_line, created_at, modified_at)
     VALUES ('c1', ?, '杨平', '主角', '河内士族子弟', '保全家族', '以家族为先', ?, ?)`,
    [workId, ts, ts]
  );
  await db.run(
    `INSERT INTO work_anchors
       (id, work_id, kind, subject, claim, confidence, source_title, source_locator,
        rules, immutable, status, created_at, modified_at)
     VALUES ('a1', ?, 'time', '建安五年', '建安五年正月曹操东征', 'sourced', '三国志', '武帝纪',
             '[]', 1, 'active', ?, ?)`,
    [workId, ts, ts]
  );

  await insertChapter('ch1', 1, '第一章', '杨平在府中听到密诏的消息。');
  await insertChapter('ch2', 2, '第二章', '杨平受托进司空府取密诏。');
  await insertChapter('ch3', 3, '第三章', '司马懿与杨平在府外对峙。');
});

async function dbReady() {
  db = require('../database');
  await db.ready;
  app = require('../app');
}

test.after(async () => {
  if (server) await server.close();
  if (fakeModel) await fakeModel.close();
  if (originalConfig) require('../services/aiConfig').updateConfig(originalConfig);
  env.cleanup();
});

test('PV11：四类齐全、非法章序与空话条目被丢弃，其余照常落库', async () => {
  fakeModel.setDefault({ content: RISK_RESPONSE, finishReason: 'stop' });

  const res = await server.request(`/api/pipeline/${workId}/risks/test`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.strictEqual(body.failed, false, '有可用条目时不应视为失败');
  assert.strictEqual(body.risks.length, 4, '两条不合格条目必须被丢弃');
  assert.deepStrictEqual(
    body.risks.map((risk) => risk.category).sort(),
    ['evidence', 'human', 'institution', 'time'],
    '四类必须各有一条'
  );
  for (const risk of body.risks) {
    assert.ok(Number.isInteger(risk.earliestBreakChapter), '章序必须是整数');
    assert.ok(risk.earliestBreakChapter >= 1 && risk.earliestBreakChapter <= 8);
  }

  const rows = await db.all(
    "SELECT * FROM setting_risks WHERE work_id = ? AND status = 'open'",
    [workId]
  );
  assert.strictEqual(rows.length, 4);
  assert.ok(!rows.some((row) => row.earliest_break_chapter === null));
  assert.ok(rows.every((row) => row.fix && row.fix.length > 0), '修补方向不能为空');
});

test('重新测试只刷新 open 条目，已采纳/已忽略的不被清掉', async () => {
  const risk = (await db.get(
    "SELECT * FROM setting_risks WHERE work_id = ? AND status = 'open' ORDER BY created_at LIMIT 1",
    [workId]
  ));
  const dismissed = await server.request(`/api/pipeline/${workId}/risks/${risk.id}/dismiss`, {
    method: 'POST',
  });
  assert.strictEqual(dismissed.status, 200);

  const res = await server.request(`/api/pipeline/${workId}/risks/test`, { method: 'POST' });
  const body = await res.json();
  assert.strictEqual(body.risks.length, 4);

  const kept = await db.get('SELECT status FROM setting_risks WHERE id = ?', [risk.id]);
  assert.strictEqual(kept.status, 'dismissed', '已处理的条目不参与替换');
});

test('采纳：显式写成设定卡，状态转为 accepted', async () => {
  const risk = await db.get(
    "SELECT * FROM setting_risks WHERE work_id = ? AND status = 'open' LIMIT 1",
    [workId]
  );
  const before = await db.get('SELECT COUNT(*) AS c FROM settings WHERE work_id = ?', [workId]);

  const res = await server.request(`/api/pipeline/${workId}/risks/${risk.id}/adopt`, {
    method: 'POST',
    body: { target: 'setting' },
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.cardId, '要返回新建卡片的 id');

  const after = await db.get('SELECT COUNT(*) AS c FROM settings WHERE work_id = ?', [workId]);
  assert.strictEqual(after.c, before.c + 1, '采纳后只新增一张设定卡');
  const updated = await db.get('SELECT status FROM setting_risks WHERE id = ?', [risk.id]);
  assert.strictEqual(updated.status, 'accepted');

  const again = await server.request(`/api/pipeline/${workId}/risks/${risk.id}/adopt`, {
    method: 'POST',
    body: { target: 'setting' },
  });
  assert.strictEqual(again.status, 409, '同一条不能重复采纳');
});

test('无可用条目：返回空清单 + notice，不写库', async () => {
  fakeModel.setDefault({
    content: JSON.stringify({
      risks: [
        {
          category: 'time',
          title: '章序是中文',
          detail: '时间线不可能成立，因为年龄与章节顺序存在冲突。',
          earliest_break_chapter: '第十章',
          fix: ['重排'],
        },
      ],
    }),
  });
  const before = await db.get('SELECT COUNT(*) AS c FROM setting_risks WHERE work_id = ?', [workId]);
  const res = await server.request(`/api/pipeline/${workId}/risks/test`, { method: 'POST' });
  const body = await res.json();
  assert.strictEqual(body.failed, true);
  assert.strictEqual(body.risks.length, 0);
  assert.match(body.notice, /没有给出可用/);
  const after = await db.get('SELECT COUNT(*) AS c FROM setting_risks WHERE work_id = ?', [workId]);
  assert.strictEqual(after.c, before.c, '失败不能清空或新增风险');
});
