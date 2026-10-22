import React, { useEffect, useState, useCallback } from 'react';
import {
  Button,
  Input,
  Modal,
  Form,
  message,
  Upload,
  List,
  Empty,
  Typography,
  Popconfirm,
  Drawer,
  Spin,
} from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  UploadOutlined,
  SearchOutlined,
  AimOutlined,
} from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useIsMobile } from '../hooks/useMediaQuery';

const { Text } = Typography;

/**
 * 素材库。
 *
 * 素材是 AI 检索的本地语料库：作者自己的积累，比外部搜索更贴合他的风格。
 * 搜索走 FTS5 + bigram 索引（服务端 /api/materials/search），
 * 命中片段会带高亮位置，作者一眼能看出为什么这条被检索到。
 */
export default function Materials() {
  const isMobile = useIsMobile();
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [editing, setEditing] = useState(null);
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

  const load = useCallback(async () => {
    try {
      const res = await api.get('/materials');
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
      load();
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
  }, [load]);

  useEffect(() => {
    load();
  }, [load]);

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

  const list = hits || items;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 12,
          marginBottom: 20,
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

      {list.length === 0 ? (
        <Empty description="素材库还是空的。导入一些参考材料，AI 检索时会用到它们。" />
      ) : (
        <List
          bordered
          loading={searching}
          dataSource={list}
          renderItem={(item) => (
            <List.Item
              actions={[
                <EditOutlined key="edit" onClick={() => openEditor(item)} />,
                <Popconfirm
                  key="del"
                  title="删除这条素材？"
                  onConfirm={() => remove(item)}
                >
                  <DeleteOutlined />
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <span className="ct-material-title">
                    {item.title}
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
                    <div className="ct-material-meta">
                      {item.char_count || 0} 字
                      {item.page_count ? ` · ${item.page_count} 页` : ''}
                      {item.tags ? ` · ${item.tags}` : ''}
                    </div>
                  </div>
                }
              />
            </List.Item>
          )}
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
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="没能在这条素材里定位到引用的片段。可能是 AI 转述了原文而不是照抄。"
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
          <Form.Item name="source" label="来源">
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
