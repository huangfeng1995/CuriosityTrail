const express = require('express');
const router = express.Router();
const db = require('../database');

// 获取图谱数据
router.get('/', async (req, res) => {
  try {
    const { type = 'citations' } = req.query;

    if (type === 'citations') {
      // 获取引用关系图谱 - 即使没有 citations 表也能返回报告节点
      let nodes = [];
      let links = [];

      try {
        nodes = await db.all(`
          SELECT 
            r.id,
            r.title,
            r.content,
            r.created_at,
            r.modified_at,
            0 as citation_count
          FROM reports r
          ORDER BY r.created_at DESC
        `);
      } catch (err) {
        console.log('citations 表可能不存在，使用基础报告数据');
        nodes = await db.all(`
          SELECT 
            r.id,
            r.title,
            r.content,
            r.created_at,
            r.modified_at,
            0 as citation_count
          FROM reports r
          ORDER BY r.created_at DESC
        `);
      }

      // 尝试获取 links，但如果失败就返回空数组
      try {
        links = await db.all(`
          SELECT 
            c.id,
            c.source_report_id as source,
            c.target_report_id as target,
            c.citation_type as type,
            c.context
          FROM citations c
        `);
      } catch (err) {
        console.log('citations 表不存在，返回空链接');
      }

      res.json({
        nodes: nodes.map(n => ({
          id: n.id,
          title: n.title,
          content: n.content,
          created_at: n.created_at,
          modified_at: n.modified_at,
          citation_count: n.citation_count
        })),
        links: links.map(l => ({
          id: l.id,
          source: l.source,
          target: l.target,
          type: l.type,
          context: l.context
        }))
      });
    } else if (type === 'keywords') {
      // 获取关键词图谱
      let nodes = [];
      let links = [];

      try {
        nodes = await db.all(`
          SELECT 
            k.id,
            k.keyword,
            k.frequency,
            k.report_id,
            r.title as report_title
          FROM keywords k
          JOIN reports r ON k.report_id = r.id
          ORDER BY k.frequency DESC
        `);

        links = await db.all(`
          SELECT DISTINCT
            k1.keyword as source,
            k2.keyword as target,
            COUNT(*) as weight
          FROM keywords k1
          JOIN keywords k2 ON k1.report_id = k2.report_id AND k1.id < k2.id
          GROUP BY k1.keyword, k2.keyword
          HAVING weight > 0
        `);
      } catch (err) {
        console.log('keywords 表不存在，从报告获取节点');
        // 如果 keywords 表不存在，返回报告节点
        const reports = await db.all(`
          SELECT 
            r.id,
            r.title as label,
            r.created_at,
            r.id as report_id,
            r.title as report_title
          FROM reports r
          ORDER BY r.created_at DESC
        `);
        nodes = reports.map((r, idx) => ({
          id: idx + 1,
          label: r.label,
          frequency: 1,
          report_id: r.report_id,
          report_title: r.report_title,
          type: 'report'
        }));
      }

      res.json({
        nodes: nodes.map(n => ({
          id: n.id,
          label: n.label,
          frequency: n.frequency || 1,
          report_id: n.report_id,
          report_title: n.report_title,
          type: n.type || 'keyword'
        })),
        links: links.map(l => ({
          source: l.source,
          target: l.target,
          weight: l.weight
        }))
      });
    }
  } catch (err) {
    console.error('获取图谱数据失败:', err);
    // 即使出错也返回空数据，不要崩溃
    res.json({ nodes: [], links: [] });
  }
});

// 添加引用关系
router.post('/', async (req, res) => {
  try {
    const { source_report_id, target_report_id, citation_type = 'reference', context } = req.body;

    if (source_report_id === target_report_id) {
      return res.status(400).json({ error: '不能引用自己' });
    }

    const result = await db.run(`
      INSERT INTO citations (source_report_id, target_report_id, citation_type, context)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_report_id, target_report_id, citation_type) 
      DO UPDATE SET context = ?
    `, [source_report_id, target_report_id, citation_type, context, context]);

    res.json({ id: result.lastID, message: '引用关系添加成功' });
  } catch (err) {
    console.error('添加引用关系失败:', err);
    res.status(500).json({ error: '添加引用关系失败' });
  }
});

