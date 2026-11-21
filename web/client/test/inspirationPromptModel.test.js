import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFS,
  cacheKey,
  clipTitle,
  collectExclude,
  countPrompts,
  normalizePrefs,
  readCache,
  readPrefs,
  writeCache,
  writePrefs,
} from '../src/components/Sidebar/inspirationPromptModel.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

test('normalizePrefs: 脏数据退回默认值', () => {
  assert.deepEqual(normalizePrefs({}), { ...DEFAULT_PREFS });
  assert.deepEqual(normalizePrefs({ enabled: false, auto: false }), {
    enabled: false,
    dimensions: null,
    count: 2,
    auto: false,
  });
  assert.equal(normalizePrefs({ count: 99 }).count, 2);
  assert.equal(normalizePrefs({ count: 3 }).count, 3);
  assert.equal(normalizePrefs({ dimensions: [] }).dimensions, null);
  assert.deepEqual(normalizePrefs({ dimensions: ['conflict', 'conflict', ''] }).dimensions, [
    'conflict',
  ]);
});

test('readPrefs / writePrefs: 往返不丢字段，坏缓存不炸', () => {
  const storage = fakeStorage();
  writePrefs({ enabled: false, dimensions: ['image'], count: 1, auto: false }, storage);
  assert.deepEqual(readPrefs(storage), {
    enabled: false,
    dimensions: ['image'],
    count: 1,
    auto: false,
  });

  storage.setItem('ct:inspiration-prompt-prefs', '{坏 json');
  assert.deepEqual(readPrefs(storage), { ...DEFAULT_PREFS });
});

test('readCache / writeCache: 按作品和章节分开，坏数据返回 null', () => {
  const storage = fakeStorage();
  writeCache('work-1', 'chapter-1', {
    dimension: 'conflict',
    groups: [{ dimension: 'conflict', prompts: [{ id: 'p1', text: '方向' }] }],
  }, storage);

  assert.ok(cacheKey('work-1', 'chapter-1') !== cacheKey('work-1', 'chapter-2'));
  const cached = readCache('work-1', 'chapter-1', storage);
  assert.equal(cached.dimension, 'conflict');
  assert.equal(cached.groups.length, 1);
  assert.equal(cached.workId, 'work-1');
  assert.equal(readCache('work-1', 'chapter-2', storage), null);

  storage.setItem(cacheKey('work-1', 'chapter-1'), '{"groups":');
  assert.equal(readCache('work-1', 'chapter-1', storage), null);
});

test('collectExclude: 当前候选和已忽略项去重，保住原文本', () => {
  const groups = [
    {
      dimension: 'conflict',
      prompts: [
        { id: '1', text: '让沈书白在码头撕掉船票。' },
        { id: '2', text: '让雾出现三次。' },
      ],
    },
    {
      dimension: 'conflict',
      prompts: [{ id: '3', text: '让沈书白在码头撕掉船票。' }],
    },
  ];

  assert.deepEqual(collectExclude(groups, ['让雾出现三次。', '新的忽略项']), [
    '让沈书白在码头撕掉船票。',
    '让雾出现三次。',
    '新的忽略项',
  ]);
});

test('clipTitle: 单行化并按长度截断', () => {
  assert.equal(clipTitle('第一行\n第二行', 20), '第一行 第二行');
  assert.equal(clipTitle('一二三四五六', 5), '一二三四…');
  assert.equal(clipTitle('  短标题  '), '短标题');
});

test('countPrompts: 统计所有维度的候选数', () => {
  assert.equal(countPrompts([]), 0);
  assert.equal(
    countPrompts([
      { prompts: [{ id: '1' }, { id: '2' }] },
      { prompts: [{ id: '3' }] },
      { prompts: [] },
    ]),
    3
  );
});
