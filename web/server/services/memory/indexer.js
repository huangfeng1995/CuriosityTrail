'use strict';

/**
 * 记忆索引器。
 *
 * 职责：
 *  1. 把一个"来源"（章节/人物卡/设定卡/对话消息）切成块，写进台账
 *  2. 把块推给 sidecar 建向量，失败则退避重试
 *  3. 来源变了或删了，把旧块从台账与向量里清掉
 *
 * 三条原则：
 *
 *  - **索引失败不阻塞作者。** 保存章节的请求不等索引，索引在后台队列里跑。
 *  - **SQLite 是唯一事实来源。** viking 只是可重建的向量存储，
 *    任何时候都能靠台账 + 源表重新建一遍。
 *  - **幂等。** 同一份内容重复索引，结果一样；内容没变就不重复调 embedding。
 */

const crypto = require('crypto');

const config = require('../../config');
const { all, get, run, transaction } = require('../../database');
const client = require('./client');
const chunker = require('./chunker');
const sources = require('./sources');
const uris = require('./uris');

/** 连续保存章节的防抖窗口（毫秒）。 */
const DEBOUNCE_MS = 5000;

/** 索引失败的最大重试次数。 */
const MAX_ATTEMPTS = 3;

/** 待执行的任务队列。 */
const queue = [];

/** 正在执行的任务数。 */
let active = 0;

/** 防抖定时器：key -> timer。 */
const debounceTimers = new Map();

/** 等待队列清空的回调。 */
const idleWaiters = [];

/**
 * 进行中的重建：userId -> 还没跑完的任务数。
 *
 * 重建完要把索引元信息刷新一遍（模型换了、向量重建过了）。
 * 什么时候算"完"？等队列里这个用户的重建任务全部跑完的那一刻。
 */
const rebuildPending = new Map();

/**
 * 生成台账主键。
 * @returns {string}
 */
function chunkId() {
  return crypto.randomUUID();
}

/**
 * 索引元信息的键。
 *
 * 带用户前缀：索引是每个用户各自一份，元信息也得跟着分。
 *
 * @param {string} userId
 * @param {string} name
 * @returns {string}
 */
function metaKey(userId, name) {
  return `u:${userId}:${name}`;
}

/**
 * 队列是否已空。
 * @returns {boolean}
 */
function isIdle() {
  return active === 0 && queue.length === 0 && debounceTimers.size === 0;
}

/**
 * 队列空了就通知等待者。
 */
function notifyIdle() {
  if (!isIdle()) return;
  while (idleWaiters.length) {
    const resolve = idleWaiters.shift();
    resolve();
  }
}

/**
 * 等队列跑空。测试用。
 * @returns {Promise<void>}
 */
