'use strict';

/**
 * 记忆召回质量标定工具。
 *
 * 为什么需要它：
 *
 * `MEMORY_MIN_SCORE` 这类阈值，靠拍脑袋定是不作数的。真实稿件上，
 * "该召回的"和"不该召回的"两拨得分各自分布在什么位置，
 * 只有拿真数据量出来才知道。阈值定高了漏掉关键记忆，
 * 定低了把无关内容塞进上下文——两边都要钱：前者是剧情失忆，后者是 token 浪费。
 *
 * 这个脚本做两件事：
 *
 *  1. **建语料**：把数据库里真实的章节/人物/设定/对话切成块，索引进 sidecar。
 *  2. **量分布**：用一组"探针查询"打进去，记录每条召回的得分，
 *     然后按得分从高到低扫阈值，算出每个阈值下的
 *     命中率（该召回的召回了没有）与噪音率（不该召回的混进来没有）。
 *
 * 用法：
 *
 *   cd web/server
 *   node scripts/calibrate-memory.js                 # 用当前库里的真实内容
 *   node scripts/calibrate-memory.js --min 0.10 --max 0.60 --step 0.02
 *   node scripts/calibrate-memory.js --corpus /path/to/book/  # 用纯文本稿件
 *
 * 前提：sidecar 已经在跑（否则索引会失败，脚本会如实报错退出）。
 *
 * 它是**离线标定工具**，不在服务运行路径上，不进 `npm test`。
 */

const path = require('path');

const { all, get } = require('../database');
const config = require('../config');
const client = require('../services/memory/client');
const chunker = require('../services/memory/chunker');
const sources = require('../services/memory/sources');
const uris = require('../services/memory/uris');
const { TYPE_WEIGHTS } = require('../services/memory/retriever');

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

/**
 * 解析命令行参数。
 * @returns {{min: number, max: number, step: number, limit: number, corpus: string, chunkSize: number}}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const out = { min: 0.10, max: 0.60, step: 0.02, limit: 16, corpus: '', chunkSize: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = Number(argv[i + 1]);
    if (key === '--min' && Number.isFinite(value)) out.min = value;
    else if (key === '--max' && Number.isFinite(value)) out.max = value;
    else if (key === '--step' && Number.isFinite(value)) out.step = value;
    else if (key === '--limit' && Number.isFinite(value)) out.limit = value;
    else if (key === '--chunk-size' && Number.isFinite(value)) out.chunkSize = value;
    else if (key === '--corpus' && argv[i + 1]) {
      out.corpus = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * 由目标块大小推出一整套切块参数。
 *
 * 其余参数按比例跟着走，不然「目标 400 字但硬上限还是 1000」就自相矛盾了。
 * 比例取的是线上默认值 800/1000/200/100 的同一套比例。
 *
 * @param {number} target 目标块大小，0 表示用线上默认
 * @returns {object|null}
 */
function chunkOptions(target) {
  if (!target || target <= 0) return null;
  return {
    targetSize: target,
    maxSize: Math.round(target * 1.25),
    minSize: Math.round(target * 0.25),
    overlap: Math.round(target * 0.125),
  };
}

/**
 * 标定用的虚拟作者 id。用真实 id 会污染作者的召回结果，
 * 而且标定语料跟作者自己的稿子混在一起，得分分布会被带偏。
 */
const CALIBRATION_USER = 'calibration-user';

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

/**
 * 收集数据库里所有可索引的内容。
 *
 * @returns {Promise<Array<{sourceType: string, sourceId: string, workId: string, conversationId: string|null, text: string, blocks: Array}>>}
 */
async function collectCorpus() {
  const items = [];

  const chapters = await all(
    `SELECT c.*, w.user_id AS user_id FROM chapters c
     JOIN works w ON w.id = c.work_id`
  );
  for (const chapter of chapters) {
    items.push({
      sourceType: 'chapter',
      sourceId: chapter.id,
      workId: chapter.work_id,
      conversationId: null,
      text: sources.chapterText(chapter),
      blocks: sources.chapterBlocks(chapter),
    });
  }

  const characters = await all(
    `SELECT ch.*, w.user_id AS user_id FROM characters ch
     JOIN works w ON w.id = ch.work_id`
  );
  for (const character of characters) {
    items.push({
      sourceType: 'character',
      sourceId: character.id,
      workId: character.work_id,
      conversationId: null,
      text: sources.characterText(character),
      blocks: [],
    });
  }

  const settings = await all(
    `SELECT s.*, w.user_id AS user_id FROM settings s
     JOIN works w ON w.id = s.work_id`
  );
  for (const setting of settings) {
    items.push({
      sourceType: 'setting',
      sourceId: setting.id,
      workId: setting.work_id,
      conversationId: null,
      text: sources.settingText(setting),
      blocks: [],
    });
  }

  const messages = await all(
    `SELECT m.*, c.work_id AS work_id FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE c.work_id IS NOT NULL`
  );
  for (const message of messages) {
    if (!message.content || message.content.length < 40) continue;
    items.push({
      sourceType: 'conv_raw',
      sourceId: message.id,
      workId: message.work_id,
      conversationId: message.conversation_id,
      text: message.content,
      blocks: [],
    });
  }

  return items;
}

