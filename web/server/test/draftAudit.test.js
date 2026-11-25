/**
 * 写后确定性审查的独立测试。
 *
 * 这些检查原先内联在 /chat 里，只有整轮生成的集成测试能间接覆盖。
 * 抽成纯函数后，可以直接验证「超长段必拦」「无节拍表不记账」这类规则。
 */

const test = require('node:test');
const assert = require('node:assert');

const { auditDraft } = require('../services/agent/draftAudit');

const PLAN = { beats: [{ id: 'B1', paragraphs: 3, type: '行动' }] };

test('无节拍表：不记篇幅配比，形态没有可归属的拍号', () => {
  const r = auditDraft({
    plan: null,
    brief: null,
    text: '他把弓收进鞘里。\n\n雪停了，院里的脚印被风抹平。',
  });
  assert.strictEqual(r.wordShares, null);
  assert.deepStrictEqual(r.shapeIds, []);
  assert.ok(Array.isArray(r.withhold.violations));
  assert.ok(Array.isArray(r.invariant.violations));
  assert.ok(Array.isArray(r.handover.beatIds));
});

test('有节拍表：篇幅配比按拍给出实值，形态违规能归到拍号', () => {
  const r = auditDraft({
    plan: PLAN,
    brief: null,
    text: '他把弓收进鞘里。\n\n雪停了，院里的脚印被风抹平。\n\n他推门进屋，炭火还亮着。',
  });
  assert.ok(r.wordShares, '有拍表就要有配比记录');
  assert.equal(r.wordShares.beats.length, 1);
  assert.equal(r.wordShares.beats[0].id, 'B1');
  assert.ok(r.wordShares.beats[0].chars > 0);
  assert.ok(r.shapeIds.every((id) => id === 'B1'));
});

test('单段超过 320 字：硬拦并归到所在拍', () => {
  const r = auditDraft({ plan: PLAN, brief: null, text: '长'.repeat(400) });
  assert.ok(r.shapeIds.includes('B1'));
  assert.ok(r.shapeDelivery.blocking.some((row) => row.kind === 'too_long'));
});

test('段落都在范文区间内：形态不拦', () => {
  const paragraph = '雪'.repeat(110);
  const r = auditDraft({
    plan: PLAN,
    brief: null,
    text: [paragraph, paragraph, paragraph].join('\n\n'),
  });
  assert.deepStrictEqual(r.shapeIds, []);
  assert.deepStrictEqual(r.shapeDelivery.blocking, []);
});
