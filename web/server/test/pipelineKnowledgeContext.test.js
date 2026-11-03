'use strict';

/**
 * HP6：本章知情边界注入（P.6.4 / PV7）。
 *
 * 验收重点：
 *   * PV7：chapter_seq=3 的 knows 行，第 2/3 章看不到内容与关键词，第 4 章看得到
 *   * 关闭态：system 逐字节不变，无「## 本章知情边界」段
 *   * 整段 ≤700 字；超限先砍「未知」、再砍证据，绝不砍「本章允许揭示」
 *   * 「半知」与「怀疑」分开标注
 *   * 无节拍表时明确写出「本章未规划揭示点」，且未知事实不进入允许揭示
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { setupTempEnv, startServer } = require('./helpers');

const env = setupTempEnv();
const TS = '2026-01-01T00:00:00.000Z';

let db;
let app;
let server;
let assembleContext;
let userId;

async function createWork(template = 'history_thriller', title = '知情边界作品') {
  const res = await server.request('/api/works', {
    method: 'POST',
    body: { title, template },
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

async function addChapter(workId, { id, seq = 1, title, outline = '', content = '', blocks = '[]' }) {
  await db.run(
    `INSERT INTO chapters
       (id, work_id, title, seq, volume, status, content, blocks, outline, word_count, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', 'draft', ?, ?, ?, 0, ?, ?)`,
    [id, workId, title, seq, content, blocks, outline, TS, TS]
  );
}

async function addCharacter(workId, { id, name, aliases = '' }) {
  await db.run(
    `INSERT INTO characters
       (id, work_id, name, aliases, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, workId, name, aliases, TS, TS]
  );
}

async function addFact(workId, { id, content, keywords = '', createdAt = TS }) {
  await db.run(
    `INSERT INTO story_facts
       (id, work_id, secret_id, part_no, content, keywords, created_at, modified_at)
     VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    [id, workId, content, keywords, createdAt, createdAt]
  );
}

async function addKnowledge(workId, characterId, factId, chapterSeq, state, createdAt = TS) {
  await db.run(
    `INSERT INTO knowledge_matrix
       (id, work_id, character_id, fact_id, chapter_seq, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), workId, characterId, factId, chapterSeq, state, createdAt]
  );
}

async function addEvidence(workId, { id, title, holderCharacterId, seenBy = [], factId = null }) {
  await db.run(
    `INSERT INTO evidence_items
       (id, work_id, fact_id, title, description, holder_character_id, holder_kind,
        seen_by, status, created_at, modified_at)
     VALUES (?, ?, ?, ?, '', ?, 'character', ?, 'active', ?, ?)`,
    [id, workId, factId, title, holderCharacterId, JSON.stringify(seenBy), TS, TS]
  );
}

function knowledgeSection(system) {
  const head = system.indexOf('## 本章知情边界（硬约束）');
  if (head < 0) return '';
  const rest = system.slice(head);
  const end = rest.indexOf('\n\n---\n\n');
  return end >= 0 ? rest.slice(0, end) : rest;
}

function allowedLine(section) {
  return section.split('\n').find((line) => line.startsWith('本章允许揭示')) || '';
}

async function assemble(workId, chapterId, extra = {}) {
  return assembleContext({
    workId,
    chapterId,
    roleKey: 'writer',
    scope: 'chapter',
    userId,
    ...extra,
  });
}

test.before(async () => {
  db = require('../database');
  await db.ready;
  app = require('../app');
  ({ assembleContext } = require('../services/context'));
  server = await startServer(app);
  const row = await db.get('SELECT id FROM users WHERE phone = ?', ['13900000001']);
  userId = row.id;
});

test.after(async () => {
  if (server) await server.close();
  env.cleanup();
});

// ---------------------------------------------------------------------------
// 1. PV7：chapter_seq=3 的行，第 2/3 章不可见，第 4 章可见
// ---------------------------------------------------------------------------

test('PV7：chapter_seq=3 表示第 3 章写完后生效，第 2/3 章只见短标题，第 4 章才见全文', async () => {
  const work = await createWork('history_thriller', 'PV7 作品');
  for (const seq of [2, 3, 4]) {
    await addChapter(work.id, {
      id: `pv7-ch-${seq}`,
      seq,
      title: `第 ${seq} 章`,
      outline: '司马懿在府中与来客密谈。',
    });
  }

  await addCharacter(work.id, { id: 'pv7-sima', name: '司马懿' });
  await addFact(work.id, {
    id: 'pv7-f2',
    content: '司马懿曾向曹操举荐他，此事只有曹操与荀彧知道',
    keywords: '举荐,曹操',
  });
  // chapter_seq = 3 表示「第 3 章写完后生效」，所以第 4 章开写前才可见。
  await addKnowledge(work.id, 'pv7-sima', 'pv7-f2', 3, 'knows');

  const ch2 = await assemble(work.id, 'pv7-ch-2');
  const ch2Section = knowledgeSection(ch2.messages[0].content);
  assert.ok(ch2Section.startsWith('## 本章知情边界（硬约束）'), '第 2 章应有知情边界段');
  assert.strictEqual(ch2.meta.knowledgeCount, 1);
  assert.ok(!ch2Section.includes('司马懿曾向曹操举荐他，此事只有曹操与荀彧知道'), '第 2 章不得出现 F2 全文');
  assert.ok(!ch2Section.includes('关键词：'), '第 2 章不得出现 F2 关键词字段');
  assert.ok(ch2Section.includes('F1（司马懿曾向曹操举荐他，此'), '未知条目必须带短标题');

  const ch3 = await assemble(work.id, 'pv7-ch-3');
  const ch3Section = knowledgeSection(ch3.messages[0].content);
  assert.ok(ch3Section.startsWith('## 本章知情边界（硬约束）'), '第 3 章应有知情边界段');
  assert.strictEqual(ch3.meta.knowledgeCount, 1);
  assert.ok(!ch3Section.includes('司马懿曾向曹操举荐他，此事只有曹操与荀彧知道'), '第 3 章不得出现 F2 全文');
  assert.ok(!ch3Section.includes('关键词：'), '第 3 章不得出现 F2 关键词字段');
  assert.ok(ch3Section.includes('F1（司马懿曾向曹操举荐他，此'), '未知条目必须带短标题');

  const ch4 = await assemble(work.id, 'pv7-ch-4');
  const ch4Section = knowledgeSection(ch4.messages[0].content);
  assert.ok(ch4Section.startsWith('## 本章知情边界（硬约束）'), '第 4 章应有知情边界段');
  assert.strictEqual(ch4.meta.knowledgeCount, 1);
  assert.ok(ch4Section.includes('司马懿曾向曹操举荐他，此事只有曹操与荀彧知道'), '第 4 章必须包含 F2 全文');
  assert.ok(ch4Section.includes('关键词：举荐,曹操'), '第 4 章必须包含 F2 关键词字段');
  assert.match(ch4Section, /【司马懿】已知：/);
});

// ---------------------------------------------------------------------------
// 2. 关闭态
// ---------------------------------------------------------------------------

test('关闭态：写入知情数据后 system 逐字节不变，且无知情边界段', async () => {
  const work = await createWork('', '关闭态知情作品');
  await addChapter(work.id, {
    id: 'off-knowledge-ch',
    seq: 1,
    title: '曹操夜宴',
    outline: '司马懿与曹操密谈。',
  });

  const before = await assemble(work.id, 'off-knowledge-ch');
  assert.strictEqual(before.meta.pipeline, false);

  await addCharacter(work.id, { id: 'off-sima', name: '司马懿' });
  await addFact(work.id, { id: 'off-fact', content: '司马懿曾向曹操举荐他', keywords: '举荐' });
  await addKnowledge(work.id, 'off-sima', 'off-fact', 1, 'knows');

  const after = await assemble(work.id, 'off-knowledge-ch');
  assert.strictEqual(
    after.messages[0].content,
    before.messages[0].content,
    '关闭模板后 system 必须逐字相同'
  );
  assert.ok(!after.messages[0].content.includes('## 本章知情边界'));
  assert.strictEqual(after.meta.knowledgeCount, 0);
});

// ---------------------------------------------------------------------------
// 3. 700 字超限
// ---------------------------------------------------------------------------

test('超限：8 角色 × 多条事实整段 ≤700 字，先砍未知与证据，允许揭示仍在', async () => {
  const work = await createWork('history_thriller', '超限知情作品');
  await addChapter(work.id, {
    id: 'limit-knowledge-ch',
    seq: 2,
    title: '群臣夜议',
    outline: '',
  });

  const names = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
  for (const name of names) {
    await addCharacter(work.id, { id: `limit-c-${name}`, name });
  }

  // 8 条事实，每条内容都很长；已知/半知会带内容，撑爆 700 字。
  for (let i = 1; i <= 8; i += 1) {
    await addFact(work.id, {
      id: `limit-f-${i}`,
      content: `事实${i}：${'长'.repeat(80)}`,
      keywords: `秘密${i}`,
      createdAt: `2026-01-01T00:00:0${i}.000Z`,
    });
  }

  // 每个角色：4 条已知 + 2 条半知 + 1 条怀疑 + 1 条未知。
  for (const name of names) {
    const characterId = `limit-c-${name}`;
    for (let i = 1; i <= 8; i += 1) {
      const state = i <= 4 ? 'knows' : i <= 6 ? 'partial' : i === 7 ? 'suspects' : null;
      if (state) await addKnowledge(work.id, characterId, `limit-f-${i}`, 1, state);
    }
  }

  await addEvidence(work.id, {
    id: 'limit-evidence',
    title: '证据卷宗',
    holderCharacterId: 'limit-c-甲',
    seenBy: ['limit-c-乙'],
    factId: 'limit-f-1',
  });

  const beatPlan = {
    plan: {
      beats: [
        {
          id: 'B4',
          type: '揭示',
          goal: '揭开卷宗',
          obstacle: '卷宗被封',
          cost: '打草惊蛇',
          delta: { variable: '信息', from: '不知', to: '知道秘密1' },
          infoGain: '揭示秘密1',
          paragraphs: 8,
          endHook: '门外有人',
        },
      ],
    },
  };

  const result = await assemble(work.id, 'limit-knowledge-ch', { beatPlan });
  const section = knowledgeSection(result.messages[0].content);
  assert.ok(section.startsWith('## 本章知情边界（硬约束）'));
  assert.ok(section.length <= 700, `知情边界段应 ≤700 字，实际 ${section.length}`);
  assert.ok(section.includes('本章允许揭示'), '「本章允许揭示」绝不能被砍');
  assert.ok(section.includes('F1（B4 揭示）'), '允许揭示的条目必须保留');
  assert.ok(
    section.includes('规划外新事实本章合计仍限 1 条（本章总量，不是每角色）。'),
    '有节拍表时，规划外新事实仍限本章合计 1 条'
  );
  assert.ok(!section.includes('证据：'), '超限时证据行应先于允许揭示被砍');
  assert.ok(!section.includes('未知：'), '超限时「未知」列表应先被砍');
  assert.ok(section.includes('F1（事实1：长长长长长长长长'), '超限时保留编号+短标题');
  assert.ok(!section.includes('长'.repeat(80)), '超限时砍掉内容解释');
  assert.ok(result.meta.knowledgeCount <= 8);
  const omitted = 8 - result.meta.knowledgeCount;
  assert.ok(omitted > 0, '该场景必须触发角色行裁剪');
  assert.ok(
    section.includes(`其余 ${omitted} 人本轮未注入边界`),
    '被砍掉的角色必须在段末计数，不能静默'
  );
});

// ---------------------------------------------------------------------------
// 4. 半知与怀疑分开
// ---------------------------------------------------------------------------

test('半知与怀疑分开标注，不合并成「已知」', async () => {
  const work = await createWork('history_thriller', '半知与怀疑');
  await addChapter(work.id, {
    id: 'split-ch',
    seq: 2,
    title: '夜谈',
    outline: '甲、乙在场。',
  });

  await addCharacter(work.id, { id: 'split-a', name: '甲' });
  await addCharacter(work.id, { id: 'split-b', name: '乙' });
  await addFact(work.id, { id: 'split-f1', content: '事实一', keywords: '秘密一' });
  await addFact(work.id, { id: 'split-f2', content: '事实二', keywords: '秘密二' });

  await addKnowledge(work.id, 'split-a', 'split-f1', 1, 'partial');
  await addKnowledge(work.id, 'split-b', 'split-f2', 1, 'suspects');

  const result = await assemble(work.id, 'split-ch');
  const section = knowledgeSection(result.messages[0].content);

  assert.ok(section.includes('半知：F1'), '半知必须单独标注');
  assert.ok(section.includes('怀疑：F2'), '怀疑必须单独标注');
  assert.ok(!section.includes('已知：F1'), '半知不得合并成已知');
  assert.ok(!section.includes('已知：F2'), '怀疑不得合并成已知');
  assert.strictEqual(result.meta.knowledgeCount, 2);
});

// ---------------------------------------------------------------------------
// 5. 无节拍表
// ---------------------------------------------------------------------------

test('无节拍表：允许揭示为空，但必须写出「最多允许揭示 1 条」而不是锁死故事', async () => {
  const work = await createWork('history_thriller', '无节拍表');
  await addChapter(work.id, {
    id: 'noplan-ch',
    seq: 2,
    title: '密谈',
    outline: '司马懿在府中密谈。',
  });

  await addCharacter(work.id, { id: 'noplan-sima', name: '司马懿' });
  await addFact(work.id, { id: 'noplan-f1', content: '司马懿见过密诏', keywords: '密诏' });
  await addKnowledge(work.id, 'noplan-sima', 'noplan-f1', 1, 'knows');

  const result = await assemble(work.id, 'noplan-ch');
  const section = knowledgeSection(result.messages[0].content);

  assert.ok(section.includes('本章未规划揭示点'), '不能沉默，必须让作者看见');
  assert.ok(section.includes('最多允许揭示 1 条新事实'), '无节拍表时允许 1 条，不能锁死');
  assert.ok(section.includes('本章总量，不是每角色'), '必须说明 1 条是本章总量');
  assert.ok(section.includes('未规划模式'), '必须让作者知道当前是未规划模式');
  assert.ok(!section.includes('仅允许已知范围内'), '旧措辞必须移除');
  assert.strictEqual(
    allowedLine(section),
    '本章允许揭示（未规划模式）：本章未规划揭示点。最多允许揭示 1 条新事实（本章总量，不是每角色），且必须写出触发契机与代价；不得本章连开多条。'
  );
});

// ---------------------------------------------------------------------------
// 6. 无节拍表 + 未知事实
// ---------------------------------------------------------------------------

test('无节拍表 + 有未知事实：未知事实只进「未知」列表，不进入允许揭示', async () => {
  const work = await createWork('history_thriller', '未知事实不越界');
  await addChapter(work.id, {
    id: 'unknown-ch',
    seq: 2,
    title: '密谈',
    outline: '司马懿在府中密谈。',
  });

  await addCharacter(work.id, { id: 'unknown-sima', name: '司马懿' });
  await addFact(work.id, { id: 'unknown-f1', content: '司马懿见过密诏', keywords: '密诏' });
  await addFact(work.id, {
    id: 'unknown-f2',
    content: '曹操有意废长立幼，此事由荀彧密报',
    keywords: '废长立幼',
  });
  await addKnowledge(work.id, 'unknown-sima', 'unknown-f1', 1, 'knows');

  const result = await assemble(work.id, 'unknown-ch');
  const section = knowledgeSection(result.messages[0].content);
  const allowed = allowedLine(section);

  assert.ok(section.includes('未知：F2（曹操有意废长立幼，此事由'), '未知事实必须带短标题');
  assert.ok(!section.includes('曹操有意废长立幼，此事由荀彧密报'), '未知事实不得带完整正文');
  assert.ok(!allowed.includes('F2'), '未知事实不得进入允许揭示');
  assert.ok(!allowed.includes('曹操有意废长立幼，此事由荀彧密报'), '未知事实内容不得进入允许揭示');
  assert.ok(!allowed.includes('废长立幼'), '未知事实关键词不得进入允许揭示');
});
