const db = require('../../database');

class MemorySystem {
  constructor() {
    this.shortTermLimit = 20; // 短期记忆保留最近 20 条
  }

  async saveToLongTerm(userId, type, content) {
    try {
      await db.run(`
        INSERT INTO agent_memory (user_id, memory_type, content, created_at)
        VALUES (?, ?, ?, datetime('now'))
      `, [userId, type, JSON.stringify(content)]);
      return true;
    } catch (error) {
      console.error('保存长期记忆失败:', error);
      return false;
    }
  }

  async getLongTermMemory(userId, type = null, limit = 50) {
    try {
      let query = `
        SELECT * FROM agent_memory 
        WHERE user_id = ?
      `;
      const params = [userId];

      if (type) {
        query += ' AND memory_type = ?';
        params.push(type);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const rows = await db.all(query, params);
      return rows.map(row => ({
        ...row,
        content: JSON.parse(row.content)
      }));
    } catch (error) {
      console.error('获取长期记忆失败:', error);
      return [];
    }
  }

  async searchSemanticMemory(userId, query) {
    try {
      // 简单的关键词匹配搜索
      const memories = await db.all(`
        SELECT * FROM agent_memory 
        WHERE user_id = ? 
        AND memory_type = 'semantic'
        AND content LIKE ?
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId, `%${query}%`]);

      return memories.map(row => ({
        ...row,
        content: JSON.parse(row.content)
      }));
    } catch (error) {
      console.error('搜索语义记忆失败:', error);
      return [];
    }
  }

  async deleteMemory(memoryId) {
    try {
      await db.run('DELETE FROM agent_memory WHERE id = ?', [memoryId]);
      return true;
    } catch (error) {
      console.error('删除记忆失败:', error);
      return false;
    }
  }

  async clearOldMemories(userId, daysOld = 30) {
    try {
      await db.run(`
        DELETE FROM agent_memory 
        WHERE user_id = ? 
        AND created_at < datetime('now', '-${daysOld} days')
      `, [userId]);
      return true;
    } catch (error) {
      console.error('清理旧记忆失败:', error);
      return false;
    }
  }
}

// 扩展数据库表
async function initializeMemoryTable() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await db.run(`
      CREATE INDEX IF NOT EXISTS idx_agent_memory_user 
      ON agent_memory(user_id, memory_type)
    `);
    
    console.log('Agent memory table initialized');
  } catch (error) {
    console.error('初始化记忆表失败:', error);
  }
}

module.exports = {
  MemorySystem: new MemorySystem(),
  initializeMemoryTable
};