// 删除引用关系
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM citations WHERE id = ?', [id]);
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('删除引用关系失败:', err);
    res.status(500).json({ error: '删除引用关系失败' });
  }
});

// 自动提取引用关系
router.post('/extract', async (req, res) => {
  try {
    const { report_id } = req.body;

    const report = await db.get('SELECT content FROM reports WHERE id = ?', [report_id]);
    if (!report || !report.content) {
      return res.status(400).json({ error: '报告内容为空' });
    }

    // 提取引用模式：查找其他报告标题作为引用
    const allReports = await db.all('SELECT id, title FROM reports WHERE id != ?', [report_id]);
    let extractedCitations = [];

    for (const otherReport of allReports) {
      // 检查当前报告是否提到了其他报告的标题
      if (report.content.includes(otherReport.title)) {
        extractedCitations.push({
          source_report_id: report_id,
          target_report_id: otherReport.id,
          citation_type: 'mentions',
          context: `在报告中提到了"${otherReport.title}"`
        });
      }
    }

    // 批量插入引用关系
    for (const citation of extractedCitations) {
      try {
        await db.run(`
          INSERT INTO citations (source_report_id, target_report_id, citation_type, context)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source_report_id, target_report_id, citation_type) 
          DO UPDATE SET context = excluded.context
        `, [citation.source_report_id, citation.target_report_id, citation.citation_type, citation.context]);
      } catch (err) {
        // 忽略重复插入错误
      }
    }

    res.json({ 
      message: '提取完成',
      count: extractedCitations.length,
      citations: extractedCitations
    });
  } catch (err) {
    console.error('提取引用关系失败:', err);
    res.status(500).json({ error: '提取引用关系失败' });
  }
});

// 提取关键词
router.post('/keywords/extract', async (req, res) => {
  try {
    const { report_id } = req.body;

    const report = await db.get('SELECT content FROM reports WHERE id = ?', [report_id]);
    if (!report || !report.content) {
      return res.status(400).json({ error: '报告内容为空' });
    }

    // 简单的关键词提取（实际项目中可以使用 NLP 库）
    const words = report.content.match(/[\u4e00-\u9fa5]+/g) || [];
    const wordCount = {};
    
    words.forEach(word => {
      if (word.length >= 2 && word.length <= 10) { // 2-10个字的词
        wordCount[word] = (wordCount[word] || 0) + 1;
      }
    });

    // 过滤常见词和提取高频词
    const commonWords = ['的', '了', '和', '是', '在', '有', '我', '不', '这', '个', '中', '大', '为', '与', '或', '等', '及', '等', '以及', '通过', '可以', '能够', '进行', '实现', '使用', '方法', '问题', '研究', '发展', '形成', '成为', '具有', '一个', '一种', '一定', '包括', '主要'];
    
    const keywords = Object.entries(wordCount)
      .filter(([word]) => !commonWords.includes(word) && wordCount[word] >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([keyword, frequency]) => ({ keyword, frequency }));

    // 保存关键词 - 如果表不存在也没关系
    for (const { keyword, frequency } of keywords) {
      try {
        await db.run(`
          INSERT INTO keywords (report_id, keyword, frequency)
          VALUES (?, ?, ?)
          ON CONFLICT(report_id, keyword) 
          DO UPDATE SET frequency = excluded.frequency
        `, [report_id, keyword, frequency]);
      } catch (err) {
        // 忽略错误
      }
    }

    res.json({
      message: '关键词提取完成',
      keywords
    });
  } catch (err) {
    console.error('提取关键词失败:', err);
    res.status(500).json({ error: '提取关键词失败' });
  }
});

module.exports = router;
