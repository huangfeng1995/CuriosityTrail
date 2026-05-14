const express = require('express');
const router = express.Router();
const { all, get, run } = require('../database');

const REPORT_TEMPLATE = `1. 探索主题

2. 背景介绍

3. 提出问题

4. 猜想与假设

5. 实验材料与工具

6. 实验步骤

7. 实验数据与现象

8. 分析与结论

9. 反思与改进

10. 参考文献
`;

router.get('/', async (req, res) => {
  const { search, sort_by = 'modified_at' } = req.query;
  try {
    let sql = 'SELECT * FROM reports';
    const params = [];
    if (search) {
      sql += ' WHERE title LIKE ? OR content LIKE ?';
      params.push(`%${search}%`, `%${search}%`);
    }
    const orderField = sort_by === 'title' ? 'title' : sort_by === 'created_at' ? 'created_at' : 'modified_at';
    sql += ` ORDER BY ${orderField} DESC`;
    
    const reports = await all(sql, params);
    const reportsWithCounts = [];
    for (const report of reports) {
      const countRow = await get('SELECT COUNT(*) as count FROM report_documents WHERE report_id = ?', [report.id]);
      reportsWithCounts.push({ ...report, document_count: countRow.count });
    }
    res.json(reportsWithCounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const report = await get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
    if (!report) {
      return res.status(404).json({ error: '报告不存在' });
    }
    const documents = await all(`
      SELECT d.* FROM documents d
      INNER JOIN report_documents rd ON d.id = rd.document_id
      WHERE rd.report_id = ?
    `, [req.params.id]);
    res.json({ ...report, documents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { title, use_template = false } = req.body;
  try {
    const content = use_template ? REPORT_TEMPLATE : '';
    const result = await run('INSERT INTO reports (title, content) VALUES (?, ?)', [title, content]);
    const report = await get('SELECT * FROM reports WHERE id = ?', [result.lastID]);
    res.json({ ...report, document_count: 0 });
  } catch (err) {
    res.status(400).json({ error: '报告标题已存在' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  try {
    await run('UPDATE reports SET title = ?, content = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?', [title, content, id]);
    const report = await get('SELECT * FROM reports WHERE id = ?', [id]);
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: '报告标题已存在' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM reports WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/documents', async (req, res) => {
  const { id } = req.params;
  const { document_ids } = req.body;
  try {
    await run('DELETE FROM report_documents WHERE report_id = ?', [id]);
    for (const docId of document_ids) {
      await run('INSERT OR IGNORE INTO report_documents (report_id, document_id) VALUES (?, ?)', [id, docId]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
