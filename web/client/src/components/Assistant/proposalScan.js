import api from '../../api/client.js';

/**
 * 正文保存后的增量卡片识别。
 *
 * 只做一件事：拿「这次保存的 blocks」和「上次已经扫过的基线」做差，
 * 把改动过的段落攒起来，debounce 一会儿后合并成一次请求发给识别接口。
 *
 * 三条底线：
 *   · 只在保存成功后触发，不在保存路径里同步跑；
 *   · 只扫改动的 block，不清空重扫全章——自动保存很频繁，全章扫描会把
 *     识别成本翻几十倍，还会把已经丢弃过的提案反复识别出来；
 *   · 识别失败静默：不重试、不报错，下一次保存时自然再试。
 */

/** 合并窗口：连续输入时等作者停手 1.5s 再发。 */
const DEBOUNCE_MS = 1500;
/** 单次识别的正文字数上限（与 recognizer 的 4000 上限留一点余量）。 */
const BATCH_CHARS = 3500;
/** 单次请求最多带多少个 block。 */
const BATCH_BLOCKS = 20;
/** 低于这个长度的段落不值得识别，直接记为已扫。 */
const MIN_CHARS = 30;

/**
 * 当前章节的扫描状态。
 *
 * scanned: blockId → 上次送去识别的文字。保存后内容不变就不扫。
 * texts:   blockId → 最新文字。flush 时从这里取，避免拿到过期内容。
 * pending: 本次改动过、还没送出去的 blockId。
 */
// 章节切换时递增：在途请求回来后要能和「现在是哪一章」对上。
let generationSeq = 0;

/** originRef → 这一轮采纳触发的识别请求（可能多个 block）。 */
const adoptionsInFlight = new Map();

let state = createState();

function createState() {
  return {
    workId: '',
    chapterId: '',
    generation: ++generationSeq,
    scanned: new Map(),
    texts: new Map(),
    pending: new Set(),
    // 正在走「采纳即识别」的 block 及其文字：识别通常要 3–8s，
    // 期间的自动保存不能把它再当成改动送一遍（会重复计费，且丢了 originRef）。
    adopting: new Map(),
    timer: null,
    inFlight: false,
  };
}

function clearTimer() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function notifyChanged(count) {
  if (!count) return;
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('ct:proposals-changed', { detail: { count } })
  );
}

/**
 * 载入章节时重置基线。
 *
 * 必须把刚拉下来的正文整章记为「已扫」：否则第一次自动保存会把它当成
 * 新内容全章识别一遍——这正是要避免的事。
 */
export function resetScanBaseline({ workId, chapterId, blocks }) {
  clearTimer();
  state = createState();
  state.workId = workId || '';
  state.chapterId = chapterId || '';
  for (const block of blocks || []) {
    const text = String(block.content || '');
    state.scanned.set(block.id, text);
    state.texts.set(block.id, text);
  }
}

/** 手动把某个 block 记为已扫（采纳后调用，避免保存时重复识别同一段）。 */
export function markBlockScanned(chapterId, blockId, text) {
  if (!chapterId || state.chapterId !== chapterId || !blockId) return;
  state.scanned.set(blockId, String(text || ''));
  state.texts.set(blockId, String(text || ''));
  state.pending.delete(blockId);
  // 采纳识别还没回来时撤销：等它回来也不该把这段再算成「已扫的新文本」
  state.adopting.delete(blockId);
}

/** 撤销写入后把 block 的基线退回原样；整块被删时直接丢掉记录。 */
export function dropBlockScan(chapterId, blockId) {
  if (!chapterId || state.chapterId !== chapterId || !blockId) return;
  state.scanned.delete(blockId);
  state.texts.delete(blockId);
  state.pending.delete(blockId);
  state.adopting.delete(blockId);
}

/**
 * 保存成功后调用：找出本次改动的 block，攒进待扫队列。
 *
 * @param {Object} params
 * @param {string} params.workId
 * @param {string} params.chapterId
 * @param {Array<{id: string, content: string}>} params.blocks 本次保存的完整快照
 */
export function scheduleBlockScan({ workId, chapterId, blocks }) {
  if (!workId || !chapterId) return;

  // 基线还没建（例如章节没走 loadChapter）：宁可这次不扫，
  // 也不能把整章当新内容一次性送出去。
  if (state.chapterId !== chapterId) return;

  for (const block of blocks || []) {
    const text = String(block.content || '');
    state.texts.set(block.id, text);

    const before = state.scanned.get(block.id);
    if (before !== undefined && before === text) continue;

    // 这段正在走采纳识别：等它回来自己会写基线，这里不重复送
    if (state.adopting.get(block.id) === text) continue;

    if (text.trim().length < MIN_CHARS) {
      // 太短不值得识别，直接记成已扫，免得每次保存都拿来比一遍
      state.scanned.set(block.id, text);
      continue;
    }

    state.pending.add(block.id);
  }

  if (!state.pending.size) return;

  clearTimer();
  state.timer = setTimeout(flush, DEBOUNCE_MS);
}

