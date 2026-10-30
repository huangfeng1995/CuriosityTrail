import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Form,
  message,
  List,
  Typography,
  Popconfirm,
  Radio,
  Select,
  Tag,
  Spin,
  Alert,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import api from '../api/client';
import EmptyState from '../components/EmptyState';

const { Text, Paragraph } = Typography;

/**
 * 文风参照。
 *
 * 作者在这里存下「我心中的好文章」和「我讨厌的文章」，系统把它蒸馏成
 * 可执行的规则（句长区间 / 对白占比 / 比喻密度 / 禁用词表），
 * 规则常驻注入 AI 上下文，AI 写完还能自己核一遍。
 *
 * **样例原文不会留下**：粘贴的原文只送到蒸馏那一步就丢掉了。
 * 粘贴的原文很可能来自别人的作品，留片段也是替对方保管。
 * 从自己写过的章节里选是更好的来源——那天然带着作者的口味，
 * 而且能拿到块结构（哪些是对白），对话占比算得准。
 */

/** 维度定义。顺序即展示顺序。 */
const METRICS = [
  {
    key: 'sentenceLength',
    label: '句长',
    unit: '字/句',
    hint: '每句多少字。短句节奏快，长句适合铺陈。',
  },
  {
    key: 'dialogueRatio',
    label: '对白占比',
    unit: '%',
    hint: '对白在全文字数里的百分比。',
  },
  {
    key: 'imageryDensity',
    label: '比喻密度',
    unit: '处/千字',
    hint: '每千字里有多少处比喻。',
  },
];

/** 把一张卡的规则渲染成 chips。 */
function metricChips(rules) {
  const chips = [];
  for (const m of METRICS) {
    const entry = rules?.metrics?.[m.key];
    if (!entry) continue;

    let text;
    if (entry.min !== undefined && entry.max !== undefined) {
      text = `${m.label} ${entry.min}–${entry.max}${m.unit}`;
    } else if (entry.min !== undefined) {
      text = `${m.label} ≥${entry.min}${m.unit}`;
    } else if (entry.max !== undefined) {
      text = `${m.label} ≤${entry.max}${m.unit}`;
    } else {
      continue;
    }
    chips.push({ key: m.key, text });
  }
  return chips;
}

