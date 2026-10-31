import React, { useCallback, useEffect, useState } from 'react';
import { Tabs, Spin, Empty, Typography, Segmented, Progress, Tooltip } from 'antd';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import api from '../api/client';
import EmptyState from '../components/EmptyState';
import { formatWords } from '../utils/wordCount';

const { Text } = Typography;

/**
 * 写作统计。
 *
 * 三块内容，分三个标签页：
 *   统计 —— 跨全部作品的写作量（原有进度面板只管单部作品）
 *   指纹 —— 从正文统计出的风格特征。数字每次算出来都一样，
 *           所以能当基线用；模型评价做不到这一点。
 *   徽章 —— 里程碑类的成就，全是作者自己能核对的事实。
 */

const PERIODS = [
  { label: '按日', value: 'day' },
  { label: '按周', value: 'week' },
  { label: '按月', value: 'month' },
  { label: '按年', value: 'year' },
];

/**
 * 一个数字卡片。
 */
function StatCard({ label, value, sub }) {
  return (
    <div className="ct-insight-card">
      <div className="ct-insight-card-label">{label}</div>
      <div className="ct-insight-card-value">{value}</div>
      {sub && <div className="ct-insight-card-sub">{sub}</div>}
    </div>
  );
}

/**
 * 统计页主体。
 */
