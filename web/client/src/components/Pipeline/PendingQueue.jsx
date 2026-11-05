import React, { useCallback, useEffect, useState } from 'react';
import { Button, Spin, message } from 'antd';
import { AimOutlined, CheckOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';

const STATE_LABELS = {
  unknown: '未知',
  suspects: '怀疑',
  partial: '半知',
  knows: '已知',
  exposed: '公开',
};

const RULE_LABELS = {
  presence_forbidden: '人物不该出现',
  event_forbidden: '事件不该发生',
  term_forbidden: '用词越界',
  chronology: '时间线冲突',
  blank_guard: '空白区被写实',
  manual_only: '需人工判断',
};

/**
 * 待确认队列。
 *
 * 引擎发现但不敢自己生效的两类东西都在这里：
 *   1. 知情变化（knows/exposed，或证据句/跳级校验不过）
 *   2. 章末锚点冲突
 * 每条都给原句和「定位」，作者能看到它发生在哪一章、哪一句。
 */
export default function PendingQueue({ workId }) {
  const navigate = useNavigate();
  const [data, setData] = useState({ knowledge: [], violations: [], anchors: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    if (!workId) return;
    setLoading(true);
    try {
      const res = await api.get(`/pipeline/${workId}/pending`);
      setData({
        knowledge: res.data?.knowledge || [],
        violations: res.data?.violations || [],
        anchors: res.data?.anchors || [],
      });
    } catch (e) {
      message.error(e.response?.data?.error || '待确认列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    load();
  }, [load]);

  const locate = (row) => {
    if (!row.chapterId) {
      message.info('这条记录没有关联章节，可能是章节已被删除');
      return;
    }
    navigate(`/works/${workId}?chapter=${row.chapterId}`);
  };

  const confirmKnowledge = async (row) => {
    setBusy(row.id);
    try {
      await api.post(`/pipeline/${workId}/pending/knowledge/${row.id}/confirm`);
      message.success('已确认，写入知情矩阵');
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || '确认失败');
    } finally {
      setBusy('');
    }
  };

  const dismissKnowledge = async (row) => {
    setBusy(row.id);
    try {
      await api.post(`/pipeline/${workId}/pending/knowledge/${row.id}/dismiss`);
      message.success('已驳回，不改知情矩阵');
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || '驳回失败');
    } finally {
      setBusy('');
    }
  };

  const dismissViolation = async (row) => {
    setBusy(row.id);
    try {
      await api.post(`/pipeline/${workId}/violations/${row.id}/dismiss`);
      message.success('已标记为有意改写');
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || '驳回失败');
    } finally {
      setBusy('');
    }
  };

  const confirmAllKnowledge = async (rows) => {
    const ids = rows.map((row) => row.id);
    if (!ids.length) return;
    setBusy('batch');
    try {
      const res = await api.post(`/pipeline/${workId}/pending/knowledge/confirm-batch`, { ids });
      const skipped = res.data?.skipped?.length || 0;
      message.success(
        `已确认 ${res.data?.confirmed ?? 0} 条${skipped ? `，${skipped} 条校验未过已跳过` : ''}`
      );
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || '批量确认失败');
    } finally {
      setBusy('');
    }
  };

  const confirmAnchors = async (rows) => {
    const ids = rows.map((row) => row.id);
    if (!ids.length) return;
    setBusy('anchors');
    try {
      const res = await api.post(`/pipeline/${workId}/anchors/activate-batch`, { ids });
      const skipped = res.data?.skipped?.length || 0;
      message.success(
        `已启用 ${res.data?.activated ?? 0} 条锚点${skipped ? `，${skipped} 条已跳过` : ''}`
      );
      await load();
    } catch (e) {
      message.error(e.response?.data?.error || '批量启用失败');
    } finally {
      setBusy('');
    }
  };

  const total = data.knowledge.length + data.violations.length + data.anchors.length;
  const confirmable = data.knowledge.filter((row) => row.characterId && row.factId);

  return (
    <div className="ct-pending">
      <div className="ct-pending-toolbar">
        <span className="ct-pending-summary">
          {loading ? '正在读取…' : `共 ${total} 条待确认`}
        </span>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
          刷新
        </Button>
      </div>

      {loading && (
        <div className="ct-loading">
          <Spin size="small" />
        </div>
      )}

      {!loading && total === 0 && (
        <p className="ct-hint">
          没有待确认的条目。正文写完后，知情变化与锚点冲突会出现在这里。
        </p>
      )}

      {!loading && data.anchors.length > 0 && (
        <section className="ct-pending-section">
          <div className="ct-pending-head">
            <span className="ct-pending-title">锚点草稿</span>
            <span className="ct-pending-count">{data.anchors.length} 条</span>
            <span className="ct-pending-hint">
              由素材升格而来；启用后才进入写作上下文，驳回则丢弃
            </span>
            <Button
              size="small"
              type="primary"
              ghost
              icon={<CheckOutlined />}
              loading={busy === 'anchors'}
              onClick={() => confirmAnchors(data.anchors)}
              style={{ marginLeft: 'auto' }}
            >
              全部启用（{data.anchors.length}）
            </Button>
          </div>
          {data.anchors.map((row) => (
            <div key={row.id} className="ct-pending-row">
              <div className="ct-pending-main">
                <div className="ct-pending-line">
                  <span className="ct-pending-subject">{row.subject}</span>
                  <span className="ct-anchor-tier-hint">
                    {row.kind} · {row.confidence === 'sourced' ? '有出处' : '可推定'}
                  </span>
                  {row.rules?.length ? (
                    <span className="ct-anchor-tier-hint">
                      {row.rules.map((rule) => RULE_LABELS[rule.ruleType || rule.rule_type] || rule.rule_type).join(' / ')}
                    </span>
                  ) : null}
                </div>
                <p className="ct-pending-reason">{row.claim}</p>
                {row.sourceTitle ? (
                  <p className="ct-anchor-quote">
                    出处：{row.sourceTitle}
                    {row.sourceLocator ? ` · ${row.sourceLocator}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="ct-anchor-row-actions">
                <Button
                  size="small"
                  type="primary"
                  ghost
                  icon={<CheckOutlined />}
                  loading={busy === row.id}
                  onClick={() => confirmAnchors([row])}
                >
                  启用
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {!loading && data.knowledge.length > 0 && (
        <section className="ct-pending-section">
          <div className="ct-pending-head">
            <span className="ct-pending-title">知情变化</span>
            <span className="ct-pending-count">{data.knowledge.length} 条</span>
            <span className="ct-pending-hint">确认后才写入知情矩阵；驳回只丢弃这一条候选</span>
            {confirmable.length > 0 && (
              <Button
                size="small"
                type="primary"
                ghost
                icon={<CheckOutlined />}
                loading={busy === 'batch'}
                onClick={() => confirmAllKnowledge(confirmable)}
                style={{ marginLeft: 'auto' }}
              >
                全部确认（{confirmable.length}）
              </Button>
            )}
          </div>
          {data.knowledge.map((row) => {
            const canConfirm = Boolean(row.characterId && row.factId);
            return (
              <div key={row.id} className="ct-pending-row">
                <div className="ct-pending-main">
                  <div className="ct-pending-line">
                    <span className="ct-pending-subject">{row.characterName}</span>
                    <span className="ct-pending-fact">{row.factLabel}</span>
                    <span className="ct-pending-transition">
                      {STATE_LABELS[row.fromState] || row.fromState} →{' '}
                      {STATE_LABELS[row.toState] || row.toState}
                    </span>
                    <span className="ct-anchor-tier-hint">第 {row.chapterSeq} 章</span>
                    {row.source === 'model_only' && (
                      <span className="ct-pending-source">低可信 · 需人工核对</span>
                    )}
                  </div>
                  <p className="ct-pending-reason">{row.reason}</p>
                  {row.evidence && <p className="ct-anchor-quote">原句：{row.evidence}</p>}
                  {!canConfirm && (
                    <p className="ct-anchor-error">
                      角色或事实没能对应到库里，不能确认；先补齐人物/事实再重扫。
                    </p>
                  )}
                </div>
                <div className="ct-anchor-row-actions">
                  <Button
                    size="small"
                    icon={<AimOutlined />}
                    onClick={() => locate(row)}
                  >
                    定位
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    ghost
                    icon={<CheckOutlined />}
                    disabled={!canConfirm}
                    loading={busy === row.id}
                    onClick={() => confirmKnowledge(row)}
                  >
                    确认
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<CloseOutlined />}
                    loading={busy === row.id}
                    onClick={() => dismissKnowledge(row)}
                  >
                    驳回
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {!loading && data.violations.length > 0 && (
        <section className="ct-pending-section">
          <div className="ct-pending-head">
            <span className="ct-pending-title">锚点冲突</span>
            <span className="ct-pending-count">{data.violations.length} 条</span>
            <span className="ct-pending-hint">block 级必须改正文；warn 级可标记为有意改写</span>
          </div>
          {data.violations.map((row) => {
            const blocked = row.severity === 'block';
            return (
              <div key={row.id} className={`ct-pending-row${blocked ? ' is-block' : ''}`}>
                <div className="ct-pending-main">
                  <div className="ct-pending-line">
                    <span className={`ct-pending-sev is-${row.severity}`}>
                      {blocked ? '硬冲突' : '提示'}
                    </span>
                    <span className="ct-pending-subject">
                      {RULE_LABELS[row.ruleType] || row.ruleType}
                    </span>
                    <span className="ct-anchor-tier-hint">
                      第 {row.chapterSeq ?? '?'} 章{row.chapterTitle ? ` · ${row.chapterTitle}` : ''}
                    </span>
                  </div>
                  {row.detail && <p className="ct-pending-reason">锚点：{row.detail}</p>}
                  <p className="ct-anchor-quote">原句：{row.quote}</p>
                </div>
                <div className="ct-anchor-row-actions">
                  <Button size="small" icon={<AimOutlined />} onClick={() => locate(row)}>
                    定位
                  </Button>
                  <Button
                    size="small"
                    danger
                    icon={<CloseOutlined />}
                    disabled={blocked}
                    title={blocked ? 'block 级冲突必须改写正文' : '标记为有意改写'}
                    loading={busy === row.id}
                    onClick={() => dismissViolation(row)}
                  >
                    {blocked ? '不可驳回' : '有意改写'}
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
