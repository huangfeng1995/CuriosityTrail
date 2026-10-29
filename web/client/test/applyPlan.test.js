import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planApply,
  resolveTargetIndex,
  normalizeText,
  joinAppend,
} from '../src/components/Assistant/applyPlan.js';

/**
 * AI 输出落笔规则测试。
 *
 * 这些用例覆盖的都是作者真实遇到过的场面：
 *   - 新建章节后让写手起一段（章里还没有任何正文）
 *   - AI 把 target 写成原文片段而不是块 ID
 *   - AI 引用了段落索引里的预览（只有前 30 字）
 *   - 章节正文被作者删空后再应用
 */

// ---------------------------------------------------------------------------
// resolveTargetIndex
// ---------------------------------------------------------------------------

test('resolveTargetIndex: 块 ID 精确匹配', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  assert.equal(resolveTargetIndex(blocks, 'b2'), 1);
});

test('resolveTargetIndex: target 里嵌着块 ID 也能命中', () => {
  // 模型常把段落索引那一整行抄回来："[b2] 陈默把伞收了。"
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  assert.equal(resolveTargetIndex(blocks, '[b2] 陈默把伞收了。'), 1);
});

test('resolveTargetIndex: 原文片段能命中对应的段', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了，雨水顺着伞骨往下淌。' },
  ];
  assert.equal(resolveTargetIndex(blocks, '陈默把伞收了'), 1);
});

test('resolveTargetIndex: 片段空白与原文不一致也能命中', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '陈默把伞收了，\n雨水顺着伞骨往下淌。' },
  ];
  assert.equal(resolveTargetIndex(blocks, '陈默把伞收了， 雨水顺着伞骨往下淌。'), 0);
});

test('resolveTargetIndex: 太短的片段在多处出现时不乱匹配', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '雨停了。' },
  ];
  // "雨"这种片段在章节里能匹配一堆段，命中谁全靠运气
  assert.equal(resolveTargetIndex(blocks, '雨'), -1);
});

test('resolveTargetIndex: 短片段只在一处出现时照样认', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  assert.equal(resolveTargetIndex(blocks, '雨落下来'), 0);
});

test('resolveTargetIndex: 匹配不上返回 -1', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' }];
  assert.equal(resolveTargetIndex(blocks, '完全不相干的一段话在这里'), -1);
  assert.equal(resolveTargetIndex(blocks, ''), -1);
  assert.equal(resolveTargetIndex([], 'b1'), -1);
});

// ---------------------------------------------------------------------------
// joinAppend
// ---------------------------------------------------------------------------

test('joinAppend: 两段之间补换行', () => {
  assert.equal(joinAppend('他走进巷子。', '远处传来钟声。'), '他走进巷子。\n远处传来钟声。');
});

test('joinAppend: 已经带换行时不重复加', () => {
  assert.equal(joinAppend('他走进巷子。\n', '远处传来钟声。'), '他走进巷子。\n远处传来钟声。');
  assert.equal(joinAppend('他走进巷子。', '\n远处传来钟声。'), '他走进巷子。\n远处传来钟声。');
});

test('joinAppend: 原文为空时直接用新内容', () => {
  assert.equal(joinAppend('', '远处传来钟声。'), '远处传来钟声。');
  assert.equal(joinAppend(null, '远处传来钟声。'), '远处传来钟声。');
});

// ---------------------------------------------------------------------------
// planApply —— 本次 bug 的核心
// ---------------------------------------------------------------------------

test('planApply: 空章节 + append → 内容作为第一段写进去', () => {
  // 这就是用户遇到的场面：新建章节，让写手写一段，点"应用到正文"
  // 旧逻辑在这里直接甩一句"当前章节还没有正文"，内容白生成。
  const blocks = [];
  const plan = planApply(blocks, 'append', '', '十点整，雨落下来。');
  assert.equal(plan.kind, 'insert');
  assert.equal(plan.index, 0);
  assert.equal(plan.text, '十点整，雨落下来。');
});

test('planApply: 只有空块时 append → 填进那个空块', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '' }];
  const plan = planApply(blocks, 'append', '', '十点整，雨落下来。');
  assert.equal(plan.kind, 'append');
  assert.equal(plan.blockId, 'b1');
  assert.equal(plan.text, '十点整，雨落下来。');
});

test('planApply: 空章节 + replace → 同样落成第一段', () => {
  const blocks = [];
  const plan = planApply(blocks, 'replace', '', '十点整，雨落下来。');
  assert.equal(plan.kind, 'insert');
  assert.equal(plan.text, '十点整，雨落下来。');
});

