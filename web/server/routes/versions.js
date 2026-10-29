'use strict';

/**
 * 章节版本历史路由。
 *
 *   GET    /api/versions/chapter/:chapterId            版本列表
 *   POST   /api/versions/chapter/:chapterId            手动快照
 *   GET    /api/versions/chapter/:chapterId/:versionId 版本详情（含正文）
 *   POST   /api/versions/chapter/:chapterId/:versionId/restore  回滚
 *   DELETE /api/versions/chapter/:chapterId/:versionId 删除版本
 *
 * 版本表本身不带 user_id，归属靠 chapter → work → user_id 间接判断，
 * 所以每个入口先过 ownedChapter，不能直接拿 chapterId 查。
 */

const express = require('express');
const versions = require('../services/versions');
const { ownedChapter } = require('../services/scope');

const router = express.Router();

/**
 * 校验章节归属，不通过就直接回 404。
 * @returns {Promise<boolean>} true 表示可以继续
 */
async function ensureChapter(req, res) {
  const chapter = await ownedChapter(req.params.chapterId, req.userId);
  if (!chapter) {
    res.status(404).json({ error: '章节不存在' });
    return false;
  }
  return true;
}

router.get('/chapter/:chapterId', async (req, res) => {
  try {
    if (!(await ensureChapter(req, res))) return;
    const list = await versions.listVersions(req.params.chapterId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chapter/:chapterId', async (req, res) => {
  const { label } = req.body || {};
  try {
    if (!(await ensureChapter(req, res))) return;
    const version = await versions.createManualVersion(req.params.chapterId, label);
    res.json(version);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/chapter/:chapterId/:versionId', async (req, res) => {
  try {
    if (!(await ensureChapter(req, res))) return;
    const version = await versions.getVersion(req.params.chapterId, req.params.versionId);
    if (!version) return res.status(404).json({ error: '版本不存在' });
    res.json(version);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chapter/:chapterId/:versionId/restore', async (req, res) => {
  try {
    if (!(await ensureChapter(req, res))) return;
    const chapter = await versions.restoreVersion(req.params.chapterId, req.params.versionId);
    res.json(chapter);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/chapter/:chapterId/:versionId', async (req, res) => {
  try {
    if (!(await ensureChapter(req, res))) return;
    const ok = await versions.deleteVersion(req.params.chapterId, req.params.versionId);
    if (!ok) return res.status(404).json({ error: '版本不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
