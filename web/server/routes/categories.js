const express = require('express');
const router = express.Router();
const { all, get, run } = require('../database');

router.get('/', async (req, res) => {
  try {
    const categories = await all('SELECT * FROM categories ORDER BY is_default DESC, id');
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { name } = req.body;
  try {
    const result = await run('INSERT INTO categories (name) VALUES (?)', [name]);
    res.json({ id: result.lastID, name, is_default: 0 });
  } catch (err) {
    res.status(400).json({ error: '分类名称已存在' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  try {
    await run('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: '分类名称已存在' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const category = await get('SELECT * FROM categories WHERE id = ?', [id]);
    if (category.is_default) {
      return res.status(400).json({ error: '无法删除默认分类' });
    }
    const defaultCategory = await get('SELECT * FROM categories WHERE is_default = 1');
    await run('UPDATE documents SET category_id = ? WHERE category_id = ?', [defaultCategory.id, id]);
    await run('DELETE FROM categories WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