function whenIdle() {
  if (isIdle()) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

/**
 * 把一个任务推进队列。
 * @param {object} task
 */
function enqueue(task) {
  queue.push(task);
  pump();
}

/**
 * 启动 worker。
 */
function pump() {
  while (active < config.memoryIndexConcurrency && queue.length) {
    const task = queue.shift();
    active += 1;
    runTask(task)
      .catch((e) => {
        // 任务本身已经处理过失败，这里只是兜底，别让进程挂掉
        console.error(`记忆索引任务失败：${e.message}`);
      })
      .finally(() => {
        active -= 1;
        pump();
        notifyIdle();
      });
  }
}

/**
 * 执行一个索引任务。
 * @param {object} task
 */
async function runTask(task) {
  if (task.kind === 'index') {
    try {
      await indexSource(task);
    } finally {
      // 无论成功失败都算这个重建任务跑完了：最后一块跑完时刷新元信息。
      if (task.force && task.rebuildOwner) await settleRebuild(task.rebuildOwner);
    }
    return;
  }
  if (task.kind === 'repush') {
    try {
      await repushConversationChunks(task);
    } finally {
      if (task.rebuildOwner) await settleRebuild(task.rebuildOwner);
    }
    return;
  }
  if (task.kind === 'remove') {
    await removeSource(task);
    return;
  }
  if (task.kind === 'removeWork') {
    await removeWork(task);
  }
}

/**
 * 一个重建任务跑完。整批跑完时刷新索引元信息。
 *
 * @param {string} userId
 */
async function settleRebuild(userId) {
  const left = (rebuildPending.get(userId) || 1) - 1;
  if (left > 0) {
    rebuildPending.set(userId, left);
    return;
  }
  rebuildPending.delete(userId);
  await finishRebuild(userId);
}

/**
 * 投递一个来源的索引任务。
 *
 * 章节会走防抖：连续保存五次只索引最后一次——
 * 写作时保存是连续的，每次都建向量纯属浪费 embedding 额度。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string} params.sourceType
 * @param {string} params.sourceId
 * @param {string} [params.conversationId]
 * @param {string} [params.content] 对话类直接给内容；章节/人物/设定留空，worker 会重新读源表
 * @param {boolean} [params.immediate] 跳过防抖（重建时用）
 * @param {boolean} [params.force] 无视增量判定，全部重新向量化（重建时用）
 * @param {string} [params.rebuildOwner] 属于哪一次重建（用于跑完后刷新元信息）
 */
function scheduleIndex(params) {
  const {
    userId,
    workId,
    sourceType,
    sourceId,
    conversationId,
    content,
    immediate,
    force,
    rebuildOwner,
  } = params;
  if (!client.isEnabled()) return;

  const key = `${sourceType}:${sourceId}`;

  // 只有章节需要防抖。人物卡、设定卡保存频率低，防抖反而让作者等。
  if (!immediate && sourceType === 'chapter') {
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      enqueue({
        kind: 'index',
        userId,
        workId,
        sourceType,
        sourceId,
        conversationId,
        content,
        force,
        rebuildOwner,
      });
    }, DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    debounceTimers.set(key, timer);
    return;
  }

  enqueue({
    kind: 'index',
    userId,
    workId,
    sourceType,
    sourceId,
    conversationId,
    content,
    force,
    rebuildOwner,
  });
}

/**
 * 投递一个来源的删除任务。
 *
 * 删除不防抖——作者点了删除就该立刻消失，不能等 5 秒。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.sourceType
 * @param {string} params.sourceId
 */
function scheduleRemove({ userId, sourceType, sourceId }) {
  if (!client.isEnabled()) return;
  enqueue({ kind: 'remove', userId, sourceType, sourceId });
}

/**
 * 投递一个作品的删除任务。
 *
 * 删作品时，数据库里的台账会随外键级联删掉，
 * 但 viking 里的向量还在——不显式清掉，召回时会捞到一部已经不存在的作品。
 *
 * 所以 URI 必须在删除发生**之前**抓好：这里同步查一次台账，
 * 把要删的 URI 塞进任务里，队列跑的时候台账可能已经空了。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 */
async function scheduleRemoveWork({ userId, workId }) {
  if (!client.isEnabled()) return;
  const rows = await all(
    'SELECT viking_uri FROM memory_chunks WHERE user_id = ? AND work_id = ?',
    [userId, workId]
  );
  enqueue({ kind: 'removeWork', userId, workId, uris: rows.map((row) => row.viking_uri) });
}

/**
 * 读取来源正文。
 *
 * 对话类用投递时带的内容快照（那时候的原文不会变）；
 * 章节/人物/设定在 worker 里重新读源表——防抖期间可能又改过，
 * 重新读才能拿到最新版本。
 *
 * @param {object} task
 * @returns {Promise<{text: string, blocks: Array}>}
 */
