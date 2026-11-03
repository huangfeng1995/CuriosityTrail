import React from 'react';
import { Button } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';
import { REASON_LABEL } from './findings';

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
 *
 * 审稿人的 comment 若带 findings，就在正文下面列出每条意见：
 * 可定位的直接给「采纳」，未定位的标「全章建议」并说明降级原因。
 */
export default function ActionCard({
  action,
  content,
  reason,
  applied,
  onApply,
  onRevert,
  findings = [],
  activeFindingKey = '',
  onAdoptFinding,
  onJumpToFinding,
}) {
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

      <div className="ct-action-body">
        {(content || '').trim() || '（本次没有返回内容）'}
      </div>

      {findings.length > 0 && (
        <div className="ct-finding-list">
          {findings.map((finding) => {
            const located = finding.status === 'located';
            return (
              <div
                key={finding.key}
                data-finding-key={finding.key}
                className={`ct-finding${located ? '' : ' is-unlocated'}${
                  finding.key === activeFindingKey ? ' is-active' : ''
                }`}
                onClick={located ? () => onJumpToFinding?.(finding) : undefined}
                title={located ? '跳到正文对应位置' : undefined}
              >
                <span className="ct-finding-no">{finding.marker}</span>
                <div className="ct-finding-main">
                  <div className="ct-finding-text">{finding.text}</div>
                  {finding.quote && (
                    <div className="ct-finding-quote">原文：{finding.quote}</div>
                  )}
                  {located ? (
                    <Button
                      size="small"
                      className="ct-finding-adopt"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAdoptFinding?.(finding);
                      }}
                    >
                      采纳
                    </Button>
                  ) : (
                    <span className="ct-finding-tag">
                      全章建议 · {REASON_LABEL[finding.reason] || '未定位'}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
