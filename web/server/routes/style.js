'use strict';

/**
 * 文风规则卡路由。
 *
 *   GET    /api/style/cards         列出卡（全局 + 可选作品）
 *   POST   /api/style/cards         添样例 → 蒸馏 → 建卡
 *   PUT    /api/style/cards/:id     改标题 / 改规则 / 停用启用
 *   DELETE /api/style/cards/:id     删卡
 *   GET    /api/style/chapters      列出「我已写的章节」供选样例
 *
 * 样例原文只在 POST 的处理过程里活着：调完模型立刻丢弃，
 * 库里只留规则、来源标注和 ≤100 字摘要。
 */

const express = require('express');
const { all } = require('../database');
const { ownedWork, ownedChapter, ownedStyleCard } = require('../services/scope');
const aiConfig = require('../services/aiConfig');
const { resolveProvider } = require('../services/providers');
const style = require('../services/style');
const { distill, makeExcerpt } = require('../services/style/distill');

const router = express.Router();

/**
 * 列卡。
 *
 * workId 只用来筛选显示范围，不影响「哪张生效」——
 * 生效与否由 style/index.js 按作品级优先的规则算。
 */
router.get('/cards', async (req, res) => {
  try {
    const cards = await style.listCards(req.userId, req.query.workId || '');
    const effective = await style.resolveEffectiveStyle(req.userId, req.query.workId || '');
    const effectiveIds = new Set([
      ...effective.good.cards.map((c) => c.id),
      ...effective.bad.cards.map((c) => c.id),
    ]);

    res.json({
      cards: cards.map((c) => ({ ...c, effective: effectiveIds.has(c.id) })),
      conflicts: effective.conflicts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 添样例。
 *
 * 流程：取原文 → 蒸馏 → 写卡。原文在这一步之后就没人引用了。
 */
router.post('/cards', async (req, res) => {
  const { kind, title, content, chapterId, workId, notes } = req.body || {};

  if (kind !== 'good' && kind !== 'bad') {
    return res.status(400).json({ error: '样例类型只能是 good 或 bad' });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '标题不能为空' });
  }
  if (!content && !chapterId) {
    return res.status(400).json({ error: '请粘贴一段文字，或选择一段你写过的章节' });
  }

  try {
    // 作品级卡片：作品必须是本人的
    if (workId) {
      const work = await ownedWork(workId, req.userId);
      if (!work) return res.status(404).json({ error: '作品不存在' });
    }

    let source = 'paste';
    let text = String(content || '');
    let blocks = null;
    let sourceChapterId = null;

    if (chapterId) {
      // 从自己写过的章节里选。这是最好的样例来源：
      // 天然带着作者的口味，还带块结构（对话占比算得准）。
      const chapter = await ownedChapter(chapterId, req.userId);
      if (!chapter) return res.status(404).json({ error: '章节不存在' });

      blocks = parseBlocks(chapter.blocks);
      text = blocks
        .map((b) => (b && b.content ? b.content : ''))
        .filter(Boolean)
        .join('\n\n');
      if (!text) text = chapter.content || '';
      if (!text.trim()) {
        return res.status(400).json({ error: '这一章还没有正文，不能作为样例' });
      }

      source = 'chapter';
      sourceChapterId = chapter.id;
    }

    const cfg = aiConfig.getConfig();
    let provider;
    let degraded = false;
    try {
      const resolved = resolveProvider(cfg);
      provider = resolved.provider;
      degraded = resolved.degraded;
    } catch (e) {
      return res.status(503).json({ error: '没有可用的 AI 服务，请先到设置页配置' });
    }

    let rules;
    try {
      rules = await distill({ provider, kind, text, notes, blocks });
    } catch (e) {
      // 蒸馏失败不写卡：半张卡会被当成生效规则，比没有更糟。
      return res.status(502).json({ error: e.message || '文风规则提炼失败，请再试一次' });
    }

    const card = await style.createCard({
      userId: req.userId,
      kind,
      title: String(title).trim(),
      rules,
      workId: workId || null,
      source,
      chapterId: sourceChapterId,
      // 只有自己写过的章节才留摘要。
      // 粘贴的样例可能是别人的作品，留摘要等于替对方长期保管原文；
      // 而且短样例的「摘要」就是全文，留了等于原文入库。
      // 粘贴样例靠标题辨认就够了。
      excerpt: source === 'chapter' ? makeExcerpt(text) : '',
    });

    res.json({ ...card, degraded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 改卡。
 *
 * 规则作者可以手改——蒸馏是模型猜的，作者看一眼觉得不对就得能改。
 */
router.put('/cards/:id', async (req, res) => {
  const { title, rules, enabled } = req.body || {};

  try {
    const existing = await ownedStyleCard(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '规则卡不存在' });

    const patch = {};
    if (title !== undefined) patch.title = title;
    if (rules !== undefined) patch.rules = rules;
    if (enabled !== undefined) patch.enabled = Boolean(enabled);

    const updated = await style.updateCard({
      id: req.params.id,
      userId: req.userId,
      patch,
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 删卡。
 */
router.delete('/cards/:id', async (req, res) => {
  try {
    const existing = await ownedStyleCard(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '规则卡不存在' });

    await style.deleteCard(req.params.id, req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 列出可作样例的章节。
 *
 * 只列作者自己作品下的章节，按作品分组。
 * 正文不全给——这里只是让作者挑一个标题，正文在提交时由服务端自己去读。
 */
router.get('/chapters', async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.id, c.work_id, c.title, c.seq, c.word_count, w.title AS work_title
       FROM chapters c
       JOIN works w ON w.id = c.work_id
       WHERE w.user_id = ? AND c.word_count > 0
       ORDER BY w.modified_at DESC, c.seq ASC`,
      [req.userId]
    );

    res.json(
      rows.map((r) => ({
        id: r.id,
        workId: r.work_id,
        workTitle: r.work_title,
        title: r.title,
        seq: r.seq,
        wordCount: r.word_count,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 解析章节块。坏 JSON 当空数组，不让一个脏数据毁掉整个请求。
 */
function parseBlocks(blocksJson) {
  if (!blocksJson) return [];
  try {
    const parsed = JSON.parse(blocksJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

module.exports = router;