async function readSource(task) {
  const { userId, sourceType, sourceId, content } = task;

  if (sourceType === 'chapter') {
    const chapter = await sources.findChapter(sourceId, userId);
    if (!chapter) return { text: '', blocks: [] };
    return { text: sources.chapterText(chapter), blocks: sources.chapterBlocks(chapter) };
  }
  if (sourceType === 'character') {
    const character = await sources.findCharacter(sourceId, userId);
    return { text: sources.characterText(character), blocks: [] };
  }
  if (sourceType === 'setting') {
    const setting = await sources.findSetting(sourceId, userId);
    return { text: sources.settingText(setting), blocks: [] };
  }
  return { text: content || '', blocks: [] };
}

/**
 * 给一个来源建索引。
 *
 * @param {object} task
 * @param {number} [task.maxAttempts] 最多试几次。手动层传 1（作者在等回话）。
 */
async function indexSource(task) {
  const { userId, workId, sourceType, sourceId, conversationId } = task;
  const maxAttempts = task.maxAttempts || MAX_ATTEMPTS;

  const { text, blocks } = await readSource(task);
  const pieces = sourceType === 'chapter' && blocks.length
    ? chunker.chunkChapterBlocks(blocks)
    : chunker.chunkText(text);

  if (!pieces.length) {
    // 内容空了：把旧块清掉，别让召回继续吐已经删掉的正文
    await removeSource({ userId, sourceType, sourceId });
    return;
  }

  const now = new Date().toISOString();
  const prepared = pieces.map((content, chunkNo) => ({
    chunkNo,
    content,
    contentHash: chunker.hashContent(content),
    vikingUri: uris.chunkUri({
      userId,
      workId,
      sourceType,
      sourceId,
      chunkNo,
      conversationId,
    }),
  }));

  // 台账先落 pending。哪怕进程此刻挂了，也能靠台账知道哪些块没进向量。
  const existing = await all(
    `SELECT * FROM memory_chunks
     WHERE source_type = ? AND source_id = ?`,
    [sourceType, sourceId]
  );
  const existingByNo = new Map(existing.map((row) => [row.chunk_no, row]));

  // 先判定哪些块真的需要重新推送。
  //
  // 顺序很重要：如果先把所有块都 upsert 成 pending，再判断"哪些不用推"，
  // 那些被跳过的块就会永远停在 pending——它们没被推送，也没人再推一次。
  //
  // force=true 时全部重推：重建索引的意义就是"重新生成一遍向量"，
  // 而正文没变、URI 没变、状态还是 indexed 的块，增量判定会把它们全跳掉，
  // 一次 embedding 都不会调。换模型、清空 viking 目录之后重建就成了一场空。
  const todo = prepared.filter((item) => {
    if (task.force) return true;
    const previous = existingByNo.get(item.chunkNo);
    if (!previous) return true;
    if (previous.content_hash !== item.contentHash) return true;
    if (previous.viking_uri !== item.vikingUri) return true;
    // 之前没成功过（failed/pending）的要再试
    return previous.status !== 'indexed';
  });
  const todoNos = new Set(todo.map((item) => item.chunkNo));

  await transaction(
    prepared.map((item) => {
      // 没变化的块保持原状态，别把 indexed 打回 pending
      const status = todoNos.has(item.chunkNo) ? 'pending' : 'indexed';
      return {
        sql: `INSERT INTO memory_chunks
                (id, user_id, work_id, source_type, source_id, chunk_no, content, content_hash,
                 viking_uri, status, attempts, last_error, indexed_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
              ON CONFLICT(source_type, source_id, chunk_no) DO UPDATE SET
                content = excluded.content,
                content_hash = excluded.content_hash,
                viking_uri = excluded.viking_uri,
                status = excluded.status,
                attempts = 0,
                last_error = NULL,
                indexed_at = excluded.indexed_at,
                updated_at = excluded.updated_at`,
        params: [
          chunkId(),
          userId,
          workId,
          sourceType,
          sourceId,
          item.chunkNo,
          item.content,
          item.contentHash,
          item.vikingUri,
          status,
          status === 'indexed' ? now : null,
          now,
          now,
        ],
      };
    })
  );

  // 逐块推给 sidecar。只推真正变了的块——省 embedding 调用。
  for (const item of todo) {
    await pushChunk({ ...item, userId, workId, sourceType, sourceId }, maxAttempts);
  }

  // 第一次给这个用户建索引时，把当前模型记进元信息。
  // 之后模型变了就得靠重建来解——那时覆盖它等于把混维度盖掉。
  if (todo.length) await ensureMeta(userId);

  // 新的块建好了，再清掉多余的旧块（作者删了一大段，块数变少了）
  const keepNos = new Set(prepared.map((item) => item.chunkNo));
  const stale = existing.filter((row) => !keepNos.has(row.chunk_no));
  for (const row of stale) {
    await deleteChunkVector(row);
    await run('DELETE FROM memory_chunks WHERE id = ?', [row.id]);
  }
}

