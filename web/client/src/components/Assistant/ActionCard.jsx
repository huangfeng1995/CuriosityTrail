import React, { useMemo, useState } from 'react';
import { Button, Checkbox, Popover } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';
import { REASON_LABEL } from './findings';

const ACTION_LABEL = {
  replace: '改写',
  append: '续写',
  insert: '插入',
  comment: '建议',
  none: '回复',
};

const PLAN_DEGRADED_LABEL = {
  invalid: '格式不合格',
  failed: '规划失败',
  timeout: '规划超时',
  error: '规划出错',
};

const ANCHOR_RULE_LABEL = {
  presence_forbidden: '人物出场禁区',
  event_forbidden: '事件禁区',
  term_forbidden: '称谓禁区',
  chronology: '时间线',
  blank_guard: '空白区护栏',
  manual_only: '需人工核对',
};

/**
 * 冲突徽标点开后的明细：每条都给原句与定位。
 * 定位优先用块 ID；生成稿还没落到块上时，用本章正文的字符偏移。
 */
function AnchorViolationList({ violations, chapterSeq }) {
  return (
    <div className="ct-violation-list">
      {violations.map((violation, index) => (
        <div
          className="ct-violation-item"
          key={`${violation.anchorId || 'a'}-${violation.offset}-${index}`}
        >
          <div className="ct-violation-quote">原句：{violation.quote || '（未记录原句）'}</div>
          <div className="ct-violation-loc">
            定位：{violation.blockId ? `块 ${violation.blockId}` : '本章正文'}
            {Number.isFinite(violation.offset) ? ` · 字符偏移 ${violation.offset}` : ''}
            {chapterSeq ? ` · 第 ${chapterSeq} 章` : ''}
          </div>
          <div className="ct-violation-rule">
            {ANCHOR_RULE_LABEL[violation.ruleType] || violation.ruleType || '规则冲突'}
            {violation.severity === 'block' ? ' · 必须处理' : ' · 可标记有意改写'}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 结构化输出卡片。
 *
 * AI 的输出分两种：
 * - comment/none：只是讨论，展开看内容，不动稿
 * - replace/append/insert：确实是正文，需要用户确认后写回
 *
 * 审稿人的 comment 若带 findings，就在正文下面列出每条意见：
 * 每条都可以勾选（未定位的全章建议同样可以），底部一次交给写手改，
 * 不用一条一条点、让写手来回改几轮。
 */
export default function ActionCard({
  action,
  content,
  reason,
  applied,
  onApply,
  onRevert,
  findings = [],
  beatCheck = null,
  planDegraded = '',
  anchorViolations = [],
  chapterSeq,
  activeFindingKey = '',
  adoptedFindingKeys,
  onAdoptFindings,
  onJumpToFinding,
}) {
  const isTextAction = ['replace', 'append', 'insert'].includes(action);
  // 空正文不渲染占位文案：卡片的 reason / findings 已经说明了情况，
  // 「（本次没有返回内容）」对作者没有信息量。
  const body = (content || '').trim();

  // 节拍与章末检查的结构化结果。徽标只占卡片内的一行元信息，
  // 不进入正文、不参与正文 34px 格线，也不改变正文列宽。
  const missingBeats = Array.isArray(beatCheck?.missing) ? beatCheck.missing : [];
  const coveredBeats = Array.isArray(beatCheck?.covered) ? beatCheck.covered.length : 0;
  const totalBeats = coveredBeats + missingBeats.length;
  const hasMeta = Boolean(planDegraded) || totalBeats > 0 || anchorViolations.length > 0;

  // 勾选顺序就是发给写手的顺序：用数组保存，Set 会丢掉顺序。
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [adopting, setAdopting] = useState(false);

  const adopted = useMemo(() => {
    if (adoptedFindingKeys instanceof Set) return adoptedFindingKeys;
    return new Set(Array.isArray(adoptedFindingKeys) ? adoptedFindingKeys : []);
  }, [adoptedFindingKeys]);

  const toggle = (key) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  const selected = findings.filter((f) => selectedKeys.includes(f.key) && !adopted.has(f.key));

  const adoptSelected = async () => {
    if (!selected.length || adopting) return;
    setAdopting(true);
    const result = await onAdoptFindings?.(selected);
    setAdopting(false);
    // 只有整批成功才清空选择；失败时保留勾选，作者可以直接重试。
    if (result?.ok) setSelectedKeys([]);
  };

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

      {hasMeta && (
        <div className="ct-action-meta">
          {/* 规划降级 / 节拍覆盖 / 史实冲突都是核对用的元信息，
              平时不该占卡片一行；收进「详情」，颜色保留原来的警示级别。 */}
          <Popover
            trigger="click"
            placement="topRight"
            title="生成详情"
            content={
              <div className="ct-action-detail">
                {planDegraded && (
                  <div>
                    规划降级：{PLAN_DEGRADED_LABEL[planDegraded] || planDegraded}
                  </div>
                )}
                {totalBeats > 0 && (
                  <div>
                    节拍覆盖：{coveredBeats}/{totalBeats}
                    {missingBeats.length > 0 && `（缺拍 ${missingBeats.join('、')}）`}
                  </div>
                )}
                {anchorViolations.length > 0 && (
                  <div>
                    <div>史实冲突 {anchorViolations.length} 条</div>
                    <AnchorViolationList
                      violations={anchorViolations}
                      chapterSeq={chapterSeq}
                    />
                  </div>
                )}
              </div>
            }
          >
            <button
              type="button"
              className={`ct-badge${
                anchorViolations.length
                  ? ' is-bad'
                  : missingBeats.length || planDegraded
                    ? ' is-warn'
                    : ' is-ok'
              }`}
            >
              详情
            </button>
          </Popover>
        </div>
      )}

      {body && <div className="ct-action-body">{body}</div>}

      {findings.length > 0 && (
        <div className="ct-finding-list">
          {findings.map((finding) => {
            const located = finding.status === 'located';
            const isAdopted = adopted.has(finding.key);
            const isSelected = selectedKeys.includes(finding.key);
            return (
              <div
                key={finding.key}
                data-finding-key={finding.key}
                className={`ct-finding${located ? '' : ' is-unlocated'}${
                  finding.key === activeFindingKey ? ' is-active' : ''
                }${isAdopted ? ' is-adopted' : ''}${isSelected ? ' is-selected' : ''}`}
                onClick={located ? () => onJumpToFinding?.(finding) : undefined}
                title={located ? '跳到正文对应位置' : undefined}
              >
                <span className="ct-finding-no">{finding.marker}</span>
                <div className="ct-finding-main">
                  <div className="ct-finding-text">{finding.text}</div>
                  {finding.quote && (
                    <div className="ct-finding-quote">原文：{finding.quote}</div>
                  )}
                  {!located && (
                    <span className="ct-finding-tag">
                      全章建议 · {REASON_LABEL[finding.reason] || '未定位'}
                    </span>
                  )}
                </div>
                <span
                  className="ct-finding-check"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isAdopted ? (
                    <span className="ct-finding-tag">已采纳</span>
                  ) : (
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggle(finding.key)}
                      aria-label={`选择第 ${finding.marker} 条意见`}
                    />
                  )}
                </span>
              </div>
            );
          })}

          <div className="ct-finding-batch">
            <Button
              size="small"
              type="primary"
              disabled={!selected.length}
              loading={adopting}
              onClick={adoptSelected}
            >
              采纳选中（{selected.length}）
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
