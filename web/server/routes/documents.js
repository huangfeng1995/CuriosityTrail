const express = require('express');
const router = express.Router();
const db = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const docsDir = path.join(__dirname, '../../documents');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, docsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('只支持 PDF 文件'));
    }
  }
});

router.get('/', (req, res) => {
  const { search, category_id } = req.query;
  let query = 'SELECT d.*, c.name as category_name FROM documents d LEFT JOIN categories c ON d.category_id = c.id';
  const params = [];
  const conditions = [];
  if (search) {
    conditions.push('d.name LIKE ?');
    params.push(`%${search}%`);
  }
  if (category_id) {
    conditions.push('d.category_id = ?');
    params.push(category_id);
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY d.created_at DESC';
  const documents = db.prepare(query).all(...params);
  res.json(documents);
});

router.post('/upload', upload.array('files'), (req, res) => {
  const { category_id } = req.body;
  const defaultCategory = db.prepare('SELECT * FROM categories WHERE is_default = 1').get();
  const results = [];
  for (const file of req.files) {
    const name = path.basename(file.originalname, '.pdf');
    const result = db.prepare('INSERT INTO documents (name, file_path, category_id) VALUES (?, ?, ?)').run(
      name,
      file.path,
      category_id || defaultCategory.id
    );
    results.push({ id: result.lastInsertRowid, name, file_path: file.path });
  }
  res.json(results);
});

router.get('/:id/file', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || !fs.existsSync(doc.file_path)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.sendFile(doc.file_path);
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, category_id } = req.body;
  db.prepare('UPDATE documents SET name = ?, category_id = ? WHERE id = ?').run(name, category_id, id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (doc && fs.existsSync(doc.file_path)) {
    fs.unlinkSync(doc.file_path);
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
