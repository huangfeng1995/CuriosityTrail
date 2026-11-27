'use strict';

/**
 * 形态修补任务的落库与注册表。
 *
 * 后台任务不能再用 /chat 的 SSE 连接（done 之后连接已经关闭），
 * 所以状态全在 shape_repairs 表里；前端按章轮询 GET /api/ai/shape-repairs/:chapterId。
 *
 * 两处去重，防止同一章开两个任务：
 *   1. 数据库：idx_shape_repairs_active 部分唯一索引（pending/running）；
 *   2. 进程内：active Map（chapterId → 当前任务），挡住并发启动。
 *
 * 取消只 abort 当前任务；任务结束后如果行状态已被改成 cancelled，
 * 不再用结果覆盖——作者已经明确不要这版了。
 */

const { get, run } = require('../../database');
const shapeRepair = require('./shapeRepair');

/** chapterId → { id, controller } */
const active = new Map();

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

/** 数据库行 → 前端/消息 payload 共用的形态。 */
function payloadOf(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    shortfall: parseJson(row.shortfall, []),
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    // 只有修订成功且整章不低于 85% 才有内容；失败时保留原稿。
    revisedContent: row.status === 'done' ? row.revised_content || '' : '',
    applied: Boolean(row.applied),
    dismissed: Boolean(row.dismissed),
    rounds: Number(row.rounds) || 0,
    calls: Number(row.calls) || 0,
    durationMs: Number(row.duration_ms) || 0,
    note: row.note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 把修补状态镜像到消息 payload。
 *
 * 表是权威数据；payload 只是让历史消息重载时不用再查一次就能显示状态。
 * 修订正文也一并镜像（约一章大小），换来刷新后直接能对照替换。
 */
async function syncMessage(messageId, repair) {
  if (!messageId) return;
  const row = await get('SELECT payload FROM messages WHERE id = ?', [messageId]);
  if (!row) return;
  const payload = parseJson(row.payload, {}) || {};
  payload.shapeRepair = repair;
  await run('UPDATE messages SET payload = ? WHERE id = ?', [JSON.stringify(payload), messageId]);
}

async function readRow(id) {
  return get('SELECT * FROM shape_repairs WHERE id = ?', [id]);
}

async function failRow(id, note, extra = {}) {
  const existing = await readRow(id);
  // 作者已经取消：任何失败都不该把 cancelled 覆盖掉。
  if (existing && existing.status === 'cancelled') return existing;
  const now = new Date().toISOString();
  await run(
    `UPDATE shape_repairs
        SET status = 'failed', note = ?, rounds = ?, calls = ?, duration_ms = ?, updated_at = ?
      WHERE id = ?`,
    [
      note,
      Number(extra.rounds) || 0,
      Number(extra.calls) || 0,
      Number(extra.durationMs) || 0,
      now,
      id,
    ]
  );
  const row = await readRow(id);
  if (row) await syncMessage(row.message_id, payloadOf(row));
  return row;
}

/**
 * 启动一次后台修补。
 *
 * 调用方不 await：正文已经交付，修补在后台跑，结果只写该章消息。
 * 同章已有活动任务时不再启动，并把新行标成 failed 说明原因。
 *
 * @param {Object} options
 * @param {string} options.repairId
 * @param {string} options.chapterId
 * @param {string} options.messageId
 * @param {string} options.body 交付时的原稿
 * @param {Object} options.plan 节拍表
 * @param {Array} options.blockers 不达标项（不含 count）
 * @param {Array} options.namedCast
 * @param {Object} options.provider
 * @param {Object} options.role
 * @param {string} options.name provider 名
 * @param {string} [options.traceId]
 * @returns {{started: boolean, id: string}}
 */
function startRepairTask({
  repairId,
  chapterId,
  messageId,
  body,
  plan,
  blockers,
  namedCast,
  provider,
  role,
  name,
  traceId = '',
}) {
  if (!repairId || active.has(chapterId)) {
    failRow(repairId, '同章已有修订任务，本次未启动').catch(() => {});
    return { started: false, id: repairId };
  }

  const controller = new AbortController();
  active.set(chapterId, { id: repairId, controller });
  const startedAt = Date.now();

  const chat = async ({ system, user, signal }) => {
    const out = await provider.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: role && role.temperature,
      model: role && role.model && name === 'deepseek' ? role.model : undefined,
      thinking:
        role && role.thinking !== null && role.thinking !== undefined
          ? role.thinking
            ? 'enabled'
            : 'disabled'
          : undefined,
      jsonOutput: true,
      signal,
    });
    return { content: (out && out.content) || '', finishReason: (out && out.finishReason) || '' };
  };

  setImmediate(async () => {
    let result = null;
    let error = null;
    try {
      await run(
        "UPDATE shape_repairs SET status = 'running', updated_at = ? WHERE id = ?",
        [new Date().toISOString(), repairId]
      );
      const running = await readRow(repairId);
      if (running) await syncMessage(running.message_id, payloadOf(running));

      result = await shapeRepair.runRepair({
        body,
        plan,
        blockers,
        namedCast,
        chat,
        signal: controller.signal,
        now: Date.now,
      });
    } catch (err) {
      error = err;
    } finally {
      active.delete(chapterId);
    }

    const now = new Date().toISOString();
    try {
      const row = await readRow(repairId);
      if (!row) return;
      // 作者已经点过取消：结果一律不覆盖，正文保持原稿。
      if (row.status === 'cancelled') return;

      if (error) {
        await failRow(repairId, `修订失败：${error.message || error}`, {
          durationMs: Date.now() - startedAt,
        });
        log({ event: 'ai_shape_repair_done', traceId, repairId, chapterId, ok: false, error: String(error.message || error) });
        return;
      }

      if (result && result.ok) {
        await run(
          `UPDATE shape_repairs
              SET status = 'done', revised_content = ?, before_json = ?, after_json = ?,
                  rounds = ?, calls = ?, duration_ms = ?, note = '', updated_at = ?
            WHERE id = ?`,
          [
            result.content,
            JSON.stringify(result.before || {}),
            JSON.stringify(result.after || {}),
            result.rounds || 0,
            result.calls || 0,
            result.durationMs || 0,
            now,
            repairId,
          ]
        );
      } else {
        await run(
          `UPDATE shape_repairs
              SET status = 'failed', revised_content = NULL, before_json = ?, after_json = ?,
                  rounds = ?, calls = ?, duration_ms = ?, note = ?, updated_at = ?
            WHERE id = ?`,
          [
            JSON.stringify((result && result.before) || {}),
            JSON.stringify((result && result.after) || {}),
            (result && result.rounds) || 0,
            (result && result.calls) || 0,
            (result && result.durationMs) || 0,
            (result && result.note) || '已尝试修补，仍有不达标项',
            now,
            repairId,
          ]
        );
      }

      const done = await readRow(repairId);
      if (done) await syncMessage(done.message_id, payloadOf(done));
      log({
        event: 'ai_shape_repair_done',
        traceId,
        repairId,
        chapterId,
        ok: Boolean(result && result.ok),
        rounds: (result && result.rounds) || 0,
        calls: (result && result.calls) || 0,
        durationMs: (result && result.durationMs) || 0,
        before: (result && result.before) || null,
        after: (result && result.after) || null,
        changes: (result && result.changes) || [],
        note: (result && result.note) || '',
      });
    } catch (err) {
      console.error('[shape-repair] 结果落库失败:', err.message || err);
    }
  });

  return { started: true, id: repairId };
}

