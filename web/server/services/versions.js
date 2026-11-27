'use strict';

/**
 * 章节版本历史。
 *
 * 前端的撤销栈只存在浏览器内存里（50 步），关掉页面就没了。
 * 写小说最怕的不是改不动，而是改坏了找不回来——三万字的手稿，
 * 一次误删段落，Ctrl+Z 早就用完了。
 *
 * 所以这里在服务端留一份持久化的版本链：
 *   自动快照 —— 每次保存把「被覆盖掉的旧内容」存一份，作者可以回滚到任意一版
 *   手动快照 —— 作者主动命名存档点（"第三章结尾定稿"），永远不会被自动清理
 *
 * 存 blocks 而不是只存 content：blocks 才是权威数据，只存纯文本会把
 * 对白块、图片块的结构信息丢掉，回滚之后章节就散了。
 */

const crypto = require('crypto');
const { all, get, run } = require('../database');
const { countBlockWords, countWords } = require('./wordCount');

/**
 * 自动快照的保留策略。
 *
 * 最近 MAX_AUTO_VERSIONS 份 + 最近 DAILY_KEEP_DAYS 天每天一份。
 *
 * 为什么是 10：写手一次连续修改通常在 10 次保存以内，保留最近 10 份
 * 足够覆盖「刚才那几段改坏了」；再往前靠按天快照。
 * 为什么是 14 天：两周足够覆盖一次集中创作周期，也更符合「隔几天
 * 回来看看旧稿」的实际使用。
 *
 * 手动快照不计入这个额度——它们是作者主动留的存档点，不能被系统清掉。
 * 单章上限是 10 + 14 = 24 份；按当前 69 个有版本的章节算，稳定上界
 * 约 1,656 行，且只随章节数线性增长，不随时间增长。
 */
const MAX_AUTO_VERSIONS = 10;
const DAILY_KEEP_DAYS = 14;

/**
 * 版本时间戳落在本地哪一天（YYYY-MM-DD）。
 *
 * 用服务器本地时区而不是 UTC：作者说的「今天」是本地今天，
 * 否则晚上 8 点后的快照会被算到第二天，按天保留就错位了。
 */
function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 最近 N 个本地自然日的日期键（含今天）。
 */
function recentDayKeys(days) {
  const keys = new Set();
  const now = new Date();
  for (let i = 0; i < days; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.add(localDayKey(d));
  }
  return keys;
}

/**
 * 解析章节的 blocks JSON。
 */
