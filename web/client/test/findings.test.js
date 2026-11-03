import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_QUOTE_LENGTH,
  normalizeQuote,
  locateFindings,
  collectCriticFindings,
  buildAdoptPrompt,
  dedupeFindings,
  buildBatchAdoptPrompt,
  sendAdoptionBatch,
} from '../src/components/Assistant/findings.js';

/**
 * 审稿意见锚点匹配测试。
 *
 * 覆盖产品约定的四种落点：
 *   - 精确块 ID
 *   - 片段唯一命中
 *   - 多处命中 / 找不到 → 降级为全章建议
 * 另外覆盖归一化、省略号截断、消息收集与采纳指令。
 */

const blocks = [
  { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。林叙把灯芯挑亮。' },
  { id: 'b2', type: 'paragraph', content: '陈默把伞收了，雨水顺着伞骨往下淌。' },
  { id: 'b3', type: 'paragraph', content: '“别动。”他说，“门外有人。”' },
];

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

test('normalizeQuote: 去空白 + 全角标点转半角 + 省略号统一', () => {
  assert.equal(normalizeQuote('十点整，\n雨落下来。'), '十点整,雨落下来.');
  assert.equal(normalizeQuote('“别动……”'), '"别动…"');
});

// ---------------------------------------------------------------------------
// ① 精确块 ID
// ---------------------------------------------------------------------------

test('locateFindings: 块 ID 命中且块内含 quote → 用该块', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', blockId: 'b2', quote: '陈默把伞收了', text: '动作交代太急。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b2');
  assert.equal(found.index, 1);
});

test('locateFindings: 模型报的块 ID 错了，但 quote 全文唯一 → 按片段命中', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', blockId: 'b1', quote: '陈默把伞收了', text: '动作交代太急。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b2');
});

test('locateFindings: 块 ID 不存在时退回片段匹配', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', blockId: 'b9', quote: '林叙把灯芯挑亮', text: '细节多余。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b1');
});

// ---------------------------------------------------------------------------
// ② 片段唯一命中
// ---------------------------------------------------------------------------

test('locateFindings: 只有 quote 时按唯一命中的块落点', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '雨水顺着伞骨往下淌', text: '这句可以更克制。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b2');
});

test('locateFindings: 空白与全角标点不同也能认出来', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '别动。”他说，\n“门外有人', text: '对白拆得太碎。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b3');
});

// ---------------------------------------------------------------------------
// ③ 多处命中 → 未定位
// ---------------------------------------------------------------------------

