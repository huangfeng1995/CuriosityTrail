'use strict';

/**
 * 召回门槛的标定结论与重排顺序测试。
 *
 * 这组用例守的是标定脚本（`scripts/calibrate-memory.js`）量出来的那几条结论：
 * 门槛按来源类型分开定、准入判断在加权之后做、粗筛下限不能提前砍掉候选。
 *
 * 它们的共同点：都是**顺序**或**分类型**的约束，跟具体分数无关，
 * 所以用假 sidecar 的字符重合度打分也能测准。
 */

const test = require('node:test');
const assert = require('node:assert');

const retriever = require('../services/memory/retriever');

test('门槛：卡片类比章节类更严', () => {
  const base = 0.24;
  const card = retriever.thresholdFor('character', base);
  const chapter = retriever.thresholdFor('chapter', base);

  assert.ok(card > chapter, '人物卡的门槛应该比章节高');
  assert.strictEqual(chapter, base, '章节用基准门槛');
  assert.ok(card > 0.25, '卡片门槛要高于实测的卡片噪音上沿');
  assert.ok(card < 0.57, '卡片门槛要低于实测的卡片真命中下沿');
});

test('门槛：未列出的类型回落到基准值', () => {
  assert.strictEqual(retriever.thresholdFor('不存在的类型', 0.24), 0.24);
});

test('粗筛：下限低于任何类型的门槛，不会提前砍掉候选', () => {
  const base = 0.24;
  const floor = retriever.coarseFloor(base);

  for (const [type, weight] of Object.entries(retriever.TYPE_WEIGHTS)) {
    const threshold = retriever.thresholdFor(type, base);
    // 候选的原始分只要达到「门槛 ÷ 权重」，加权后就能过线。
    // 粗筛下限必须比这个还低，否则候选在 sidecar 那一层就没了。
    const rawNeeded = threshold / weight;
    assert.ok(
      floor <= rawNeeded,
      `${type} 的粗筛下限 ${floor} 高于过线所需的原始分 ${rawNeeded}，候选会被提前砍掉`
    );
  }
});

test('粗筛：下限不高于基准门槛', () => {
  const floor = retriever.coarseFloor(0.24);
  assert.ok(floor <= 0.24, '粗筛不该比基准门槛还高');
  assert.ok(floor > 0, '粗筛下限不能是 0，否则什么都拉回来');
});

test('权重：卡片与手动层高于章节与对话原文', () => {
  const { TYPE_WEIGHTS } = retriever;
  assert.ok(TYPE_WEIGHTS.character > TYPE_WEIGHTS.chapter);
  assert.ok(TYPE_WEIGHTS.setting > TYPE_WEIGHTS.chapter);
  assert.ok(TYPE_WEIGHTS.conv_manual > TYPE_WEIGHTS.conv_raw);
  assert.ok(TYPE_WEIGHTS.conv_raw < 1, '对话原文是噪声大户，应该压到 1 以下');
});

test('门槛：每个类型的实际原始门槛都落在自己的标定区间里', () => {
  // 标定表（加权分）折算成原始分区间。真命中下沿必须高于噪音上沿，
  // 否则这个类型召回什么都不准。
  const calibrated = {
    character: { trueMin: 0.591, noiseMax: 0.192 },
    setting: { trueMin: 0.566, noiseMax: 0.246 },
    chapter: { trueMin: 0.260, noiseMax: 0.153 },
    conv_raw: { trueMin: 0.149, noiseMax: 0.127 },
  };
  const base = 0.24;

  for (const [type, band] of Object.entries(calibrated)) {
    const weight = retriever.TYPE_WEIGHTS[type];
    const threshold = retriever.thresholdFor(type, base);
    // 门槛作用在加权分上 → 折算回原始分是 门槛 ÷ 权重
    const rawNeeded = threshold / weight;

    assert.ok(
      rawNeeded > band.noiseMax / weight,
      `${type} 的原始门槛 ${rawNeeded.toFixed(3)} 不高于噪音上沿 ${(band.noiseMax / weight).toFixed(3)}`
    );
    assert.ok(
      rawNeeded <= band.trueMin / weight,
      `${type} 的原始门槛 ${rawNeeded.toFixed(3)} 高于真命中下沿 ${(band.trueMin / weight).toFixed(3)}，真命中会被整段误杀`
    );
  }
});

test('门槛：对话原文的系数下调，避免权重把实际门槛抬高', () => {
  const base = 0.24;
  const weight = retriever.TYPE_WEIGHTS.conv_raw;
  const threshold = retriever.thresholdFor('conv_raw', base);
  const rawNeeded = threshold / weight;

  // 旧实现里它跟章节一样用 1.0，原始门槛 0.24/0.8 = 0.30，
  // 比章节（0.24/0.95 ≈ 0.253）还严——真命中 0.184~0.291 全被误杀。
  assert.ok(rawNeeded < 0.24, `对话原文的原始门槛 ${rawNeeded.toFixed(3)} 不该高于基准 0.24`);
  // 实测漏召的原始分区间 0.184~0.291，现在能过线
  assert.ok(rawNeeded <= 0.184, `原始门槛 ${rawNeeded.toFixed(3)} 仍高于实测漏召的原始分 0.184`);
});

test('重排：先加权再过滤——原始分不够但权重高的候选仍然过线', () => {
  const base = 0.24;
  // 人物卡权重 1.15，原始分 0.22 → 加权分 0.253，超过基准门槛 0.24。
  const cardScore = 0.22;
  const cardWeighted = retriever.weightedScore(cardScore, 'character');
  assert.ok(cardWeighted > base, '加权后应该过线');
  assert.ok(cardScore < base, '原始分没过线——这正是必须先加权的原因');

  // 同一份原始分给章节（权重 0.95），加权后 0.209，不过线。
  const chapterWeighted = retriever.weightedScore(cardScore, 'chapter');
  assert.ok(chapterWeighted < base, '章节用同样的原始分应该被过滤掉');
});
