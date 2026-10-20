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

const db = new sqlite3.Database(config.dbPath);

/**
 * Schema 版本。用 SQLite 的 user_version 记录，版本不匹配时重建全部表。
 *
 * 为什么用版本号而不是"列出要删的旧表"：
 * 'settings' 在旧 schema 里是键值对配置表，在新 schema 里是世界观设定表——
 * 同名不同结构。若把 'settings' 放进"每次启动都删"的列表，新建的设定会在重启后消失；
 * 若不放进去，CREATE TABLE IF NOT EXISTS 又会沿用旧结构。
 * 版本号一次性解决这个问题：版本不匹配 → 全删重建；匹配 → 什么都不动。
 */
const SCHEMA_VERSION = 1;

// 需要在重建时一并清掉的表
const ALL_TABLES = [
  // 旧 schema
  'reports',
  'documents',
  'categories',
  'report_documents',
  'citations',
  'keywords',
  'translation_history',
  'agent_memory',
  // 新 schema（版本不匹配时同样重建）
  'works',
  'chapters',
  'characters',
  'settings',
  'materials',
  'inspirations',
  'conversations',
  'messages',
  'prompt_overrides',
];

const SCHEMA = `
-- 作品
CREATE TABLE IF NOT EXISTS works (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  genre        TEXT,
  synopsis     TEXT,
  outline      TEXT,
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
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, seq);

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

-- 素材库
CREATE TABLE IF NOT EXISTS materials (
  rid          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  body         TEXT,
  source       TEXT,
  source_url   TEXT,
  file_path    TEXT,
  tags         TEXT,
  char_count   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);

-- 灵感速记
CREATE TABLE IF NOT EXISTS inspirations (
  id           TEXT PRIMARY KEY,
  text         TEXT NOT NULL,
  tags         TEXT,
  consumed     INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- AI 会话
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
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

-- 提示词覆盖
CREATE TABLE IF NOT EXISTS prompt_overrides (
  id             TEXT PRIMARY KEY,
  system_prompt  TEXT NOT NULL,
  temperature    REAL,
  updated_at     TEXT NOT NULL
);
`;

/**
 * 初始化数据库：版本不匹配则重建表结构，匹配则只确保表存在。
 * @returns {Promise<void>}
 */
function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.get('PRAGMA user_version', (err, row) => {
        if (err) {
          reject(err);
          return;
        }

        const currentVersion = row ? row.user_version : 0;

        if (currentVersion === SCHEMA_VERSION) {
          // 版本一致：只确保表存在，不动任何数据
          db.exec(SCHEMA, (execErr) => {
            if (execErr) reject(execErr);
            else resolve();
          });
          return;
        }

        console.log(
          `数据库 schema 版本 ${currentVersion} → ${SCHEMA_VERSION}，重建表结构（旧数据不迁移）`
        );

        // 重建期间关闭外键：旧表之间存在引用关系，开着外键删表会报 constraint failed
        db.run('PRAGMA foreign_keys = OFF');
        for (const table of ALL_TABLES) {
          db.run(`DROP TABLE IF EXISTS ${table}`);
        }
        db.exec(SCHEMA, (execErr) => {
          if (execErr) {
            reject(execErr);
            return;
          }
          db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`, (verErr) => {
            if (verErr) {
              reject(verErr);
              return;
            }
            // 建完新表再开启外键，否则 ON DELETE CASCADE 不生效
            db.run('PRAGMA foreign_keys = ON', (pragmaErr) => {
              if (pragmaErr) reject(pragmaErr);
              else resolve();
            });
          });
        });
      });
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

module.exports = { db, all, get, run, transaction, ready };
