'use strict';

/**
 * 记忆切块测试。
 *
 * 切块质量直接决定召回质量，所以每个边界都要钉死：
 *  - 场景分隔必须断开
 *  - 台词不能被劈成两半
 *  - 超长段落要切开且不丢字
 *  - 块大小要在目标区间内
 */

const test = require('node:test');
const assert = require('node:assert');

const chunker = require('../services/memory/chunker');

/** 造一段指定长度的中文正文。 */
function makeText(length) {
  return '雨'.repeat(length);
}

test('normalizeText: 去掉零宽字符与多余空行', () => {
  const raw = '第一段\n\n\n\n第二段\r\n第三段  ';
  assert.strictEqual(chunker.normalizeText(raw), '第一段\n\n第二段\n第三段');
});

test('normalizeText: 空输入返回空串', () => {
  assert.strictEqual(chunker.normalizeText(''), '');
  assert.strictEqual(chunker.normalizeText(null), '');
});

test('chunkText: 短文本切一块', () => {
  const chunks = chunker.chunkText('雨夜巷子里，林昭握着一枚青铜令牌。');
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].includes('青铜令牌'));
});

test('chunkText: 长文本切成多块，每块不超过上限', () => {
  const paragraph = makeText(200);
  const text = Array.from({ length: 20 }, () => paragraph).join('\n');
  const chunks = chunker.chunkText(text);

  assert.ok(chunks.length > 1, '长文本应该被切开');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= chunker.MAX_SIZE + chunker.OVERLAP + 2, `块过长：${chunk.length}`);
  }
});

test('chunkText: 内容不丢——所有段落都能在块里找到', () => {
  const paragraph = makeText(300);
  const text = Array.from({ length: 10 }, (_, i) => `第${i}段${paragraph}`).join('\n');
  const chunks = chunker.chunkText(text);

  for (let i = 0; i < 10; i += 1) {
    assert.ok(
      chunks.some((chunk) => chunk.includes(`第${i}段`)),
      `第${i}段丢失了`
    );
  }
});

test('chunkChapterBlocks: 场景分隔是硬边界', () => {
  const blocks = [
    { id: 'a', type: 'paragraph', content: '雨夜，林昭在巷口等一个人。' },
    { id: 'b', type: 'scene_break', content: '分场' },
    { id: 'c', type: 'paragraph', content: '天亮了，他在城门口看见那枚令牌。' },
  ];
  const chunks = chunker.chunkChapterBlocks(blocks);

  assert.strictEqual(chunks.length, 2, '场景分隔应该把内容断成两块');
  assert.ok(chunks[0].includes('巷口'));
  assert.ok(chunks[1].includes('城门口'));
  assert.ok(!chunks[0].includes('城门口'), '分场后的内容不该出现在前一块');
});

test('chunkChapterBlocks: 对白带上说话人', () => {
  const blocks = [
    { id: 'a', type: 'dialogue', speaker: '林昭', content: '你终于来了。' },
  ];
  const chunks = chunker.chunkChapterBlocks(blocks);
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].includes('林昭：'));
});

test('chunkText: 超长段落会被切开且内容不丢', () => {
  // 用可辨识的编号，验证每一段都被保留（重叠会让内容重复，但不会丢）
  const long = Array.from({ length: 40 }, (_, i) => `【${i}】${makeText(70)}`).join('');
  const chunks = chunker.chunkText(long);

  assert.ok(chunks.length > 1);
  for (let i = 0; i < 40; i += 1) {
    assert.ok(
      chunks.some((chunk) => chunk.includes(`【${i}】`)),
      `第${i}段丢失了`
    );
  }
});

test('splitLongParagraph: 优先在句号处断', () => {
  const text = '第一句话。'.repeat(100);
  const pieces = chunker.splitLongParagraph(text, 100);

  assert.ok(pieces.length > 1);
  for (const piece of pieces) {
    assert.ok(piece.length <= 100);
  }
});

test('chunkText: 相邻块之间有重叠', () => {
  const text = Array.from({ length: 20 }, (_, i) => `第${i}段${makeText(150)}`).join('\n');
  const chunks = chunker.chunkText(text);

  assert.ok(chunks.length >= 2);
  // 后一块的开头应该能在前一块的结尾找到
  const head = chunks[1].slice(0, 30);
  assert.ok(chunks[0].includes(head.slice(0, 20)), '相邻块之间应该保留重叠');
});

test('chunkText: 块大小始终不超过上限', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第${i}段${makeText(150)}`).join('\n');
  const chunks = chunker.chunkText(text);

  for (const chunk of chunks) {
    assert.ok(chunk.length <= chunker.MAX_SIZE, `块过长：${chunk.length}`);
  }
});

test('chunkText: 不产生纯重复的尾巴块', () => {
  // 800 字 + 800 字：第二块收尾时会把末尾 100 字作为重叠带走，
  // 循环结束时如果再 flush 一次，那 100 字会变成一块纯重复的碎片。
  const text = '雨'.repeat(800) + '\n' + '雪'.repeat(800);
  const chunks = chunker.chunkText(text);

  assert.strictEqual(chunks.length, 2, `不该有第三块：${JSON.stringify(chunks.map((c) => c.length))}`);
  // 每一块都必须含有新内容，不能整块都是上一块的重复。
  for (let i = 1; i < chunks.length; i += 1) {
    const prev = chunks[i - 1];
    const cur = chunks[i];
    assert.ok(!cur.includes(prev), `第 ${i + 1} 块整块都是上一块的重复`);
  }
});

test('chunkText: 尾部不足一块时不产生碎片', () => {
  const text = '雨'.repeat(900);
  const chunks = chunker.chunkText(text);

  assert.strictEqual(chunks.length, 1, `不该有第二块：${JSON.stringify(chunks.map((c) => c.length))}`);
  assert.strictEqual(chunks[0].length, 900);
});

test('hashContent: 相同内容哈希一致，不同内容不同', () => {
  const a = chunker.hashContent('林昭的青铜令牌');
  const b = chunker.hashContent('林昭的青铜令牌');
  const c = chunker.hashContent('苏晚的青铜令牌');

  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(a.length, 32);
});

test('hashContent: 换行差异算不同内容', () => {
  assert.notStrictEqual(
    chunker.hashContent('第一段\n第二段'),
    chunker.hashContent('第一段 第二段')
  );
});
