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
