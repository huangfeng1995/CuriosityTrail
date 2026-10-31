'use strict';

/**
 * 用户反馈路由。
 *
 *   GET    /api/feedback          我提交过的反馈
 *   POST   /api/feedback          提交一条反馈
 *
 * 反馈只能看自己的：作者的反馈里可能有作品片段与联系方式，
 * 别人的反馈不该被看到。
 */

const express = require('express');
const crypto = require('crypto');
const { all, get, run } = require('../database');

const router = express.Router();
const now = () => new Date().toISOString();

/** 反馈分类。 */
const CATEGORIES = ['bug', 'feature', 'experience', 'other'];

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, category, content, contact, status, reply, created_at
       FROM feedbacks WHERE user_id = ? ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ categories: CATEGORIES, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { category, content, contact } = req.body || {};
  const text = String(content || '').trim();

  if (!text) return res.status(400).json({ error: '说点什么吧' });
  if (text.length > 2000) {
    return res.status(400).json({ error: '内容太长了，2000 字以内就好' });
  }

  const cat = CATEGORIES.includes(category) ? category : 'other';

  try {
    const id = crypto.randomUUID();
    await run(
      `INSERT INTO feedbacks (id, user_id, category, content, contact, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)`,
      [
        id,
        req.userId,
        cat,
        text,
        contact ? String(contact).trim().slice(0, 120) : '',
        now(),
      ]
    );
    res.json(
      await get(
        `SELECT id, category, content, contact, status, reply, created_at
         FROM feedbacks WHERE id = ? AND user_id = ?`,
        [id, req.userId]
      )
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
