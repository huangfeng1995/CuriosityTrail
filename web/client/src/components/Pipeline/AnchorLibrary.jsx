import React, { useCallback, useEffect, useState } from 'react';
import { Button, Spin, message } from 'antd';
import api from '../../api/client';

const KIND_LABELS = {
  event: '事件',
  person: '人物',
  time: '时间',
  place: '地点',
  office: '官职',
  custom: '其他',
};

const CONFIDENCE_LABELS = {
  sourced: '有出处',
  inferable: '可推定',
  blank: '纯空白',
};

const STATUS_TABS = [
  { key: 'pending', label: '待确认' },
  { key: 'active', label: '已启用' },
  { key: 'rejected', label: '已驳回' },
];

const SOURCE_LABELS = {
  sourced: '出处',
  inferable: '推定依据',
  blank: '空白说明',
};

/**
 * 锚点库（只读管理）。
 *
 * 锚点由 agent 在素材库里整理、用户确认后升格而来；这个页面不是录入入口，
 * 只做三件事：核对、启用、驳回。作者不需要为了开模板逐条勾选候选。
 *
 * 素材与锚点是两套数据：素材在 materials，锚点在 work_anchors，
 * 只有「用户确认后升格」这一步会把它们关联起来，不做自动双向同步。
 */
export default function AnchorLibrary({ workId }) {
  const [status, setStatus] = useState('pending');
  const [anchors, setAnchors] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async (nextStatus = status) => {
    if (!workId) return;
    setLoading(true);
    try {
      const res = await api.get(`/pipeline/${workId}/anchors`, {
        params: { status: nextStatus },
      });
      setAnchors(res.data || []);
    } catch (e) {
      message.error(e.response?.data?.error || '锚点列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId, status]);

  useEffect(() => {
    loadList(status);
  }, [workId, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeStatus = async (anchor, action) => {
    try {
      await api.post(`/pipeline/${workId}/anchors/${anchor.id}/${action}`);
      message.success(action === 'activate' ? '已启用' : '已驳回');
      loadList();
    } catch (e) {
      message.error(e.response?.data?.error || '操作失败');
    }
  };

  return (
    <div className="ct-anchor-library">
      <section className="ct-anchor-list">
        <div className="ct-anchor-list-head">
          <span className="ct-anchor-list-title">锚点库</span>
          <div className="ct-anchor-status-tabs">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`ct-anchor-status-tab${status === tab.key ? ' is-active' : ''}`}
                onClick={() => setStatus(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <p className="ct-hint">
          这里只做核对与状态变更。需要新锚点时，直接跟资料员说「帮我准备这个题材的素材」，
          由 agent 整理进素材库，你确认后再升格——不用逐条勾选候选。
        </p>

        {loading && (
          <div className="ct-loading">
            <Spin size="small" />
          </div>
        )}

        {!loading && anchors.length === 0 && (
          <p className="ct-hint">
            {status === 'pending' ? '没有待确认的锚点。' : '这一栏还没有锚点。'}
          </p>
        )}

        {anchors.map((anchor) => (
          <div key={anchor.id} className="ct-anchor-row">
            <div className="ct-anchor-main">
              <div className="ct-anchor-head">
                <span className="ct-anchor-subject">{anchor.subject}</span>
                <span className="ct-badge">{KIND_LABELS[anchor.kind] || anchor.kind}</span>
                <span className={`ct-anchor-conf is-${anchor.confidence}`}>
                  {CONFIDENCE_LABELS[anchor.confidence] || anchor.confidence}
                </span>
                {anchor.immutable && <span className="ct-badge">不可变</span>}
              </div>
              <p className="ct-anchor-claim">{anchor.claim}</p>
              {(anchor.sourceTitle || anchor.sourceLocator) && (
                <p className="ct-anchor-source">
                  {SOURCE_LABELS[anchor.confidence] || '出处'}：《
                  {anchor.sourceTitle || '未给书名'}》
                  {anchor.sourceLocator ? ` · ${anchor.sourceLocator}` : ''}
                </p>
              )}
              {anchor.sourceQuote && <p className="ct-anchor-quote">原文：{anchor.sourceQuote}</p>}
            </div>
            <div className="ct-anchor-row-actions">
              {anchor.status === 'pending' && (
                <Button
                  size="small"
                  type="primary"
                  ghost
                  onClick={() => changeStatus(anchor, 'activate')}
                >
                  启用
                </Button>
              )}
              {anchor.status !== 'rejected' && (
                <Button size="small" danger onClick={() => changeStatus(anchor, 'reject')}>
                  撤回
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
