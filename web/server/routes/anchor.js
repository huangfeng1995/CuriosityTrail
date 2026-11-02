'use strict';

/**
 * 范文编排锚点的授权开关。
 *
 *   GET    /api/anchor  当前状态（开没开、来源、字数、撤回时间）
 *   POST   /api/anchor  开启（必须带 confirmed: true）
 *   DELETE /api/anchor  撤回（清空内容并留标记）
 *
 * 锚点内容由服务端内置一份，作者不能上传任意文本：
 * 「只允许存在 1 张锚点」既是数量约束，也是内容约束。
 */

const express = require('express');
const referenceAnchor = require('../services/agent/referenceAnchor');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    res.json(await referenceAnchor.getStatus(req.userId));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const status = await referenceAnchor.enableAnchor(req.userId, {
      confirmed: req.body?.confirmed === true,
    });
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    const status = await referenceAnchor.withdrawAnchor(req.userId);
    res.json({ ...status, withdrawn: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