function log(payload) {
  try {
    console.log(JSON.stringify(payload));
  } catch (e) {
    // 日志失败不能反过来影响任务收尾
  }
}

/** 取消：abort 当前任务，并把状态立刻写成 cancelled。 */
async function cancelRepairTask(id, userId) {
  const row = await get('SELECT * FROM shape_repairs WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  const entry = active.get(row.chapter_id);
  if (entry && entry.id === id) entry.controller.abort();

  await run(
    "UPDATE shape_repairs SET status = 'cancelled', note = ?, updated_at = ? WHERE id = ?",
    ['作者已取消修补，正文保持原稿', new Date().toISOString(), id]
  );
  const updated = await readRow(id);
  const repair = payloadOf(updated);
  await syncMessage(row.message_id, repair);
  return repair;
}

/** 某章最近一次修补（前端轮询与刷新恢复都读它）。 */
async function getRepairByChapter(chapterId, userId) {
  let row = await get(
    `SELECT sr.* FROM shape_repairs sr
       JOIN works w ON w.id = sr.work_id
      WHERE sr.chapter_id = ? AND sr.user_id = ? AND w.user_id = ?
      ORDER BY sr.created_at DESC, sr.rowid DESC
      LIMIT 1`,
    [chapterId, userId, userId]
  );

  // 服务重启或进程被杀后，行可能永远停在 pending/running。
  // 超过总预算 + 1 分钟仍没有进程内的活动任务，就落成 failed，
  // 让作者看到「未完成，正文保持原稿」，而不是一直转圈。
  if (
    row &&
    ['pending', 'running'].includes(row.status) &&
    !active.has(row.chapter_id)
  ) {
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (Number.isFinite(age) && age > shapeRepair.REPAIR_TOTAL_MS + 60000) {
      await run(
        "UPDATE shape_repairs SET status = 'failed', note = ?, updated_at = ? WHERE id = ?",
        ['修补中断（服务重启或超时），正文保持原稿', new Date().toISOString(), row.id]
      );
      row = await readRow(row.id);
      if (row) await syncMessage(row.message_id, payloadOf(row));
    }
  }

  return payloadOf(row);
}

async function markFlag(id, userId, field) {
  const row = await get('SELECT * FROM shape_repairs WHERE id = ? AND user_id = ?', [id, userId]);
  if (!row) return null;
  if (field === 'applied' && row.status !== 'done') return payloadOf(row);
  await run(`UPDATE shape_repairs SET ${field} = 1, updated_at = ? WHERE id = ?`, [
    new Date().toISOString(),
    id,
  ]);
  const updated = await readRow(id);
  const repair = payloadOf(updated);
  await syncMessage(row.message_id, repair);
  return repair;
}

function markApplied(id, userId) {
  return markFlag(id, userId, 'applied');
}

function markDismissed(id, userId) {
  return markFlag(id, userId, 'dismissed');
}

module.exports = {
  payloadOf,
  startRepairTask,
  cancelRepairTask,
  getRepairByChapter,
  markApplied,
  markDismissed,
  activeChapters: () => [...active.keys()],
  // 单元测试用：重置注册表，避免用例之间互相影响
  _resetActive: () => active.clear(),
};
