'use strict';

/**
 * 导出与备份。
 *
 *   GET  /api/export/work/:id/txt        导出整部作品为纯文本
 *   GET  /api/export/work/:id/markdown   导出整部作品为 Markdown
 *   GET  /api/export/chapter/:id/markdown  导出单章为 Markdown
 *   GET  /api/export/backup              下载全量备份 zip
 *   POST /api/export/restore             从备份 zip 恢复
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const config = require('../config');
const { all, get } = require('../database');

const router = express.Router();

/**
 * 把章节的 blocks 转成 Markdown 段落列表。
 */
function blocksToParagraphs(chapter) {
  let blocks = [];
  if (chapter.blocks) {
    try {
      const parsed = JSON.parse(chapter.blocks);
      if (Array.isArray(parsed)) blocks = parsed;
    } catch (e) {
      // 解析失败就退回纯文本
    }
  }
  if (!blocks.length) {
    return (chapter.content || '').split(/\n{2,}/).filter(Boolean);
  }
  return blocks
    .filter((b) => b && b.content)
    .map((b) => {
      if (b.type === 'scene_break') return '---';
      if (b.type === 'dialogue') return b.speaker ? `「${b.content}」——${b.speaker}` : `「${b.content}」`;
      if (b.type === 'setting_ref') return `〔设定：${b.content}〕`;
      if (b.type === 'image') return b.fileName ? `〔插图：${b.content || b.fileName}〕` : `〔插图：${b.content}〕`;
      return b.content;
    });
}

/**
 * 读取作品的全部章节。
 */
async function loadWorkChapters(workId) {
  const work = await get('SELECT * FROM works WHERE id = ?', [workId]);
  if (!work) return null;

  const chapters = await all(
    'SELECT * FROM chapters WHERE work_id = ? ORDER BY seq, created_at',
    [workId]
  );
  return { work, chapters };
}

router.get('/work/:id/txt', async (req, res) => {
  try {
    const data = await loadWorkChapters(req.params.id);
    if (!data) return res.status(404).json({ error: '作品不存在' });

    const { work, chapters } = data;
    const lines = [work.title, '='.repeat(work.title.length), ''];
    if (work.synopsis) lines.push(work.synopsis, '');

    for (const chapter of chapters) {
      lines.push('');
      lines.push(chapter.title);
      lines.push('-'.repeat(chapter.title.length));
      lines.push('');
      lines.push(blocksToParagraphs(chapter).join('\n\n'));
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(work.title)}.txt"`
    );
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/work/:id/markdown', async (req, res) => {
  try {
    const data = await loadWorkChapters(req.params.id);
    if (!data) return res.status(404).json({ error: '作品不存在' });

    const { work, chapters } = data;
    const lines = [`# ${work.title}`, ''];
    if (work.synopsis) lines.push(`> ${work.synopsis}`, '');
    if (work.outline) lines.push('## 大纲', '', work.outline, '');

    for (const chapter of chapters) {
      lines.push(`## ${chapter.title}`, '');
      lines.push(blocksToParagraphs(chapter).join('\n\n'));
      lines.push('');
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(work.title)}.md"`
    );
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/chapter/:id/markdown', async (req, res) => {
  try {
    const chapter = await get('SELECT * FROM chapters WHERE id = ?', [req.params.id]);
    if (!chapter) return res.status(404).json({ error: '章节不存在' });

    const body = blocksToParagraphs(chapter).join('\n\n');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(chapter.title)}.md"`
    );
    res.send(`# ${chapter.title}\n\n${body}\n`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backup', async (req, res) => {
  const dataDir = config.dataDir;
  const timestamp = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="curiosity-backup-${timestamp}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);

  const dbPath = path.join(dataDir, 'curiosity.db');
  if (fs.existsSync(dbPath)) {
    archive.file(dbPath, { name: 'curiosity.db' });
  }
  if (fs.existsSync(config.uploadsDir)) {
    archive.directory(config.uploadsDir, 'uploads');
  }
  if (fs.existsSync(config.docsDir)) {
    archive.directory(config.docsDir, 'documents');
  }

  archive.finalize();
});

router.post('/restore', async (req, res) => {
  if (!req.files || !req.files.backup) {
    return res.status(400).json({ error: '请选择备份文件' });
  }

  const tempDir = config.tempDir;
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const extractDir = path.join(tempDir, 'restore-' + Date.now());

  try {
    const zip = new AdmZip(req.files.backup.data);
    zip.extractAllTo(extractDir, true);

    const dbSrc = path.join(extractDir, 'curiosity.db');
    if (fs.existsSync(dbSrc)) {
      fs.copyFileSync(dbSrc, path.join(config.dataDir, 'curiosity.db'));
    }

    for (const [sub, target] of [
      ['uploads', config.uploadsDir],
      ['documents', config.docsDir],
    ]) {
      const src = path.join(extractDir, sub);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(target, { recursive: true });
      for (const file of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, file), path.join(target, file));
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
