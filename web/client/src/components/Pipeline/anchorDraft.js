/**
 * 锚点草稿的分档与勾选规则。
 *
 * 这里是防「AI 编史料」的人工闸门：模型给的候选可以很多，
 * 但只有校验通过、且「有出处」真的带书名时，作者才能勾选入库。
 * 缺少书名的 sourced 条目整条不可选——它的 claim 再像真的也不能进库。
 *
 * 纯函数，便于 node --test 直接覆盖。
 */

export const TIERS = [
  {
    key: 'sourced',
    label: '有出处',
    hint: '书名与卷次/条目齐全，可以回查原文',
  },
  {
    key: 'inferable',
    label: '可推定',
    hint: '只有书名或通行说法，能撑住方向，不能当原文引用',
  },
  {
    key: 'blank',
    label: '纯空白',
    hint: '史料无载，可以合法虚构，但不要写成史实',
  },
];

const TIER_KEYS = new Set(TIERS.map((tier) => tier.key));

/**
 * 一条候选为什么不能勾选。空串表示可选。
 *
 * 缺书名单独说清楚，因为这是最常见的「AI 编出处」形态：
 * confidence 写了 sourced，书名却是空的。
 */
export function anchorBlockReason(anchor) {
  if (!anchor || typeof anchor !== 'object') return '候选格式不正确';

  if (anchor.confidence === 'sourced' && !String(anchor.source_title || '').trim()) {
    return '缺少书名：有出处的锚点必须能回到原书，不能凭 AI 的一句话入库';
  }

  if (Array.isArray(anchor.errors) && anchor.errors.length) {
    return anchor.errors.join('；');
  }
  if (anchor.valid === false) return '校验未通过';

  return '';
}

/** 是否可勾选。三重防御：格式、书名、后端校验结果。 */
export function isSelectable(anchor) {
  return anchorBlockReason(anchor) === '';
}

/**
 * 按置信度分档。置信度不在三档内的候选单独归到 invalid，
 * 不混进任何一档，避免作者以为它是可用的。
 *
 * @returns {{sourced: Array, inferable: Array, blank: Array, invalid: Array}}
 */
export function groupCandidates(anchors) {
  const groups = { sourced: [], inferable: [], blank: [], invalid: [] };
  (Array.isArray(anchors) ? anchors : []).forEach((anchor, index) => {
    const key = anchor && TIER_KEYS.has(anchor.confidence) ? anchor.confidence : 'invalid';
    groups[key].push({ anchor, index });
  });
  return groups;
}

/**
 * 生成 import 请求体。只保留作者勾选且可选的条目，字段名对齐后端。
 */
export function buildImportPayload(anchors, selected) {
  const list = Array.isArray(anchors) ? anchors : [];
  const picked = selected && typeof selected === 'object' ? selected : {};
  return list
    .filter((anchor, index) => picked[index] === true && isSelectable(anchor))
    .map((anchor) => ({
      kind: anchor.kind,
      subject: anchor.subject,
      claim: anchor.claim,
      confidence: anchor.confidence,
      source_title: anchor.source_title || '',
      source_locator: anchor.source_locator || '',
      source_quote: anchor.source_quote || '',
      rules: Array.isArray(anchor.rules) ? anchor.rules : [],
      immutable: anchor.immutable,
      why_blank: anchor.why_blank || '',
      usable_for: anchor.usable_for || '',
    }));
}