/**
 * 从目录读纯文本稿件当语料。
 *
 * 设计文档要求"用一部 30 万字样书做召回质量评估"——库里的内容远不到这个量，
 * 结论只能当参考。真拿到长篇稿件后，把 .txt/.md 丢进一个目录，
 * 用 --corpus 指过来就行。
 *
 * 每个文件当一章，按文件名排序拼成一本。
 *
 * @param {string} dir
 * @returns {Promise<Array>}
 */
async function collectCorpusFromDir(dir) {
  const fs = require('fs');
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`语料目录不存在：${resolved}`);
  }

  const files = fs
    .readdirSync(resolved)
    .filter((name) => /\.(txt|md)$/i.test(name))
    .sort();

  if (!files.length) {
    throw new Error(`语料目录里没有 .txt/.md 文件：${resolved}`);
  }

  const workId = 'corpus-work';
  return files.map((name, i) => ({
    sourceType: 'chapter',
    sourceId: `corpus${String(i).padStart(4, '0')}`,
    workId,
    conversationId: null,
    text: fs.readFileSync(path.join(resolved, name), 'utf8'),
    blocks: [],
  }));
}

/**
 * 高频虚词字表。
 *
 * 中文没有空格，不做分词就没法把"词"从"字串"里挑出来。
 * 但其实不需要真的分词：把虚词字排除掉，剩下的连续汉字
 * 天然就是「林昭」「长乐巷」「玉镯」这类实词。
 *
 * 这比正则直接切字串准得多——后者切出来的是
 * "何九在旧码头遇见" 这种跨词边界的碎片。
 */
const FUNCTION_CHARS = new Set(
  '的了在有和与就都而及或也很不没这那些他她它们个着过吗呢吧啊把被让给对从到为以之而且但因所以然并曾经正将要可以能应该必须需想要时候样个些点种位名号再又还只更最很非常实在真的确实原来当初后来此后此时那些某个' +
    '已经正在将要曾经方才随即便即就才刚曾尚未将要已经在就要要道说道问答叫喊笑哭想看走跑站坐拿放做用打开关来去回进出上下左右前后里外中间旁边'
);

/**
 * 从正文里抽实词。
 *
 * 做法：扫连续汉字段，遇到虚词字就断开，剩下的段就是候选词。
 * 再按长度过滤（2–4 字最像中文的词），挑第一个可用的。
 *
 * @param {string} text
 * @returns {Array<string>}
 */
function extractTerms(text) {
  const terms = [];
  let buffer = '';

  const flush = () => {
    if (buffer.length >= 2 && buffer.length <= 4) terms.push(buffer);
    buffer = '';
  };

  for (const ch of String(text || '')) {
    if (/[一-鿿]/.test(ch)) {
      if (FUNCTION_CHARS.has(ch)) flush();
      else buffer += ch;
    } else {
      flush();
    }
  }
  flush();
  return terms;
}

/**
 * 造探针查询。
 *
 * 每条探针有三种形态：
 *  - `needle`：正文里出现的实词。查它必须命中包含该词的来源。
 *  - `unrelated`：与语料无关的查询。查它**不该**有任何命中，命中就是噪音。
 *  - `paraphrase`：换个说法问同一件事。看语义召回能不能顶住措辞变化。
 *
 * 实词从正文里自动抽，避免人工维护一份会过期的清单。
 *
 * 关键一点：**一个词可能出现在多个来源里**（人名、地名尤其如此）。
 * 这时候"正确答案"不是某一个来源，而是"包含这个词的任意一个来源"。
 * 把期望写成单一来源，会把本来正确的召回判成漏召——
 * 那样量出来的命中率是假的，比不量还糟。
 *
 * @param {Array} corpus
 * @returns {Array<{query: string, expect: string[]|null, kind: string, label: string}>}
 */