/** 按字数和条数切批，一次请求最多 BATCH_CHARS 字 / BATCH_BLOCKS 条。 */
function buildBatches(ids) {
  const batches = [];
  let current = [];
  let chars = 0;

  for (const id of ids) {
    const text = state.texts.get(id) || '';
    if (!text.trim()) continue;

    if (
      current.length &&
      (chars + text.length > BATCH_CHARS || current.length >= BATCH_BLOCKS)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push({ blockId: id, text });
    chars += text.length;
  }

  if (current.length) batches.push(current);
  return batches;
}

async function flush() {
  state.timer = null;
  if (state.inFlight) return;

  const ids = [...state.pending];
  if (!ids.length) return;

  // 先取出待扫 id；发送期间又改动的 block 会重新落回 pending，
  // 不会被这批一起吞掉。
  for (const id of ids) state.pending.delete(id);

  const batches = buildBatches(ids);
  if (!batches.length) return;

  const gen = state.generation;
  const workId = state.workId;
  const chapterId = state.chapterId;
  state.inFlight = true;

  let added = 0;
  try {
    for (const batch of batches) {
      if (gen !== state.generation) return;
      const res = await api.post('/card-proposals/scan', {
        workId,
        chapterId,
        originRef: '',
        blocks: batch,
      });
      if (gen !== state.generation) return;

      // 只有请求成功才把基线推进；失败就留着，下次保存自然重试
      for (const seg of batch) state.scanned.set(seg.blockId, seg.text);
      added += res.data?.proposals?.length || 0;
    }
  } catch (e) {
    // 识别是写作的附带能力：网络失败不打扰作者
  } finally {
    if (gen === state.generation) {
      state.inFlight = false;
      notifyChanged(added);
      if (state.pending.size) {
        clearTimer();
        state.timer = setTimeout(flush, 500);
      }
    }
  }
}

/**
 * 采纳 AI 正文后立刻识别这一段。
 *
 * 与保存扫描走同一个接口；originRef 记下是哪条消息采纳的，
 * 撤销时按它把这一轮还没确认的提案一起作废。
 *
 * @returns {Promise<Object|null>} 接口数据；失败返回 null（不抛错）
 */
export function scanAdoptedBlock(params) {
  const promise = runAdoptionScan(params).finally(() => {
    const set = adoptionsInFlight.get(params?.originRef);
    if (set) {
      set.delete(promise);
      if (!set.size) adoptionsInFlight.delete(params.originRef);
    }
  });

  // 记下这一轮采纳的识别请求：撤销时如果识别还没回来，要等它回来再作废，
  // 否则会出现「作废了 0 条，几秒后提案又冒出来」。
  if (params?.originRef) {
    if (!adoptionsInFlight.has(params.originRef)) {
      adoptionsInFlight.set(params.originRef, new Set());
    }
    adoptionsInFlight.get(params.originRef).add(promise);
  }

  return promise;
}

/** 撤销采纳：等这一轮的识别落地后，把它产生的 pending 提案一并作废。 */
export async function dismissProposalsFrom(originRef) {
  if (!originRef) return { dismissed: 0, confirmed: 0 };

  const waiting = [...(adoptionsInFlight.get(originRef) || [])];
  await Promise.allSettled(waiting);

  try {
    const res = await api.post('/card-proposals/dismiss-source', { originRef });
    const data = res.data || { dismissed: 0, confirmed: 0 };
    // 作废是服务端完成的；不广播的话左栏角标和面板会一直挂着已经不存在的提案
    if (data.dismissed) notifyChanged(data.dismissed);
    return data;
  } catch (e) {
    return { dismissed: 0, confirmed: 0 };
  }
}

async function runAdoptionScan({
  workId,
  chapterId,
  blockId,
  text,
  originRef,
}) {
  if (!workId || !chapterId || !blockId) return null;

  const ownChapter = state.chapterId === chapterId;
  if (ownChapter) state.adopting.set(blockId, String(text || ''));

  try {
    const res = await api.post('/card-proposals/scan', {
      workId,
      chapterId,
      blockId,
      text,
      originRef: originRef || '',
    });

    // 这段已经识别过，保存时不必再扫一次
    if (state.chapterId === chapterId) {
      state.scanned.set(blockId, String(text || ''));
      state.texts.set(blockId, String(text || ''));
      state.adopting.delete(blockId);
    }

    const count = res.data?.proposals?.length || 0;
    notifyChanged(count);
    return res.data;
  } catch (e) {
    if (state.chapterId === chapterId) {
      // 失败就放开标记；这段文字仍是当前正文的话，补进保存扫描的队列
      state.adopting.delete(blockId);
      if (state.texts.get(blockId) === text) {
        state.pending.add(blockId);
        clearTimer();
        state.timer = setTimeout(flush, DEBOUNCE_MS);
      }
    }
    return null;
  }
}

/** 复位模块状态（测试用）。 */
export function resetProposalScan() {
  clearTimer();
  state = createState();
}
