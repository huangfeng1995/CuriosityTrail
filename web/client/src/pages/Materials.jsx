import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Button,
  Input,
  Modal,
  Form,
  message,
  Upload,
  List,
  Typography,
  Popconfirm,
  Drawer,
  Spin,
  Checkbox,
  Segmented,
  Select,
  Tag,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  UploadOutlined,
  SearchOutlined,
  AimOutlined,
  SafetyCertificateOutlined,
  QuestionCircleOutlined,
  BulbOutlined,
  RollbackOutlined,
  CheckOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import EmptyState from '../components/EmptyState';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Text } = Typography;

/** 置信档的显示与配色。sourced / missing 必须一眼能分开，不能只靠文案。 */
const CONFIDENCE_META = {
  sourced: {
    label: '有出处',
    icon: <SafetyCertificateOutlined />,
    color: 'var(--bamboo)',
    bg: 'rgba(92, 125, 85, 0.08)',
    border: '3px solid var(--bamboo)',
  },
  inferable: {
    label: '可推定',
    icon: <BulbOutlined />,
    color: 'var(--gold)',
    bg: 'transparent',
    border: '3px solid var(--paper-4)',
  },
  missing: {
    label: '查不到',
    icon: <QuestionCircleOutlined />,
    color: 'var(--cinnabar)',
    bg: 'repeating-linear-gradient(135deg, rgba(176, 64, 47, 0.07) 0 6px, transparent 6px 12px)',
    border: '3px dashed var(--cinnabar-soft)',
  },
};

function confidenceMeta(item) {
  return CONFIDENCE_META[item?.confidence] || CONFIDENCE_META.inferable;
}

/**
 * 素材库。
 *
 * agent 整理的素材直接落在这里：有出处的、可推定的、查不到的三种档位
 * 用底色/边框/图标区分。high-risk（有出处）默认 pending，需要作者一次确认一批；
 * 撤回后立刻不再被写作检索命中。
 */
