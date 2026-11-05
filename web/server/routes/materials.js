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
const { ownedMaterial } = require('../services/scope');
const localSearch = require('../services/search/local');
const documentText = require('../services/documentText');
const citations = require('../services/citations');
const materialStore = require('../services/materials/store');

const router = express.Router();
const now = () => new Date().toISOString();

const ALLOWED_EXT = new Set(['.pdf', '.txt', '.md', '.markdown']);

/** 列表里每条素材给的正文预览长度 */
const PREVIEW_LEN = 120;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.docsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  },
});

const upload = multer({
  storage,
  // 上限必须显式写：multer 不给默认值，不写就等于不限制，
  // 已登录用户可以无限量上传大文件把磁盘塞满。
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 10,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) {
      cb(null, true);
    } else {
      cb(
        Object.assign(
          new Error(`不支持的文件类型：${ext}（支持 ${[...ALLOWED_EXT].join('、')}）`),
          { status: 400 }
        )
      );
    }
  },
});

/**
 * 素材列表。
 *
 * 不返回完整正文：一本解析好的 PDF 有几十万字，全量返回会拖垮列表页。
 * 列表只给一段预览，正文在详情接口里按需取。
 */
router.get('/', async (req, res) => {
  const { search, status } = req.query;
  // 默认视图不展示已撤回的条目；管理页可以显式按状态查
  const statusFilter = materialStore.STATUS_VALUES.includes(String(status || ''))
    ? String(status)
    : '';
  try {
    // 「查不到」的缺口标记默认排在后面，不跟有出处/可推定的素材混排
    const columns = `id, title, substr(body, 1, ?) AS preview, source, source_url, tags,
                work_id, provenance, confidence, origin, status, created_by, search_log,
                char_count, page_count, file_path, created_at, modified_at`;
    const order = `ORDER BY CASE WHEN confidence = 'missing' THEN 1 ELSE 0 END, modified_at DESC`;
    let rows;
    if (search) {
      const where = statusFilter
        ? 'AND status = ?'
        : "AND status != 'retracted'";
      rows = await all(
        `SELECT ${columns}
         FROM materials
         WHERE user_id = ? AND (title LIKE ? OR body LIKE ? OR tags LIKE ?) ${where}
         ${order}`,
        statusFilter
          ? [PREVIEW_LEN, req.userId, `%${search}%`, `%${search}%`, `%${search}%`, statusFilter]
          : [PREVIEW_LEN, req.userId, `%${search}%`, `%${search}%`, `%${search}%`]
      );
    } else {
      const where = statusFilter ? 'AND status = ?' : "AND status != 'retracted'";
      rows = await all(
        `SELECT ${columns}
         FROM materials
         WHERE user_id = ? ${where}
         ${order}`,
        statusFilter ? [PREVIEW_LEN, req.userId, statusFilter] : [PREVIEW_LEN, req.userId]
      );
    }
    // 页码标记是内部记号，列表里不显示；页码单独用 page_count 字段
    res.json(
      rows.map((r) => ({
        ...r,
        preview: (r.preview || '')
          .replace(/\[\[PAGE \d+\]\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 全文检索素材。走 FTS5 + bigram 索引，带命中片段。
 *
 * 两层策略：先精确（多词元 AND），命中不了再退回宽松（宽召回 + 打分）。
 * 作者既会搜"雨夜 巷子"这种关键词组合，也会整句问"有没有适合写雨夜追逐的环境描写"，
 * 只用 AND 的话后者必然零命中。
 */
router.get('/search', async (req, res) => {
  const { q, limit } = req.query;
  if (!q || !String(q).trim()) {
    return res.json([]);
  }
  const max = Math.min(Number(limit) || 10, 30);
  try {
    let results = await localSearch.search(String(q), { limit: max, userId: req.userId });
    if (!results.length) {
      results = await localSearch.searchLoose(String(q), { limit: max, userId: req.userId });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const { title, body, source, sourceUrl, tags, provenance, confidence, workId } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '标题不能为空' });
  }

  try {
    // 手工录入同样过机械约束：sourced 必须有出处，missing 必须写待补。
    // 但作者本人录入就是一次确认，不再进待确认队列。
    const item = materialStore.normalizeItem(
      { title, body, source: source || '手记', sourceUrl, tags, provenance, confidence, workId, origin: 'user' },
      req.userId,
      { createdBy: 'user', workId }
    );
    item.status = 'active';

    const id = crypto.randomUUID();
    const ts = now();
    await run(
      `INSERT INTO materials
         (id, user_id, work_id, title, body, source, source_url, tags, provenance,
          confidence, origin, status, created_by, search_log, char_count, page_count,
          created_at, modified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        req.userId,
        item.work_id,
        item.title,
        item.body,
        item.source,
        item.source_url,
        item.tags,
        item.provenance,
        item.confidence,
        item.origin,
        item.status,
        item.created_by,
        item.search_log,
        item.body.length,
        ts,
        ts,
      ]
    );
    const created = await ownedMaterial(id, req.userId);
    await localSearch.indexMaterial(created);
    res.json(created);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * 批量确认：把 pending 的素材一次转成 active。
 *
 * 一条一条确认会把作者赶回逐条勾选的老路，所以这里只收一批 id。
 */
router.post('/confirm', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: '没有待确认的条目' });
  try {
    const confirmed = await materialStore.confirmBatch(req.userId, ids);
    res.json({ confirmed });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** 撤回一条素材：立刻不再进检索与默认列表。 */
router.post('/:id/retract', async (req, res) => {
  try {
    const row = await materialStore.retract(req.userId, req.params.id);
    res.json(row);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * 上传参考文件。
 *
 * 上传即解析：正文抽出来存进 body，正文才能被检索到。
 * 只存文件名的话，作者问"里面怎么写巷子的"，AI 什么也答不上。
 */
router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const results = [];
    const warnings = [];

    for (const file of req.files || []) {
      const ext = path.extname(file.originalname).toLowerCase();
      const title = path.basename(file.originalname, ext);

      let body = '';
      let pageCount = 0;

      try {
        const extracted = await documentText.extract(file.path);
        body = extracted.text;
        pageCount = extracted.pageCount;
        // 扫描版 PDF 没有文本层，正文是空的——得告诉作者，不然他以为导入失败了
        if (ext === '.pdf' && !extracted.hasTextLayer) {
          warnings.push(`${title}：这份 PDF 没有可提取的文字层（可能是扫描件），暂时搜不到内容`);
        }
      } catch (err) {
        warnings.push(`${title}：解析失败（${err.message}），已保存文件但正文为空`);
      }

      const id = crypto.randomUUID();
      const ts = now();
      await run(
        `INSERT INTO materials
           (id, user_id, title, body, source, file_path, char_count, page_count, created_at, modified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          req.userId,
          title,
          body,
          ext === '.pdf' ? 'PDF' : '文件',
          file.path,
          body.length,
          pageCount,
          ts,
          ts,
        ]
      );
      results.push(await ownedMaterial(id, req.userId));
    }

    // 上传的文件同样要进索引，否则检索不到
    for (const material of results) {
      await localSearch.indexMaterial(material);
    }

    res.json({
      materials: results.map((m) => ({
        id: m.id,
        title: m.title,
        charCount: m.char_count,
        pageCount: m.page_count,
      })),
      warnings,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await ownedMaterial(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: '素材不存在' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/file', async (req, res) => {
  try {
    const row = await ownedMaterial(req.params.id, req.userId);
    if (!row || !row.file_path || !fs.existsSync(row.file_path)) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(row.file_path);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 定位引用片段在素材原文中的位置。
 *
 * 作者点开 AI 引用时，要能直接落到那段文字上，而不是自己翻。
 * 返回原文下标、页码和上下文，前端据此滚动并高亮。
 */
router.get('/:id/locate', async (req, res) => {
  const { snippet = '' } = req.query;
  try {
    const result = await citations.locateCitation({
      materialId: req.params.id,
      snippet: String(snippet),
      userId: req.userId,
    });
    if (!result) return res.status(404).json({ error: '素材不存在' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  const { title, body, source, sourceUrl, tags, provenance, confidence } = req.body || {};
  try {
    const existing = await ownedMaterial(req.params.id, req.userId);
    if (!existing) return res.status(404).json({ error: '素材不存在' });

    const nextBody = body !== undefined ? body : existing.body;
    const nextConfidence = confidence !== undefined ? String(confidence) : existing.confidence;
    const nextProvenance =
      provenance !== undefined ? String(provenance).trim() : existing.provenance;

    // 与入库同一套机械约束，避免编辑绕过去
    if (!materialStore.CONFIDENCE_VALUES.includes(nextConfidence)) {
      return res.status(400).json({ error: '置信档取值不合法' });
    }
    if (nextConfidence === 'sourced' && !nextProvenance) {
      return res.status(400).json({ error: '有出处的条目必须填 provenance' });
    }
    if (nextConfidence === 'missing') {
      if (nextProvenance) {
        return res.status(400).json({ error: '待补条目不能标出处' });
      }
      if (!materialStore.hasTodoLine(nextBody)) {
        return res.status(400).json({ error: '待补条目正文首行必须写成「待补：<缺什么>」' });
      }
    }

    await run(
      `UPDATE materials SET title = ?, body = ?, source = ?, source_url = ?, tags = ?,
         provenance = ?, confidence = ?, char_count = ?, modified_at = ?
       WHERE id = ?`,
      [
        title !== undefined ? String(title).trim() : existing.title,
        nextBody,
        source !== undefined ? source : existing.source,
        sourceUrl !== undefined ? sourceUrl : existing.source_url,
        tags !== undefined ? tags : existing.tags,
        nextProvenance,
        nextConfidence,
        nextBody.length,
        now(),
        req.params.id,
      ]
    );
    const updated = await ownedMaterial(req.params.id, req.userId);
    await localSearch.indexMaterial(updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const row = await ownedMaterial(req.params.id, req.userId);
    if (!row) return res.status(404).json({ error: '素材不存在' });
    if (row.file_path && fs.existsSync(row.file_path)) {
      fs.unlinkSync(row.file_path);
    }
    await run('DELETE FROM materials WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