/**
 * 把一个块推进向量库，失败则退避重试。
 *
 * @param {object} item
 * @param {number} [maxAttempts] 最多试几次。手动层传 1——作者正等着回话，
 *   让他等三轮退避（最长 30 秒）才看到"失败了"，比立刻报错糟糕得多。
 */
async function pushChunk(item, maxAttempts = MAX_ATTEMPTS) {
  const { userId, workId, sourceType, sourceId, chunkNo, content, vikingUri } = item;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await run(
      `UPDATE memory_chunks SET status = 'indexing', attempts = ?, updated_at = ?
       WHERE source_type = ? AND source_id = ? AND chunk_no = ?`,
      [attempt, new Date().toISOString(), sourceType, sourceId, chunkNo]
    );

    try {
      await client.index(vikingUri, content);
      await run(
        `UPDATE memory_chunks
         SET status = 'indexed', last_error = NULL, indexed_at = ?, updated_at = ?
         WHERE source_type = ? AND source_id = ? AND chunk_no = ?`,
        [new Date().toISOString(), new Date().toISOString(), sourceType, sourceId, chunkNo]
      );
      return;
    } catch (e) {
      const retryable = e.retryable !== false;
      await run(
        `UPDATE memory_chunks
         SET status = 'failed', last_error = ?, updated_at = ?
         WHERE source_type = ? AND source_id = ? AND chunk_no = ?`,
        [String(e.message || e).slice(0, 500), new Date().toISOString(), sourceType, sourceId, chunkNo]
      );
      if (!retryable || attempt >= maxAttempts) return;
      await sleep(backoffMs(attempt));
    }
  }
}

/**
 * 退避时长。
 * @param {number} attempt
 * @returns {number}
 */
function backoffMs(attempt) {
  return Math.min(config.memoryRetryBaseMs * 2 ** (attempt - 1), 30000);
}

/**
 * 睡一会儿。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer.unref) timer.unref();
  });
}

/**
 * 删掉一个块的向量。
 *
 * 删不掉也要继续——台账必须清干净，否则作者重写了这一段，
 * 新旧两块同时存在，召回会拿到旧内容。
 *
 * @param {object} row 台账行
 */
async function deleteChunkVector(row) {
  try {
    await client.remove(row.viking_uri);
  } catch (e) {
    console.error(`记忆向量删除失败：${row.viking_uri}`);
  }
}

/**
 * 删除一个来源的全部记忆。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.sourceType
 * @param {string} params.sourceId
 */
async function removeSource({ userId, sourceType, sourceId }) {
  const rows = await all(
    `SELECT * FROM memory_chunks
     WHERE user_id = ? AND source_type = ? AND source_id = ?`,
    [userId, sourceType, sourceId]
  );
  for (const row of rows) {
    await deleteChunkVector(row);
    await run('DELETE FROM memory_chunks WHERE id = ?', [row.id]);
  }
}

/**
 * 删除一个作品的全部记忆。
 *
 * URI 列表由投递任务时抓好的（见 scheduleRemoveWork）——
 * 作品一删，外键级联就把台账清空了，到时候就找不到该删哪些向量。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.workId
 * @param {string[]} [params.uris]
 */