test('planApply: 空章节 + insert → 插在开头', () => {
  const blocks = [];
  const plan = planApply(blocks, 'insert', '', '十点整，雨落下来。');
  assert.equal(plan.kind, 'insert');
  assert.equal(plan.index, 0);
});

test('planApply: 有正文时 append 接到最后一段后面', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  const plan = planApply(blocks, 'append', '', '远处传来钟声。');
  assert.equal(plan.kind, 'append');
  assert.equal(plan.blockId, 'b2');
  assert.equal(plan.text, '陈默把伞收了。\n远处传来钟声。');
});

test('planApply: append 有明确目标时接到那一段后面', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  const plan = planApply(blocks, 'append', 'b1', '远处传来钟声。');
  assert.equal(plan.blockId, 'b1');
  assert.equal(plan.text, '十点整，雨落下来。\n远处传来钟声。');
});

test('planApply: append 的目标是原文片段时也能落到那一段', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  const plan = planApply(blocks, 'append', '陈默把伞收了', '远处传来钟声。');
  assert.equal(plan.kind, 'append');
  assert.equal(plan.blockId, 'b2');
});

test('planApply: append 的目标是分场块时改为接到正文后面', () => {
  // 分场块不是正文容器，往里写散文是错的
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' },
    { id: 'b2', type: 'scene_break', content: '' },
  ];
  const plan = planApply(blocks, 'append', 'b2', '远处传来钟声。');
  assert.equal(plan.kind, 'append');
  assert.equal(plan.blockId, 'b1');
});

test('planApply: replace 命中块 ID 时整段换掉', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' }];
  const plan = planApply(blocks, 'replace', 'b1', '十点整，雨点砸在窗玻璃上。');
  assert.equal(plan.kind, 'replace');
  assert.equal(plan.blockId, 'b1');
  assert.equal(plan.text, '十点整，雨点砸在窗玻璃上。');
});

test('planApply: replace 命中原文片段时整段换掉', () => {
  // 模型回的是原文片段而不是块 ID，不能因此报"找不到要替换的段落"
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' }];
  const plan = planApply(blocks, 'replace', '十点整，雨落下来。', '十点整，雨点砸在窗玻璃上。');
  assert.equal(plan.kind, 'replace');
  assert.equal(plan.blockId, 'b1');
  assert.equal(plan.text, '十点整，雨点砸在窗玻璃上。');
});

test('planApply: replace 只改一小截时保留段落其余部分', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整，雨落下来。他把伞收了。' },
  ];
  const plan = planApply(blocks, 'replace', '雨落下来', '雨点砸在窗玻璃上');
  assert.equal(plan.kind, 'replace');
  assert.equal(plan.text, '十点整，雨点砸在窗玻璃上。他把伞收了。');
});

test('planApply: replace 找不到目标且章里有正文 → 明确报错', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整，雨落下来。' }];
  const plan = planApply(blocks, 'replace', '完全不相干的一段话在这里', '新的正文');
  assert.equal(plan.kind, 'error');
  assert.match(plan.message, /找不到要替换的段落/);
});

test('planApply: insert 有目标时插在目标后面', () => {
  const blocks = [
    { id: 'b1', type: 'paragraph', content: '十点整。' },
    { id: 'b2', type: 'paragraph', content: '陈默把伞收了。' },
  ];
  const plan = planApply(blocks, 'insert', 'b1', '新插入的一段。');
  assert.equal(plan.kind, 'insert');
  assert.equal(plan.index, 1);
});

test('planApply: insert 没目标时插到末尾', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整。' }];
  const plan = planApply(blocks, 'insert', '', '新插入的一段。');
  assert.equal(plan.kind, 'insert');
  assert.equal(plan.index, 1);
});

test('planApply: AI 没给正文 → 报错而不是静默写空', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整。' }];
  assert.equal(planApply(blocks, 'append', 'b1', '').kind, 'error');
  assert.equal(planApply(blocks, 'append', 'b1', '   ').kind, 'error');
});

test('planApply: 未知 action → 报错', () => {
  const blocks = [{ id: 'b1', type: 'paragraph', content: '十点整。' }];
  assert.equal(planApply(blocks, 'comment', 'b1', '一段建议').kind, 'error');
});

// ---------------------------------------------------------------------------
// normalizeText
// ---------------------------------------------------------------------------

test('normalizeText: 压平空白', () => {
  assert.equal(normalizeText('  雨  落\n下来。  '), '雨 落 下来。');
});