export default function StylePage() {
  const [cards, setCards] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [works, setWorks] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    try {
      const res = await api.get('/style/cards');
      setCards(res.data.cards || []);
      setConflicts(res.data.conflicts || []);
    } catch (e) {
      message.error('文风规则加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // 作品列表只在「添加样例」时用来选作用范围
  const loadWorks = useCallback(async () => {
    try {
      const res = await api.get('/works');
      setWorks(res.data || []);
    } catch (e) {
      // 选不了作用范围不影响查看规则
    }
  }, []);

  // 章节列表用来选「从自己写过的章节里取样例」
  const loadChapters = useCallback(async () => {
    try {
      const res = await api.get('/style/chapters');
      setChapters(res.data || []);
    } catch (e) {
      // 同上
    }
  }, []);

  useEffect(() => {
    load();
    loadWorks();
    loadChapters();
  }, [load, loadWorks, loadChapters]);

  // 这两个 watch 必须无条件调用，不能放在 loading 早退之后
  const formKind = Form.useWatch('kind', form);
  const sourceType = Form.useWatch('sourceType', form);

  /** 打开「添加样例」弹窗。 */
  const openAdd = (kind) => {
    form.resetFields();
    form.setFieldsValue({ kind, sourceType: 'paste', workId: '' });
    setAdding(kind);
  };

  /**
   * 提交样例。
   *
   * 这一步会调模型蒸馏，通常要几秒——按钮转圈并说明在做什么，
   * 否则作者以为没点上而重复提交。
   */
  const submitAdd = async () => {
    const values = await form.validateFields();
    const payload = {
      kind: values.kind,
      title: values.title.trim(),
      notes: values.notes || '',
    };
    if (values.workId) payload.workId = values.workId;

    if (values.sourceType === 'chapter') {
      payload.chapterId = values.chapterId;
    } else {
      payload.content = values.content;
    }

    try {
      await api.post('/style/cards', payload);
      message.success('规则已生成');
      setAdding(false);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '规则提炼失败');
    }
  };

  /** 打开「编辑规则」弹窗。 */
  const openEdit = (card) => {
    const r = card.rules || {};
    editForm.setFieldsValue({
      title: card.title,
      summary: r.summary || '',
      notes: (r.notes || []).join('\n'),
      bannedWords: (r.bannedWords || []).join('、'),
      sentenceLengthMin: r.metrics?.sentenceLength?.min,
      sentenceLengthMax: r.metrics?.sentenceLength?.max,
      dialogueRatioMin: r.metrics?.dialogueRatio?.min,
      dialogueRatioMax: r.metrics?.dialogueRatio?.max,
      imageryDensityMax: r.metrics?.imageryDensity?.max,
    });
    setEditing(card);
  };

  /**
   * 保存手改的规则。
   *
   * 蒸馏是模型猜的，作者看一眼觉得不对就得能改。
   * 留空表示这一项不约束。
   */
  const submitEdit = async () => {
    const v = await editForm.validateFields();
    const rules = {
      summary: v.summary || '',
      notes: v.notes
        ? v.notes
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      bannedWords: v.bannedWords
        ? v.bannedWords
            .split(/[、,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      metrics: {},
    };

    const sl = {};
    if (v.sentenceLengthMin !== undefined && v.sentenceLengthMin !== null) {
      sl.min = v.sentenceLengthMin;
    }
    if (v.sentenceLengthMax !== undefined && v.sentenceLengthMax !== null) {
      sl.max = v.sentenceLengthMax;
    }
    if (Object.keys(sl).length) rules.metrics.sentenceLength = sl;

    const dr = {};
    if (v.dialogueRatioMin !== undefined && v.dialogueRatioMin !== null) {
      dr.min = v.dialogueRatioMin;
    }
    if (v.dialogueRatioMax !== undefined && v.dialogueRatioMax !== null) {
      dr.max = v.dialogueRatioMax;
    }
    if (Object.keys(dr).length) rules.metrics.dialogueRatio = dr;

    if (v.imageryDensityMax !== undefined && v.imageryDensityMax !== null) {
      rules.metrics.imageryDensity = { max: v.imageryDensityMax };
    }

    try {
      await api.put(`/style/cards/${editing.id}`, { title: v.title.trim(), rules });
      message.success('已保存');
      setEditing(null);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const toggle = async (card) => {
    try {
      await api.put(`/style/cards/${card.id}`, { enabled: !card.enabled });
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '操作失败');
    }
  };

  const remove = async (card) => {
    try {
      await api.delete(`/style/cards/${card.id}`);
      message.success('已删除');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '删除失败');
    }
  };

  const renderSection = (kind, title, desc) => {
    const list = cards.filter((c) => c.kind === kind);
    return (
      <section style={{ marginBottom: 36 }}>
        <div className="ct-page-head" style={{ marginBottom: 14 }}>
          <div>
            <h3 className="ct-page-title font-serif" style={{ fontSize: 18 }}>
              {title}
            </h3>
            <p className="ct-page-sub">{desc}</p>
          </div>
          <span style={{ flex: 1 }} />
          <Button icon={<PlusOutlined />} onClick={() => openAdd(kind)}>
            添加{kind === 'good' ? '好' : '坏'}样例
          </Button>
        </div>

        {list.length === 0 ? (
          <EmptyState
            className="ct-empty-pad"
            text={
              kind === 'good'
                ? '还没有好样例。挑一段你自己写得顺手的文字，AI 会照着它的调子写。'
                : '还没有坏样例。挑一段你不想看到的样子，AI 会避开它的毛病。'
            }
          />
        ) : (
          <List
            bordered
            dataSource={list}
            renderItem={(card) => {
              const chips = metricChips(card.rules);
              return (
                <List.Item
                  style={{ opacity: card.enabled ? 1 : 0.5 }}
                  actions={[
                    <EditOutlined key="edit" title="编辑规则" onClick={() => openEdit(card)} />,
                    <Popconfirm
                      key="toggle"
                      title={card.enabled ? '停用这条规则？' : '启用这条规则？'}
                      onConfirm={() => toggle(card)}
                    >
                      <ReloadOutlined title={card.enabled ? '停用' : '启用'} />
                    </Popconfirm>,
                    <Popconfirm
                      key="del"
                      title="删除这条规则？"
                      onConfirm={() => remove(card)}
                    >
                      <DeleteOutlined />
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <span className="ct-material-title">
                        {card.title}
                        <span className="ct-material-source">
                          {card.source === 'chapter' ? '我的章节' : '粘贴'}
                        </span>
                        {card.workId ? (
                          <span className="ct-material-source">
                            {works.find((w) => w.id === card.workId)?.title || '某部作品'}
                          </span>
                        ) : (
                          <span className="ct-material-source">全局</span>
                        )}
                        {card.effective ? <span className="ct-badge">生效中</span> : null}
                      </span>
                    }
                    description={
                      <div>
                        {card.rules?.summary ? (
                          <div className="ct-material-preview">{card.rules.summary}</div>
                        ) : null}
                        {card.excerpt ? (
                          <div className="ct-material-snippet">{card.excerpt}</div>
                        ) : null}
                        {chips.length ? (
                          <div style={{ marginTop: 6 }}>
                            {chips.map((c) => (
                              <Tag key={c.key} bordered={false} style={{ marginBottom: 4 }}>
                                {c.text}
                              </Tag>
                            ))}
                          </div>
                        ) : null}
                        {card.rules?.bannedWords?.length ? (
                          <div style={{ marginTop: 4 }}>
                            <Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>
                              禁用词
                            </Text>
                            {card.rules.bannedWords.map((w) => (
                              <Tag key={w} color="warning" bordered={false} style={{ marginBottom: 4 }}>
                                {w}
                              </Tag>
                            ))}
                          </div>
                        ) : null}
                        {card.rules?.notes?.length ? (
                          <div className="ct-material-meta">
                            {card.rules.notes.join('；')}
                          </div>
                        ) : null}
                      </div>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </section>
    );
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div className="ct-page-head">
        <div>
          <h2 className="ct-page-title font-serif">文风</h2>
          <p className="ct-page-sub">
            告诉 AI 什么样的文字是你想要的、什么样的是你不想要的。规则会常驻在每次写作的上下文里。
          </p>
        </div>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 24 }}
        message="样例原文不会保存"
        description="粘贴的文字只送到「提炼规则」那一步就被丢掉，库里只留规则。粘贴的原文可能来自别人的作品，留着不合适；从你自己写过的章节里选更好——那本来就是你的风格。"
      />

      {conflicts.length ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 24 }}
          message="有几处规则互相矛盾，已经放宽处理"
          description={conflicts.join('；')}
        />
      ) : null}

      {renderSection(
        'good',
        '要学的',
        '你欣赏的写法。AI 写正文时会照着这些规则来。'
      )}
      {renderSection(
        'bad',
        '要避开的',
        '你不想要的写法。AI 会主动躲开这些毛病。'
      )}

      {/* ---------------- 添加样例 ---------------- */}
      <Modal
        open={!!adding}
        title={adding === 'bad' ? '添加坏样例' : '添加好样例'}
        okText="提炼规则"
        cancelText="取消"
        width={620}
        onOk={submitAdd}
        onCancel={() => setAdding(false)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="kind" label="类型">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              onChange={(e) => form.setFieldsValue({ kind: e.target.value })}
              options={[
                { label: '好样例（要学的）', value: 'good' },
                { label: '坏样例（要避开的）', value: 'bad' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="title"
            label="标题"
            rules={[{ required: true, message: '给这条规则起个名字，方便你认出来' }]}
          >
            <Input placeholder="例如：第三章那段雨夜" />
          </Form.Item>

          <Form.Item name="sourceType" label="样例来源">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              options={[
                { label: '粘贴一段文字', value: 'paste' },
                { label: '从我的章节选', value: 'chapter' },
              ]}
            />
          </Form.Item>

          {sourceType === 'chapter' ? (
            <Form.Item
              name="chapterId"
              label="选一章"
              rules={[{ required: true, message: '选一章作为样例' }]}
            >
              <Select
                placeholder="选你自己写过的章节"
                options={chapters.map((c) => ({
                  value: c.id,
                  label: `${c.workTitle} · ${c.title}（${c.wordCount} 字）`,
                }))}
              />
            </Form.Item>
          ) : (
            <Form.Item
              name="content"
              label="样例原文"
              rules={[
                {
                  required: true,
                  message:
                    formKind === 'bad'
                      ? '粘贴一段你不想要的文字'
                      : '粘贴一段你想让 AI 学的文字',
                },
              ]}
              extra={
                formKind === 'bad'
                  ? '原文不会保存，只用来提炼毛病。挑最能代表那种毛病的段落。'
                  : '原文不会保存，只用来提炼规则。挑最有代表性的段落，不用整章。'
              }
            >
              <Input.TextArea rows={8} placeholder="把那段文字贴在这里" />
            </Form.Item>
          )}

          <Form.Item name="workId" label="作用范围" extra="不选就是全局规则，所有作品都适用。">
            <Select
              allowClear
              placeholder="全局（所有作品）"
              options={works.map((w) => ({ value: w.id, label: w.title }))}
            />
          </Form.Item>

          <Form.Item name="notes" label="补充说明" extra="可选。比如「这段是慢节奏的章节」。">
            <Input.TextArea rows={2} placeholder="想让 AI 注意但文字里看不出来的偏好" />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------------- 编辑规则 ---------------- */}
      <Modal
        open={!!editing}
        title="编辑规则"
        okText="保存"
        cancelText="取消"
        width={620}
        onOk={submitEdit}
        onCancel={() => setEditing(null)}
      >
        {editing ? (
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            提炼出来的规则可以手改。留空表示这一项不约束。
            {editing.kind === 'bad' ? '坏样例的数值是「上限」，超过就算违规。' : ''}
          </Paragraph>
        ) : null}
        <Form form={editForm} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
            <Input />
          </Form.Item>

          <Form.Item name="summary" label="整体感觉">
            <Input placeholder="例如：短句为主，白描，不煽情" />
          </Form.Item>

          {METRICS.map((m) => (
            <Form.Item key={m.key} label={m.label} extra={m.hint}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* 坏样例只有「上限」有意义：它说的是"别超过多少" */}
                {m.key !== 'imageryDensity' && editing?.kind !== 'bad' ? (
                  <>
                    <Form.Item name={`${m.key}Min`} noStyle>
                      <InputNumber style={{ width: 120 }} placeholder="下限" min={0} />
                    </Form.Item>
                    <span style={{ color: 'var(--text-tertiary)' }}>–</span>
                  </>
                ) : null}
                <Form.Item name={`${m.key}Max`} noStyle>
                  <InputNumber
                    style={{ width: 120 }}
                    placeholder={m.key === 'imageryDensity' ? '不超过' : '上限'}
                    min={0}
                  />
                </Form.Item>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {m.unit}
                </Text>
              </div>
            </Form.Item>
          ))}

          <Form.Item name="bannedWords" label="禁用词" extra="用顿号或逗号分隔。这些词 AI 写的时候一律避开。">
            <Input placeholder="眸色一暗、嘴角勾起一抹弧度" />
          </Form.Item>

          <Form.Item name="notes" label="要点" extra="一行一条。">
            <Input.TextArea rows={3} placeholder={'不用比喻\n对话推进情节，不解释'} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
