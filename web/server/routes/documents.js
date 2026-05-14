const express = require('express');
const router = express.Router();
const { all, get, run } = require('../database');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const docsDir = process.env.DOCS_DIR || path.join(__dirname, '../../documents');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

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

router.get('/', async (req, res) => {
  const { search, category_id } = req.query;
  try {
    let sql = 'SELECT d.*, c.name as category_name FROM documents d LEFT JOIN categories c ON d.category_id = c.id';
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
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY d.created_at DESC';
    const documents = await all(sql, params);
    res.json(documents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.array('files'), async (req, res) => {
  const { category_id } = req.body;
  try {
    const defaultCategory = await get('SELECT * FROM categories WHERE is_default = 1');
    const results = [];
    for (const file of req.files) {
      const name = path.basename(file.originalname, '.pdf');
      const result = await run('INSERT INTO documents (name, file_path, category_id) VALUES (?, ?, ?)', [
        name, file.path, category_id || defaultCategory.id
      ]);
      results.push({ id: result.lastID, name, file_path: file.path });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/file', async (req, res) => {
  try {
    const doc = await get('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (!doc || !fs.existsSync(doc.file_path)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(doc.file_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, category_id } = req.body;
  try {
    await run('UPDATE documents SET name = ?, category_id = ? WHERE id = ?', [name, category_id, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const doc = await get('SELECT * FROM documents WHERE id = ?', [req.params.id]);
    if (doc && fs.existsSync(doc.file_path)) {
      fs.unlinkSync(doc.file_path);
    }
    await run('DELETE FROM documents WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
