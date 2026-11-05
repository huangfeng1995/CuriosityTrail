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
 * 版本 4 → 5：用户反馈（feedbacks）。
 * 版本 5 → 6：范文编排锚点（reference_anchors）。
 * 版本 6 → 7：卡片提案（card_proposals）与卡片来源列。
 * 版本 7 → 8：历史悬疑模板开关（works.template）与锚点三表。
 * 版本 8 → 9：人物卡正史/立场/底线/弱点，秘密/事实/知情矩阵/证据四表。
 * 版本 9 → 10：知情扫描待确认表（knowledge_pending）。
 * 版本 10 → 11：素材出处/置信/来源/状态列（agent 整理素材的机械约束）。
 */
const SCHEMA_VERSION = 11;

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
  -- 项目级创作模板。'' 表示未启用；白名单见 services/pipeline/gate.js。
  template     TEXT NOT NULL DEFAULT '',
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
  source_block_id TEXT,
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
--
-- source_chapter_id / source_block_id：这张卡是从哪段正文里沉淀出来的。
-- 作者手动建卡时为空；由卡片提案确认生成的卡会带上来源，
-- 上下文装配据此把「当前章确认过的卡」无条件纳入。
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
  -- 历史悬疑模板的四列。默认 NULL：未启用模板的作品与老库不产生任何新文案。
  canon        TEXT,   -- 正史 / 虚构
  stance       TEXT,   -- 立场
  bottom_line  TEXT,   -- 底线
  weakness     TEXT,   -- 弱点
  source_chapter_id TEXT,
  source_block_id   TEXT,
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
  source_chapter_id TEXT,
  source_block_id   TEXT,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_settings_work ON settings(work_id, category);

