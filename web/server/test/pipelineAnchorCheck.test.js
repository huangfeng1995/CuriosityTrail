'use strict';

/**
 * HP4：断言投影与章末检查。
 *
 * 这一层是纯函数，不碰数据库、不碰 provider。
 * 验收：PV4 生卒锚点越界命中并报原句；PV5 章序在界内零命中；
 * 规则写错/未知类型跳过该条且不抛错；5000 字 + 50 条规则 <10ms。
 */

const test = require('node:test');
const assert = require('node:assert');

const { checkAnchors } = require('../services/pipeline/anchorCheck');

const RULE = (ruleType, params) => JSON.stringify([{ rule_type: ruleType, params }]);

/** 生卒锚点：曹操卒于建安二十五年，第 40 章起不得在场 */
function caoChaoAnchor() {
  return {
    id: 'anchor-caocao',
    status: 'active',
    confidence: 'sourced',
    immutable: 1,
    subject: '曹操',
    claim: '曹操卒于建安二十五年正月',
    rules: RULE('presence_forbidden', { persons: ['曹操'], from_seq: 40 }),
  };
}

const BODY = '庭中鼓噪。曹操端坐堂上，众客屏息。';

function blocksOf(content) {
  return [{ id: 'blk-1', content }];
}

// ---------------------------------------------------------------------------
// PV4
// ---------------------------------------------------------------------------

test('PV4：生卒锚点 + 越界正文 → 1 条，quote 可 slice 回原文，offset 正确', () => {
  const violations = checkAnchors([caoChaoAnchor()], 45, blocksOf(BODY));

  assert.strictEqual(violations.length, 1);

  const hit = violations[0];
  assert.strictEqual(hit.anchorId, 'anchor-caocao');
  assert.strictEqual(hit.ruleType, 'presence_forbidden');
  assert.strictEqual(hit.blockId, 'blk-1');
  assert.ok(hit.quote.includes('曹操端坐堂上'), '必须报出包含触发词的整句');
  assert.ok(!hit.quote.includes('庭中鼓噪'), '只报命中那一句，不报上一句');
  assert.strictEqual(
    BODY.slice(hit.offset, hit.offset + hit.quote.length),
    hit.quote,
    'offset 必须能在原文 slice 回 quote'
  );
});

// ---------------------------------------------------------------------------
// PV5
// ---------------------------------------------------------------------------

test('PV5：同一正文，章序在界内 → 0 条', () => {
  assert.deepStrictEqual(checkAnchors([caoChaoAnchor()], 39, blocksOf(BODY)), []);
});

// ---------------------------------------------------------------------------
// 坏规则：跳过该条，不报错
// ---------------------------------------------------------------------------

test('未知 rule_type 跳过，不影响同锚点的有效规则', () => {
  const anchor = {
    ...caoChaoAnchor(),
    rules: JSON.stringify([
      { rule_type: 'no_such_rule', params: {} },
      { rule_type: 'presence_forbidden', params: { persons: ['曹操'], from_seq: 40 } },
    ]),
  };

  const violations = checkAnchors([anchor], 45, blocksOf(BODY));
  assert.strictEqual(violations.length, 1);
  assert.strictEqual(violations[0].ruleType, 'presence_forbidden');
});

test('rules JSON 坏掉时按 manual_only 处理：零命中且不抛错', () => {
  const anchor = { ...caoChaoAnchor(), rules: '{不是 JSON' };
  assert.deepStrictEqual(checkAnchors([anchor], 45, blocksOf(BODY)), []);
});

test('manual_only 与非法参数一律不命中', () => {
  const anchors = [
    {
      id: 'manual',
      status: 'active',
      rules: RULE('manual_only', {}),
    },
    {
      id: 'bad-params',
      status: 'active',
      rules: RULE('presence_forbidden', { persons: ['曹操'] }), // 缺 from_seq
    },
    {
      id: 'not-active',
      status: 'pending',
      rules: RULE('presence_forbidden', { persons: ['曹操'], from_seq: 40 }),
    },
  ];
  assert.deepStrictEqual(checkAnchors(anchors, 45, blocksOf(BODY)), []);
});

// ---------------------------------------------------------------------------
// 其他 rule_type 的基本投影
// ---------------------------------------------------------------------------

test('其余五类规则均按 P.5.4 命中', () => {
  const anchors = [
    {
      id: 'event',
      status: 'active',
      rules: RULE('event_forbidden', { triggers: ['称魏王'], before_seq: 55 }),
    },
    {
      id: 'term',
      status: 'active',
      rules: RULE('term_forbidden', { terms: ['老爷'], allow_near: ['张老爷'] }),
    },
    {
      id: 'chrono',
      status: 'active',
      rules: RULE('chronology', { not_before: '建安四年', not_after: '建安五年' }),
    },
    {
      id: 'blank',
      status: 'active',
      rules: RULE('blank_guard', { phrases: ['史书记载'] }),
    },
  ];

  const content = '他称魏王。老爷吩咐下去。建安九年冬，大军南征。史书记载此事确凿。';
  const violations = checkAnchors(anchors, 50, blocksOf(content));
  const types = violations.map((v) => v.ruleType).sort();

  assert.deepStrictEqual(types, ['blank_guard', 'chronology', 'event_forbidden', 'term_forbidden']);
  for (const hit of violations) {
    assert.strictEqual(
      content.slice(hit.offset, hit.offset + hit.quote.length),
      hit.quote,
      '每条 offset 都要能 slice 回原句'
    );
  }
  // allow_near 里的「张老爷」不算命中——本例没有该词，但规则本身不应误伤
  assert.strictEqual(violations.filter((v) => v.ruleType === 'term_forbidden').length, 1);
});

// ---------------------------------------------------------------------------
// 性能：5000 字 + 50 条规则
// ---------------------------------------------------------------------------

test('命中耗时：5000 字 + 50 条规则 <10ms', () => {
  const sentence = '曹操与众将议事，帐中烛火摇动。';
  const longBody = sentence.repeat(340); // ≈ 5100 字
  assert.ok(longBody.length >= 5000);

  const anchors = [];
  for (let i = 0; i < 50; i += 1) {
    anchors.push({
      id: `perf-${i}`,
      status: 'active',
      rules: RULE('presence_forbidden', {
        persons: ['曹操', '曹孟德'],
        from_seq: i % 40,
      }),
    });
  }

  // 预热一次，排除首次解析/编译开销
  checkAnchors(anchors, 45, blocksOf(longBody));

  let best = Infinity;
  for (let i = 0; i < 20; i += 1) {
    const started = process.hrtime.bigint();
    checkAnchors(anchors, 45, blocksOf(longBody));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms < best) best = ms;
  }

  console.log(`[perf] 5000 字 + 50 条规则：最快 ${best.toFixed(2)}ms`);
  assert.ok(best < 10, `命中检查应 <10ms，实测 ${best.toFixed(2)}ms`);
});
