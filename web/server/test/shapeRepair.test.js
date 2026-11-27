'use strict';

/**
 * 形态后台修补的纯逻辑测试。
 *
 * 重点不是「模型修得好不好」，而是三条硬约束：
 *   1. 交付缺口必须写清实测值、阈值与差值（作者要知道差在哪）；
 *   2. 本地修补不删字、不改段数，只合并短句/换具名；
 *   3. 任何一段修订低于原段 85% 一律拒绝，不许整组重写砍字。
 */

const test = require('node:test');
const assert = require('node:assert');

const shapeRepair = require('../services/agent/shapeRepair');
const { countWords } = require('../services/wordCount');

/** 一段约 100 字、全由短句组成的正文。 */
function shortSentenceParagraph() {
  return (
    '他推开门。风灌进来。灯晃了一下。' +
    '院里没有人。雪压在瓦上。檐角滴着水。' +
    '他站了一会儿。手揣进袖里。' +
    '远处有马蹄声。很快又没了。' +
    '他转身回去。门在身后合上。' +
    '屋里还是那样。桌上摊着旧信。信纸发黄。' +
    '他坐下。没有点灯。'
  );
}

/** 六段、约 600 字，段长落在范文均值的允许区间；无对白。 */
function sampleBody() {
  return Array.from({ length: 6 }, () => shortSentenceParagraph()).join('\n\n');
}

const plan = { beats: [{ id: 'B1', paragraphs: 6 }] };

test('shortfallRows 写清哪项、实测值、阈值与差值', () => {
  const rows = shapeRepair.shortfallRows({
    blocking: [
      { kind: 'short_sentence', ratio: 24.6, limit: 18.4 },
      { kind: 'dialogue_low', ratio: 14.1, limit: 14.4, deficitChars: 9 },
      // 段数偏差不属于修补目标，不进入缺口清单
      { kind: 'count', expected: 4, actual: 9, tolerance: 2 },
    ],
  });

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].kind, 'short_sentence');
  assert.match(rows[0].text, /24\.6%/);
  assert.match(rows[0].text, /18\.4%/);
  assert.match(rows[0].text, /多 6\.2pp/);
  assert.match(rows[1].text, /下限 14\.4%/);
  assert.match(rows[1].text, /差 0\.3pp/);
  assert.match(rows[1].text, /约 9 字引语/);
});

test('localRepair 合并短句：不删字、不改段数，短句占比下降', () => {
  const body = sampleBody();
  const before = shapeRepair.measureShape(plan, body);
  const beforeParagraphs = body.split(/\n+/).filter(Boolean).length;

  const out = shapeRepair.localRepair({
    text: body,
    blockers: [{ kind: 'short_sentence' }],
    namedCast: [],
  });

  assert.ok(out.changes.some((line) => line.includes('合并短句')));
  assert.strictEqual(out.text.split(/\n+/).filter(Boolean).length, beforeParagraphs);
  // 无损：合并只换标点与并句，字数不减少
  assert.ok(countWords(out.text) >= countWords(body));
  const after = shapeRepair.measureShape(plan, out.text);
  assert.ok(
    after.summary.shortSentenceRatio <= before.summary.shortSentenceRatio,
    `短句占比应下降：${before.summary.shortSentenceRatio} → ${after.summary.shortSentenceRatio}`
  );
});

test('localRepair 只在本章唯一同姓人物时替换匿名指代', () => {
  const text = '姓周的把册子放下。姓周的说了一句。姓韩的没有动。';
  const out = shapeRepair.localRepair({
    text,
    blockers: [{ kind: 'generic_reference' }],
    namedCast: [{ name: '周牧' }, { name: '韩遂' }, { name: '韩当' }],
  });

  // 周姓唯一 → 换成姓名；韩姓有两人 → 保持原样，不猜
  assert.match(out.text, /周牧把册子放下/);
  assert.match(out.text, /周牧说了一句/);
  assert.match(out.text, /姓韩的没有动/);
});

test('applyParagraphPatches 拒绝低于原段 85% 的修订，其余段照常应用', () => {
  const paragraphs = [shortSentenceParagraph(), shortSentenceParagraph()];
  const text = paragraphs.join('\n\n');

  const out = shapeRepair.applyParagraphPatches(text, [
    { index: 0, text: '他推开门，风灌进来。' }, // 远低于 85%
    { index: 1, text: `${paragraphs[1]}他回头看了一眼。` }, // 变长，允许
    { index: 99, text: '越界段' },
  ]);

  assert.strictEqual(out.applied.length, 1);
  assert.strictEqual(out.applied[0].index, 1);
  assert.strictEqual(out.rejected.length, 2);
  assert.match(out.rejected[0].reason, /低于原段 85%/);
  // 被拒绝的那段保持原样
  assert.ok(out.text.split('\n\n')[0].includes('他推开门。风灌进来。'));
});

test('runRepair 在模型只给砍字修订时保留原稿，并说明仍有几项不达标', async () => {
  const body = sampleBody();
  let calls = 0;
  const result = await shapeRepair.runRepair({
    body,
    plan,
    blockers: [{ kind: 'dialogue_low', ratio: 0, limit: 14.4, deficitChars: 90 }],
    namedCast: [],
    chat: async () => {
      calls += 1;
      return {
        content: JSON.stringify({
          paragraphs: [{ index: 0, text: '他进门。' }],
        }),
      };
    },
  });

  assert.strictEqual(calls, 1);
  assert.strictEqual(result.calls, 1);
  assert.strictEqual(result.rounds, 1);
  assert.strictEqual(result.ok, false);
  assert.match(result.note, /已尝试修补，仍有 \d+ 项不达标/);
  // 砍字的修补被拒绝后，原稿不被替换
  assert.ok(countWords(result.content) >= Math.ceil(countWords(body) * 0.85));
});

test('runRepair 的模型补丁按段应用后，段数保持不变', async () => {
  const body = sampleBody();
  const paragraphs = body.split('\n\n');
  const result = await shapeRepair.runRepair({
    body,
    plan,
    blockers: [{ kind: 'dialogue_low', ratio: 0, limit: 14.4, deficitChars: 90 }],
    namedCast: [],
    chat: async () => ({
      content: JSON.stringify({
        paragraphs: [
          // 只做句边界调整，字数不减少
          { index: 0, text: paragraphs[0].replace('他推开门。', '他推开门，风立刻灌了进来。') },
          { index: 1, text: `${paragraphs[1]}灯始终没有点。` },
        ],
      }),
    }),
  });

  assert.strictEqual(result.content.split(/\n+/).filter(Boolean).length, 6);
  assert.ok(result.calls <= shapeRepair.MAX_REPAIR_CALLS);
});
