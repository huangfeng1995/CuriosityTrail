const express = require('express');
const router = express.Router();
const db = require('../database');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');

router.get('/report/:id/txt', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });

  let content = `${report.title}\n`;
  content += '='.repeat(report.title.length) + '\n\n';
  content += report.content || '';

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(report.title)}.txt"`);
  res.send(content);
});

router.get('/report/:id/docx', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });

  const PizZip = require('pizzip');
  const Docxtemplater = require('docxtemplater');

  const tempPath = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
  const outputPath = path.join(tempPath, `report_${report.id}.docx`);

  const zip = new PizZip();
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

  let html = `<h1 style="text-align:center">${report.title}</h1>`;
  if (report.content) {
    const lines = report.content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        html += '<p>&nbsp;</p>';
      } else if (trimmed.match(/^\d+\./)) {
        html += `<h2>${trimmed}</h2>`;
      } else {
        html += `<p>${trimmed}</p>`;
      }
    }
  }

  const simpleDocx = `
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr><w:t>${report.title}</w:t></w:r></w:p>
    ${report.content ? report.content.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '<w:p></w:p>';
      if (trimmed.match(/^\d+\./)) return `<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>${trimmed}</w:t></w:r></w:p>`;
      return `<w:p><w:r><w:t>${trimmed}</w:t></w:r></w:p>`;
    }).join('') : ''}
  </w:body>
</w:document>
  `;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr><w:t>${report.title}</w:t></w:r></w:p>
    ${report.content ? report.content.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '<w:p></w:p>';
      if (trimmed.match(/^\d+\./)) return `<w:p><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:r><w:t>${trimmed}</w:t></w:r></w:p>`;
      return `<w:p><w:r><w:t>${trimmed}</w:t></w:r></w:p>`;
    }).join('') : ''}
    <w:sectPr/>
  </w:body>
</w:document>`;

  const zipObj = new AdmZip();
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  zipObj.addFile('_rels/.rels', rels);
  zipObj.addFile('[Content_Types].xml', contentTypes);
  zipObj.addFile('word/document.xml', docXml);
  zipObj.writeZip(outputPath);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(report.title)}.docx"`);
  res.sendFile(outputPath, () => fs.unlinkSync(outputPath));
});

router.get('/backup', (req, res) => {
  const dataDir = path.join(__dirname, '../../data');
  const docsDir = path.join(__dirname, '../../documents');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `curiosity_backup_${timestamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${backupName}"`);

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

  const backupFile = req.files.backup;
  const tempPath = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
  const extractPath = path.join(tempPath, 'restore_' + Date.now());

  try {
    const zip = new AdmZip(backupFile.data);
    zip.extractAllTo(extractPath, true);

    const dbSrc = path.join(extractPath, 'curiosity.db');
    const docsSrc = path.join(extractPath, 'documents');
    const dataDir = path.join(__dirname, '../../data');
    const docsDir = path.join(__dirname, '../../documents');

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
  } catch (e) {
    res.status(500).json({ error: '恢复失败' });
  } finally {
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true });
    }
  }
});

module.exports = router;
