import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessRewrite,
  visibleLength,
  paragraphCount,
  MIN_KEEP_RATIO,
  MIN_GUARD_LENGTH,
} from '../src/components/Editor/writebackGuard.js';
import { planApply } from '../src/components/Assistant/applyPlan.js';

/**
 * 写回保护的用例。
 *
 * 全部围绕线上那次事故：模型被长度上限截断，只回了第一句，
 * 前端把这一句当成"改写结果"整段覆盖，一整章只剩开头。
 * 这里钉住的就是"宁可拒绝、也不吞稿"。
 */

const LONG = '雨夜的巷子很窄，两边的墙挤过来，只留一线天。陈默把伞收了，雨水顺着伞骨往下淌。'
  + '他停在第七级台阶前，听见楼上有人轻轻咳了一声。那声音很轻，却像一枚钉子。';

test('visibleLength: 只数可见字符', () => {
  assert.equal(visibleLength(' 雨 夜\n巷子 '), 4);
  assert.equal(visibleLength(''), 0);
});

test('paragraphCount: 空行与单换行都算分段', () => {
  assert.equal(paragraphCount('第一段\n第二段'), 2);
  assert.equal(paragraphCount('第一段\n\n第二段\n\n'), 2);
  assert.equal(paragraphCount('  '), 0);
});

test('被截断的改写（只剩一句）一律拒绝', () => {
  const result = assessRewrite(LONG, '雨夜的巷子很窄。');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHRUNK');
  assert.match(result.reason, /拒绝写回/);
});

test('保留六成以上视为正常改写', () => {
  const next = '雨夜巷子很窄，墙挤过来只剩一线天。陈默收伞，雨水顺伞骨往下淌。'
    + '他停在第七级台阶前，听见楼上有人轻咳了一声，轻得像钉子。';
  const result = assessRewrite(LONG, next);
  assert.equal(result.ok, true);
  // 确认这个用例本身不越界
  assert.ok(visibleLength(next) >= visibleLength(LONG) * MIN_KEEP_RATIO);
});

test('空结果永远拒绝', () => {
  const result = assessRewrite(LONG, '   ');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EMPTY');
});

test('原文很短时不做比例判断（正常润色不该被挡）', () => {
  assert.ok(visibleLength(LONG) > MIN_GUARD_LENGTH);
  const result = assessRewrite('他慢慢地站了起来。', '他起身。');
  assert.equal(result.ok, true);
});

test('缩写明确允许变短', () => {
  const result = assessRewrite(LONG, '雨夜巷窄，陈默收伞。', { action: 'shorten' });
  assert.equal(result.ok, true);
});

test('段落数骤减也拒绝，即使字数勉强够', () => {
  const before = '第一段文字比较长一些，用来凑够长度。\n第二段也不短，继续把字数撑起来。\n第三段同样有内容，不能少。';
  const after = '第一段文字比较长一些用来凑够长度。第二段也不短继续把字数撑起来。第三段同样有内容不能少。';
  const result = assessRewrite(before, after);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'PARAGRAPHS_LOST');
});

// ---------------------------------------------------------------------------
// 与落笔规则串起来：事故场景
// ---------------------------------------------------------------------------

test('planApply: 整章一段时，被截断成一句的 replace 被拒绝', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: LONG }];
  const plan = planApply(blocks, 'replace', 'b1', '雨夜的巷子很窄。');
  assert.equal(plan.kind, 'error');
  assert.match(plan.message, /拒绝写回|截断/);
});

test('planApply: 只替换选区片段、其余原文保留时仍然放行', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: LONG }];
  const plan = planApply(blocks, 'replace', '雨夜的巷子很窄', '雨夜的小巷很窄');
  assert.equal(plan.kind, 'replace');
  assert.ok(plan.text.includes('陈默把伞收了'));
});
