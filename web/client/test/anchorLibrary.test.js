import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorBlockReason,
  buildImportPayload,
  groupCandidates,
  isSelectable,
} from '../src/components/Pipeline/anchorDraft.js';

test('有出处但缺书名：整条不可选，原因写明缺书名', () => {
  const anchor = {
    kind: 'event',
    subject: '官渡之战',
    claim: '曹操以少胜多。',
    confidence: 'sourced',
    source_title: '',
    source_locator: '卷一',
    valid: true,
    errors: [],
  };
  assert.equal(isSelectable(anchor), false);
  assert.match(anchorBlockReason(anchor), /缺少书名/);
});

test('有出处：书名与卷次齐全才可选', () => {
  const anchor = {
    kind: 'event',
    subject: '官渡之战',
    claim: '曹操以少胜多。',
    confidence: 'sourced',
    source_title: '三国志',
    source_locator: '魏书·武帝纪',
    valid: true,
  };
  assert.equal(isSelectable(anchor), true);
  assert.equal(anchorBlockReason(anchor), '');
});

test('分档：三档互不混入，置信度缺失的进 invalid', () => {
  const groups = groupCandidates([
    { confidence: 'sourced' },
    { confidence: 'inferable' },
    { confidence: 'blank' },
    { confidence: 'sourced', source_title: '' },
    { confidence: '' },
  ]);
  assert.equal(groups.sourced.length, 2);
  assert.equal(groups.inferable.length, 1);
  assert.equal(groups.blank.length, 1);
  assert.equal(groups.invalid.length, 1);
  // 索引保留原数组位置，前端勾选与候选顺序才能对上
  assert.deepEqual(
    groups.sourced.map((item) => item.index),
    [0, 3]
  );
});

test('导入载荷：只取勾选且可选的条目', () => {
  const anchors = [
    {
      kind: 'person',
      subject: '司马懿',
      claim: '曾向曹操举荐人才。',
      confidence: 'sourced',
      source_title: '晋书',
      source_locator: '宣帝纪',
      source_quote: '……',
      rules: [{ rule_type: 'manual_only', params: {} }],
      immutable: 1,
    },
    {
      kind: 'event',
      subject: '无书名条目',
      claim: '不可入库。',
      confidence: 'sourced',
      source_title: '',
      source_locator: '',
      rules: [],
      immutable: 1,
    },
  ];
  const payload = buildImportPayload(anchors, { 0: true, 1: true, 2: true });
  assert.equal(payload.length, 1);
  assert.equal(payload[0].subject, '司马懿');
  assert.equal(payload[0].source_title, '晋书');

  const none = buildImportPayload(anchors, {});
  assert.equal(none.length, 0);
});