-- 卡片提案。
--
-- 从正文里识别出来的「这里出现了新人物 / 新设定 / 新情节节点」先落在这里，
-- 作者确认后才写进 characters / settings / plot_cards。
-- 单独建表而不是直接写卡片表：未确认的提案不能被上下文装配当事实注入，
-- 也不能在人物/设定列表里出现——那等于模型替作者定了稿。
--
-- status 状态机：
--   pending   → confirmed（card_id 指向新建的卡片，终态）
--   pending   → dismissed（终态）
-- 已处理的提案不会被重新扫描复活：去重只针对同 kind + 同标题的 pending 行。
CREATE TABLE IF NOT EXISTS card_proposals (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id   TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  block_id     TEXT,
  kind         TEXT NOT NULL CHECK (kind IN ('character','setting','plot')),
  title        TEXT NOT NULL,
  content      TEXT,
  payload      TEXT,
  source_quote TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','confirmed','dismissed')),
  card_id      TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_proposals_work
  ON card_proposals(work_id, status, created_at);

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
  -- 素材归到哪部作品。空串 = 全库通用，不绑作品。
  work_id      TEXT,
  -- 出处（书名/篇目/网页标题）。标 sourced 时非空，missing 时必须为空。
  provenance   TEXT NOT NULL DEFAULT '',
  -- sourced / inferable / missing。老数据迁移后一律 inferable，绝不冒充有出处。
  confidence   TEXT NOT NULL DEFAULT 'inferable',
  -- web / model / internal / user。web 必须有可核的 search_log。
  origin       TEXT NOT NULL DEFAULT 'user',
  -- active / pending / retracted。pending 需用户批量确认后才进检索。
  status       TEXT NOT NULL DEFAULT 'active',
  -- user / agent。
  created_by   TEXT NOT NULL DEFAULT 'user',
  -- 联网检索记录（JSON）：query、返回条数、命中 URL、抓取成败。
  search_log   TEXT NOT NULL DEFAULT '',
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

-- 用户反馈。作者提的问题、想要的功能、遇到的故障，都落在这里。
--
-- status 由运营侧改（new / triaged / resolved），
-- 目前没有后台页面，改库即可，先把通道建起来。
CREATE TABLE IF NOT EXISTS feedbacks (
  id         TEXT PRIMARY KEY,
  user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  category   TEXT NOT NULL DEFAULT 'other',
  content    TEXT NOT NULL,
  contact    TEXT,
  status     TEXT NOT NULL DEFAULT 'new'
             CHECK (status IN ('new','triaged','resolved')),
  reply      TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedbacks_user
  ON feedbacks (user_id, created_at);

-- 范文编排锚点。
--
-- 作者授权后，把一段从基线范文里精选的编排示范注入写手 system，
-- 紧挨节拍表。user_id 就是主键：一个作者只允许存在一张锚点，
-- 重复开启是覆盖同一行，不会出现第二张。
--
-- 撤回时 content 必须真的置空。只把 enabled 关掉而留着正文，
-- 一旦后续代码忽略开关就会静默复活；withdrawn_at 用来在设置页
-- 显示「这张锚点撤回过」，与「从未开启」区分开。
CREATE TABLE IF NOT EXISTS reference_anchors (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0,
  content      TEXT,
  source       TEXT,
  confirmed_at TEXT,
  withdrawn_at TEXT,
  updated_at   TEXT NOT NULL
);

-- 历史锚点库。
--
-- 一条锚点是「不能写错什么」的史实断言，与 reference_anchors（怎么写）
-- 是两回事。confidence 分三档，其中两条 CHECK 是数据层的硬约束：
--   * sourced 必须给书名 + 卷次/条目，无出处不得入库；
--   * blank 天然不可作为不可变校验器，强制 immutable = 0。
-- 只有 status = 'active' 的锚点参与注入与章末断言。
CREATE TABLE IF NOT EXISTS work_anchors (
  id             TEXT PRIMARY KEY,
  work_id        TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('event','person','time','place','office','custom')),
  subject        TEXT NOT NULL,
  claim          TEXT NOT NULL,
  confidence     TEXT NOT NULL CHECK (confidence IN ('sourced','inferable','blank')),
  source_title   TEXT,
  source_locator TEXT,
  source_quote   TEXT,
  rules          TEXT NOT NULL DEFAULT '[]',
  immutable      INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','active','rejected')),
  created_at     TEXT NOT NULL,
  modified_at    TEXT NOT NULL,
  CHECK (confidence <> 'sourced'
         OR (source_title IS NOT NULL AND source_title <> ''
             AND source_locator IS NOT NULL AND source_locator <> '')),
  CHECK (confidence <> 'blank' OR immutable = 0)
);
CREATE INDEX IF NOT EXISTS idx_work_anchors
  ON work_anchors (work_id, status, kind);

-- 史料空白区。正史无载、可合法虚构的区间，单独成表，不混进锚点库。
CREATE TABLE IF NOT EXISTS work_blank_areas (
  id          TEXT PRIMARY KEY,
  work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  topic       TEXT NOT NULL,
  why_blank   TEXT,
  usable_for  TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','closed')),
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- 章末断言命中记录。作者确认「有意改写」后标记 dismissed，
-- 同规则同锚点不再重复报；block 级不允许 dismiss。
CREATE TABLE IF NOT EXISTS anchor_violations (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id   TEXT REFERENCES chapters(id) ON DELETE CASCADE,
  anchor_id    TEXT REFERENCES work_anchors(id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL,
  severity     TEXT NOT NULL CHECK (severity IN ('block','warn')),
  quote        TEXT NOT NULL,
  offset_start INTEGER,
  detail       TEXT,
  dismissed    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

-- 秘密的叙事容器。作者先写整条秘密，再拆成事实单元。
CREATE TABLE IF NOT EXISTS story_secrets (
  id          TEXT PRIMARY KEY,
  work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  reveal_seq  INTEGER,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','revealed','dropped')),
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- 事实单元：秘密被拆成的最小可被告知单位。
CREATE TABLE IF NOT EXISTS story_facts (
  id          TEXT PRIMARY KEY,
  work_id     TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  secret_id   TEXT REFERENCES story_secrets(id) ON DELETE CASCADE,
  part_no     INTEGER NOT NULL DEFAULT 1,
  content     TEXT NOT NULL,
  keywords    TEXT,
  created_at  TEXT NOT NULL,
  modified_at TEXT NOT NULL
);

-- 知情矩阵：只记状态变化点。
--
-- chapter_seq = N 表示「第 N 章写完后生效」，所以生成第 N 章时只能读到
-- chapter_seq <= N - 1 的行。这条语义由 services/pipeline/knowledge.js
-- 的 knowledgeAt() 统一收口，调用方不要自己拼条件。
CREATE TABLE IF NOT EXISTS knowledge_matrix (
  id            TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  fact_id       TEXT NOT NULL REFERENCES story_facts(id) ON DELETE CASCADE,
  chapter_seq   INTEGER NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
                  ('suspects','partial','knows','exposed')),
  evidence_id   TEXT,
  source_chapter_id TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (character_id, fact_id, chapter_seq)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_lookup
  ON knowledge_matrix (work_id, character_id, chapter_seq);

-- 证据台账：物证/人证在谁手上、被谁见过、何时暴露。
CREATE TABLE IF NOT EXISTS evidence_items (
  id            TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  fact_id       TEXT REFERENCES story_facts(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  holder_character_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  holder_kind   TEXT NOT NULL DEFAULT 'character'
                CHECK (holder_kind IN ('character','place','none')),
  seen_by       TEXT NOT NULL DEFAULT '[]',
  acquired_seq  INTEGER,
  exposed_seq   INTEGER,
  destroyed_seq INTEGER,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','destroyed','exposed')),
  created_at    TEXT NOT NULL,
  modified_at   TEXT NOT NULL
);

-- 待确认的知情变化：扫描没有全过的条目先落在这里，作者确认后才写 knowledge_matrix。
-- 实体可能没解析出来（角色不存在/事实不存在），所以 character_id、fact_id 允许 NULL，
-- 同时保留模型给的原始名字/编号，作者才能判断它到底想说什么。
CREATE TABLE IF NOT EXISTS knowledge_pending (
  id            TEXT PRIMARY KEY,
  work_id       TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  chapter_id    TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  chapter_seq   INTEGER NOT NULL,
  character_id  TEXT REFERENCES characters(id) ON DELETE SET NULL,
  character_name TEXT NOT NULL,
  fact_id       TEXT REFERENCES story_facts(id) ON DELETE SET NULL,
  fact_label    TEXT NOT NULL,
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  evidence      TEXT NOT NULL,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','dismissed')),
  created_at    TEXT NOT NULL,
  modified_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_pending_work
  ON knowledge_pending (work_id, status, created_at);

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
CREATE INDEX IF NOT EXISTS idx_materials_user_status ON materials(user_id, status, modified_at);
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
  // 10 → 11：素材的出处/置信/来源/状态。老行没有可核出处，
  // confidence 默认 inferable（可推定），绝不默认成 sourced。
  await ensureColumn('materials', 'work_id', 'TEXT');
  await ensureColumn('materials', 'provenance', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('materials', 'confidence', "TEXT NOT NULL DEFAULT 'inferable'");
  await ensureColumn('materials', 'origin', "TEXT NOT NULL DEFAULT 'user'");
  await ensureColumn('materials', 'status', "TEXT NOT NULL DEFAULT 'active'");
  await ensureColumn('materials', 'created_by', "TEXT NOT NULL DEFAULT 'user'");
  await ensureColumn('materials', 'search_log', "TEXT NOT NULL DEFAULT ''");
  await ensureColumn('prompt_overrides', 'model', 'TEXT');
  await ensureColumn('prompt_overrides', 'thinking', 'INTEGER');
  await ensureColumn('chapters', 'outline', 'TEXT');
  await ensureColumn('chapters', 'word_count', 'INTEGER DEFAULT 0');
  await ensureColumn('works', 'target_words', 'INTEGER DEFAULT 0');
  // 6 → 7：卡片来源。老库不会因为 SCHEMA 里的新列自动补上，必须单独 ALTER。
  await ensureColumn('characters', 'source_chapter_id', 'TEXT');
  await ensureColumn('characters', 'source_block_id', 'TEXT');
  await ensureColumn('settings', 'source_chapter_id', 'TEXT');
  await ensureColumn('settings', 'source_block_id', 'TEXT');
  await ensureColumn('plot_cards', 'source_block_id', 'TEXT');
  // 7 → 8：模板开关。SCHEMA 已含该列，老库必须单独补。
  await ensureColumn('works', 'template', "TEXT NOT NULL DEFAULT ''");
  // 8 → 9：人物卡四列。老行保持 NULL，formatCharacter 不会输出空标签。
  await ensureColumn('characters', 'canon', 'TEXT');
  await ensureColumn('characters', 'stance', 'TEXT');
  await ensureColumn('characters', 'bottom_line', 'TEXT');
  await ensureColumn('characters', 'weakness', 'TEXT');

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
