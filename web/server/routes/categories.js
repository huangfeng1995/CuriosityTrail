const express = require('express');
const router = express.Router();
const db = require('../database');

router.get('/', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY is_default DESC, id').all();
  res.json(categories);
});

router.post('/', (req, res) => {
  const { name } = req.body;
  try {
    const result = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.json({ id: result.lastInsertRowid, name, is_default: 0 });
  } catch (e) {
    res.status(400).json({ error: '分类名称已存在' });
  }
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  try {
    db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '分类名称已存在' });
  }
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (category?.is_default) {
    return res.status(400).json({ error: '无法删除默认分类' });
  }
  const defaultCategory = db.prepare('SELECT * FROM categories WHERE is_default = 1').get();
  db.prepare('UPDATE documents SET category_id = ? WHERE category_id = ?').run(defaultCategory.id, id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
