import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_QUOTE_LENGTH,
  normalizeQuote,
  locateFindings,
  collectCriticFindings,
  buildAdoptPrompt,
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
