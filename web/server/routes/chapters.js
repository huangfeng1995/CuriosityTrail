'use strict';

/**
 * 章节路由（独立于作品路由，因为章节操作都以 chapterId 为入口）。
 *
 *   GET    /api/chapters/:id            章节详情
 *   PUT    /api/chapters/:id            更新章节（blocks 为权威数据）
 *   DELETE /api/chapters/:id            删除章节
 */

const express = require('express');
const { run } = require('../database');
const { ownedChapter } = require('../services/scope');
const versions = require('../services/versions');
const { countBlockWords, countWords } = require('../services/wordCount');
const progress = require('../services/progress');
const memory = require('../services/memory/indexer');

const router = express.Router();
const now = () => new Date().toISOString();

/**
 * blocks 为权威数据，同时维护 content 纯文本派生快照。
 */
function deriveContent(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
}

router.get('/:id', async (req, res) => {
  try {
    const chapter = await ownedChapter(req.params.id, req.userId);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });
    res.json(chapter);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, volume, status, blocks, content, outline } = req.body || {};

  try {
    const existing = await ownedChapter(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '章节不存在' });

    // blocks 存在时以 blocks 为准，content 是派生快照
    let nextContent = existing.content;
    let nextBlocks = existing.blocks;
    if (Array.isArray(blocks)) {
      nextBlocks = JSON.stringify(blocks);
      nextContent = deriveContent(blocks);
    } else if (typeof content === 'string') {
      nextContent = content;
    }

    // 内容变了就把旧版本存一份。撤销栈只在浏览器内存里，
    // 关掉页面就没了——这里留的是能跨会话回滚的持久化版本链。
    const contentChanged = nextContent !== existing.content;
    if (contentChanged) {
      await versions.autoSnapshot(req.params.id);
    }

    const nextWordCount = Array.isArray(blocks)
      ? countBlockWords(blocks)
      : countWords(nextContent);

    await run(
      `UPDATE chapters SET title = ?, volume = ?, status = ?, content = ?, blocks = ?,
         outline = ?, word_count = ?, modified_at = ?
       WHERE id = ?`,
      [
        title !== undefined ? String(title).trim() : existing.title,
        volume !== undefined ? volume : existing.volume,
        status !== undefined ? status : existing.status,
        nextContent,
        nextBlocks,
        outline !== undefined ? outline : existing.outline,
        nextWordCount,
        now(),
        req.params.id,
      ]
    );

    // 记录本次新增字数，供"写作进度"曲线用
    if (contentChanged) {
      // 老数据 word_count 是 0（列是后加的），直接拿来当基数会把
      // 整章字数都算成"本次新增"。基数为 0 且确实有正文时按正文重算。
      const prevWordCount =
        existing.word_count || (existing.content ? countWords(existing.content) : 0);
      await progress.recordWrite({
        workId: existing.work_id,
        chapterId: req.params.id,
        addedWords: nextWordCount - prevWordCount,
      });
    }

    // 正文变了就把新内容排进记忆索引（后台异步，不阻塞保存）
    if (contentChanged) {
      memory.scheduleIndex({
        userId: req.userId,
        workId: existing.work_id,
        sourceType: 'chapter',
        sourceId: req.params.id,
      });
    }

    res.json(await ownedChapter(req.params.id, req.userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const chapter = await ownedChapter(req.params.id, req.userId);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });

    const result = await run('DELETE FROM chapters WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: '章节不存在' });

    // 章节没了，它在记忆库里的块也得跟着消失——否则召回会捞到已删的正文
    memory.scheduleRemove({
      userId: req.userId,
      sourceType: 'chapter',
      sourceId: req.params.id,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
