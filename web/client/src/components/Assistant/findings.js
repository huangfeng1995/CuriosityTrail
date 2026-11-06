/**
 * 审稿意见的锚点匹配（纯函数）。
 *
 * 规则（2026-11-03 与产品确认）：
 * ① blockId 命中且该块确实包含 quote → 用这个块；
 * ② 否则按 quote 归一化后在全文找，唯一命中才用；
 * ③ 命中多个块 → 视为未定位（宁可标成全章建议，不许乱挂）；
 * ④ 零命中 → 未定位。
 *
 * 归一化：去掉全部空白、全角标点转半角、省略号统一为「…」。
 * 以省略号结尾的截断片段按「…」之前的唯一前缀匹配。
 */

export const MIN_QUOTE_LENGTH = 6;

const PUNCTUATION = {
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '、': ',',
  '—': '-',
  '–': '-',
  '～': '~',
  '《': '<',
  '》': '>',
};

export const REASON_LABEL = {
  ambiguous: '多处命中',
  not_found: '未找到',
  changed: '原文已改动',
  invalid: '片段过短',
};

/** 归一化：空白、全半角标点、省略号。 */
export function normalizeQuote(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[…⋯]{2,}/g, '…')
    .replace(/\.{3,}/g, '…')
    .replace(/[，。！？；：（）【】「」『』“”‘’、—–～《》]/g, (ch) => PUNCTUATION[ch] || ch);
}

/** 把 quote 转成用于子串匹配的 needle；截断片段去掉结尾的「…」。 */
function toNeedle(quote) {
  const normalized = normalizeQuote(quote);
  return normalized.endsWith('…') ? normalized.slice(0, -1) : normalized;
}

function hitsOf(blocks, needle) {
  const hits = [];
  blocks.forEach((block, index) => {
    if (!block || !block.id) return;
    if (normalizeQuote(block.content).includes(needle)) hits.push(index);
  });
  return hits;
}

/**
 * 把一条消息里的 findings 落到当前正文的块上。
 *
 * blocks 是当前编辑中的块；每次渲染实时算，不落库、不持久化锚点。
 * 找不到的条目保留原始 quote，前端标「全章建议」。
 */
export function locateFindings(blocks, findings) {
  const list = Array.isArray(blocks) ? blocks : [];
  const rawFindings = Array.isArray(findings) ? findings : [];

  return rawFindings.map((raw, i) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const id = String(item.id || `f${i + 1}`);
    const quote = String(item.quote || '');
    const text = String(item.text || '').trim();
    const needle = toNeedle(quote);

    const base = { id, quote, text };
    if (!text || !quote || needle.length < MIN_QUOTE_LENGTH) {
      return { ...base, status: 'unlocated', reason: 'invalid' };
    }

    // ① 模型自报的 blockId：块必须存在，且块内确实能匹配到 quote
    const claimedId = String(item.blockId || '').trim();
    const claimedIndex = claimedId ? list.findIndex((b) => b && b.id === claimedId) : -1;
    if (claimedIndex >= 0 && normalizeQuote(list[claimedIndex].content).includes(needle)) {
      return {
        ...base,
        status: 'located',
        blockId: list[claimedIndex].id,
        index: claimedIndex,
      };
    }

    // ② 全文唯一命中
    const hits = hitsOf(list, needle);
    if (hits.length === 1) {
      return {
        ...base,
        status: 'located',
        blockId: list[hits[0]].id,
        index: hits[0],
      };
    }

    // ③ 多处命中 → 宁可不挂
    if (hits.length > 1) {
      return { ...base, status: 'unlocated', reason: 'ambiguous' };
    }

    // ④ 零命中：模型指过某个块，说明原文大概率被改过
    return {
      ...base,
      status: 'unlocated',
      reason: claimedIndex >= 0 ? 'changed' : 'not_found',
    };
  });
}

/**
 * 收集当前对话里所有可处理的审稿意见，并编号。
 *
 * 只收 roleKey='critic' 且 action='comment' 的消息；其他角色照旧走纯文本。
 * 编号跨消息连续，侧栏与正文沟槽用同一个数字。
 */
export function collectCriticFindings(messages, blocks) {
  const out = [];
  let marker = 0;

  (Array.isArray(messages) ? messages : []).forEach((msg) => {
    if (!msg || msg.role !== 'assistant' || msg.roleKey !== 'critic') return;
    if (msg.action !== 'comment') return;
    if (!Array.isArray(msg.findings) || !msg.findings.length) return;

    locateFindings(blocks, msg.findings).forEach((finding, i) => {
      marker += 1;
      out.push({
        ...finding,
        key: `${msg.id}:${finding.id}:${i}`,
        messageId: msg.id,
        marker,
      });
    });
  });

  return out;
}

/**
 * 采纳一条意见时发给写手的指令。
 *
 * 复用现有 /chat，不新造通道；服务端不需要解析这段文本。
 */
export function buildAdoptPrompt(finding) {
  const text = String(finding?.text || '').trim();
  const quote = String(finding?.quote || '').trim();
  return `请按这条审稿意见修改正文：\n意见：${text}\n原文片段「${quote}」\n只改这一段，其余保持不动。`;
}