async function removeWork({ userId, workId, uris: targetUris }) {
  const rows = await all(
    `SELECT * FROM memory_chunks WHERE user_id = ? AND work_id = ?`,
    [userId, workId]
  );
  const list = targetUris && targetUris.length
    ? targetUris
    : rows.map((row) => row.viking_uri);

  for (const uri of list) {
    try {
      await client.remove(uri);
    } catch (e) {
      console.error(`记忆向量删除失败：${uri}`);
    }
  }
  await run('DELETE FROM memory_chunks WHERE user_id = ? AND work_id = ?', [userId, workId]);
}

/**
 * 统计索引状态。
 *
 * @param {string} userId
 * @returns {Promise<{total: number, indexed: number, pending: number, failed: number, works: number}>}
 */
async function stats(userId) {
  const rows = await all(
    `SELECT status, COUNT(*) AS n FROM memory_chunks WHERE user_id = ? GROUP BY status`,
    [userId]
  );
  const counters = { total: 0, indexed: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    counters.total += row.n;
    if (row.status === 'indexed') counters.indexed = row.n;
    else if (row.status === 'pending' || row.status === 'indexing') counters.pending += row.n;
    else if (row.status === 'failed') counters.failed = row.n;
  }

  const works = await get('SELECT COUNT(*) AS n FROM works WHERE user_id = ?', [userId]);
  counters.works = works ? works.n : 0;
  return counters;
}

/**
 * 取某用户全部需要重建的来源。
 *
 * @param {string} userId
 * @param {string} [workId] 只重建某个作品
 * @returns {Promise<Array>}
 */
async function listRebuildTargets(userId, workId) {
  const works = await all(
    `SELECT id FROM works WHERE user_id = ?${workId ? ' AND id = ?' : ''}`,
    workId ? [userId, workId] : [userId]
  );
  const workIds = works.map((w) => w.id);
  if (!workIds.length) return [];

  const placeholders = workIds.map(() => '?').join(',');
  const chapters = await all(
    `SELECT id, work_id FROM chapters WHERE work_id IN (${placeholders})`,
    workIds
  );
  const characters = await all(
    `SELECT id, work_id FROM characters WHERE work_id IN (${placeholders})`,
    workIds
  );
  const settings = await all(
    `SELECT id, work_id FROM settings WHERE work_id IN (${placeholders})`,
    workIds
  );

  return [
    ...chapters.map((row) => ({
      userId,
      workId: row.work_id,
      sourceType: 'chapter',
      sourceId: row.id,
    })),
    ...characters.map((row) => ({
      userId,
      workId: row.work_id,
      sourceType: 'character',
      sourceId: row.id,
    })),
    ...settings.map((row) => ({
      userId,
      workId: row.work_id,
      sourceType: 'setting',
      sourceId: row.id,
    })),
  ];
}

/**
 * 取需要重建的对话记忆块。
 *
 * 对话记忆（原文层 / 事实层 / 手动层）**不在源表里**——
 * 原文是当时那轮对话的快照，事实是抽取出来的，都没法重新算。
 * 但台账里存着当时写入的正文（`memory_chunks.content`），
 * 拿它重新推一遍就行：内容不变，重新向量化。
 *
 * 不重建它们的后果是换模型之后维度对不上：
 * 章节是新维度的向量、对话还是旧维度的，混在一个库里查询，
 * 出来的结果是"看起来正常但全是错的"。
 *
 * @param {string} userId
 * @param {string} [workId]
 * @returns {Promise<Array>}
 */
async function listRebuildConversationChunks(userId, workId) {
  const rows = await all(
    `SELECT user_id, work_id, source_type, source_id, chunk_no, content, viking_uri, status
     FROM memory_chunks
     WHERE user_id = ? AND source_type IN ('conv_raw', 'conv_fact', 'conv_manual')
     ${workId ? 'AND work_id = ?' : ''}`,
    workId ? [userId, workId] : [userId]
  );
  return rows;
}