function StatsTab() {
  const [period, setPeriod] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/insights/stats?period=${period}`);
      setData(res.data);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="ct-insight-loading">
        <Spin />
      </div>
    );
  }

  if (!data) {
    return <EmptyState className="ct-empty-pad" text="统计加载失败，稍后再试" />;
  }

  const hasOutput = data.timeline.some((d) => d.words > 0);

  return (
    <>
      <div className="ct-insight-cards">
        <StatCard
          label="累计字数"
          value={formatWords(data.totalWords)}
          sub={
            data.targetWords > 0
              ? `目标 ${formatWords(data.targetWords)} 字 · 完成 ${data.percent}%`
              : `${data.workCount} 部作品 · ${data.chapterCount} 章`
          }
        />
        <StatCard
          label="连续写作"
          value={`${data.streak} 天`}
          sub={`最长纪录 ${data.longestStreak} 天`}
        />
        <StatCard
          label="有产出的日子"
          value={`${data.activeDays} 天`}
          sub={
            data.avgWordsPerActiveDay > 0
              ? `日均 ${formatWords(data.avgWordsPerActiveDay)} 字`
              : '还没有记录'
          }
        />
        <StatCard
          label="完成章节"
          value={`${data.doneChapters}/${data.chapterCount}`}
          sub={`累计落笔 ${data.totalEdits} 次`}
        />
      </div>

      <div className="ct-insight-section">
        <div className="ct-insight-section-head">
          <span className="ct-insight-section-title">写作量</span>
          <Segmented
            size="small"
            value={period}
            options={PERIODS}
            onChange={(v) => setPeriod(v)}
          />
        </div>

        {!hasOutput ? (
          <Text type="secondary" style={{ fontSize: 13 }}>
            这段时间还没有写作记录。写点字，曲线就出来了。
          </Text>
        ) : (
          <>
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.timeline} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.25} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} width={46} />
                  <ChartTooltip
                    formatter={(value) => [`${value} 字`, '新增']}
                    labelFormatter={(label) => label}
                  />
                  <Bar dataKey="words" fill="var(--accent)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="ct-insight-note">
              共 {formatWords(data.totalAdded)} 字 · 平均每次落笔{' '}
              {data.avgWordsPerEdit > 0 ? `${data.avgWordsPerEdit} 字` : '—'}
            </div>
          </>
        )}
      </div>

      {data.works.length > 0 && (
        <div className="ct-insight-section">
          <div className="ct-insight-section-title">各作品篇幅</div>
          <div className="ct-insight-works">
            {data.works.map((w) => (
              <div key={w.id} className="ct-insight-work">
                <span className="ct-insight-work-title">{w.title}</span>
                <span className="ct-insight-work-meta">
                  {w.chapterCount} 章 · {formatWords(w.words)} 字
                </span>
                {w.targetWords > 0 && (
                  <Progress
                    percent={Math.min(100, Math.round((w.words / w.targetWords) * 100))}
                    size="small"
                    showInfo={false}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 写作指纹页。
 *
 * 每个数字背后都有可复算的规则，所以作者可以自己核：
 * 句长就是按句末标点切出来求平均，对白占比就是引号内字数除以全文字数。
 */
function FingerprintTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .get('/insights/fingerprint')
      .then((res) => alive && setData(res.data))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="ct-insight-loading">
        <Spin />
      </div>
    );
  }

  if (!data || !data.sampleWords) {
    return (
      <EmptyState
        className="ct-empty-pad"
        text="还没有正文可以分析。写上几千字，风格特征就出来了。"
      />
    );
  }

  const sensoryEntries = Object.entries(data.sensory || {});
  const maxSensory = Math.max(1, ...sensoryEntries.map(([, v]) => v));

  return (
    <>
      <div className="ct-insight-section">
        <div className="ct-insight-section-title">风格速写</div>
        {data.labels?.length > 0 ? (
          <div className="ct-insight-labels">
            {data.labels.map((l) => (
              <span key={l.key} className="ct-insight-label">
                {l.text}
              </span>
            ))}
          </div>
        ) : (
          <Text type="secondary" style={{ fontSize: 13 }}>
            样本还太少，暂时给不出稳定的结论。
          </Text>
        )}
        <div className="ct-insight-note">
          统计自 {data.sampleChapters} 章 · {formatWords(data.sampleWords)} 字
        </div>
      </div>

      <div className="ct-insight-cards">
        <StatCard label="平均句长" value={`${data.avgSentenceLength} 字`} sub={`共 ${data.sentenceCount} 句`} />
        <StatCard label="平均段长" value={`${data.avgParagraphLength} 字`} sub={`共 ${data.paragraphCount} 段`} />
        <StatCard label="对白占比" value={`${data.dialogueRatio}%`} sub={`短句占 ${data.shortSentenceRatio}%`} />
        <StatCard
          label="最长句"
          value={`${data.longestSentence} 字`}
          sub={`最长段 ${data.longestParagraph} 字`}
        />
      </div>

      <div className="ct-insight-section">
        <div className="ct-insight-section-title">标点偏好（每千字）</div>
        <div className="ct-insight-bars">
          {Object.entries(data.punctuation || {}).map(([name, value]) => {
            const max = Math.max(1, ...Object.values(data.punctuation));
            return (
              <div key={name} className="ct-insight-bar-row">
                <span className="ct-insight-bar-label">{name}</span>
                <span className="ct-insight-bar-track">
                  <span
                    className="ct-insight-bar-fill"
                    style={{ width: `${Math.min(100, (value / max) * 100)}%` }}
                  />
                </span>
                <span className="ct-insight-bar-value">{value}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ct-insight-section">
        <div className="ct-insight-section-title">感官细节（每千字）</div>
        <div className="ct-insight-bars">
          {sensoryEntries.map(([name, value]) => (
            <div key={name} className="ct-insight-bar-row">
              <span className="ct-insight-bar-label">{name}</span>
              <span className="ct-insight-bar-track">
                <span
                  className="ct-insight-bar-fill"
                  style={{ width: `${Math.min(100, (value / maxSensory) * 100)}%` }}
                />
              </span>
              <span className="ct-insight-bar-value">{value}</span>
            </div>
          ))}
        </div>
      </div>

      {data.topWords?.length > 0 && (
        <div className="ct-insight-section">
          <div className="ct-insight-section-title">高频词</div>
          <div className="ct-insight-labels">
            {data.topWords.map((w) => (
              <Tooltip key={w.word} title={`出现 ${w.count} 次`}>
                <span className="ct-insight-label is-word">
                  {w.word}
                  <span className="ct-insight-label-count">{w.count}</span>
                </span>
              </Tooltip>
            ))}
          </div>
          <div className="ct-insight-note">
            按二字词近似统计，仅供参考——中文没有空格分词，这里是粗略计数。
          </div>
        </div>
      )}
    </>
  );
}

/**
 * 徽章页。
 */
function BadgesTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .get('/insights/badges')
      .then((res) => alive && setData(res.data))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="ct-insight-loading">
        <Spin />
      </div>
    );
  }

  if (!data) {
    return <EmptyState className="ct-empty-pad" text="徽章加载失败" />;
  }

  const unlocked = data.badges.filter((b) => b.unlocked);
  const locked = data.badges.filter((b) => !b.unlocked);

  return (
    <>
      <div className="ct-insight-section-head">
        <span className="ct-insight-section-title">
          已点亮 {data.unlockedCount} / {data.totalCount}
        </span>
      </div>

      {unlocked.length > 0 && (
        <div className="ct-insight-badges">
          {unlocked.map((b) => (
            <div key={b.id} className="ct-insight-badge is-on">
              <div className="ct-insight-badge-name">{b.name}</div>
              <div className="ct-insight-badge-desc">{b.desc}</div>
            </div>
          ))}
        </div>
      )}

      {locked.length > 0 && (
        <div className="ct-insight-section">
          <div className="ct-insight-section-title">未解锁</div>
          <div className="ct-insight-badges">
            {locked.map((b) => (
              <div key={b.id} className="ct-insight-badge">
                <div className="ct-insight-badge-name">{b.name}</div>
                <div className="ct-insight-badge-desc">{b.desc}</div>
                <Progress
                  percent={b.percent}
                  size="small"
                  format={() => `${b.current} / ${b.threshold}`}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default function StatsPage() {
  return (
    <div className="ct-page">
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">写作统计</h2>
          <p className="ct-page-sub">跨全部作品的写作量、风格特征与成就</p>
        </div>
      </div>

      <Tabs
        defaultActiveKey="stats"
        items={[
          { key: 'stats', label: '统计', children: <StatsTab /> },
          { key: 'fingerprint', label: '写作指纹', children: <FingerprintTab /> },
          { key: 'badges', label: '徽章', children: <BadgesTab /> },
        ]}
      />
    </div>
  );
}