test('locateFindings: 片段命中多个块 → 未定位（多处命中）', () => {
  const many = [
    { id: 'b1', content: '雨落在窗棂上，他把窗关上。' },
    { id: 'b2', content: '雨落在窗棂上，她把灯吹灭。' },
  ];
  const [found] = locateFindings(many, [
    { id: 'f1', quote: '雨落在窗棂上，', text: '开场重复。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'ambiguous');
  assert.equal(found.blockId, undefined);
});

test('locateFindings: 即使指定了块 ID，全文多处命中也不强行挂', () => {
  const many = [
    { id: 'b1', content: '雨落在窗棂上，他把窗关上。' },
    { id: 'b2', content: '雨落在窗棂上，她把灯吹灭。' },
  ];
  const [found] = locateFindings(many, [
    { id: 'f1', blockId: 'b9', quote: '雨落在窗棂上，', text: '开场重复。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'ambiguous');
});

// ---------------------------------------------------------------------------
// ④ 零命中 → 未定位
// ---------------------------------------------------------------------------

test('locateFindings: 全文找不到 → 未定位（未找到）', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '完全不相干的一段话在这里', text: '需要补一段过渡。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'not_found');
});

test('locateFindings: 指定的块还在但原文已改、别处也没有 → 原文已改动', () => {
  const edited = [{ id: 'b2', content: '陈默把伞收进包里，雨水顺着包带往下淌。' }];
  const [found] = locateFindings(edited, [
    { id: 'f1', blockId: 'b2', quote: '陈默把伞收了', text: '动作交代太急。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'changed');
});

test(`locateFindings: 少于 ${MIN_QUOTE_LENGTH} 字的片段不参与匹配`, () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '雨落', text: '太短。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'invalid');
});

// ---------------------------------------------------------------------------
// 省略号截断
// ---------------------------------------------------------------------------

test('locateFindings: 省略号结尾的截断片段按唯一前缀命中', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '陈默把伞收了，雨水顺着伞骨…', text: '后半句像在凑字。' },
  ]);
  assert.equal(found.status, 'located');
  assert.equal(found.blockId, 'b2');
});

test('locateFindings: 省略号前缀多处命中 → 未定位', () => {
  const many = [
    { id: 'b1', content: '陈默把伞收了，雨水顺着伞骨往下淌。' },
    { id: 'b2', content: '陈默把伞收了，雨水顺着伞骨滴进领口。' },
  ];
  const [found] = locateFindings(many, [
    { id: 'f1', quote: '陈默把伞收了，雨水顺着伞骨…', text: '重复。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'ambiguous');
});

test('locateFindings: 省略号前缀找不到 → 未找到', () => {
  const [found] = locateFindings(blocks, [
    { id: 'f1', quote: '他推门走进雨里，街上一个人也…', text: '缺少收束。' },
  ]);
  assert.equal(found.status, 'unlocated');
  assert.equal(found.reason, 'not_found');
});

test('locateFindings: 空 findings / 空 blocks 不报错', () => {
  assert.deepEqual(locateFindings(blocks, []), []);
  assert.deepEqual(locateFindings(blocks, null), []);
  const [found] = locateFindings([], [{ id: 'f1', quote: '雨落下来，他把窗关上', text: '问题。' }]);
  assert.equal(found.status, 'unlocated');
});

// ---------------------------------------------------------------------------
// 消息收集
// ---------------------------------------------------------------------------

test('collectCriticFindings: 只收 critic 的 comment，编号跨消息连续', () => {
  const messages = [
    {
      id: 'a1',
      role: 'assistant',
      roleKey: 'critic',
      action: 'comment',
      findings: [
        { id: 'f1', quote: '林叙把灯芯挑亮', text: '细节多余。' },
        { id: 'f2', quote: '完全不相干的一段话在这里', text: '补过渡。' },
      ],
    },
    {
      id: 'a2',
      role: 'assistant',
      roleKey: 'critic',
      action: 'comment',
      findings: [{ id: 'f3', quote: '陈默把伞收了', text: '动作太急。' }],
    },
    {
      id: 'a3',
      role: 'assistant',
      roleKey: 'editor',
      action: 'comment',
      findings: [{ id: 'f4', quote: '林叙把灯芯挑亮', text: '不该处理。' }],
    },
    {
      id: 'a4',
      role: 'assistant',
      roleKey: 'critic',
      action: 'replace',
      findings: [{ id: 'f5', quote: '林叙把灯芯挑亮', text: '不是 comment。' }],
    },
  ];

  const list = collectCriticFindings(messages, blocks);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((f) => f.marker), [1, 2, 3]);
  assert.equal(list[0].messageId, 'a1');
  assert.equal(list[0].status, 'located');
  assert.equal(list[1].status, 'unlocated');
  assert.equal(list[2].messageId, 'a2');
  assert.equal(list[2].blockId, 'b2');
});

test('collectCriticFindings: 旧消息没有 findings 时返回空数组', () => {
  const messages = [
    { id: 'a1', role: 'assistant', roleKey: 'critic', action: 'comment', content: '纯文本建议' },
  ];
  assert.deepEqual(collectCriticFindings(messages, blocks), []);
});

// ---------------------------------------------------------------------------
// 采纳指令
// ---------------------------------------------------------------------------

test('buildAdoptPrompt: 带意见正文、锚定片段与只改这一段', () => {
  const prompt = buildAdoptPrompt({
    text: '动作交代太急。',
    quote: '陈默把伞收了',
  });
  assert.match(prompt, /动作交代太急。/);
  assert.match(prompt, /原文片段「陈默把伞收了」/);
  assert.match(prompt, /只改这一段，其余保持不动。/);
});

// ---------------------------------------------------------------------------
// 批量采纳
// ---------------------------------------------------------------------------

const located = (id, marker, quote, text) => ({
  key: `msg:${id}`,
  marker,
  quote,
  text,
  status: 'located',
  blockId: 'b1',
});

const unlocated = (id, marker, text, quote = '') => ({
  key: `msg:${id}`,
  marker,
  quote,
  text,
  status: 'unlocated',
  reason: 'not_found',
});

/** 假发送器：记录每次调用，便于断言「只发一次」。 */
function makeSender(ok = true) {
  const calls = [];
  const fn = async (prompt, options) => {
    calls.push({ prompt, options });
    return ok;
  };
  return { fn, calls };
}

test('buildBatchAdoptPrompt: 三条意见按勾选顺序逐条列出，各带原文片段', () => {
  const list = [
    located('f3', 3, '他说门外有人', '收尾太拖。'),
    located('f1', 1, '林叙把灯芯挑亮', '细节多余。'),
    located('f2', 2, '陈默把伞收了', '动作太急。'),
  ];

  const prompt = buildBatchAdoptPrompt(list);
  assert.match(prompt, /1\. 意见：收尾太拖。/);
  assert.match(prompt, /2\. 意见：细节多余。/);
  assert.match(prompt, /3\. 意见：动作太急。/);

  const i1 = prompt.indexOf('原文片段「他说门外有人」');
  const i2 = prompt.indexOf('原文片段「林叙把灯芯挑亮」');
  const i3 = prompt.indexOf('原文片段「陈默把伞收了」');
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, '原文片段顺序应与勾选顺序一致');

  assert.match(prompt, /只改这几处，其余段落保持不动/);
  assert.match(prompt, /以不破坏前文事实为先/);
});

test('dedupeFindings: 相同片段 + 相同意见只算一条，顺序保留', () => {
  const a = located('f1', 1, '陈默把伞收了', '动作太急。');
  const dup = located('f9', 9, '陈默把伞收了', '动作太急。');
  const other = located('f2', 2, '陈默把伞收了', '这句可以更克制。');
  const list = dedupeFindings([a, dup, other]);

  assert.equal(list.length, 2);
  assert.equal(list[0], a);
  assert.equal(list[1], other);
});

test('buildBatchAdoptPrompt: 重复勾选同一条，请求体里只出现一次', () => {
  const a = located('f1', 1, '陈默把伞收了', '动作太急。');
  const dup = located('f9', 9, '陈默把伞收了', '动作太急。');

  const prompt = buildBatchAdoptPrompt([a, dup]);
  assert.equal(prompt.match(/动作太急。/g).length, 1);
  assert.equal(prompt.match(/原文片段「陈默把伞收了」/g).length, 1);
});

test('buildBatchAdoptPrompt: 同一块多条意见不合并，按勾选顺序分别列出', () => {
  const a = located('f1', 1, '陈默把伞收了', '动作太急。');
  const b = located('f2', 2, '陈默把伞收了', '雨水描写重复。');

  const prompt = buildBatchAdoptPrompt([a, b]);
  const ia = prompt.indexOf('意见：动作太急。');
  const ib = prompt.indexOf('意见：雨水描写重复。');
  assert.ok(ia >= 0 && ib >= 0 && ia < ib);
  assert.equal(prompt.match(/原文片段「陈默把伞收了」/g).length, 2);
});

test('buildBatchAdoptPrompt: 未定位的全章建议带「全章级」标记', () => {
  const prompt = buildBatchAdoptPrompt([
    located('f1', 1, '陈默把伞收了', '动作太急。'),
    unlocated('f2', 2, '整章节奏偏慢，建议压缩铺垫。'),
  ]);

  assert.match(prompt, /（全章级要求，无具体段落锚点）/);
  assert.ok(prompt.indexOf('动作太急。') < prompt.indexOf('全章级要求'));
});

test('sendAdoptionBatch: 三条意见只发一次 /chat，roleKey=writer', async () => {
  const sender = makeSender(true);
  const list = [
    located('f3', 3, '他说门外有人', '收尾太拖。'),
    located('f1', 1, '林叙把灯芯挑亮', '细节多余。'),
    located('f2', 2, '陈默把伞收了', '动作太急。'),
  ];

  const result = await sendAdoptionBatch(sender.fn, list);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].options.roleKey, 'writer');
  assert.ok(result.ok);
  assert.equal(result.sent, true);
  assert.deepEqual(result.keys, ['msg:f3', 'msg:f1', 'msg:f2']);

  const prompt = sender.calls[0].prompt;
  assert.match(prompt, /收尾太拖。/);
  assert.match(prompt, /细节多余。/);
  assert.match(prompt, /动作太急。/);
  assert.match(prompt, /原文片段「他说门外有人」/);
  assert.match(prompt, /原文片段「林叙把灯芯挑亮」/);
  assert.match(prompt, /原文片段「陈默把伞收了」/);
});

test('sendAdoptionBatch: 重复勾选只发一份，请求体只出现一次', async () => {
  const sender = makeSender(true);
  const a = located('f1', 1, '陈默把伞收了', '动作太急。');

  await sendAdoptionBatch(sender.fn, [a, { ...a, key: 'msg:f9', marker: 9 }]);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].prompt.match(/动作太急。/g).length, 1);
});

test('sendAdoptionBatch: 失败返回 ok=false 且携带 keys（调用方不得标记）', async () => {
  const sender = makeSender(false);
  const list = [located('f1', 1, '陈默把伞收了', '动作太急。')];

  const result = await sendAdoptionBatch(sender.fn, list);
  assert.equal(sender.calls.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.sent, true);
  assert.deepEqual(result.keys, ['msg:f1']);
});

test('sendAdoptionBatch: 单条采纳仍走一次请求（原路径不坏）', async () => {
  const sender = makeSender(true);
  const list = [located('f1', 1, '陈默把伞收了', '动作太急。')];

  const result = await sendAdoptionBatch(sender.fn, list);
  assert.equal(sender.calls.length, 1);
  assert.equal(result.ok, true);
  assert.match(sender.calls[0].prompt, /动作太急。/);
  assert.match(sender.calls[0].prompt, /原文片段「陈默把伞收了」/);
});

test('sendAdoptionBatch: 没有勾选任何一条时不发请求', async () => {
  const sender = makeSender(true);

  const result = await sendAdoptionBatch(sender.fn, []);
  assert.equal(sender.calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.sent, false);
  assert.deepEqual(result.keys, []);
});
