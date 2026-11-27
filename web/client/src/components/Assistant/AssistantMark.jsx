import React from 'react';

/**
 * AI 写作助手的专属标识：钢笔尖 + 一点朱砂星芒。
 *
 * 之前右栏收起后用的是 PanelRight（方框加一条竖线），那是「收起侧栏」的
 * 通用符号，说的是布局动作，不是「这里有 AI」。这里换成笔尖——
 * 和顶栏品牌标识的钢笔尖同一母题——星芒取朱砂，表示「替作者落笔」。
 *
 * 15px 是侧栏与顶栏图标的既有档位：星芒必须单独着色，
 * 所以用内联 SVG 而不是图标库新增依赖。
 */
export default function AssistantMark({ size = 15, className = '' }) {
  return (
    <svg
      className={`ct-ai-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 笔尖：上宽下收，中缝一直开到笔尖 */}
      <path d="M10.7 22.2 C 8.0 18.9 5.6 15.7 5.6 12.2 C 5.6 9.0 7.5 6.4 10.7 3.6 C 13.9 6.4 15.8 9.0 15.8 12.2 C 15.8 15.7 13.4 18.9 10.7 22.2 Z" />
      <path d="M10.7 13.2 L10.7 21.2" />
      {/* 星芒：四角凹边的星，实心朱砂 */}
      <path
        className="ct-ai-mark-spark"
        d="M18.6 1.5 L19.7 4.0 L22.2 5.1 L19.7 6.2 L18.6 8.7 L17.5 6.2 L15.0 5.1 L17.5 4.0 Z"
        fill="var(--cinnabar)"
        stroke="none"
      />
    </svg>
  );
}
