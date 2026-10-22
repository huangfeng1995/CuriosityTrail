import React from 'react';
import { Button } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';

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
    <div className={`ct-action-card${applied ? ' is-applied' : ''}`}>
      <div className="ct-action-head">
        <span className="ct-action-label">{ACTION_LABEL[action] || '回复'}</span>
        {reason && <span className="ct-action-reason">{reason}</span>}
        <span style={{ flex: 1 }} />
        {isTextAction && !applied && (
          <Button size="small" type="primary" icon={<CheckOutlined />} onClick={onApply}>
            应用到正文
          </Button>
        )}
        {isTextAction && applied && (
          <>
            <span className="ct-action-applied">已写入</span>
            <Button size="small" icon={<RollbackOutlined />} onClick={onRevert}>
              撤销
            </Button>
          </>
        )}
      </div>

      <div className="ct-action-body">{content}</div>
    </div>
  );
}