function buildProbes(corpus) {
  const probes = [];

  // 先建立「实词 → 包含它的所有来源」索引。
  const termSources = new Map();
  const sourceTerms = new Map();
  for (const item of corpus) {
    const key = `${item.sourceType}:${item.sourceId}`;
    const terms = extractTerms(item.text);
    sourceTerms.set(key, terms);
    for (const term of terms) {
      if (!termSources.has(term)) termSources.set(term, new Set());
      termSources.get(term).add(key);
    }
  }

  // 实词探针：每个来源挑几个它独有的词。
  // 专有词最能说明问题——地名、人名、物件名。
  for (const item of corpus) {
    const key = `${item.sourceType}:${item.sourceId}`;
    const terms = sourceTerms.get(key) || [];
    let taken = 0;
    for (const term of terms) {
      if (term.length < 3) continue;
      // 只在多个来源里出现过的词有区分度；独有的词更好。
      const sources = termSources.get(term);
      if (sources.size > 6) continue;
      probes.push({
        query: term,
        expect: [...sources],
        kind: 'needle',
        label: `实词「${term}」应命中 ${sources.size} 个来源之一`,
      });
      taken += 1;
      if (taken >= 2) break;
    }
  }

  // 无关查询：与任何语料都不该沾边。
  const unrelated = [
    '推荐几个适合清晨喝的咖啡冲泡方式',
    '怎么申请护照需要什么材料',
    '篮球三分线距离篮筐多少米',
    '家用洗衣机怎么除垢',
  ];
  for (const query of unrelated) {
    probes.push({
      query,
      expect: null,
      kind: 'noise',
      label: `无关查询「${query}」不应有命中`,
    });
  }

  // 换说法问同一件事——这是最难的一类探针。
  //
  // 关键词探针测的是"字面匹配"，换个说法就答不上来。
  // 语义召回的价值恰恰在这里，所以必须单独量：
  // 改写之后还能命中，才说明模型学到的是意思而不是字。
  for (const probe of buildParaphraseProbes(corpus)) {
    probes.push(probe);
  }

  return probes;
}

/**
 * 生产级查询探针。
 *
 * 前面的探针都是「两三个字的词」当查询，但线上的查询根本不是这样——
 * `buildQueryText()` 拼的是「当前章末尾 1500 字 + 本次指令」，最坏 2000 字。
 *
 * **查询长度会彻底改变得分区间**：短查询跟正文比的是几个词的密度，
 * 长查询跟正文比的是整段语境的相似度，两者的分数不在一个量级上。
 * 拿短查询量出来的阈值去卡长查询，等于用错误的尺子量东西。
 *
 * 所以这里单独做一套长查询探针，量的是线上真实的分数区间：
 *  - `long`：从来源正文里截一段（模拟章末尾），应当命中该来源；
 *  - `long_noise`：一段完全无关的长文本（模拟作者问了不相干的事）。
 *
 * @param {Array} corpus
 * @returns {Array<{query: string, expect: string[]|null, kind: string, label: string}>}
 */
function buildLongProbes(corpus) {
  /** 模拟「当前章末尾」的截取长度。线上是 1500 字，这里取 400 字跑得快些。 */
  const EXCERPT = 400;

  const probes = [];

  // 长查询真命中：从来源正文中间截一段，期望召回该来源。
  for (const item of corpus) {
    const text = String(item.text || '');
    if (text.length < EXCERPT * 2) continue;
    const start = Math.floor(text.length / 3);
    const excerpt = text.slice(start, start + EXCERPT);
    probes.push({
      query: excerpt,
      expect: [`${item.sourceType}:${item.sourceId}`],
      kind: 'long',
      label: `长查询（${EXCERPT} 字）应命中 ${item.sourceType}`,
    });
  }

  // 长查询噪音：完全不相干的长文本。
  const unrelatedLong = [
    '做红烧肉要先焯水去腥，锅里放少许油，冰糖炒出糖色，肉块下锅翻炒上色，' +
      '加生抽老抽料酒，热水没过肉面，小火慢炖四十分钟，最后大火收汁即可。',
    '篮球场地的标准尺寸是二十八米乘十五米，篮筐离篮板上沿三点零五米，' +
      '三分线距离篮筐六点七五米，中圈半径一点八米，罚球线距离端线五点八米。',
  ];
  for (const query of unrelatedLong) {
    probes.push({
      query,
      expect: null,
      kind: 'long_noise',
      label: '长查询·无关文本不应有命中',
    });
  }

  return probes;
}

