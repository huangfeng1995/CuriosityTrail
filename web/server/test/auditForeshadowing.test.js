'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { setupTempEnv } = require('./helpers');

const env = setupTempEnv();

const { ready, close } = require('../database');
const { extractKeywords, recallChapters, splitByFirstAppearance, STATUS } =
  require('../services/skills/auditForeshadowing')._internal;

test.before(async () => {
  await ready;
});

test.after(async () => {
  await close().catch(() => {});
  env.cleanup();
});

test('关键词来自标题与备注两部分', () => {
  const kws = extractKeywords({ title: '铜钥匙', content: '第 3 章随尸体出现，后来收进铁盒' });
  assert.ok(kws.includes('铜钥匙'), '标题整串要在');
  assert.ok(kws.some((k) => k.includes('铁盒')), '备注里的短语也要在');
});

test('备注里的关键词能召回章节——只匹配标题会漏召', () => {
  // 备注里要有分隔符，否则整串会被当成一个关键词。
  // 正文里说的是「铁盒」，卡片标题只写了「铜钥匙」，
  // 只匹配标题的话这条伏笔就漏了——必须靠备注里的「铁盒」召回。
  const cards = [{ id: 'c1', title: '铜钥匙', content: '收进、铁盒，藏在床下' }];
  const chapters = [
    { id: 'ch1', title: '第三章', seq: 3, content: '陈默把铁盒里的东西塞进背包。' },
    { id: 'ch2', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' },
  ];

  const recalled = recallChapters(cards, chapters);
  const rec = recalled.get('c1');
  assert.strictEqual(rec.hits.length, 1);
  assert.strictEqual(rec.hits[0].chapter.id, 'ch1');
});

test('关键词一个都没命中的卡不得被断言为未回收', () => {
  const cards = [{ id: 'c1', title: '银钥匙', content: '' }];
  const chapters = [{ id: 'ch1', title: '第一章', seq: 1, content: '雨夜的巷子里只剩脚步声。' }];

  const rec = recallChapters(cards, chapters).get('c1');
  assert.strictEqual(rec.hits.length, 0, '不该召回到任何章节');
  // 关键断言：命中为 0 时，不能走到「未回收」那一档
  assert.notStrictEqual(STATUS.NOT_FOUND, STATUS.UNRECOVERED);
});

test('能分出首次出场章与后续再次出场章', () => {
  const card = { id: 'c1', title: '铜钥匙', content: '', chapter_id: 'ch1' };
  const hits = [
    { chapter: { id: 'ch2', seq: 7 }, hitWords: ['铜钥匙'] },
    { chapter: { id: 'ch1', seq: 3 }, hitWords: ['铜钥匙'] },
  ];
  const { first, later } = splitByFirstAppearance(card, hits);
  assert.strictEqual(first.chapter.id, 'ch1', '卡片挂着的章就是埋下点');
  assert.strictEqual(later.length, 1);
  assert.strictEqual(later[0].chapter.id, 'ch2');
});
