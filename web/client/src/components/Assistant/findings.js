/**
 * 审稿意见的锚点匹配（纯函数）。
 *
 * 规则（2026-11-03 与产品确认，2026-11-12 补句级区间）：
 * ① blockId 命中且该块确实包含 quote → 用这个块，并算出段内字符区间；
 * ② 否则按 quote 归一化后在全文找，唯一命中才用，同样算字符区间；
 * ③ 命中多个块 → 视为未定位（宁可标成全章建议，不许乱挂）；
 * ④ 零命中但模型指过具体块 → 退化为整段级意见（块内整段高亮）；
 *    连块都没指过 → 未定位。
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

/**
 * 归一化的同时保留「归一化字符 → 原文下标」的映射。
 *
 * 只在归一化后的文本里能判断「有没有」，但正文高亮要的是原文里的
 * 字符区间。没有这张映射就只能整段标黄——这正是作者反馈「看不出
 * 对应哪一句」的根因。
 */
function normalizeWithMap(text) {
  const src = String(text || '');
  let normalized = '';
  const starts = [];
  const ends = [];

  const push = (ch, start, end) => {
    normalized += ch;
    starts.push(start);
    ends.push(end);
  };

  // 归一化时空白会先被整体删掉，所以「… …」「. . .」这类被空格隔开的
  // 连写，在正则眼里是连在一起的。这里扫描时也要跨过空白，否则
  // 映射出来的文本和 normalizeQuote 不一致，区间就会漏算。
  const scanRun = (from, isMember) => {
    let j = from;
    let count = 0;
    let end = from;
    const indices = [];
    while (j < src.length) {
      const c = src[j];
      if (isMember(c)) {
        count += 1;
        end = j + 1;
        indices.push(j);
        j += 1;
        continue;
      }
      if (/\s/.test(c)) {
        j += 1;
        continue;
      }
      break;
    }
    return { count, end, next: j, indices };
  };

  for (let i = 0; i < src.length; ) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    // 省略号：两个及以上的 …/⋯ 归一成一个「…」，区间映射到整段原字符。
    if (ch === '…' || ch === '⋯') {
      const run = scanRun(i, (c) => c === '…' || c === '⋯');
      if (run.count >= 2) {
        push('…', i, run.end);
      } else {
        push(ch, i, i + 1);
      }
      i = run.next;
      continue;
    }

    // 三个及以上英文句点同样归一成「…」。
    if (ch === '.') {
      const run = scanRun(i, (c) => c === '.');
      if (run.count >= 3) {
        push('…', i, run.end);
      } else {
        run.indices.forEach((index) => push('.', index, index + 1));
      }
      i = run.next;
      continue;
    }

    push(PUNCTUATION[ch] || ch, i, i + 1);
    i += 1;
  }

  return { text: normalized, starts, ends };
}

/** 在块内定位 quote 的原始字符区间；定位不到返回 null。 */
export function findQuoteRange(content, quote) {
  const needle = toNeedle(quote);
  if (!needle) return null;

  const hay = normalizeWithMap(content);
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;

  return {
    start: hay.starts[at],
    end: hay.ends[at + needle.length - 1],
  };
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
 *
 * 定位精度分三级：
 *   quote —— 块内找到原文，range 给出段内字符区间，正文只标这一句；
 *   block —— 模型指过具体块，但原文对不上（被改过/片段过短），
 *            退化为整段标黄，前端明确标「整段级意见」；
 *   unlocated —— 连块都指不出来，只能作为全章建议留在面板。
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
    const claimedId = String(item.blockId || '').trim();
    const claimedIndex = claimedId ? list.findIndex((b) => b && b.id === claimedId) : -1;
    const degradeToBlock = (reason) => {
      if (!text || claimedIndex < 0) {
        return { ...base, status: 'unlocated', reason };
      }
      return {
        ...base,
        status: 'located',
        precision: 'block',
        blockId: list[claimedIndex].id,
        index: claimedIndex,
        reason,
      };
    };

    // 没有意见正文，或原文片段太短/缺失：定位不了句子。
    if (!text) return degradeToBlock('invalid');
    if (!quote || needle.length < MIN_QUOTE_LENGTH) return degradeToBlock('invalid');

    // ① 模型自报的 blockId 优先，但块内必须真的能对上原文。
    if (claimedIndex >= 0) {
      const range = findQuoteRange(list[claimedIndex].content, quote);
      if (range) {
        return {
          ...base,
          status: 'located',
          precision: 'quote',
          blockId: list[claimedIndex].id,
          index: claimedIndex,
          range,
        };
      }
    }

    // ② 全文唯一命中：模型报错块号时以原文为准。
    const hits = hitsOf(list, needle);
    if (hits.length === 1) {
      const range = findQuoteRange(list[hits[0]].content, quote);
      if (range) {
        return {
          ...base,
          status: 'located',
          precision: 'quote',
          blockId: list[hits[0]].id,
          index: hits[0],
          range,
        };
      }
    }

    // ③ 多处命中 → 指不出是哪一段，宁可不挂。
    // 注意：这里不能用模型报的块兜底——原文并不在那一块里，挂上去就是乱挂。
    if (hits.length > 1) return { ...base, status: 'unlocated', reason: 'ambiguous' };

    // ④ 零命中：模型指过某个块时，退化整段；没指过则只能算全章建议。
    return degradeToBlock(claimedIndex >= 0 ? 'changed' : 'not_found');
  });
}

/**
 * 收集当前对话里所有可处理的审稿意见，并按**正文出现顺序**编号。
 *
 * 只收 roleKey='critic' 且 action='comment' 的消息；其他角色照旧走纯文本。
 *
 * 编号规则（2026-11-12 按作者反馈调整）：
 *   - 先按块在正文里的先后排序，同块内再按原文起始字符排序；
 *     同一段上的多条意见因此拿到相邻号码，沟槽可以并列显示成「1·2」。
 *   - 定位不到的条目排在有位条目之后，但仍占一个号——
 *     列表是 1..N 的完整序列，不跳号、不重号。
 *   - 侧栏列表与正文沟槽读的是同一份 marker，不再各编各的。
 */
export function collectCriticFindings(messages, blocks) {
  const raw = [];

  (Array.isArray(messages) ? messages : []).forEach((msg, msgOrder) => {
    if (!msg || msg.role !== 'assistant' || msg.roleKey !== 'critic') return;
    if (msg.action !== 'comment') return;
    if (!Array.isArray(msg.findings) || !msg.findings.length) return;

    locateFindings(blocks, msg.findings).forEach((finding, i) => {
      raw.push({
        ...finding,
        key: `${msg.id}:${finding.id}:${i}`,
        messageId: msg.id,
        msgOrder,
        findingOrder: i,
      });
    });
  });

  const position = (finding) => (finding.range ? finding.range.start : Number.MAX_SAFE_INTEGER);
  const located = raw
    .filter((finding) => finding.status === 'located')
    .sort(
      (a, b) =>
        a.index - b.index ||
        position(a) - position(b) ||
        a.msgOrder - b.msgOrder ||
        a.findingOrder - b.findingOrder
    );
  const unlocated = raw.filter((finding) => finding.status !== 'located');

  return [...located, ...unlocated].map((finding, i) => ({
    ...finding,
    marker: i + 1,
  }));
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