function parseBlocks(blocksJson) {
  if (!blocksJson) return [];
  try {
    const parsed = JSON.parse(blocksJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 从 blocks 派生纯文本（与章节保存逻辑保持一致）。
 */
function deriveContent(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.content)
    .map((b) => b.content)
    .join('\n\n');
}

/**
 * 内容指纹。用来判断"这一版跟上一版是不是一样的"。
 *
 * 用 sha256 而不是简单比较字符串：blocks 里含块 id，
 * 同一段文字重新排块后 id 变了，但内容其实没变——不该记成新版本。
 * 只比正文内容，不比结构。
 */
function fingerprint(content) {
  return crypto.createHash('sha256').update(content || '').digest('hex');
}

/**
 * 为一个章节创建版本快照。
 *
 * @param {Object} params
 * @param {string} params.chapterId
 * @param {string} params.workId
 * @param {string} [params.title]
 * @param {Array}  [params.blocks] 权威数据；不传则用章节当前内容
 * @param {string} [params.content] 纯文本快照；不传则从 blocks 派生
 * @param {string} [params.label]  快照标签（手动快照用）
 * @param {boolean} [params.manual] 是否手动快照
 * @returns {Promise<Object>}
 */
async function createVersion(params) {
  const {
    chapterId,
    workId,
    title = '',
    blocks,
    content,
    label = '',
    manual = false,
  } = params;

  let nextBlocks = blocks;
  let nextContent = content;

  if (!Array.isArray(nextBlocks)) {
    const chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
    if (!chapter) {
      const err = new Error('章节不存在');
      err.status = 404;
      throw err;
    }
    nextBlocks = parseBlocks(chapter.blocks);
    nextContent = chapter.content;
    if (!title) title = chapter.title;
    if (!workId) workId = chapter.work_id;
  }

  if (typeof nextContent !== 'string') {
    nextContent = deriveContent(nextBlocks);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const wordCount = countBlockWords(nextBlocks) || countWords(nextContent);

  await run(
    `INSERT INTO chapter_versions
       (id, chapter_id, work_id, title, blocks, content, label, manual, word_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      chapterId,
      workId || '',
      title,
      JSON.stringify(Array.isArray(nextBlocks) ? nextBlocks : []),
      nextContent,
      label,
      manual ? 1 : 0,
      wordCount,
      createdAt,
    ]
  );

  return get('SELECT * FROM chapter_versions WHERE id = ?', [id]);
}

/**
 * 自动快照：保存章节当前状态。
 *
 * 只在内容真的变了时才建版本——作者点开页面又点保存，
 * 不该凭空多出一条一模一样的历史记录。
 *
 * @param {string} chapterId
 * @returns {Promise<Object|null>} 建了返回版本对象，没变化返回 null
 */
async function autoSnapshot(chapterId) {
  const chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) return null;

  const content = chapter.content || '';
  const latest = await get(
    `SELECT * FROM chapter_versions
     WHERE chapter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [chapterId]
  );

  // 跟最新一版内容一致就不记了
  if (latest && fingerprint(latest.content) === fingerprint(content)) {
    return null;
  }

  const version = await createVersion({
    chapterId,
    workId: chapter.work_id,
    title: chapter.title,
    blocks: parseBlocks(chapter.blocks),
    content,
    label: '自动快照',
    manual: false,
  });

  await pruneAutoVersions(chapterId);
  return version;
}

/**
 * 手动快照：作者主动留的存档点。
 */
async function createManualVersion(chapterId, label) {
  const chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) {
    const err = new Error('章节不存在');
    err.status = 404;
    throw err;
  }
  return createVersion({
    chapterId,
    workId: chapter.work_id,
    title: chapter.title,
    blocks: parseBlocks(chapter.blocks),
    content: chapter.content || '',
    label: (label && String(label).trim()) || '手动存档',
    manual: true,
  });
}

/**
 * 列出某章的版本历史，最新在前。
 *
 * 不返回 blocks/content 全量正文——一章十几版，全量返回能让响应膨胀到
 * 几十 MB。列表只给元信息，要看具体内容再单独取。
 *
 * @param {string} chapterId
 * @returns {Promise<Array>}
 */
async function listVersions(chapterId) {
  return all(
    `SELECT id, chapter_id, work_id, title, label, manual, word_count, created_at,
            length(content) AS content_length
     FROM chapter_versions
     WHERE chapter_id = ?
     ORDER BY created_at DESC, rowid DESC`,
    [chapterId]
  );
}

/**
 * 取单个版本的完整内容。
 */
async function getVersion(chapterId, versionId) {
  return get(
    'SELECT * FROM chapter_versions WHERE id = ? AND chapter_id = ?',
    [versionId, chapterId]
  );
}

/**
 * 回滚到某个版本。
 *
 * 回滚前先把当前内容存一份自动快照——否则"回滚回滚"就没得回了。
 *
 * @param {string} chapterId
 * @param {string} versionId
 * @returns {Promise<Object>} 回滚后的章节
 */
async function restoreVersion(chapterId, versionId) {
  const version = await getVersion(chapterId, versionId);
  if (!version) {
    const err = new Error('版本不存在');
    err.status = 404;
    throw err;
  }

  const chapter = await get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
  if (!chapter) {
    const err = new Error('章节不存在');
    err.status = 404;
    throw err;
  }

  // 当前状态先留档
  await autoSnapshot(chapterId);

  const blocks = parseBlocks(version.blocks);
  const content = version.content ?? deriveContent(blocks);
  const wordCount = countBlockWords(blocks) || countWords(content);
  const now = new Date().toISOString();

  await run(
    `UPDATE chapters SET content = ?, blocks = ?, word_count = ?, modified_at = ?
     WHERE id = ?`,
    [content, JSON.stringify(blocks), wordCount, now, chapterId]
  );

  return get('SELECT * FROM chapters WHERE id = ?', [chapterId]);
}

/**
 * 删除一个版本。手动快照也允许删——作者自己决定留不留。
 */
async function deleteVersion(chapterId, versionId) {
  const result = await run(
    'DELETE FROM chapter_versions WHERE id = ? AND chapter_id = ?',
    [versionId, chapterId]
  );
  return result.changes > 0;
}

/**
 * 清理自动快照。
 *
 * 保留规则（手动快照永远不动）：
 *   1. 最近 MAX_AUTO_VERSIONS 份；
 *   2. 最近 DAILY_KEEP_DAYS 天里，每天最新的一份。
 * 两条规则取并集。
 *
 * 幂等：同一份数据重复执行，第二次不会再删任何行。
 * 只删 chapter_versions，不碰 chapters，因此不会影响章节当前正文；
 * 最新一份永远落在规则 1 里，当天最新一份同时落在规则 1 和 2 里。
 */
async function pruneAutoVersions(chapterId) {
  const rows = await all(
    `SELECT id, created_at FROM chapter_versions
     WHERE chapter_id = ? AND manual = 0
     ORDER BY created_at DESC, rowid DESC`,
    [chapterId]
  );
  if (!rows.length) return 0;

  const keep = new Set();
  // 规则 1：最近 N 份
  for (const row of rows.slice(0, MAX_AUTO_VERSIONS)) keep.add(row.id);

  // 规则 2：最近 D 天每天最新的一份
  const wantedDays = recentDayKeys(DAILY_KEEP_DAYS);
  const coveredDays = new Set();
  for (const row of rows) {
    const day = localDayKey(row.created_at);
    if (!day || !wantedDays.has(day) || coveredDays.has(day)) continue;
    keep.add(row.id);
    coveredDays.add(day);
  }

  let deleted = 0;
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    await run('DELETE FROM chapter_versions WHERE id = ?', [row.id]);
    deleted += 1;
  }
  return deleted;
}

module.exports = {
  createVersion,
  autoSnapshot,
  createManualVersion,
  listVersions,
  getVersion,
  restoreVersion,
  deleteVersion,
  pruneAutoVersions,
  parseBlocks,
  deriveContent,
  fingerprint,
  MAX_AUTO_VERSIONS,
  DAILY_KEEP_DAYS,
};
