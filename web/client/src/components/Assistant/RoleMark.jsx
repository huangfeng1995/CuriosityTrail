import React from 'react';

/**
 * 五个 AI 角色的专属线描图标。
 *
 * 服务端下发的 role.icon 是 emoji（✍️🔍📐📚💡），在宣纸/墨色体系里
 * 像贴纸：大小不受控、各平台字形不同、和周围线描图标不同源。
 * 前端统一按 role.key 覆盖，绝不渲染服务端那份 emoji；
 * 认不出的 key 落到「星芒」兜底，也不会把 emoji 漏出来。
 *
 * 笔触与收起条的 AssistantMark 同源：24 网格、纯描边、currentColor、
 * 选中态颜色由父级 .ct-role-tab 决定，图标自己不写颜色。
 */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

const GLYPHS = {
  // 写手：钢笔尖，中缝开到笔锋——「把思路变成正文」
  writer: (
    <>
      <path d="M11 21.8 C 8.3 18.6 6 15.5 6 12.1 C 6 8.9 7.9 6.3 11 3.5 C 14.1 6.3 16 8.9 16 12.1 C 16 15.5 13.7 18.6 11 21.8 Z" />
      <path d="M11 12.9 L11 20.9" />
    </>
  ),
  // 审稿人：放大镜里一道被审视的行——挑毛病
  critic: (
    <>
      <circle cx="10.6" cy="10.6" r="5.6" />
      <path d="M14.7 14.7 L20.2 20.2" />
      <path d="M8.2 10.6 L13 10.6" />
    </>
  ),
  // 编辑：左侧书脊括住三条长短不一的行——结构、节奏、把关
  editor: (
    <>
      <path d="M7.2 4 H4.4 V20 H7.2" />
      <path d="M9.2 8 H20.2" />
      <path d="M9.2 12 H17.2" />
      <path d="M9.2 16 H18.6" />
    </>
  ),
  // 资料员：合上的资料册 + 书签——搜素材、查资料
  researcher: (
    <>
      <path d="M5.4 4.6 H15.4 C 16.5 4.6 17.4 5.5 17.4 6.6 V19.4 H7.4 C 6.3 19.4 5.4 18.5 5.4 17.4 Z" />
      <path d="M5.4 17.4 C 5.4 16.3 6.3 15.4 7.4 15.4 H17.4" />
      <path d="M13.4 4.8 V10.6 L11.4 9.2 L9.4 10.6 V4.8" />
    </>
  ),
  // 灵感师：一大两小的星火——给方向而不是成品
  inspiler: (
    <>
      <path d="M10.2 7.4 L11.6 10.4 L14.6 11.8 L11.6 13.2 L10.2 16.2 L8.8 13.2 L5.8 11.8 L8.8 10.4 Z" />
      <path d="M18.2 3.4 L18.9 5.1 L20.6 5.8 L18.9 6.5 L18.2 8.2 L17.5 6.5 L15.8 5.8 L17.5 5.1 Z" />
      <path d="M18.4 16.2 L18.8 17.3 L19.9 17.7 L18.8 18.1 L18.4 19.2 L18 18.1 L16.9 17.7 L18 17.3 Z" />
    </>
  ),
};

// 未知角色：一枚单星，和灵感师的大星同形，不引入新形状
const FALLBACK = (
  <path d="M12 4.4 L13.9 9.1 L18.6 11 L13.9 12.9 L12 17.6 L10.1 12.9 L5.4 11 L10.1 9.1 Z" />
);

export default function RoleMark({ roleKey, size = 14, className = '' }) {
  return (
    <svg
      className={`ct-role-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      {...STROKE}
    >
      {GLYPHS[roleKey] || FALLBACK}
    </svg>
  );
}
