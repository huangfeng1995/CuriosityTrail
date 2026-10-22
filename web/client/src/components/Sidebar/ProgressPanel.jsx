import React, { useCallback, useEffect, useState } from 'react';
import {
  Progress,
  Button,
  InputNumber,
  Spin,
  Tooltip,
  Typography,
  message,
  Empty,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../../api/client';
import { formatWords } from '../../utils/wordCount';

const { Text } = Typography;

/**
 * 写作进度。
 *
 * 两条线：
 *   结构进度 —— 多少字、离目标还差多少、哪几章写完了
 *   时间进度 —— 最近每天写了多少字
 *
 * 时间进度用"每天的净增量"统计，不是"当前总字数"。
 * 从版本历史反推会出问题：回滚会产生负增量，作者看到"今天写了 -800 字"会以为程序坏了。
 */
export default function ProgressPanel({ workId, work, onWorkChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [savingTarget, setSavingTarget] = useState(false);

  const load = useCallback(async () => {
    if (!workId) return;
    setLoading(true);
    try {
      const res = await api.get(`/progress/${workId}?days=30`);
      setData(res.data);
    } catch (e) {
      message.error('进度加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => {
    load();
  }, [load]);

  const saveTarget = async (targetWords) => {
    if (!workId) return;
    setSavingTarget(true);
    try {
      await api.put(`/works/${workId}`, { targetWords });
      message.success('已更新目标字数');
      load();
      onWorkChanged?.();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setSavingTarget(false);
    }
  };

  if (!workId) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选一个作品" />;
  }

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 30 }}>
        <Spin />
      </div>
    );
  }

  if (!data) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无进度数据" />;
  }

  const { totalWords, targetWords, percent, remainingWords, chapters, timeline } = data;
  const doneCount = chapters.filter((c) => c.status === 'done').length;

  // 目标字数这一项
  const target = (
    <div className="ct-section">
      <div className="ct-stat-label">目标字数</div>
      <InputNumber
        size="small"
        min={0}
        step={10000}
        value={targetWords || undefined}
        placeholder="未设定"
        disabled={savingTarget}
        onBlur={(e) => {
          const next = Number(e.target.value) || 0;
          if (next !== (targetWords || 0)) saveTarget(next);
        }}
        onPressEnter={(e) => {
          // rc-input-number 把 onKeyDown 挂在外层 div 上，e.currentTarget 是 div、拿不到 value，
          // 必须用 e.target（触发按键的 input）
          const next = Number(e.target.value) || 0;
          if (next !== (targetWords || 0)) saveTarget(next);
        }}
        style={{ width: '100%' }}
      />
    </div>
  );

  const stats = (
    <div className="ct-section">
      <div className="ct-stat-row">
        <span className="ct-stat-value">{formatWords(totalWords)}</span>
        {targetWords > 0 && <Text type="secondary">{percent}%</Text>}
      </div>
      {targetWords > 0 ? (
        <Progress
          percent={percent}
          size="small"
          status={percent >= 100 ? 'success' : 'active'}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          设个目标字数，这里会显示完成度
        </Text>
      )}
      <div className="ct-stat-sub">
        {doneCount}/{chapters.length} 章已完成
        {remainingWords > 0 ? ` · 还差 ${formatWords(remainingWords)} 字` : ''}
        {data.avgWordsPerActiveDay > 0
          ? ` · 日均 ${formatWords(data.avgWordsPerActiveDay)} 字`
          : ''}
      </div>
    </div>
  );

  // 近 30 天写作量
  const chart = (
    <div className="ct-section">
      <div className="ct-stat-row">
        <span className="ct-stat-label" style={{ marginBottom: 0 }}>
          近 30 天
        </span>
        <Tooltip title="刷新">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={load} />
        </Tooltip>
      </div>
      {data.activeDays === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          这 30 天还没有写作记录
        </Text>
      ) : (
        <>
          <div style={{ height: 90 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={timeline} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" hide />
                <YAxis hide />
                <ChartTooltip
                  formatter={(value) => [`${value} 字`, '当日新增']}
                  labelFormatter={(label) => label}
                />
                <Bar dataKey="words" fill="var(--accent)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="ct-stat-sub" style={{ marginTop: 2 }}>
            近 30 天共 {formatWords(data.recentWords)} 字 · {data.activeDays} 天有产出
          </div>
        </>
      )}
    </div>
  );

  // 各章字数
  const chapterList = (
    <div>
      <div className="ct-stat-label">各章字数</div>
      {chapters.map((c) => (
        <div key={c.id} className="ct-chapter-row">
          <span className="ct-chapter-name" style={{ opacity: c.status === 'done' ? 0.55 : 1 }}>
            {c.title}
          </span>
          {c.hasOutline ? null : (
            <Tooltip title="这一章还没写大纲">
              <span className="ct-badge">无大纲</span>
            </Tooltip>
          )}
          <span className="ct-chapter-words">{c.words} 字</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="ct-panel">
      {target}
      {stats}
      {chart}
      {chapterList}
    </div>
  );
}