/**
 * 从正文里生成"换说法"的探针。
 *
 * 做法：在正文里找一个短语，把其中的动词换成近义说法，
 * 拿换过之后的短语当查询。
 *
 * 这里必须在**原文上做替换**，不能对抽出来的词做——
 * 「答应替父亲还债」是一个完整短语，换成「许诺替父亲还债」
 * 才是真正的改写；只把「答应」两个字换掉，语义太薄，
 * 量出来的是字面匹配的能力，不是语义理解的能力。
 *
 * 期望来源的判定同样得靠上下文：只按「含有这个动词」找来源，
 * 在模板化语料里一个动词可能出现在几十章里，期望集合一大，
 * 探针就退化成「随便命中一个都行」，量不出真实能力。
 * 所以拿**动词前后各 12 个字的窗口**去找：
 * 窗口包含上下文，重复的概率低得多。
 *
 * @param {Array} corpus
 * @returns {Array<{query: string, expect: string[], kind: string, label: string}>}
 */
function buildParaphraseProbes(corpus) {
  // 常见说法替换。够用就行——目的是让查询措辞跟原文拉开距离。
  const rewrites = [
    ['答应', '许诺'],
    ['发现', '察觉'],
    ['离开', '离去'],
    ['找到', '寻得'],
    ['收到', '接到'],
    ['想起', '忆起'],
    ['决定', '下定决心'],
    ['拒绝', '回绝'],
    ['烧掉', '付之一炬'],
    ['当掉', '典押'],
    ['交付', '交托'],
    ['隐瞒', '藏住'],
    ['把门锁换', '更换了门锁'],
    ['把信读', '将信反复读了'],
    ['敲开', '叩开'],
    ['遇见', '碰见'],
  ];

  /** 上下文窗口的半宽（字符）。 */
  const WINDOW = 12;

  const probes = [];
  for (const item of corpus) {
    const text = String(item.text || '');
    let taken = 0;
    for (const [from, to] of rewrites) {
      const at = text.indexOf(from);
      if (at < 0) continue;

      // 带上前后各若干字，让查询像个短语而不是孤零零一个动词。
      const start = Math.max(0, at - WINDOW);
      const end = Math.min(text.length, at + from.length + WINDOW);
      const original = text.slice(start, end);
      const phrase = original.replace(from, to);

      // 期望来源 = 含有这个**窗口**（未改写）的所有来源。
      const sources = new Set();
      for (const other of corpus) {
        if (String(other.text || '').includes(original)) {
          sources.add(`${other.sourceType}:${other.sourceId}`);
        }
      }
      if (!sources.size || sources.size > 6) continue;

      probes.push({
        query: phrase,
        expect: [...sources],
        kind: 'paraphrase',
        label: `改写「${from}」→「${to}」应命中 ${sources.size} 个来源之一`,
      });
      taken += 1;
      if (taken >= 3) break;
    }
  }
  return probes;
}

// ---------------------------------------------------------------------------
// 索引与探测
// ---------------------------------------------------------------------------

/**
 * 把语料切块并写进 sidecar。
 *
 * @param {Array} corpus
 * @param {object|null} [options] 切块参数，null 用线上默认
 * @returns {Promise<number>} 写入的块数
 */
async function indexCorpus(corpus, options = null) {
  let count = 0;
  for (const item of corpus) {
    const pieces =
      item.sourceType === 'chapter' && item.blocks.length
        ? chunker.chunkChapterBlocks(item.blocks, options || undefined)
        : chunker.chunkText(item.text, options || undefined);
    for (let chunkNo = 0; chunkNo < pieces.length; chunkNo += 1) {
      const uri = uris.chunkUri({
        userId: CALIBRATION_USER,
        workId: item.workId,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        chunkNo,
        conversationId: item.conversationId,
      });
      await client.index(uri, pieces[chunkNo]);
      count += 1;
    }
  }
  return count;
}

/**
 * 清掉标定语料。
 *
 * 不清的话标定块会一直留在向量库里，污染之后的召回。
 *
 * @param {Array} corpus
 * @param {object|null} [options] 切块参数，必须跟索引时一致，否则删不到
 */
async function cleanupCorpus(corpus, options = null) {
  for (const item of corpus) {
    const pieces =
      item.sourceType === 'chapter' && item.blocks.length
        ? chunker.chunkChapterBlocks(item.blocks, options || undefined)
        : chunker.chunkText(item.text, options || undefined);
    for (let chunkNo = 0; chunkNo < pieces.length; chunkNo += 1) {
      const uri = uris.chunkUri({
        userId: CALIBRATION_USER,
        workId: item.workId,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        chunkNo,
        conversationId: item.conversationId,
      });
      try {
        await client.remove(uri);
      } catch (e) {
        // 清不掉的块不影响标定结论，只是残留向量。
      }
    }
  }
}

/**
 * 跑一次探测，返回每条探针的召回明细。
 *
 * @param {Array} probes
 * @param {Array} corpus
 * @param {number} limit
 * @returns {Promise<Array<{probe: object, hits: Array<{uri: string, score: number, sourceKey: string}>}>>}
 */
