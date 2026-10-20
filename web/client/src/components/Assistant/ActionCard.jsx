import React from 'react';
import { Button, Typography } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';

const { Text } = Typography;

const ACTION_LABEL = {
  replace: '改写',
  append: '续写',
  insert: '插入',
  comment: '建议',
  none: '回复',
};

/**
 * 结构化输出卡片。
 *
 * AI 的输出分两种：
 * - comment/none：只是讨论，展开看内容，不动稿
 * - replace/append/insert：确实是正文，需要用户确认后写回
 */
export default function ActionCard({ action, content, reason, applied, onApply, onRevert }) {
  const isTextAction = ['replace', 'append', 'insert'].includes(action);

  return (
    <div
      style={{
        marginTop: 8,
        border: '1px solid rgba(128,128,128,0.2)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          background: 'rgba(128,128,128,0.08)',
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>{ACTION_LABEL[action] || '回复'}</span>
        {reason && <Text type="secondary">{reason}</Text>}
        <span style={{ flex: 1 }} />
        {isTextAction && !applied && (
          <Button size="small" type="primary" icon={<CheckOutlined />} onClick={onApply}>
            应用到正文
          </Button>
        )}
        {isTextAction && applied && (
          <Button size="small" icon={<RollbackOutlined />} onClick={onRevert}>
            撤销
          </Button>
        )}
      </div>

      <div
        style={{
          padding: '10px 12px',
          fontSize: 14,
          lineHeight: 1.85,
          whiteSpace: 'pre-wrap',
          maxHeight: 320,
          overflowY: 'auto',
          fontFamily: 'Noto Serif SC, serif',
        }}
      >
        {content}
      </div>
    </div>
  );
}
