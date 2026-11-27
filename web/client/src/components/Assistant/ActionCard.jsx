import React, { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Popover } from 'antd';
import { CheckOutlined, RollbackOutlined } from '@ant-design/icons';
import { REASON_LABEL } from './findings';
import { diffInline, renderDiff } from '../Editor/inlineDiff';

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

/** 形态缺口里每项对应的 before/after 字段与单位。 */
const SHAPE_METRIC = {
  short_sentence: ['shortSentenceRatio', '%'],
  dialogue_ratio: ['dialogueRatio', '%'],
  dialogue_low: ['dialogueRatio', '%'],
  quote_density: ['quotePerKilo', ' 处/千字'],
  imagery_density: ['imageryPerKilo', ' 处/千字'],
  generic_reference: ['genericPerKilo', ' 处/千字'],
};

function formatMetric(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return String(Math.round(num * 10) / 10);
}

/** 后台修订的状态文案：先看作者是否已处理，再看任务状态。 */
function repairStateOf(repair) {
  if (!repair) return null;
  if (repair.applied) return { key: 'applied', label: '已替换正文' };
  if (repair.dismissed) return { key: 'dismissed', label: '已保留原稿' };
  const map = {
    pending: '后台修订中…',
    running: '后台修订中…',
    done: '修订完成',
    failed: '修补未达标',
    cancelled: '已停止修补',
  };
  return { key: repair.status || '', label: map[repair.status] || repair.status || '' };
}

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
  shapeRepair = null,
  shapeShortfall = [],
  onApplyRepair,
  onKeepRepair,
  onCancelRepair,
}) {
  const isTextAction = ['replace', 'append', 'insert'].includes(action);
  // 空正文不渲染占位文案：卡片的 reason / findings 已经说明了情况，
  // 「（本次没有返回内容）」对作者没有信息量。
  const body = (content || '').trim();

  const repair = shapeRepair && shapeRepair.id ? shapeRepair : null;
  const shortfalls =
    Array.isArray(shapeShortfall) && shapeShortfall.length
      ? shapeShortfall
      : (repair && Array.isArray(repair.shortfall) ? repair.shortfall : []);
  const repairState = repairStateOf(repair);
  const repairBusy = repair && ['pending', 'running'].includes(repair.status);
  const repairDone =
    repair &&
    repair.status === 'done' &&
    !repair.applied &&
    !repair.dismissed &&
    Boolean(repair.revisedContent);
  const [repairOpen, setRepairOpen] = useState(false);
  const repairDiff = useMemo(() => {
    if (!repair || repair.status !== 'done' || !repair.revisedContent) return null;
    return diffInline(content || '', repair.revisedContent);
  }, [repair, content]);

  // 同一类指标只显示一次：短句/对白/引号/比喻/泛称各自一行。
  const repairMetrics = useMemo(() => {
    const seen = new Set();
    const rows = [];
    for (const item of shortfalls) {
      const metric = SHAPE_METRIC[item.kind];
      if (!metric || seen.has(item.kind)) continue;
      seen.add(item.kind);
      const [field, unit] = metric;
      const before = repair && repair.before ? repair.before[field] : undefined;
      const after = repair && repair.after ? repair.after[field] : undefined;
      rows.push({
        kind: item.kind,
        label: item.label || item.kind,
        before: formatMetric(before),
        after: formatMetric(after),
        unit,
      });
    }
    return rows;
  }, [shortfalls, repair]);

  // 节拍与章末检查的结构化结果。徽标只占卡片内的一行元信息，
  // 不进入正文、不参与正文 34px 格线，也不改变正文列宽。
  const missingBeats = Array.isArray(beatCheck?.missing) ? beatCheck.missing : [];
  const coveredBeats = Array.isArray(beatCheck?.covered) ? beatCheck.covered.length : 0;
  const totalBeats = coveredBeats + missingBeats.length;
  const hasMeta = Boolean(planDegraded) || totalBeats > 0 || anchorViolations.length > 0;

  // 勾选顺序就是发给写手的顺序：用数组保存，Set 会丢掉顺序。
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [adopting, setAdopting] = useState(false);

  // 失效意见由作者手动清除，不自动删；清除后记在本地，
  // 刷新再进来也不会又冒出来。只影响这一份意见的展示。
  const [clearedKeys, setClearedKeys] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('ct:cleared-findings') || '[]');
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  });

  const clearFinding = (key) => {
    setClearedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      try {
        localStorage.setItem('ct:cleared-findings', JSON.stringify([...next]));
      } catch {
        /* 本地存储不可用时只丢「刷新后不再出现」这一点 */
      }
      return next;
    });
    setSelectedKeys((prev) => prev.filter((k) => k !== key));
  };

  const adopted = useMemo(() => {
    if (adoptedFindingKeys instanceof Set) return adoptedFindingKeys;
    return new Set(Array.isArray(adoptedFindingKeys) ? adoptedFindingKeys : []);
  }, [adoptedFindingKeys]);

  // 已清除的不再参与对账、勾选与采纳。
  const visibleFindings = findings.filter((finding) => !clearedKeys.has(finding.key));
  const locatedFindings = visibleFindings.filter((finding) => finding.status === 'located');
  const otherFindings = visibleFindings.filter((finding) => finding.status !== 'located');
  const staleCount = otherFindings.filter((finding) => finding.status === 'stale').length;
  const unlocatedCount = otherFindings.length - staleCount;

  const toggle = (key) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  };

  // 正文改动会把已勾选的意见变成失效（引文找不到了）。
  // 失效条目不能再被采纳，所以状态一变就把它们从勾选里剔除——
  // 否则行上已经没有勾选框，底部还显示「采纳选中（1）」，一点就把
  // 一条不存在的原文发给写手。
  const staleSignature = findings
    .filter((finding) => finding.status === 'stale')
    .map((finding) => finding.key)
    .join('|');

  useEffect(() => {
    if (!staleSignature) return;
    const staleKeys = new Set(staleSignature.split('|'));
    setSelectedKeys((prev) => {
      const next = prev.filter((key) => !staleKeys.has(key));
      return next.length === prev.length ? prev : next;
    });
  }, [staleSignature]);

  // 采纳只算仍然可定位、且未被采纳的条目。
  const selected = visibleFindings.filter(
    (f) =>
      f.status !== 'stale' && selectedKeys.includes(f.key) && !adopted.has(f.key)
  );

  const adoptSelected = async () => {
    if (!selected.length || adopting) return;
    setAdopting(true);
    const result = await onAdoptFindings?.(selected);
    setAdopting(false);
    // 只有整批成功才清空选择；失败时保留勾选，作者可以直接重试。
    if (result?.ok) setSelectedKeys([]);
  };

  const renderFinding = (finding) => {
    const located = finding.status === 'located';
    const stale = finding.status === 'stale';
    const isAdopted = adopted.has(finding.key);
    const isSelected = selectedKeys.includes(finding.key);
    const isBlockLevel = located && finding.precision === 'block';

    return (
      <div
        key={finding.key}
        data-finding-key={finding.key}
        className={`ct-finding${located ? '' : ' is-unlocated'}${stale ? ' is-stale' : ''}${
          isBlockLevel ? ' is-block-level' : ''
        }${finding.key === activeFindingKey ? ' is-active' : ''}${
          isAdopted ? ' is-adopted' : ''
        }${isSelected ? ' is-selected' : ''}`}
        onClick={located ? () => onJumpToFinding?.(finding) : undefined}
        title={
          located
            ? isBlockLevel
              ? '跳到正文对应段落（整段级意见）'
              : '跳到正文对应原句'
            : undefined
        }
      >
        {located ? (
          <span className="ct-finding-no">{finding.marker}</span>
        ) : (
          <span className="ct-finding-no is-blank" aria-hidden="true">
            ·
          </span>
        )}
        <div className="ct-finding-main">
          <div className="ct-finding-text">{finding.text}</div>
          {finding.quote && <div className="ct-finding-quote">原文：{finding.quote}</div>}
          {stale && (
            <span className="ct-finding-tag is-stale">
              失效 · {REASON_LABEL[finding.reason] || '原文已改动'}
            </span>
          )}
          {!located && !stale && (
            <span className="ct-finding-tag">
              全章建议 · {REASON_LABEL[finding.reason] || '未定位'}
            </span>
          )}
          {isBlockLevel && (
            <span className="ct-finding-tag is-block-level">
              整段级意见 · {REASON_LABEL[finding.reason] || '原文未命中'}
            </span>
          )}
        </div>
        <span className="ct-finding-check" onClick={(e) => e.stopPropagation()}>
          {stale ? (
            <button
              type="button"
              className="ct-finding-clear"
              onClick={() => clearFinding(finding.key)}
              title="从面板清除这条失效意见，正文不受影响"
            >
              清除
            </button>
          ) : isAdopted ? (
            <span className="ct-finding-tag">已采纳</span>
          ) : (
            <Checkbox
              checked={isSelected}
              onChange={() => toggle(finding.key)}
              aria-label={`选择这条意见：${finding.text.slice(0, 12)}`}
            />
          )}
        </span>
      </div>
    );
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

      {/* 形态自检 / 后台修订：正文已经交付，这里只给缺口与可选修订版。
          修订版不自动替换，作者点「用修订版」才写回正文。 */}
      {(shortfalls.length > 0 || repair) && (
        <div className="ct-shape-repair">
          <div className="ct-shape-repair-head">
            <span className="ct-shape-repair-title">形态自检</span>
            {repairState && (
              <span className={`ct-shape-repair-state is-${repairState.key}`}>
                {repairState.label}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {repairBusy && (
              <Button size="small" onClick={onCancelRepair}>
                停止修补
              </Button>
            )}
          </div>

          {shortfalls.length > 0 && (
            <ul className="ct-shape-repair-list">
              {shortfalls.map((item) => (
                <li key={`${item.kind}-${item.text || item.label}`}>
                  {item.text || item.label || item.kind}
                </li>
              ))}
            </ul>
          )}

          {repairDone && repairMetrics.length > 0 && (
            <div className="ct-shape-repair-metrics">
              {repairMetrics.map((row) => (
                <span key={row.kind} className="ct-shape-repair-metric">
                  <span className="ct-shape-repair-metric-name">{row.label}</span>
                  {row.before}
                  {row.unit} → {row.after}
                  {row.unit}
                </span>
              ))}
            </div>
          )}

          {repair && repair.note && (
            <div className="ct-shape-repair-note">{repair.note}</div>
          )}

          {repairDone && (
            <div className="ct-compare ct-shape-repair-compare">
              <div className="ct-compare-body">
                <div className="ct-compare-row">
                  <span className="ct-compare-tag">原文</span>
                  <span className={`ct-compare-text${repairOpen ? ' is-open' : ''}`}>
                    {repairDiff ? renderDiff(repairDiff.beforeSegs, 'del') : content}
                  </span>
                </div>
                <div className="ct-compare-row">
                  <span className="ct-compare-tag is-new">修订版</span>
                  <span className={`ct-compare-text${repairOpen ? ' is-open' : ''}`}>
                    {repairDiff
                      ? renderDiff(repairDiff.afterSegs, 'add')
                      : repair.revisedContent}
                  </span>
                </div>
              </div>
              <div className="ct-compare-acts">
                <button
                  type="button"
                  className="ct-inline-btn is-quiet"
                  onClick={() => setRepairOpen((v) => !v)}
                >
                  {repairOpen ? '收起' : '展开对照'}
                </button>
                <button type="button" className="ct-inline-btn" onClick={onApplyRepair}>
                  用修订版
                </button>
                <button
                  type="button"
                  className="ct-inline-btn is-quiet"
                  onClick={onKeepRepair}
                >
                  保持原样
                </button>
              </div>
              <div className="ct-shape-repair-cost">
                修补 {repair.rounds || 0} 轮 · 调用 {repair.calls || 0} 次 · 耗时{' '}
                {((repair.durationMs || 0) / 1000).toFixed(1)}s
              </div>
            </div>
          )}

          {repair && repair.applied && (
            <div className="ct-shape-repair-done">
              已用修订版替换正文；原稿已存入历史版本，可随时回滚。
            </div>
          )}
          {repair && repair.dismissed && (
            <div className="ct-shape-repair-done">已保留原稿，修订版已丢弃。</div>
          )}
        </div>
      )}

      {visibleFindings.length > 0 && (
        <div className="ct-finding-list">
          {/* 两侧对账：列表有几条、真正进了正文沟槽几处。
              未编号的（失效/未定位）单独报，和正文编号口径一致。 */}
          <div className={`ct-finding-audit${otherFindings.length ? ' is-mismatch' : ''}`}>
            <span>
              意见 {visibleFindings.length} 条 · 正文沟槽 {locatedFindings.length} 个
            </span>
            {otherFindings.length > 0 ? (
              <span className="ct-finding-audit-warn">
                未编号 {otherFindings.length} 条（
                {[
                  staleCount ? `失效 ${staleCount}` : '',
                  unlocatedCount ? `未定位 ${unlocatedCount}` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                ），只在面板
              </span>
            ) : (
              <span className="ct-finding-audit-ok">两侧编号一一对应</span>
            )}
          </div>

          {locatedFindings.map((finding) => renderFinding(finding))}

          {otherFindings.length > 0 && (
            <div className="ct-finding-group">
              <span className="ct-finding-group-title">全章 · 未定位</span>
              <span className="ct-finding-group-count">{otherFindings.length} 条</span>
            </div>
          )}
          {otherFindings.map((finding) => renderFinding(finding))}

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
