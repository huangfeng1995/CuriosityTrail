import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * 轻量 Markdown 渲染。
 *
 * 只用在「给人看」的地方（目前是设定预览）：作者把材等表、规则表直接写成
 * Markdown，这里按表格渲染出来，而不是把一串竖线原样摊在输入框里。
 *
 * 走 GFM 是为了表格、删除线这些常用写法；不开启原始 HTML——
 * 设定内容来自作者自己，但没必要为此放开一个 HTML 注入面。
 * 表格外面包一层横向滚动容器：七列表格在弹窗里放不下时可以左右划，
 * 不会把弹窗撑破，也不会把单元格挤成竖排。
 */
export default function Markdown({ children, className = '' }) {
  return (
    <div className={`ct-md${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          table: ({ node, ...props }) => (
            <div className="ct-md-table-wrap" tabIndex={0}>
              <table {...props} />
            </div>
          ),
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  );
}
