'use strict';

/**
 * 章节版本历史路由。
 *
 *   GET    /api/versions/chapter/:chapterId            版本列表
 *   POST   /api/versions/chapter/:chapterId            手动快照
 *   GET    /api/versions/chapter/:chapterId/:versionId 版本详情（含正文）
 *   POST   /api/versions/chapter/:chapterId/:versionId/restore  回滚
 *   DELETE /api/versions/chapter/:chapterId/:versionId 删除版本
 */

const express = require('express');
const versions = require('../services/versions');

const router = express.Router();

router.get('/chapter/:chapterId', async (req, res) => {
  try {
    const list = await versions.listVersions(req.params.chapterId);
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chapter/:chapterId', async (req, res) => {
  const { label } = req.body || {};
  try {
    const version = await versions.createManualVersion(req.params.chapterId, label);
    res.json(version);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/chapter/:chapterId/:versionId', async (req, res) => {
  try {
    const version = await versions.getVersion(req.params.chapterId, req.params.versionId);
    if (!version) return res.status(404).json({ error: '版本不存在' });
    res.json(version);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/chapter/:chapterId/:versionId/restore', async (req, res) => {
  try {
    const chapter = await versions.restoreVersion(req.params.chapterId, req.params.versionId);
    res.json(chapter);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete('/chapter/:chapterId/:versionId', async (req, res) => {
  try {
    const ok = await versions.deleteVersion(req.params.chapterId, req.params.versionId);
    if (!ok) return res.status(404).json({ error: '版本不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
