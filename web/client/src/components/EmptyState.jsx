import React from 'react';

/**
 * 空状态。
 *
 * 原来各处摆一方朱砂印章（「寻」），装饰比信息重。
 * 现在统一成一条墨线 + 一句提示，安静一些。
 *
 * @param {React.ReactNode} text 提示文案
 * @param {React.ReactNode} action 主操作
 * @param {string} className 容器修饰类：ct-empty-fill 撑满 / ct-empty-top 顶部留白 / ct-empty-pad 常规留白
 */
export default function EmptyState({ text, action, className = '' }) {
  return (
    <div className={`ct-empty ${className}`}>
      <span className="ct-empty-rule" aria-hidden="true" />
      <p className="ct-empty-text">{text}</p>
      {action}
    </div>
  );
}
