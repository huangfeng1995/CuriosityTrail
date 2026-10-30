'use strict';

/**
 * 数据库层。
 *
 * 全新 schema：作品 / 章节 / 人物卡 / 世界观设定 / 素材库 / 灵感速记 / AI 会话。
 * 旧表（reports / documents / categories / citations / keywords / translation_history）
 * 已确认无保留价值，直接删除不迁移。
 */

const sqlite3 = require('sqlite3').verbose();
const config = require('./config');

// 连接句柄是模块级变量而不是 const 常量：恢复备份要换掉整个库文件，
// 这时必须先关掉旧连接再开新的，否则旧连接会继续往被替换掉的文件上写。
let db = new sqlite3.Database(config.dbPath);

/**
 * Schema 版本。用 SQLite 的 user_version 记录。
 *
 * 版本升级只做**增量迁移**：绝不 DROP 已有的业务表。
 * 小说是作者长期积累的资产，一次误删就是不可挽回的事故，
 * 所以这里没有"版本不匹配就重建"的兜底路径。
 *
 * 版本 1 → 2：多用户（users / login_codes），业务表补 user_id。
 * 版本 2 → 3：长期记忆台账（memory_chunks / memory_index_meta）。
 * 版本 3 → 4：文风规则卡（style_cards）。
 */
const SCHEMA_VERSION = 4;

/**
 * 版本号之前的老库遗留表。
 *
 * 只在 user_version = 0（从未跑过本模块的库）时清掉：
 * 'settings' 在旧 schema 里是键值对配置表，与新 schema 的世界观设定表同名不同结构，
 * 必须先删掉才能按新结构建表。这类老库没有任何版本号，
 * 也就没有用户数据可保，清掉是安全的。
 */
const LEGACY_TABLES = [
  'reports',
  'documents',
  'categories',
  'report_documents',
  'citations',
  'keywords',
  'translation_history',
  'agent_memory',
  'settings',
];