export default function Materials() {
  const isMobile = useIsMobile();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(null);
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState([]);
  const [form] = Form.useForm();
  const [params, setParams] = useSearchParams();

  const focusId = params.get('focus');
  // 从 AI 引用跳过来时带的片段，用来在原文里定位出处
  const snippet = params.get('snippet');

  // 检索模式下的结果结构与列表模式不同，命中片段单独存
  const [hits, setHits] = useState(null);

  // 定位结果：命中的原文位置、页码与上下文
  const [locate, setLocate] = useState(null);
  const [locateLoading, setLocateLoading] = useState(false);

  const load = useCallback(async (status = '') => {
    try {
      const url = status === 'retracted' ? '/materials?status=retracted' : '/materials';
      const res = await api.get(url);
      setItems(res.data);
    } catch (e) {
      message.error('素材加载失败');
    }
  }, []);

  const doSearch = useCallback(async (keyword) => {
    const q = (keyword ?? '').trim();
    if (!q) {
      setHits(null);
      setSearch('');
      load(filter === 'retracted' ? 'retracted' : '');
      return;
    }
    setSearching(true);
    try {
      const res = await api.get(`/materials/search?q=${encodeURIComponent(q)}&limit=20`);
      setHits(res.data);
      setSearch(q);
    } catch (e) {
      message.error('搜索失败');
    } finally {
      setSearching(false);
    }
  }, [load, filter]);

  useEffect(() => {
    if (filter === 'retracted') {
      setHits(null);
      load('retracted');
    } else {
      load();
    }
  }, [filter, load]);

  // 列表接口不返回完整正文（一份 PDF 可能有几十万字），
  // 编辑时按 id 取详情再填表。
  const openEditor = async (item) => {
    if (!item?.id) {
      setEditing({});
      form.setFieldsValue({
        title: '',
        body: '',
        source: '手记',
        sourceUrl: '',
        tags: '',
        provenance: '',
        confidence: 'inferable',
      });
      return;
    }
    try {
      const res = await api.get(`/materials/${item.id}`);
      setEditing(res.data);
      form.setFieldsValue({
        title: res.data.title,
        body: res.data.body,
        source: res.data.source,
        // 接口字段是 source_url，表单字段是 sourceUrl，不映射会丢链接
        sourceUrl: res.data.source_url,
        tags: res.data.tags,
        provenance: res.data.provenance,
        confidence: res.data.confidence,
      });
    } catch (e) {
      message.error('素材详情加载失败');
    }
  };

  // 从 AI 引用跳过来时，直接打开那条素材
  useEffect(() => {
    if (!focusId) return;
    const target = items.find((i) => i.id === focusId);
    if (target) {
      openEditor(target);
      setParams({}, { replace: true });
    }
  }, [focusId, items, setParams]);

  /**
   * 定位引用片段在原文中的位置。
   *
   * 服务端算好字符下标、页码和上下文，前端只要把命中段标出来，
   * 作者一眼就能核对"这句话是从哪本书第几页来的"。
   */
  const locateSnippet = useCallback(async (materialId, text) => {
    if (!materialId || !text) return;
    setLocateLoading(true);
    setLocate(null);
    try {
      const res = await api.get(
        `/materials/${materialId}/locate?snippet=${encodeURIComponent(text)}`
      );
      setLocate(res.data);
    } catch (e) {
      message.error('定位失败');
    } finally {
      setLocateLoading(false);
    }
  }, []);

  // 从 AI 引用跳过来时，定位到片段出处
  useEffect(() => {
    if (!focusId || !snippet) return;
    locateSnippet(focusId, snippet);
  }, [focusId, snippet, locateSnippet]);

  const save = async () => {
    const values = await form.validateFields();
    try {
      if (editing?.id) {
        await api.put(`/materials/${editing.id}`, values);
      } else {
        await api.post('/materials', values);
      }
      setEditing(null);
      message.success('已保存');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    }
  };

  const remove = async (item) => {
    await api.delete(`/materials/${item.id}`);
    message.success('已删除');
    if (hits) {
      doSearch(search);
    } else {
      load();
    }
  };

  /** 撤回：立刻停止注入，但保留记录可查 */
  const retract = async (item) => {
    await api.post(`/materials/${item.id}/retract`);
    message.success('已撤回，这条不再进入写作检索');
    setSelected((prev) => prev.filter((id) => id !== item.id));
    if (hits) doSearch(search);
    else load(filter === 'retracted' ? 'retracted' : '');
  };

  /** 批量确认：有出处的条目一次点完，不逐条弹 */
  const confirmSelected = async () => {
    const ids = selected.filter((id) => {
      const item = items.find((i) => i.id === id);
      return item && item.status === 'pending';
    });
    if (!ids.length) return;
    try {
      const res = await api.post('/materials/confirm', { ids });
      message.success(`已确认 ${res.data.confirmed} 条，现在可以被写作检索命中`);
      setSelected([]);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '确认失败');
    }
  };

  const retractSelected = async () => {
    const ids = selected.filter((id) => {
      const item = items.find((i) => i.id === id);
      return item && item.status !== 'retracted';
    });
    if (!ids.length) return;
    try {
      await Promise.all(ids.map((id) => api.post(`/materials/${id}/retract`)));
      message.success(`已撤回 ${ids.length} 条`);
      setSelected([]);
      load(filter === 'retracted' ? 'retracted' : '');
    } catch (e) {
      message.error('撤回失败');
    }
  };

  // ---- 素材 → 锚点：显式升格（一次调用，不做表单式录入） ----
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgradeWorks, setUpgradeWorks] = useState([]);
  const [upgradeWorkId, setUpgradeWorkId] = useState('');
  const [upgrading, setUpgrading] = useState(false);

  const upgradeEligible = selected.filter((id) => {
    const item = items.find((i) => i.id === id);
    return item && item.confidence !== 'missing' && item.status !== 'pending';
  });

  const openUpgrade = async () => {
    if (!upgradeEligible.length) return;
    try {
      const res = await api.get('/works');
      const list = (res.data || []).filter((w) => w.template === 'history_thriller');
      if (!list.length) {
        message.warning('还没有启用历史悬疑模板的作品，先去「作品」面板开启');
        return;
      }
      setUpgradeWorks(list);
      // 素材若已绑定某部作品，默认选它
      const bound = items.find((i) => upgradeEligible.includes(i.id) && i.work_id)?.work_id;
      setUpgradeWorkId(list.some((w) => w.id === bound) ? bound : list[0].id);
      setUpgradeOpen(true);
    } catch (e) {
      message.error('作品列表加载失败');
    }
  };

  const doUpgrade = async () => {
    if (!upgradeWorkId) return;
    setUpgrading(true);
    try {
      const res = await api.post(`/pipeline/${upgradeWorkId}/anchors/upgrade`, {
        materialIds: upgradeEligible,
      });
      const created = res.data?.created || [];
      const skipped = res.data?.skipped || [];
      message.success(
        `已生成 ${created.length} 条锚点草稿，确认前不会进入写作上下文`
      );
      if (skipped.length) {
        message.info(`${skipped.length} 条跳过：${skipped[0].reason}`);
      }
      setUpgradeOpen(false);
      setSelected([]);
    } catch (e) {
      message.error(e.response?.data?.error || '升格失败');
    } finally {
      setUpgrading(false);
    }
  };

  const toggle = (id) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const list = hits || items;

  /** 过滤只在列表模式生效；检索结果保持原样 */
  const visible = useMemo(() => {
    if (hits) return list;
    if (filter === 'all') return list;
    if (filter === 'pending') return list.filter((i) => i.status === 'pending');
    if (filter === 'sourced') return list.filter((i) => i.confidence === 'sourced');
    if (filter === 'missing') return list.filter((i) => i.confidence === 'missing');
    if (filter === 'retracted') return list.filter((i) => i.status === 'retracted');
    return list;
  }, [list, hits, filter]);

  const pendingSelected = selected.filter((id) => {
    const item = items.find((i) => i.id === id);
    return item && item.status === 'pending';
  });
  const activeSelected = selected.filter((id) => {
    const item = items.find((i) => i.id === id);
    return item && item.status !== 'retracted';
  });

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <Input.Search
          placeholder="搜索素材标题、正文、标签"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onSearch={doSearch}
          allowClear
          enterButton={<SearchOutlined />}
          style={{ maxWidth: 340, flex: isMobile ? '1 1 100%' : undefined }}
        />
        {hits && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            命中 {hits.length} 条
          </Text>
        )}
        <span style={{ flex: 1 }} />
        <Upload
          multiple
          accept=".pdf,.txt,.md,.markdown"
          showUploadList={false}
          customRequest={async ({ file, onSuccess, onError }) => {
            const formData = new FormData();
            formData.append('files', file);
            try {
              const res = await api.post('/materials/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
              });
              const warnings = res.data?.warnings || [];
              if (warnings.length) {
                warnings.forEach((w) => message.warning(w));
              } else {
                message.success(`已导入 ${file.name}`);
              }
              load();
              onSuccess?.();
            } catch (err) {
              message.error('导入失败');
              onError?.(err);
            }
          }}
        >
          <Button icon={<UploadOutlined />}>导入文件</Button>
        </Upload>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
          新建素材
        </Button>
      </div>

      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <Segmented
          size="small"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setSelected([]);
            if (value === 'retracted') setHits(null);
          }}
          options={[
            { value: 'all', label: '全部' },
            { value: 'sourced', label: '有出处' },
            { value: 'missing', label: '查不到' },
            { value: 'pending', label: '待确认' },
            { value: 'retracted', label: '已撤回' },
          ]}
        />
        {selected.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'var(--bg-hover)',
            }}
          >
            <Text style={{ fontSize: 12 }}>已选 {selected.length} 条</Text>
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              disabled={!pendingSelected.length}
              onClick={confirmSelected}
            >
              确认入库（{pendingSelected.length}）
            </Button>
            <Button
              size="small"
              danger
              icon={<RollbackOutlined />}
              disabled={!activeSelected.length}
              onClick={retractSelected}
            >
              撤回（{activeSelected.length}）
            </Button>
            <Button
              size="small"
              icon={<SafetyCertificateOutlined />}
              disabled={!upgradeEligible.length}
              onClick={openUpgrade}
            >
              升格为史实锚点（{upgradeEligible.length}）
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={upgradeOpen}
        title="升格为史实锚点"
        okText="生成锚点草稿"
        cancelText="取消"
        confirmLoading={upgrading}
        onOk={doUpgrade}
        onCancel={() => setUpgradeOpen(false)}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          生成的是待确认草稿，确认前不会进入写作上下文；素材之后修改也不会自动回写锚点。
        </Text>
        <div style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 12, marginRight: 8 }}>归到作品</Text>
          <Select
            value={upgradeWorkId}
            onChange={setUpgradeWorkId}
            options={upgradeWorks.map((w) => ({ value: w.id, label: w.title }))}
            style={{ minWidth: 220 }}
          />
        </div>
      </Modal>

      {visible.length === 0 ? (
        <EmptyState
          className="ct-empty-top"
          text={
            hits
              ? '没有命中的素材。'
              : '素材库还是空的。跟资料员说「帮我准备这个题材的素材」，它会自己整理进来。'
          }
        />
      ) : (
        <List
          bordered
          loading={searching}
          dataSource={visible}
          renderItem={(item) => {
            const meta = confidenceMeta(item);
            return (
              <List.Item
                style={{
                  borderLeft: meta.border,
                  background: meta.bg,
                  opacity: item.status === 'retracted' ? 0.55 : 1,
                  paddingLeft: 12,
                }}
                actions={[
                  <EditOutlined key="edit" onClick={() => openEditor(item)} />,
                  item.status !== 'retracted' ? (
                    <Popconfirm
                      key="retract"
                      title="撤回这条素材？"
                      description="撤回后立刻不再进入写作检索，记录仍保留。"
                      onConfirm={() => retract(item)}
                    >
                      <RollbackOutlined />
                    </Popconfirm>
                  ) : null,
                  <Popconfirm
                    key="del"
                    title="删除这条素材？"
                    onConfirm={() => remove(item)}
                  >
                    <DeleteOutlined />
                  </Popconfirm>,
                ]}
              >
                {/* 勾选框是 Meta 的 avatar，不是 List.Item 的：List.Item 没有
                    avatar 这个 prop，antd 会把它当未知属性透传到 <li>
                    （li 上出现 avatar="[object Object]"），Checkbox 根本不挂载。 */}
                <List.Item.Meta
                  avatar={
                    <Checkbox
                      checked={selected.includes(item.id)}
                      onChange={() => toggle(item.id)}
                      aria-label={`选择素材 ${item.title}`}
                    />
                  }
                  title={
                    <span className="ct-material-title">
                      {item.title}
                      <Tag
                        icon={meta.icon}
                        style={{
                          marginLeft: 8,
                          color: meta.color,
                          borderColor: meta.color,
                          background: 'transparent',
                        }}
                      >
                        {meta.label}
                      </Tag>
                      {item.status === 'pending' && (
                        <Tag color="warning" style={{ marginLeft: 4 }}>
                          待确认
                        </Tag>
                      )}
                      {item.status === 'retracted' && (
                        <Tag style={{ marginLeft: 4 }}>已撤回</Tag>
                      )}
                      <span className="ct-material-source">{item.source}</span>
                    </span>
                  }
                  description={
                    <div>
                      {hits ? (
                        // 检索模式：只展示命中片段
                        <div className="ct-material-snippet">{item.snippet || '（正文为空）'}</div>
                      ) : (
                        <div className="ct-material-preview">{item.preview || '（无正文）'}</div>
                      )}
                      {item.provenance ? (
                        <div className="ct-material-meta">出处：{item.provenance}</div>
                      ) : null}
                      <div className="ct-material-meta">
                        {item.char_count || 0} 字
                        {item.page_count ? ` · ${item.page_count} 页` : ''}
                        {item.tags ? ` · ${item.tags}` : ''}
                        {item.created_by === 'agent' ? ' · 由 agent 整理' : ''}
                      </div>
                    </div>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}

      <Drawer
        open={!!locate}
        title={
          <span>
            <AimOutlined style={{ marginRight: 8 }} />
            引用出处
            {locate?.page ? <span className="ct-badge">第 {locate.page} 页</span> : null}
          </span>
        }
        width={620}
        onClose={() => setLocate(null)}
      >
        {locateLoading ? (
          <div className="ct-loading">
            <Spin />
          </div>
        ) : locate?.found ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              在《{locate.title}》中定位到：
            </Text>
            <div className="ct-locate-body">
              {locate.before && <span style={{ opacity: 0.55 }}>{locate.before}</span>}
              <mark
                style={{
                  background: 'var(--mark-bg)',
                  color: 'var(--mark-text)',
                  padding: '1px 2px',
                  borderRadius: 2,
                }}
              >
                {locate.match}
              </mark>
              {locate.after && <span style={{ opacity: 0.55 }}>{locate.after}</span>}
            </div>
            {locate.sourceUrl && (
              <a
                href={locate.sourceUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, display: 'inline-block', marginTop: 12 }}
              >
                打开来源链接
              </a>
            )}
          </div>
        ) : (
          <EmptyState
            className="ct-empty-pad"
            text="没能在这条素材里定位到引用的片段。可能是 AI 转述了原文而不是照抄。"
          />
        )}
      </Drawer>

      <Modal
        open={!!editing}
        title={editing?.id ? '编辑素材' : '新建素材'}
        okText="保存"
        cancelText="取消"
        width={640}
        onOk={save}
        onCancel={() => setEditing(null)}
      >
        <Form form={form} layout="vertical" size="small" requiredMark={false}>
          <Form.Item name="title" label="标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="雨夜巷子的描写" />
          </Form.Item>
          <Form.Item
            name="confidence"
            label="置信档"
            help="有出处：必须填写出处；可推定：常识或上下文可推；查不到：正文首行写「待补：缺什么」"
          >
            <Select
              options={[
                { value: 'sourced', label: '有出处' },
                { value: 'inferable', label: '可推定' },
                { value: 'missing', label: '查不到' },
              ]}
            />
          </Form.Item>
          <Form.Item name="provenance" label="出处">
            <Input placeholder="《三国志·魏书·武帝纪》 / 网页标题" />
          </Form.Item>
          <Form.Item name="source" label="来源类型">
            <Input placeholder="手记 / 书籍 / 网页" />
          </Form.Item>
          <Form.Item name="sourceUrl" label="来源链接">
            <Input placeholder="https://…" />
          </Form.Item>
          <Form.Item name="tags" label="标签" help="用逗号分隔，便于检索。">
            <Input placeholder="环境描写，悬疑" />
          </Form.Item>
          <Form.Item name="body" label="正文">
            <Input.TextArea rows={10} placeholder="素材内容。AI 检索时会从这里取片段。" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
