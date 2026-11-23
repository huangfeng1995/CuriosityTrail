import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Spin, message } from 'antd';
import api from '../../api/client';

const CATEGORY_LABELS = {
  institution: '制度',
  evidence: '证据',
  time: '时间',
  human: '人物',
};

const SEVERITY_LABELS = {
  block: '硬冲突',
  warn: '需留意',
};

/**
 * 设定压力测试的风险清单（HP9）。
 *
 * 独立页面而不是左栏：每条风险要同时展示「最早第几章穿帮」、具体机制与修补方向，
 * 作者得读完才能判断要不要采纳；260px 的侧栏放不下。
 *
 * 这里只做三件事：跑测试、采纳（写设定/情节卡）、忽略。测试本身不改任何设定。
 */
export default function RiskList({ workId }) {
  const [risks, setRisks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const [missingCategories, setMissingCategories] = useState([]);

  const loadRisks = useCallback(async () => {
    if (!workId) return;
    setLoading(true);
    try {
      const res = await api.get(`/pipeline/${workId}/risks`, { params: { status: 'all' } });
      setRisks(res.data?.risks || []);
    } catch (e) {
      message.error(e.response?.data?.error || '风险清单加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    loadRisks();
  }, [loadRisks]);

  const runTest = async () => {
    setRunning(true);
    setNotice('');
    setMissingCategories([]);
    try {
      const res = await api.post(`/pipeline/${workId}/risks/test`);
      const data = res.data || {};
      setRisks(data.risks || []);
      setNotice(data.notice || '');
      setMissingCategories(data.missingCategories || []);
      if (!data.failed) message.success(`压力测试完成，${(data.risks || []).length} 条风险`);
    } catch (e) {
      message.error(e.response?.data?.error || '压力测试失败');
    } finally {
      setRunning(false);
      loadRisks();
    }
  };

  const adopt = async (risk, target) => {
    try {
      await api.post(`/pipeline/${workId}/risks/${risk.id}/adopt`, { target });
      message.success(target === 'plot' ? '已写成情节卡' : '已写成设定卡');
      loadRisks();
    } catch (e) {
      message.error(e.response?.data?.error || '采纳失败');
    }
  };

  const dismiss = async (risk) => {
    try {
      await api.post(`/pipeline/${workId}/risks/${risk.id}/dismiss`);
      message.success('已忽略');
      loadRisks();
    } catch (e) {
      message.error(e.response?.data?.error || '操作失败');
    }
  };

  const openRisks = risks.filter((risk) => risk.status === 'open');
  const handledRisks = risks.filter((risk) => risk.status !== 'open');

  return (
    <div className="ct-anchor-library">
      <section className="ct-anchor-list">
        <div className="ct-anchor-list-head">
          <span className="ct-anchor-list-title">设定风险清单</span>
          <Button type="primary" loading={running} onClick={runTest}>
            运行设定压力测试
          </Button>
        </div>

        <p className="ct-hint">
          开写前用作品设定、人物卡、大纲做一次压力测试：只列「可能穿帮」的位置与修补方向，
          不会改设定、也不会阻断写作。采纳后才会写成设定卡或情节卡。
        </p>

        {notice && <p className="ct-hint">{notice}</p>}
        {missingCategories.length > 0 && (
          <p className="ct-hint">
            缺少分类：{missingCategories.map((c) => CATEGORY_LABELS[c] || c).join('、')}
          </p>
        )}

        {loading && (
          <div className="ct-loading">
            <Spin size="small" />
          </div>
        )}

        {!loading && risks.length === 0 && (
          <Empty description="还没有风险清单，点上面的按钮跑一次" />
        )}

        {openRisks.map((risk) => (
          <div key={risk.id} className="ct-anchor-row">
            <div className="ct-anchor-main">
              <div className="ct-anchor-head">
                <span className="ct-anchor-subject">{risk.title}</span>
                <span className="ct-badge">{risk.categoryLabel}</span>
                <span className={`ct-anchor-conf${risk.severity === 'block' ? ' is-sourced' : ''}`}>
                  {SEVERITY_LABELS[risk.severity] || risk.severity}
                </span>
                <span className="ct-badge">最早第 {risk.earliestBreakChapter} 章穿帮</span>
              </div>
              <p className="ct-hint">{risk.detail}</p>
              {risk.fix && <p className="ct-hint">修补方向：{risk.fix}</p>}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <Button size="small" onClick={() => adopt(risk, 'setting')}>
                  采纳为设定
                </Button>
                <Button size="small" onClick={() => adopt(risk, 'plot')}>
                  采纳为情节卡
                </Button>
                <Button size="small" type="text" onClick={() => dismiss(risk)}>
                  忽略
                </Button>
              </div>
            </div>
          </div>
        ))}

        {handledRisks.length > 0 && (
          <>
            <p className="ct-hint" style={{ marginTop: 16 }}>
              已处理 {handledRisks.length} 条
            </p>
            {handledRisks.map((risk) => (
              <div key={risk.id} className="ct-anchor-row" style={{ opacity: 0.65 }}>
                <div className="ct-anchor-main">
                  <div className="ct-anchor-head">
                    <span className="ct-anchor-subject">{risk.title}</span>
                    <span className="ct-badge">
                      {risk.status === 'accepted' ? '已采纳' : '已忽略'}
                    </span>
                    <span className="ct-badge">最早第 {risk.earliestBreakChapter} 章</span>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </section>
    </div>
  );
}