const SCHEMA = `
-- 用户。手机号即账号，首次验证码登录时自动创建。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  nickname      TEXT,
  role          TEXT DEFAULT 'user',
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

-- 短信验证码。
-- 只存哈希，不存明文：库文件泄露时验证码不能直接被拿来登录。
CREATE TABLE IF NOT EXISTS login_codes (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER DEFAULT 0,
  consumed   INTEGER DEFAULT 0,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_codes_phone ON login_codes(phone, created_at);

-- 作品
CREATE TABLE IF NOT EXISTS works (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  genre        TEXT,
  synopsis     TEXT,
  outline      TEXT,
  target_words INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 章节
CREATE TABLE IF NOT EXISTS chapters (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  volume       TEXT,
  status       TEXT DEFAULT 'draft',
  content      TEXT,
  blocks       TEXT,
  outline      TEXT,
  word_count   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, seq);

-- 章节版本历史。
--
-- 撤销栈只存在浏览器内存里，关掉页面就没了——写小说最怕改坏了找不回来。
-- 每次保存前的旧内容在这里留一份快照，作者可以随时回滚到任意一个历史版本。
-- blocks 存完整块结构（权威数据），content 只是便于检索的纯文本快照。
CREATE TABLE IF NOT EXISTS chapter_versions (
  id           TEXT PRIMARY KEY,
  chapter_id   TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  work_id      TEXT NOT NULL,
  title        TEXT,
  blocks       TEXT,
  content      TEXT,
  label        TEXT,
  manual       INTEGER DEFAULT 0,
  word_count   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapter_versions_chapter
  ON chapter_versions(chapter_id, created_at);

-- 情节卡。作者在动笔前把关键节点、伏笔、冲突先列成卡片挂在章节上。
CREATE TABLE IF NOT EXISTS plot_cards (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id   TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  kind         TEXT DEFAULT 'plot',
  content      TEXT,
  seq          INTEGER DEFAULT 0,
  status       TEXT DEFAULT 'todo',
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plot_cards_work ON plot_cards(work_id, seq);
CREATE INDEX IF NOT EXISTS idx_plot_cards_chapter ON plot_cards(chapter_id);

-- 每日写作量。按天累计新增字数，用于"写作进度"曲线。
-- 不从版本历史反推：那是保存时刻，粒度太粗也包含回滚产生的负增量。
CREATE TABLE IF NOT EXISTS writing_events (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id   TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  day          TEXT NOT NULL,
  words_added  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_writing_events_work_day ON writing_events(work_id, day);

-- 人物卡
CREATE TABLE IF NOT EXISTS characters (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  aliases      TEXT,
  role         TEXT,
  identity     TEXT,
  personality  TEXT,
  speech       TEXT,
  goal         TEXT,
  arc          TEXT,
  relations    TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_characters_work ON characters(work_id);

-- 世界观设定
CREATE TABLE IF NOT EXISTS settings (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  name         TEXT NOT NULL,
  content      TEXT NOT NULL,
  importance   INTEGER DEFAULT 3,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_work ON settings(work_id, category);

-- 素材库（每个用户一份）
CREATE TABLE IF NOT EXISTS materials (
  rid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  body         TEXT,
  source       TEXT,
  source_url   TEXT,
  file_path    TEXT,
  tags         TEXT,
  char_count   INTEGER DEFAULT 0,
  page_count   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 素材全文索引。存的是 bigram 化后的文本（见 services/search/local.js），
-- 所以用普通 FTS5 表而非 external content 表——external content 模式下
-- 索引内容必须与 materials 原文一致，bigram 化后就不再一致了。
-- rowid 对齐 materials.rid，业务 id 另存一列供回查。
CREATE VIRTUAL TABLE IF NOT EXISTS materials_fts USING fts5(
  title, body, tags,
  material_id UNINDEXED,
  tokenize='unicode61'
);

-- 素材删除时清掉索引残留。
-- 写入/更新不在这里做触发器：bigram 转换只能由应用层完成（设计文档 §3.3 方案 B）。
CREATE TRIGGER IF NOT EXISTS materials_ad AFTER DELETE ON materials BEGIN
  DELETE FROM materials_fts WHERE rowid = old.rid;
END;

-- 灵感速记（每个用户一份）
CREATE TABLE IF NOT EXISTS inspirations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  tags         TEXT,
  consumed     INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- AI 会话（每个用户一份；work_id 可为空表示不挂作品的通用对话）
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  work_id      TEXT REFERENCES works(id) ON DELETE CASCADE,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  role_key        TEXT,
  action          TEXT,
  payload         TEXT,
  citations       TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- 提示词覆盖（每个用户一份）。
-- 主键是 (user_id, id)：同一个角色在不同用户下各有一份覆盖。
CREATE TABLE IF NOT EXISTS prompt_overrides (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id             TEXT NOT NULL,
  system_prompt  TEXT NOT NULL,
  temperature    REAL,
  model          TEXT,
  thinking       INTEGER,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

-- 长期记忆台账。每一条记录对应 viking 里的一个记忆块。
--
-- SQLite 始终是唯一事实来源：这块内容是什么、该放在哪个 URI、索引成功没有，
-- 都记在这里。viking 只是可重建的向量存储，删了索引能重建，数据不会丢。
--
-- content 存切块正文，约等于原稿一份。代价是磁盘，
-- 换来的是召回结果不必回查源表就能展示预览。
CREATE TABLE IF NOT EXISTS memory_chunks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id       TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL CHECK (source_type IN
                  ('chapter','character','setting','conv_raw','conv_fact','conv_manual')),
  source_id     TEXT NOT NULL,
  chunk_no      INTEGER NOT NULL DEFAULT 0,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  viking_uri    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','indexing','indexed','failed')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  indexed_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 同一来源的同号块只能有一条：重建时按这个唯一键覆盖。
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_source_chunk
  ON memory_chunks (source_type, source_id, chunk_no);
CREATE INDEX IF NOT EXISTS idx_memory_work
  ON memory_chunks (user_id, work_id, source_type);
CREATE INDEX IF NOT EXISTS idx_memory_status
  ON memory_chunks (status, updated_at);

-- 记忆索引的元信息。
--
-- embedding_model / embedding_dim 记的是建索引时用的模型与维度。
-- 换模型后旧向量维度对不上，混用会得到静默的错误结果——
-- 启动时拿它跟 sidecar /health 报的当前模型比对，不一致就拒绝召回并要求重建。
CREATE TABLE IF NOT EXISTS memory_index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 文风规则卡。
--
-- 作者存下「我心中的好文章」「我讨厌的文章」，系统把它蒸馏成可执行的规则
-- （句长区间、对白占比、比喻密度、禁用词表），规则常驻注入 AI 上下文。
--
-- **原文不入库**。这张表只存蒸馏后的规则、来源标注与摘要。
-- 理由：坏样例最可能来自别人的作品，原文入库等于长期持有他人版权内容；
-- 而且规则才是 AI 真正要用的东西，原文留着只会让人误以为它会被喂给模型。
-- 摘要只给「从自己章节选的样例」留（≤100 字），粘贴的样例不留——
-- 粘贴的原文很可能来自别人，留片段也是替对方保管。
--
-- work_id 为 NULL 表示全局规则卡；作品级卡片整类替换同 kind 的全局卡片
-- （叠加会产生「既要 A 又要非 A」的矛盾要求）。
CREATE TABLE IF NOT EXISTS style_cards (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id      TEXT REFERENCES works(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('good','bad')),
  title        TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'paste' CHECK (source IN ('paste','chapter')),
  chapter_id   TEXT,
  excerpt      TEXT,
  rules        TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_style_cards_user
  ON style_cards (user_id, work_id, kind);
`;