/** 去重键：相同原文片段 + 相同意见文本只算一条。 */
function dedupeKey(finding) {
  return `${String(finding?.quote || '').trim()}::${String(finding?.text || '').trim()}`;
}

/**
 * 按勾选顺序去重。
 *
 * 不合并同一块上的多条意见：它们可能说的是两件事，
 * 合并成一句反而让写手抓不住重点。
 */
export function dedupeFindings(findings) {
  const seen = new Set();
  const out = [];

  (Array.isArray(findings) ? findings : []).forEach((finding) => {
    if (!finding) return;
    const key = dedupeKey(finding);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(finding);
  });

  return out;
}

/**
 * 批量采纳时发给写手的指令。
 *
 * 仍然只发一次 /chat：多条意见按勾选顺序逐条列出，
 * 未定位的条目明确标成「全章级要求」，避免写手把它当成某一段的局部改写。
 */
export function buildBatchAdoptPrompt(findings) {
  const list = dedupeFindings(findings);
  const lines = ['请按下列审稿意见修改正文，一次改完：'];

  list.forEach((finding, i) => {
    const text = String(finding.text || '').trim();
    const quote = String(finding.quote || '').trim();
    const located = finding.status === 'located';

    lines.push(`${i + 1}. 意见：${text}`);
    if (!located) {
      lines.push('   （全章级要求，无具体段落锚点）');
    }
    if (quote) {
      lines.push(`   原文片段「${quote}」`);
    }
  });

  lines.push(
    '只改这几处，其余段落保持不动；多条意见若相互冲突，以不破坏前文事实为先。'
  );
  return lines.join('\n');
}

/**
 * 把同一块上的多条审稿意见合并成一条 inline 指令。
 *
 * 不合并意见文本本身（它们可能说的是两件事），只是按序编号，
 * 让写手一次看完这块上的所有要求。
 */
function mergeBlockInstruction(findings) {
  return findings
    .map((f, i) => `${i + 1}. ${String(f.text || '').trim()}`)
    .join('\n');
}

/**
 * 执行一次批量采纳。
 *
 * 已定位的意见（status==='located'，有 blockId）走 /api/ai/inline：
 * 显式 selection + 短上下文（只带前后块），不会被聊天历史撑爆上下文窗口，
 * 也不会被 agent loop 的技能清单干扰。未定位的全章级建议仍走 /chat。
 *
 * 抽出来是为了能单测：sendFn / inlineFn 都由调用方传入。
 * 返回 ok=false 时调用方不得标记已采纳。
 *
 * @param {(prompt: string, options: Object) => Promise<boolean>} sendFn  chat 通道
 * @param {Array} findings
 * @param {Object} [options]
 * @param {Array}  [options.blocks]       当前章节的块（inline 通道需要）
 * @param {string} [options.workId]
 * @param {string} [options.chapterId]
 * @param {(params: Object) => Promise<Object>} [options.inlineFn]  inline 通道调用函数
 * @returns {Promise<{ok: boolean, sent: boolean, keys: Array<string>, blockUpdates: Array}>}
 */
export async function sendAdoptionBatch(sendFn, findings, options = {}) {
  const list = dedupeFindings(findings);
  if (!list.length) return { ok: false, sent: false, keys: [], blockUpdates: [] };

  const { blocks = [], workId, chapterId, inlineFn } = options;
  const allKeys = list.map((f) => f.key);

  // 未提供 inlineFn 时退回旧路径（兼容旧调用方与单测）。
  if (!inlineFn) {
    const ok = await sendFn(buildBatchAdoptPrompt(list), { roleKey: 'writer' });
    return {
      ok: ok === true,
      sent: true,
      keys: allKeys,
      blockUpdates: [],
    };
  }

  const located = list.filter((f) => f.status === 'located' && f.blockId);
  const unlocated = list.filter((f) => !(f.status === 'located' && f.blockId));

  let ok = true;
  let sent = false;
  const blockUpdates = [];

  // 已定位的意见：按块分组，每块调一次 inline（同一块多条意见合并指令）。
  if (located.length) {
    const byBlock = new Map();
    for (const f of located) {
      if (!byBlock.has(f.blockId)) byBlock.set(f.blockId, []);
      byBlock.get(f.blockId).push(f);
    }

    for (const [blockId, blockFindings] of byBlock) {
      const block = blocks.find((b) => b.id === blockId);
      if (!block) {
        ok = false;
        continue;
      }

      try {
        const res = await inlineFn({
          action: 'rewrite',
          selection: block.content,
          blockId,
          instruction: `按审稿意见修改：\n${mergeBlockInstruction(blockFindings)}`,
          roleKey: 'writer',
          workId,
          chapterId,
          blocks,
        });

        if (res && (res.action === 'replace' || res.action === 'append') && res.content) {
          blockUpdates.push({ blockId, content: res.content, action: res.action });
          sent = true;
        } else {
          ok = false;
        }
      } catch (e) {
        ok = false;
      }
    }
  }

  // 未定位的全章级建议：仍走 /chat。
  if (unlocated.length) {
    const chatOk = await sendFn(buildBatchAdoptPrompt(unlocated), { roleKey: 'writer' });
    if (chatOk !== true) ok = false;
    sent = true;
  }

  return {
    ok,
    sent,
    keys: allKeys,
    blockUpdates,
  };
}
