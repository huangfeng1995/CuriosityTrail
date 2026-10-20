'use strict';

/**
 * 素材库路由。
 *
 *   GET    /api/materials          列表（支持 search 关键词过滤）
 *   POST   /api/materials          新建素材
 *   GET    /api/materials/:id      素材详情
 *   PUT    /api/materials/:id      更新素材
 *   DELETE /api/materials/:id      删除素材
 *   POST   /api/materials/upload   上传文件（PDF / txt / md）
 *
 * PDF 正文解析与 FTS5 索引在 P2 落地；此处先把元数据与正文存取打通。
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { all, get, run } = require('../database');

const router = express.Router();
const now = () => new Date().toISOString();

const ALLOWED_EXT = new Set(['.pdf', '.txt', '.md', '.markdown']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.docsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`不支持的文件类型：${ext}（支持 ${[...ALLOWED_EXT].join('、')}）`));
    }
  },
});

router.get('/', async (req, res) => {
  const { search } = req.query;
  try {
    let rows;
    if (search) {
      rows = await all(
        `SELECT * FROM materials
         WHERE title LIKE ? OR body LIKE ? OR tags LIKE ?
         ORDER BY modified_at DESC`,
        [`%${search}%`, `%${search}%`, `%${search}%`]
      );
    } else {
      rows = await all('SELECT * FROM materials ORDER BY modified_at DESC');
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { title, body, source, sourceUrl, tags } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '标题不能为空' });
  }

  try {
    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO materials (id, title, body, source, source_url, tags, char_count, created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        String(title).trim(),
        body || '',
        source || '手记',
        sourceUrl || '',
        tags || '',
        (body || '').length,
        ts,
        ts,
      ]
    );
    res.json(await get('SELECT * FROM materials WHERE id = ?', [id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const results = [];
    for (const file of req.files || []) {
      const ext = path.extname(file.originalname).toLowerCase();
      let body = '';

      // 文本类文件直接读入正文；PDF 解析留到 P2
      if (ext !== '.pdf') {
        body = fs.readFileSync(file.path, 'utf8');
      }

      const id = crypto.randomUUID();
      const ts = now();
      const title = path.basename(file.originalname, ext);
      await run(
        `INSERT INTO materials (id, title, body, source, file_path, char_count, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, body, ext === '.pdf' ? 'PDF' : '文件', file.path, body.length, ts, ts]
      );
      results.push(await get('SELECT * FROM materials WHERE id = ?', [id]));
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: '素材不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/file', async (req, res) => {
  try {
    const row = await get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(row.file_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, body, source, sourceUrl, tags } = req.body || {};
  try {
    const existing = await get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '素材不存在' });

    const nextBody = body !== undefined ? body : existing.body;
    await run(
      `UPDATE materials SET title = ?, body = ?, source = ?, source_url = ?, tags = ?,
         char_count = ?, modified_at = ?
       WHERE id = ?`,
      [
        title !== undefined ? String(title).trim() : existing.title,
        nextBody,
        source !== undefined ? source : existing.source,
        sourceUrl !== undefined ? sourceUrl : existing.source_url,
        tags !== undefined ? tags : existing.tags,
        nextBody.length,
        now(),
        req.params.id,
      ]
    );
    res.json(await get('SELECT * FROM materials WHERE id = ?', [req.params.id]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const row = await get('SELECT * FROM materials WHERE id = ?', [req.params.id]);
    if (row && row.file_path && fs.existsSync(row.file_path)) {
      fs.unlinkSync(row.file_path);
    }
    const result = await run('DELETE FROM materials WHERE id = ?', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: '素材不存在' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