/**
 * user_id 相关索引必须在补列之后建。
 *
 * 老库（schema 版本 1）没有 user_id，先跑 SCHEMA 里的 CREATE INDEX 会直接报错，
 * 所以这部分从 SCHEMA 里拆出来，等 ensureColumn 完成后再执行。
 */
const USER_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_works_user ON works(user_id, modified_at);
CREATE INDEX IF NOT EXISTS idx_materials_user ON materials(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inspirations_user ON inspirations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
`;

/** 需要 user_id 的业务表。 */
const USER_SCOPED_TABLES = [
  'works',
  'materials',
  'inspirations',
  'conversations',
  'prompt_overrides',
  'style_cards',
];

/**
 * 给已存在的表补一列。
 *
 * SQLite 的 CREATE TABLE IF NOT EXISTS 不会给老表加新列，
 * 而 SCHEMA_VERSION 保持 1（老数据不重建），所以新列要单独补。
 */
function ensureColumn(table, column, definition) {
  return new Promise((resolve, reject) => {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }
      if (rows.some((r) => r.name === column)) {
        resolve(false);
        return;
      }
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (alterErr) => {
        if (alterErr) reject(alterErr);
        else resolve(true);
      });
    });
  });
}

/** 执行多条 SQL（无参数），出错即拒绝。 */
function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * prompt_overrides 老结构是 id 单列主键（全站一份覆盖），
 * 多用户后必须是 (user_id, id)。SQLite 不能直接改主键，只能重建表，
 * 重建时把老数据整体搬过去（user_id 先留空串，由迁移脚本认领）。
 */
async function ensurePromptOverridesPk() {
  const columns = await all('PRAGMA table_info(prompt_overrides)');
  const pkColumns = columns.filter((c) => c.pk > 0);
  if (pkColumns.length >= 2) return;

  await run('BEGIN');
  try {
    await run(`
      CREATE TABLE prompt_overrides_v2 (
        user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id             TEXT NOT NULL,
        system_prompt  TEXT NOT NULL,
        temperature    REAL,
        model          TEXT,
        thinking       INTEGER,
        updated_at     TEXT NOT NULL,
        PRIMARY KEY (user_id, id)
      )
    `);
    await run(`
      INSERT INTO prompt_overrides_v2
        (user_id, id, system_prompt, temperature, model, thinking, updated_at)
      SELECT COALESCE(user_id, ''), id, system_prompt, temperature, model, thinking, updated_at
      FROM prompt_overrides
    `);
    await run('DROP TABLE prompt_overrides');
    await run('ALTER TABLE prompt_overrides_v2 RENAME TO prompt_overrides');
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * 增量迁移。只加表、加列、加索引，不删任何已有业务表。
 * @param {number} fromVersion 当前库的 schema 版本
 */
async function migrate(fromVersion) {
  if (fromVersion === 0) {
    // 首次运行（或版本号之前的老库）：清掉没有保留价值的老表
    console.log('数据库首次初始化');
    await exec('PRAGMA foreign_keys = OFF');
    for (const table of LEGACY_TABLES) {
      await run(`DROP TABLE IF EXISTS ${table}`);
    }
  } else if (fromVersion < SCHEMA_VERSION) {
    console.log(
      `数据库 schema 版本 ${fromVersion} → ${SCHEMA_VERSION}，执行增量迁移（保留全部数据）`
    );
  }

  // 建缺失的表（IF NOT EXISTS，不会动已有表的数据）
  await exec(SCHEMA);

  // 老表补新列
  for (const table of USER_SCOPED_TABLES) {
    await ensureColumn(table, 'user_id', 'TEXT REFERENCES users(id) ON DELETE CASCADE');
  }
  await ensureColumn('users', 'role', "TEXT DEFAULT 'user'");
  await ensureColumn('materials', 'page_count', 'INTEGER DEFAULT 0');
  await ensureColumn('prompt_overrides', 'model', 'TEXT');
  await ensureColumn('prompt_overrides', 'thinking', 'INTEGER');
  await ensureColumn('chapters', 'outline', 'TEXT');
  await ensureColumn('chapters', 'word_count', 'INTEGER DEFAULT 0');
  await ensureColumn('works', 'target_words', 'INTEGER DEFAULT 0');

  // prompt_overrides 需要复合主键，老库要重建一次（数据整体保留）
  await ensurePromptOverridesPk();

  // 依赖 user_id 的索引要等补列完成
  await exec(USER_INDEXES);

  await run(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  // 老库重建时外键曾被关掉，建完新表再开启，否则 ON DELETE CASCADE 不生效
  if (fromVersion === 0) {
    await exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 初始化数据库：按版本号做增量迁移。
 * @returns {Promise<void>}
 */
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.get('PRAGMA user_version', (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      const currentVersion = row ? row.user_version : 0;

      if (currentVersion > SCHEMA_VERSION) {
        reject(
          new Error(
            `数据库 schema 版本 ${currentVersion} 高于当前服务端支持的 ${SCHEMA_VERSION}，请勿降级运行`
          )
        );
        return;
      }

      migrate(currentVersion).then(resolve).catch(reject);
    });
  });
}

// ---------------------------------------------------------------------------
// 查询封装
// ---------------------------------------------------------------------------
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * 在事务中执行一组语句。任一语句失败则整体回滚。
 * @param {Array<{sql: string, params?: any[]}>} statements
 */
async function transaction(statements) {
  await run('BEGIN');
  try {
    for (const stmt of statements) {
      await run(stmt.sql, stmt.params || []);
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  }
}

const ready = initDatabase();

/**
 * 关闭数据库连接。
 *
 * 恢复备份时用：备份 zip 里的 curiosity.db 会整个替换掉当前的库文件。
 * 连接开着的时候换文件，运行中的连接句柄仍指向旧 inode，继续读写会写进
 * 没人看的文件，内存里的页缓存也可能把恢复出来的数据覆盖掉。
 */
function close() {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * 重新打开库文件并跑一遍建表与迁移。
 *
 * 和 close() 配对使用：close() → 换文件 → reopen()。
 */
function reopen() {
  db = new sqlite3.Database(config.dbPath);
  return initDatabase();
}

module.exports = { db, all, get, run, transaction, ready, close, reopen };
