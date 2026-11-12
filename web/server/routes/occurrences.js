'use strict';

/**
 * 卡片名在正文中的出现位置，以及由此派生的全文改名。
 *
 *   POST /api/occurrences/scan     一次扫描整部作品，问「这些词出现在哪」
 *   POST /api/occurrences/replace  把正文里的旧名批量换成新名
 *
 * 为什么要服务端做：章节列表里只有标题，正文在 blocks 里。
 * 前端要跨章统计就得先把几十万字全拉下来——一次扫描把结果算好更省。
 *
 * 用 POST 而不是 GET：检索词是「几十张卡的名字 + 别名」，
 * 塞进 query 会超长，也会把作品内容线索写进访问日志。
 */

const express = require('express');
const { all, run } = require('../database');
const { ownedWork } = require('../services/scope');
const versions = require('../services/versions');
const { countBlockWords } = require('../services/wordCount');
const memory = require('../services/memory/indexer');
const occurrence = require('../services/occurrence');

const router = express.Router();
const now = () => new Date().toISOString();

function deriveContent(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
}

/**
 * 读当前用户名下作品的全部章节。
 * 只取统计需要的列：blocks 是正文，content 是纯文本派生快照。
 */
async function loadChapters(workId, userId) {
  const work = await ownedWork(workId, userId);
  if (!work) return null;
  const chapters = await all(
    'SELECT id, title, seq, blocks, content FROM chapters WHERE work_id = ? ORDER BY seq, created_at',
    [workId]
  );
  return { work, chapters };
}

/**
 * 批量扫描。
 *
 * body: { workId, items: [{ key, words: [] }] }
 * 返回 { [key]: { total, chapters: [{ chapterId, chapterTitle, seq, count, firstBlockId, hits }] } }
 */
router.post('/scan', async (req, res) => {
  const { workId, items } = req.body || {};
  if (!workId) return res.status(400).json({ error: '缺少 workId' });
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items 必须是数组' });

  try {
    const data = await loadChapters(workId, req.userId);
    if (!data) return res.status(404).json({ error: '作品不存在' });
    res.json(occurrence.scanWork(data.chapters, items.slice(0, 500)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 作品里所有卡片名。用来给改名做「不能误伤」的保护名单：
 * 把「王二」改成「李四」时，作品里另一个叫「王二狗」的人不该被改成「李四狗」。
 */
async function loadGuardWords(workId, excluding) {
  const skip = new Set(excluding);
  const [characters, settings] = await Promise.all([
    all('SELECT name, aliases FROM characters WHERE work_id = ?', [workId]),
    all('SELECT name FROM settings WHERE work_id = ?', [workId]),
  ]);
  const words = new Set();
  for (const row of characters) {
    for (const word of occurrence.termsOf(row.name, row.aliases)) words.add(word);
  }
  for (const row of settings) {
    for (const word of occurrence.termsOf(row.name, '')) words.add(word);
  }
  return [...words].filter((w) => w && !skip.has(w));
}

/**
 * 全文改名。
 *
 * body: { workId, words: [旧名], replacement: 新名 }
 *
 * 只动 blocks 里的字符串，不改块结构；每章落库前留一份自动快照，
 * 作者发现改错了还能在版本历史里回滚。
 */
router.post('/replace', async (req, res) => {
  const { workId, words, replacement } = req.body || {};
  if (!workId) return res.status(400).json({ error: '缺少 workId' });

  const oldWords = (Array.isArray(words) ? words : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean);
  const target = String(replacement || '').trim();
  if (!oldWords.length) return res.status(400).json({ error: '缺少旧名称' });
  if (!target) return res.status(400).json({ error: '新名称不能为空' });

  try {
    const data = await loadChapters(workId, req.userId);
    if (!data) return res.status(404).json({ error: '作品不存在' });

    const guard = await loadGuardWords(workId, oldWords);

    let replaced = 0;
    const touched = [];

    for (const chapter of data.chapters) {
      const blocks = occurrence.parseBlocks(chapter.blocks);
      if (!blocks.length) continue;

      const result = occurrence.replaceInBlocks(blocks, oldWords, target, { guard });
      if (!result) continue;

      const content = deriveContent(result.blocks);
      const wordCount = countBlockWords(result.blocks);

      // 先留旧版本，再写新内容：顺序反了，快照里存的就是改完的稿子
      await versions.autoSnapshot(chapter.id);
      await run(
        'UPDATE chapters SET blocks = ?, content = ?, word_count = ?, modified_at = ? WHERE id = ?',
        [JSON.stringify(result.blocks), content, wordCount, now(), chapter.id]
      );
      memory.scheduleIndex({
        userId: req.userId,
        workId,
        sourceType: 'chapter',
        sourceId: chapter.id,
      });

      replaced += result.count;
      touched.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title || '',
        count: result.count,
      });
    }

    res.json({ replaced, chapters: touched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
