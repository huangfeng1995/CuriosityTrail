/**
 * 块类型的定义与工具函数。
 *
 * 块是章节正文的最小单位，六种类型对应小说写作里真实的六种段落形态。
 */

export const BLOCK_TYPES = [
  { type: 'paragraph', label: '正文', hint: '普通叙述段落' },
  { type: 'dialogue', label: '对白', hint: '带说话人的台词' },
  { type: 'inner', label: '独白', hint: '心理描写 / 内心独白' },
  { type: 'scene_break', label: '分场', hint: '场景分隔' },
  { type: 'image', label: '插图', hint: '插图与图注' },
  { type: 'setting_ref', label: '设定', hint: '引用一条世界观设定' },
];

export const BLOCK_TYPE_MAP = new Map(BLOCK_TYPES.map((b) => [b.type, b]));

/**
 * 可以按选区重标类型的块。
 *
 * 只有纯文本段落能被「切开再标记」：分场、插图、设定引用没有可切分的正文，
 * 硬切只会把块拆成没有意义的两半。
 */
export const MARKABLE_TYPES = ['paragraph', 'dialogue', 'inner'];

export function isMarkableBlock(block) {
  return !!block && MARKABLE_TYPES.includes(block.type);
}

/**
 * 新建一个块。
 * id 用 crypto.randomUUID()——同毫秒创建两块时 Date.now() 会撞车。
 */
export function createBlock(type = 'paragraph', patch = {}) {
  const base = {
    id: crypto.randomUUID(),
    type,
    content: '',
  };

  if (type === 'dialogue') {
    base.speaker = '';
  }
  if (type === 'image') {
    base.fileName = '';
    base.url = '';
  }
  if (type === 'scene_break') {
    base.content = '';
  }

  return { ...base, ...patch };
}

/**
 * 块的可编辑文本。对白块的说话人单独处理。
 */
export function blockText(block) {
  if (!block) return '';
  if (block.type === 'dialogue' && block.speaker) {
    return `${block.speaker}：${block.content}`;
  }
  return block.content || '';
}

/**
 * 转换块类型。
 *
 * 正文内容一律保留；只有类型专属字段按新类型补齐或清掉——
 * 比如对白转正文要把"说话人"并进正文，否则那句"陈默："会凭空消失。
 */
export function convertBlock(block, type) {
  if (!block || block.type === type) return block;

  let content = block.content || '';
  let speaker = block.speaker;
  let url = block.url;
  let fileName = block.fileName;

  if (block.type === 'dialogue' && type !== 'dialogue' && speaker) {
    content = `${speaker}：${content}`;
    speaker = undefined;
  }

  if (type === 'dialogue' && !speaker) {
    speaker = '';
  }
  if (type === 'image' && !url) {
    url = '';
    fileName = '';
  }
  if (type !== 'image') {
    url = undefined;
    fileName = undefined;
  }
  if (type === 'scene_break') {
    content = '';
  }

  return { ...block, type, content, speaker, url, fileName };
}

/**
 * 从选中文字里拆出「说话人：台词」的说话人。
 *
 * 只认冒号前那一段：对白块把说话人单独存进 speaker 字段，
 * 留在正文里的话导出、记忆切块都会重复一遍。
 * 「陈默说：」这种把动词也带进去的写法识别不了，作者可以改说话人输入框。
 */
export function parseSpeaker(text) {
  const raw = text || '';
  const match = /^([^：:，。！？、；\s“”"'「」『』]{1,8})[：:]\s*/.exec(raw);
  if (!match) return { speaker: '', content: raw };
  return { speaker: match[1], content: raw.slice(match[0].length) };
}

/**
 * 按选区给一段正文重标类型。
 *
 * 块只有一个 type，没法在一段里标「这句是对白」。所以选区落在一段中间时，
 * 把原块切成「前段 / 选中段 / 后段」：选中段换成目标类型，其余保持原类型。
 * 这正是系统其余部分（导出、字数、记忆切块、AI 上下文）理解类型的方式。
 *
 * 返回新的 blocks 数组；不需要改动（类型相同、选区为空、块不可标记）时返回 null，
 * 调用方据此决定是否记撤销点。
 *
 * @param {Array} blocks 当前全部块
 * @param {string} blockId 选区所在块
 * @param {number} start 选区起点字符下标
 * @param {number} end 选区终点字符下标
 * @param {string} type 目标类型（只能取 MARKABLE_TYPES）
 */
export function splitBlockForMark(blocks, blockId, start, end, type) {
  if (!Array.isArray(blocks)) return null;
  if (!MARKABLE_TYPES.includes(type)) return null;

  const index = blocks.findIndex((b) => b && b.id === blockId);
  if (index < 0) return null;
  const block = blocks[index];
  if (!isMarkableBlock(block)) return null;
  if (block.type === type) return null;

  const content = block.content || '';
  const from = Math.max(0, Math.min(Number(start) || 0, content.length));
  const to = Math.max(from, Math.min(Number(end) || 0, content.length));
  if (from >= to) return null;

  // 整块都在选区里：不拆，直接换类型。对白转正文时说话人会并回正文，交给 convertBlock。
  if (from === 0 && to === content.length) {
    const next = convertBlock(block, type);
    const out = [...blocks];
    out[index] = next;
    return out;
  }

  const before = content.slice(0, from).trim();
  const middle = content.slice(from, to).trim();
  const after = content.slice(to).trim();
  if (!middle) return null;

  const parts = [];
  if (before) parts.push({ ...block, content: before });

  const marked = createBlock(type, { content: middle });
  if (type === 'dialogue') {
    const parsed = parseSpeaker(middle);
    marked.speaker = parsed.speaker;
    marked.content = parsed.content;
  }
  parts.push(marked);

  if (after) parts.push({ ...block, id: crypto.randomUUID(), content: after });

  // 第一段沿用原 id：审稿锚点、选区、撤销快照都还指着它，换了 id 会全部失联。
  parts[0] = { ...parts[0], id: block.id };

  return [...blocks.slice(0, index), ...parts, ...blocks.slice(index + 1)];
}

/**
 * 章节的纯文本，用于展示字数。
 */
export function chapterText(blocks) {
  return (blocks || [])
    .map(blockText)
    .filter(Boolean)
    .join('\n\n');
}

export function countChars(text) {
  return (text || '').replace(/\s/g, '').length;
}
