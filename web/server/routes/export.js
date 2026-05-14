const express = require('express');
const router = express.Router();
const { get } = require('../database');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');

router.get('/report/:id/txt', async (req, res) => {
  try {
    const report = await get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
    if (!report) return res.status(404).json({ error: '报告不存在' });
    let content = `${report.title}\n`;
    content += '='.repeat(report.title.length) + '\n\n';
    content += report.content || '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(report.title)}.txt"`);
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/report/:id/docx', async (req, res) => {
  try {
    const report = await get('SELECT * FROM reports WHERE id = ?', [req.params.id]);
    if (!report) return res.status(404).json({ error: '报告不存在' });
    
    // 简单的 DOCX 结构
    const tempDir = path.join(__dirname, '../../temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const tempZip = new AdmZip();
    
    // 基本的 Word 文档结构
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${report.title}</w:t></w:r></w:p>
    <w:p><w:r><w:br/></w:r></w:p>
    ${(report.content || '').split('\n').map(line => `<w:p><w:r><w:t>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>`).join('')}
    <w:sectPr/>
  </w:body>
</w:document>`;

    tempZip.addFile('[Content_Types].xml', Buffer.from(contentTypes));
    tempZip.addFile('_rels/.rels', Buffer.from(rels));
    tempZip.addFile('word/document.xml', Buffer.from(docContent));

    const outputPath = path.join(tempDir, `report-${report.id}.docx`);
    tempZip.writeZip(outputPath);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(report.title)}.docx"`);
    res.sendFile(outputPath, () => {
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backup', async (req, res) => {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
  const docsDir = process.env.DOCS_DIR || path.join(__dirname, '../../documents');
  const timestamp = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="curiosity-backup-${timestamp}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  const dbPath = path.join(dataDir, 'curiosity.db');
  if (fs.existsSync(dbPath)) {
    archive.file(dbPath, { name: 'curiosity.db' });
  }
  if (fs.existsSync(docsDir)) {
    archive.directory(docsDir, 'documents');
  }

  archive.finalize();
});

router.post('/restore', async (req, res) => {
  if (!req.files || !req.files.backup) {
    return res.status(400).json({ error: '请选择备份文件' });
  }

  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const extractDir = path.join(tempDir, 'restore-' + Date.now());

  try {
    const zip = new AdmZip(req.files.backup.data);
    zip.extractAllTo(extractDir, true);

    const dbSrc = path.join(extractDir, 'curiosity.db');
    const docsSrc = path.join(extractDir, 'documents');
    const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../data');
    const docsDir = process.env.DOCS_DIR || path.join(__dirname, '../../documents');

    if (fs.existsSync(dbSrc)) {
      fs.copyFileSync(dbSrc, path.join(dataDir, 'curiosity.db'));
    }

    if (fs.existsSync(docsSrc)) {
      if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
      const files = fs.readdirSync(docsSrc);
      for (const file of files) {
        fs.copyFileSync(path.join(docsSrc, file), path.join(docsDir, file));
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '恢复失败' });
  } finally {
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }
});

module.exports = router;