/**
 * 重建索引。
 *
 * 重建 = 把所有块**重新向量化一遍**，不只是重新排一遍队。
 *
 * 所以这里必须走 force：正文没变、URI 没变、状态还是 indexed 的块，
 * 增量判定会把它们全跳掉——换模型、清空 viking 目录之后重建就成了一场空，
 * 一次 embedding 都不会调。
 *
 * 全部重建成功后刷新索引元信息：元信息记的是"这批向量是用哪个模型建的"，
 * 重建完了就得跟着更新，否则模型不一致的降级永远解不开。
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.workId]
 * @param {boolean} [params.immediate] true 时跳过防抖立刻入队
 * @returns {Promise<{scheduled: number}>}
 */
async function rebuild({ userId, workId, immediate = true }) {
  // 记忆服务关着的时候不排任何任务：scheduleIndex 会直接返回，
  // 计数却已经设下去了，永远归不了零。
  if (!client.isEnabled()) return { scheduled: 0, skipped: '记忆服务未启用' };

  const targets = await listRebuildTargets(userId, workId);
  const convChunks = await listRebuildConversationChunks(userId, workId);
  if (!targets.length && !convChunks.length) return { scheduled: 0 };

  // 记下这一批有多少个任务：全部跑完后刷新索引元信息。
  rebuildPending.set(userId, targets.length + (convChunks.length ? 1 : 0));

  for (const target of targets) {
    scheduleIndex({ ...target, immediate, force: true, rebuildOwner: userId });
  }

  // 对话记忆不走 source-table 那条路：它的正文在台账里，直接重推。
  if (convChunks.length) {
    enqueue({ kind: 'repush', userId, workId, chunks: convChunks, rebuildOwner: userId });
  }

  return { scheduled: targets.length + convChunks.length };
}

/**
 * 重新推送对话记忆块。
 *
 * 内容来自台账（当时写入的正文快照），所以只是重新向量化——
 * 不重新切块，URI 也保持不变。
 *
 * @param {object} task
 */
async function repushConversationChunks(task) {
  const { userId, workId, chunks } = task;

  for (const chunk of chunks) {
    await pushChunk(
      {
        userId,
        workId,
        sourceType: chunk.source_type,
        sourceId: chunk.source_id,
        chunkNo: chunk.chunk_no,
        content: chunk.content,
        vikingUri: chunk.viking_uri,
      },
      MAX_ATTEMPTS
    );
  }
}

/**
 * 重建全部用户的索引。
 *
 * 只有管理员能用。换了 embedding 模型时必须重建全站——
 * 维度对不上的旧向量混在里面，召回结果是「看起来正常但全是错的」。
 *
 * @param {object} [params]
 * @param {boolean} [params.immediate]
 * @returns {Promise<{scheduled: number, users: number}>}
 */
async function rebuildAll({ immediate = true } = {}) {
  const users = await all('SELECT id FROM users');
  let scheduled = 0;
  for (const user of users) {
    const result = await rebuild({ userId: user.id, immediate });
    scheduled += result.scheduled;
  }
  return { scheduled, users: users.length };
}

/**
 * 重建完成后的收尾：刷新索引元信息。
 *
 * 只有当这个用户的全部块都重新索引成功时才更新——
 * 中途失败就还留着旧向量，模型元信息不能提前改成新的。
 *
 * @param {string} userId
 */
async function finishRebuild(userId) {
  const failed = await get(
    `SELECT COUNT(*) AS n FROM memory_chunks
     WHERE user_id = ? AND status != 'indexed'`,
    [userId]
  );
  if (failed && failed.n > 0) return;

  const health = await client.health();
  if (!health) return;

  await writeMeta(userId, {
    embedding_model: health.model,
    embedding_dim: health.dim,
    index_version: String(Date.now()),
  });
}

