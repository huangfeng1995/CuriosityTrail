const express = require('express');
const router = express.Router();
const db = require('../database');

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

router.get('/', (req, res) => {
  const { search, sort_by = 'modified_at' } = req.query;
  let query = 'SELECT * FROM reports';
  const params = [];
  if (search) {
    query += ' WHERE title LIKE ? OR content LIKE ?';
    params.push(`%${search}%`, `%${search}%`);
  }
  query += ` ORDER BY ${sort_by === 'title' ? 'title' : sort_by === 'created_at' ? 'created_at' : 'modified_at'} DESC`;
  const reports = db.prepare(query).all(...params);

  const reportsWithCounts = reports.map(report => {
    const count = db.prepare('SELECT COUNT(*) as count FROM report_documents WHERE report_id = ?').get(report.id);
    return { ...report, document_count: count.count };
  });

  res.json(reportsWithCounts);
});

router.get('/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) {
    return res.status(404).json({ error: '报告不存在' });
  }
  const documents = db.prepare(`
    SELECT d.* FROM documents d
    INNER JOIN report_documents rd ON d.id = rd.document_id
    WHERE rd.report_id = ?
  `).all(req.params.id);
  res.json({ ...report, documents });
});

router.post('/', (req, res) => {
  const { title, use_template = false } = req.body;
  try {
    const content = use_template ? REPORT_TEMPLATE : '';
    const result = db.prepare('INSERT INTO reports (title, content) VALUES (?, ?)').run(title, content);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(result.lastInsertRowid);
    res.json({ ...report, document_count: 0 });
  } catch (e) {
    res.status(400).json({ error: '报告标题已存在' });
  }
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  try {
    db.prepare('UPDATE reports SET title = ?, content = ?, modified_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, content, id);
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    res.json(report);
  } catch (e) {
    res.status(400).json({ error: '报告标题已存在' });
  }
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/:id/documents', (req, res) => {
  const { id } = req.params;
  const { document_ids } = req.body;
  db.prepare('DELETE FROM report_documents WHERE report_id = ?').run(id);
  const insert = db.prepare('INSERT INTO report_documents (report_id, document_id) VALUES (?, ?)');
  for (const docId of document_ids) {
    insert.run(id, docId);
  }
  res.json({ success: true });
});

module.exports = router;