async function runProbes(probes, corpus, limit) {
  const results = [];
  const workIds = listWorkIds(corpus);

  for (const probe of probes) {
    const hits = [];
    for (const workId of workIds) {
      const result = await client.query({
        query: probe.query,
        targetUri: uris.workRoot(CALIBRATION_USER, workId),
        limit,
        minScore: 0,
      });
      for (const item of result.results) {
        const info = uris.parseUri(item.uri);
        if (!info) continue;
        hits.push({
          uri: item.uri,
          score: item.score,
          sourceType: info.sourceType,
          sourceKey: `${info.sourceType}:${info.sourceId}`,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    results.push({ probe, hits });
  }
  return results;
}

/**
 * 加权分：跟线上 retriever 用同一套权重。
 *
 * 直接引 retriever 的常量，而不是抄一份——抄的那份迟早跟代码对不上，
 * 标定出来的结论也就跟着失真。
 *
 * @param {{score: number, sourceType: string}} hit
 * @returns {number}
 */
function weightedScore(hit) {
  return hit.score * (TYPE_WEIGHTS[hit.sourceType] ?? 1);
}

/**
 * 标用语料涉及的所有作品 id。
 *
 * 语料自己带着 workId，不用再查库——库里那点内容跟标定无关。
 *
 * @param {Array} corpus
 * @returns {Array<string>}
 */
function listWorkIds(corpus) {
  return [...new Set(corpus.map((item) => item.workId).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// 阈值扫描
// ---------------------------------------------------------------------------

/**
 * 按阈值统计命中率与噪音率。
 *
 * 命中率：该召回的探针，在阈值之上是否召回了目标来源。
 * 噪音率：无关查询在阈值之上是否还有命中，以及召回了多少条。
 *
 * 命中率按探针种类分开算：实词探针和改写探针的难度差一个量级，
 * 混在一起算出来的数字看不出问题出在哪。
 *
 * 阈值比的是**加权分**，不是原始相似度。
 *
 * 用原始分来标定，结论跟线上对不上：人物卡/设定卡权重 1.15，
 * 原始分 0.18 的卡片加权后是 0.207，能过 0.20 的线——
 * 但线上 retriever 现在是 sidecar 先按原始分过滤、回来才加权，
 * 这张卡片在 sidecar 那一层就被淘汰了，权重根本没机会生效。
 * 标定按加权分算，是在为「先加权再过滤」这个更正确的顺序做度量；
 * 线上顺序是否要改，见设计文档 §6.2 的回写说明。
 *
 * @param {Array} runs
 * @param {number} threshold
 * @returns {object}
 */
function scoreThreshold(runs, threshold) {
  const byKind = {
    needle: { hit: 0, total: 0 },
    paraphrase: { hit: 0, total: 0 },
    long: { hit: 0, total: 0 },
  };
  let noiseQueries = 0;
  let noiseHits = 0;
  let longNoiseQueries = 0;

  for (const run of runs) {
    const above = run.hits.filter((hit) => weightedScore(hit) >= threshold);
    if (run.probe.expect) {
      const bucket = byKind[run.probe.kind];
      if (bucket) {
        bucket.total += 1;
        // 期望是一组来源：命中其中任意一个就算召回。
        // 一个词出现在多个来源里时，"正确答案"本就不唯一。
        const expected = new Set(run.probe.expect);
        if (above.some((hit) => expected.has(hit.sourceKey))) bucket.hit += 1;
      }
    } else if (run.probe.kind === 'long_noise') {
      // 长查询噪音单独计数：它跟短查询噪音不是一个量级，
      // 混在一起会掩盖「长查询得分普遍更高」这个事实。
      if (above.length > 0) longNoiseQueries += 1;
    } else if (above.length > 0) {
      noiseQueries += 1;
      noiseHits += above.length;
    }
  }

  const hit = byKind.needle.hit + byKind.paraphrase.hit;
  const total = byKind.needle.total + byKind.paraphrase.total;

  return {
    threshold,
    hit,
    miss: total - hit,
    total,
    hitRate: total ? hit / total : 0,
    needleRate: byKind.needle.total ? byKind.needle.hit / byKind.needle.total : 0,
    paraphraseRate: byKind.paraphrase.total
      ? byKind.paraphrase.hit / byKind.paraphrase.total
      : 0,
    longRate: byKind.long.total ? byKind.long.hit / byKind.long.total : 0,
    noiseQueries,
    noiseHits,
    longNoiseQueries,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  const health = await client.health();
  if (!health) {
    console.error('记忆服务没起来，标定无法进行。');
    console.error('先启动 sidecar：cd web/memory-service && python3 -m uvicorn app:app --host 127.0.0.1 --port 8019');
    process.exit(1);
  }
  console.log(`记忆服务就绪：模型 ${health.model}，维度 ${health.dim}`);

  const corpus = args.corpus
    ? await collectCorpusFromDir(args.corpus)
    : await collectCorpus();
  if (!corpus.length) {
    console.error(
      args.corpus ? '语料目录里没有内容。' : '库里没有可标定的内容。先写点章节再来。'
    );
    process.exit(1);
  }
  const totalChars = corpus.reduce((sum, item) => sum + item.text.length, 0);
  console.log(
    `语料：${corpus.length} 个来源，共 ${totalChars} 字（${args.corpus ? '外部稿件' : '当前库'}）`
  );

  const probes = buildProbes(corpus);
  const longProbes = buildLongProbes(corpus);
  const allProbes = [...probes, ...longProbes];
  console.log(
    `探针：${allProbes.length} 条（短查询 ${probes.length} 条 + 长查询 ${longProbes.length} 条）`
  );

  const chunkOpts = chunkOptions(args.chunkSize);
  if (chunkOpts) {
    console.log(
      `切块：目标 ${chunkOpts.targetSize} 字（上限 ${chunkOpts.maxSize} / 下限 ${chunkOpts.minSize} / 重叠 ${chunkOpts.overlap}）`
    );
  } else {
    console.log(
      `切块：线上默认（目标 ${chunker.TARGET_SIZE} 字）`
    );
  }
  console.log('索引中……');

  let chunkCount = 0;
  try {
    chunkCount = await indexCorpus(corpus, chunkOpts);
    console.log(`已索引 ${chunkCount} 块`);

    console.log('探测中……');
    const runs = await runProbes(allProbes, corpus, args.limit);

    // 得分分布：帮助判断阈值该落在哪。
    // 原始分与加权分一起看——两者之间的差就是类型权重在起作用。
    const rawScores = runs.flatMap((run) => run.hits.map((hit) => hit.score)).sort((a, b) => a - b);
    const weightedScores = runs.flatMap((run) => run.hits.map((hit) => weightedScore(hit))).sort((a, b) => a - b);
    if (rawScores.length) {
      const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
      console.log('\n得分分布（全部召回）：');
      console.log(
        `  原始分  最小 ${rawScores[0].toFixed(3)}  p25 ${pct(rawScores, 0.25).toFixed(3)}  中位 ${pct(
          rawScores,
          0.5
        ).toFixed(3)}  p75 ${pct(rawScores, 0.75).toFixed(3)}  最大 ${rawScores[rawScores.length - 1].toFixed(3)}`
      );
      console.log(
        `  加权分  最小 ${weightedScores[0].toFixed(3)}  p25 ${pct(weightedScores, 0.25).toFixed(
          3
        )}  中位 ${pct(weightedScores, 0.5).toFixed(3)}  p75 ${pct(weightedScores, 0.75).toFixed(
          3
        )}  最大 ${weightedScores[weightedScores.length - 1].toFixed(3)}`
      );
    }

    console.log('\n阈值扫描：');
    console.log('阈值    综合     实词     改写     长查询   漏召   短噪音  长噪音');
    let best = null;
    for (let threshold = args.min; threshold <= args.max + 1e-9; threshold += args.step) {
      const row = scoreThreshold(runs, threshold);
      const mark = row.noiseQueries === 0 ? '' : ` ${row.noiseQueries} 条`;
      console.log(
        `${row.threshold.toFixed(2)}    ${(row.hitRate * 100).toFixed(0).padStart(4)}%   ${(
          row.needleRate * 100
        )
          .toFixed(0)
          .padStart(4)}%   ${(row.paraphraseRate * 100).toFixed(0).padStart(4)}%   ${(
          row.longRate * 100
        )
          .toFixed(0)
          .padStart(4)}%   ${String(row.miss).padStart(3)}    ${String(row.noiseQueries).padStart(
          2
        )}${mark}    ${String(row.longNoiseQueries).padStart(2)}`
      );
      // 推荐阈值：零噪音前提下命中率最高的那一档。
      if (row.noiseQueries === 0 && row.longNoiseQueries === 0 && (!best || row.hitRate > best.hitRate)) {
        best = row;
      }
    }

    // 噪音明细：哪条无关查询漏进来了、命中了什么、得分多少。
    // 光看一个计数没法调——得分才是决定阈值的东西。
    console.log('\n噪音明细（各无关查询的最高命中得分）：');
    for (const run of runs) {
      if (run.probe.expect) continue;
      const top = run.hits[0];
      console.log(
        `  ${top ? weightedScore(top).toFixed(3) : '  -  '}  「${run.probe.query}」${
          top ? `→ ${top.sourceKey}（原始 ${top.score.toFixed(3)} ×${TYPE_WEIGHTS[top.sourceType] ?? 1}）` : '（无命中）'
        }`
      );
    }

    // 按来源类型拆开看。
    //
    // 混在一起看会得出一个错误的结论：「噪音比真命中还高，阈值救不了」。
    // 拆开才看得清噪音到底来自哪——如果噪音全部来自短卡片（人物卡/设定卡），
    // 那是**短文本向量相似度普遍偏高**的问题，不是阈值问题：
    // 十几字的卡片跟任何查询都有 0.2 左右的余弦相似度。
    // 这时该做的是给短来源单独定更高的门槛，而不是把全局阈值抬到把正文也砍掉。
    const byType = new Map();
    for (const run of runs) {
      if (run.probe.expect) {
        const expected = new Set(run.probe.expect);
        for (const hit of run.hits) {
          if (!expected.has(hit.sourceKey)) continue;
          if (!byType.has(hit.sourceType)) {
            byType.set(hit.sourceType, { trueHits: [], noise: [], lengths: [] });
          }
          byType.get(hit.sourceType).trueHits.push(weightedScore(hit));
          break;
        }
      } else {
        for (const hit of run.hits) {
          if (!byType.has(hit.sourceType)) {
            byType.set(hit.sourceType, { trueHits: [], noise: [], lengths: [] });
          }
          byType.get(hit.sourceType).noise.push(weightedScore(hit));
        }
      }
    }

    // 每种类型的正文长度：用来验证「短文本相似度普遍偏高」这个猜测。
    const typeLength = new Map();
    for (const item of corpus) {
      const prev = typeLength.get(item.sourceType);
      const len = item.text.length;
      if (!prev) typeLength.set(item.sourceType, { min: len, max: len, sum: len, n: 1 });
      else {
        prev.min = Math.min(prev.min, len);
        prev.max = Math.max(prev.max, len);
        prev.sum += len;
        prev.n += 1;
      }
    }

    console.log('\n按来源类型拆分（加权分）：');
    console.log(
      '类型              正文字数      真命中最低  真命中最高  噪音最高  噪音条数'
    );
    for (const [type, stat] of byType) {
      const trueMin = stat.trueHits.length
        ? Math.min(...stat.trueHits).toFixed(3)
        : '  -  ';
      const trueMax = stat.trueHits.length
        ? Math.max(...stat.trueHits).toFixed(3)
        : '  -  ';
      const noiseMax = stat.noise.length ? Math.max(...stat.noise).toFixed(3) : '  -  ';
      const len = typeLength.get(type);
      const lenText = len ? `${len.min}-${len.max}` : '-';
      console.log(
        `${type.padEnd(16)} ${lenText.padStart(8)}  ${String(trueMin).padStart(8)}  ${String(
          trueMax
        ).padStart(8)}  ${String(noiseMax).padStart(7)}  ${String(stat.noise.length).padStart(8)}`
      );
    }

    // 分离度：阈值真正的依据。
    //
    // 「最低真命中分」与「最高噪音分」之间的空隙，就是阈值能放的安全区间。
    // 两边贴在一起说明没有安全区间，只能靠别的手段（类型权重、剔除）解决；
    // 空隙宽说明阈值好定，而且取区间中点最稳。
    //
    // 分开算实词与改写：改写探针的得分更低，它才是真正的下限。
    // 用实词的分数定阈值，改写召回会整片漏掉。
    const lowest = { needle: Infinity, paraphrase: Infinity, long: Infinity };
    let highestNoise = -Infinity;
    let highestLongNoise = -Infinity;
    for (const run of runs) {
      if (run.probe.expect) {
        const expected = new Set(run.probe.expect);
        const hit = run.hits.find((item) => expected.has(item.sourceKey));
        if (hit && lowest[run.probe.kind] !== undefined) {
          lowest[run.probe.kind] = Math.min(lowest[run.probe.kind], weightedScore(hit));
        }
      } else if (run.probe.kind === 'long_noise') {
        if (run.hits.length) {
          highestLongNoise = Math.max(highestLongNoise, weightedScore(run.hits[0]));
        }
      } else if (run.hits.length) {
        highestNoise = Math.max(highestNoise, weightedScore(run.hits[0]));
      }
    }

    console.log('\n分离度：');
    console.log(
      `  最低实词命中分 ${
        lowest.needle === Infinity ? '（无）' : lowest.needle.toFixed(3)
      }`
    );
    console.log(
      `  最低改写命中分 ${
        lowest.paraphrase === Infinity ? '（无）' : lowest.paraphrase.toFixed(3)
      }`
    );
    console.log(
      `  最高噪音分     ${highestNoise === -Infinity ? '（无）' : highestNoise.toFixed(3)}`
    );
    console.log('\n长查询（模拟线上「章末尾 + 指令」）：');
    console.log(
      `  最低长查询命中分 ${lowest.long === Infinity ? '（无）' : lowest.long.toFixed(3)}`
    );
    console.log(
      `  最高长查询噪音分 ${
        highestLongNoise === -Infinity ? '（无）' : highestLongNoise.toFixed(3)
      }`
    );

    const floor = Math.min(lowest.needle, lowest.paraphrase);
    let recommended = null;
    if (floor !== Infinity && highestNoise !== -Infinity) {
      const gap = floor - highestNoise;
      if (gap > 0) {
        const midpoint = (highestNoise + floor) / 2;
        console.log(
          `  空隙 ${gap.toFixed(3)} → 安全区间 (${highestNoise.toFixed(2)}, ${floor.toFixed(
            2
          )})，中点 ${midpoint.toFixed(2)}`
        );
        recommended = midpoint;
      } else {
        console.log(
          `  空隙 ${gap.toFixed(3)} → 没有安全区间：真命中比噪音还低，阈值救不了，得靠类型权重或人工剔除`
        );
      }
    }

    // 长查询的分离度。
    //
    // 线上真正用的是长查询（章末尾 + 指令），短查询只是补充。
    // 两者的**得分区间**差着一个量级（长查询真命中 0.8 起，短查询 0.34 起），
    // 但**噪音天花板**在两边都很低（0.10 / 0.14）。
    //
    // 所以阈值不能按长查询的中点定——那个值（0.46）会把短查询的真命中全砍光。
    // 正确的做法是：取两种查询形态的**并集**。
    //  - 下限 = 所有形态里最低的真命中分（短查询的 0.344），
    //  - 上限 = 所有形态里最高的噪音分（0.136）。
    // 这样一根阈值同时管住两种查询形态。
    if (lowest.long !== Infinity && highestLongNoise !== -Infinity) {
      const longGap = lowest.long - highestLongNoise;
      console.log(
        `  长查询空隙 ${longGap.toFixed(3)} → 安全区间 (${highestLongNoise.toFixed(
          2
        )}, ${lowest.long.toFixed(2)})`
      );

      const unionFloor = Math.min(floor, lowest.long);
      const unionNoise = Math.max(highestNoise, highestLongNoise);
      if (unionFloor !== Infinity && unionNoise !== -Infinity && unionFloor > unionNoise) {
        const unionMid = (unionNoise + unionFloor) / 2;
        console.log(
          `  合并两种查询形态：安全区间 (${unionNoise.toFixed(2)}, ${unionFloor.toFixed(
            2
          )})，中点 ${unionMid.toFixed(2)}`
        );
        recommended = unionMid;
      } else {
        console.log('  合并两种查询形态后没有安全区间');
      }
    }

    // 推荐取安全区间中点，而不是"最低的零噪音阈值"。
    //
    // 后者贴着噪音边界走：语料一变，噪音就可能冒出来。
    // 中点两头都有余量，是唯一站得住的选择。
    if (recommended !== null) {
      const check = scoreThreshold(runs, recommended);
      console.log(
        `\n推荐：MEMORY_MIN_SCORE=${recommended.toFixed(2)}` +
          `（综合命中 ${(check.hitRate * 100).toFixed(0)}%，实词 ${(
            check.needleRate * 100
          ).toFixed(0)}%，改写 ${(check.paraphraseRate * 100).toFixed(0)}%，长查询 ${(
            check.longRate * 100
          ).toFixed(0)}%，短噪音 ${check.noiseQueries} 条，长噪音 ${check.longNoiseQueries} 条）`
      );
    } else if (best) {
      console.log(
        `\n退而求其次：MEMORY_MIN_SCORE=${best.threshold.toFixed(2)}（命中率 ${(
          best.hitRate * 100
        ).toFixed(0)}%，零噪音，但没有可用的安全区间）`
      );
    } else {
      console.log('\n没有找到「零噪音」的阈值——说明当前语料下无关查询也会被召回。');
      console.log('这种情况多半是探针里的「无关查询」其实不够无关，换一批更远的查询再量。');
    }

    if (best && best.hitRate < 0.9) {
      console.log('注意：命中率没到 90%，说明语料或探针偏少，结论只能当参考。');
    }
  } finally {
    console.log('\n清理标定语料……');
    await cleanupCorpus(corpus, chunkOpts);
    console.log('清理完成');
  }
}

main().catch((err) => {
  console.error(`标定失败：${err.message}`);
  process.exit(1);
});