/**
 * 读索引元信息。
 *
 * 元信息是**按用户**记的，不是全站一份。
 *
 * 索引是每个用户各自一份（台账按 user_id 分，viking 里也按用户前缀隔离），
 * 而"重建索引"这个动作是按用户触发的——作者只重建自己的。
 * 如果元信息是全站一份，A 重建完就把"全站已用新模型"这件事记下了，
 * B 的旧向量会被当成新的放行，混维度脏数据照样流进上下文。
 *
 * @param {string} userId
 * @returns {Promise<{embedding_model: string, embedding_dim: number, index_version: string}>}
 */
async function readMeta(userId) {
  const rows = await all(
    'SELECT key, value FROM memory_index_meta WHERE key IN (?, ?, ?)',
    [
      metaKey(userId, 'embedding_model'),
      metaKey(userId, 'embedding_dim'),
      metaKey(userId, 'index_version'),
    ]
  );
  const meta = {};
  for (const row of rows) meta[row.key] = row.value;
  return {
    embedding_model: meta[metaKey(userId, 'embedding_model')] || '',
    embedding_dim: Number(meta[metaKey(userId, 'embedding_dim')]) || 0,
    index_version: meta[metaKey(userId, 'index_version')] || '',
  };
}

/**
 * 写索引元信息。
 *
 * @param {string} userId
 * @param {object} values
 */
async function writeMeta(userId, values) {
  const now = new Date().toISOString();
  await transaction(
    Object.entries(values).map(([key, value]) => ({
      sql: `INSERT INTO memory_index_meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [metaKey(userId, key), String(value)],
    }))
  );
  return now;
}

/**
 * 首次索引时把当前模型记下来。
 *
 * 只在还没有记录时写：已有记录说明这台 sidecar 的模型变过了，
 * 那时要靠重建来解，写新值等于把"混维度"这件事盖掉。
 *
 * @param {string} userId
 */
async function ensureMeta(userId) {
  const meta = await readMeta(userId);
  if (meta.embedding_model) return;

  const health = await client.health();
  if (!health) return;

  await writeMeta(userId, {
    embedding_model: health.model,
    embedding_dim: health.dim,
    index_version: String(Date.now()),
  });
}

/**
 * 校验当前 sidecar 的模型与该用户台账里记的是否一致。
 *
 * 换 embedding 模型后旧向量维度对不上，混用会得到"看起来正常但全是错的"结果。
 * 这种错必须显式拦住，而不是悄悄降级。
 *
 * @param {string} userId
 * @returns {Promise<{ok: boolean, reason: string, model: string, dim: number}>}
 */
async function checkMetaConsistency(userId) {
  const health = await client.health();
  if (!health) {
    return { ok: true, reason: '记忆服务未运行，跳过校验', model: '', dim: 0 };
  }

  const meta = await readMeta(userId);
  if (!meta.embedding_model) {
    await writeMeta(userId, {
      embedding_model: health.model,
      embedding_dim: health.dim,
      index_version: String(Date.now()),
    });
    return { ok: true, reason: '首次记录索引元信息', model: health.model, dim: health.dim };
  }

  if (meta.embedding_model !== health.model || meta.embedding_dim !== health.dim) {
    return {
      ok: false,
      reason: `记忆索引使用的模型（${meta.embedding_model}/${meta.embedding_dim}）与当前记忆服务（${health.model}/${health.dim}）不一致，需要重建索引`,
      model: health.model,
      dim: health.dim,
    };
  }

  return { ok: true, reason: '', model: health.model, dim: health.dim };
}

module.exports = {
  DEBOUNCE_MS,
  MAX_ATTEMPTS,
  scheduleIndex,
  scheduleRemove,
  indexSource,
  removeSource,
  rebuild,
  rebuildAll,
  listRebuildTargets,
  listRebuildConversationChunks,
  stats,
  readMeta,
  writeMeta,
  checkMetaConsistency,
  whenIdle,
  isIdle,
};
