import React, { useCallback, useEffect, useState } from 'react';
import {
  Drawer,
  List,
  Button,
  Typography,
  Empty,
  Spin,
  Input,
  Modal,
  message,
  Popconfirm,
  Tooltip,
} from 'antd';
import {
  HistoryOutlined,
  SaveOutlined,
  RollbackOutlined,
  DeleteOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import api from '../../api/client';
import { useWorkspace } from '../../store/workspace';

const { Text } = Typography;

/**
 * 解析章节的 blocks JSON。
 */
function parseBlocks(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * 章节版本历史。
 *
 * 浏览器里的撤销栈只有 50 步，关掉页面就没了——写小说最怕的不是改不动，
 * 而是三万字的手稿一次误删找不回来。这里是服务端留的持久化版本链：
 * 每次保存都会把被覆盖掉的旧内容存一份，作者可以回到任意一版。
 *
 * 手动存档点带名字（"第三章结尾定稿"），系统清理时不会动它们。
 */
export default function VersionHistoryPanel({ open, onClose }) {
  const { chapter, replaceAllBlocks } = useWorkspace();
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const chapterId = chapter?.id;

  const load = useCallback(async () => {
    if (!chapterId) return;
    setLoading(true);
    try {
      const res = await api.get(`/versions/chapter/${chapterId}`);
      setVersions(res.data || []);
    } catch (e) {
      message.error('版本列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [chapterId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // 手动存档
  const snapshot = async () => {
    if (!chapterId) return;
    setSaving(true);
    try {
      await api.post(`/versions/chapter/${chapterId}`, { label: label.trim() });
      setLabel('');
      message.success('已存档');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '存档失败');
    } finally {
      setSaving(false);
    }
  };

  // 回滚：服务端会先把当前状态存一份，所以"回滚回滚"是可逆的
  const restore = async (version) => {
    try {
      const res = await api.post(`/versions/chapter/${chapterId}/${version.id}/restore`);
      // 服务端已落库，直接把返回的块灌进编辑器
      const restored = parseBlocks(res.data?.blocks);
      if (restored.length || res.data?.blocks === '[]') {
        replaceAllBlocks(restored);
      }
      message.success(`已回到「${version.label || '自动快照'}」`);
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '回滚失败');
    }
  };

  const remove = async (version) => {
    try {
      await api.delete(`/versions/chapter/${chapterId}/${version.id}`);
      message.success('已删除');
      load();
    } catch (e) {
      message.error(e.response?.data?.error || '删除失败');
    }
  };

  const openPreview = async (version) => {
    setPreviewLoading(true);
    setPreview({ version, content: '', loading: true });
    try {
      const res = await api.get(`/versions/chapter/${chapterId}/${version.id}`);
      setPreview({ version, content: res.data?.content || '', loading: false });
    } catch (e) {
      message.error('版本内容加载失败');
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title={
        <span>
          <HistoryOutlined style={{ marginRight: 8 }} />
          版本历史
        </span>
      }
      extra={
        <Button size="small" onClick={load} loading={loading}>
          刷新
        </Button>
      }
    >
      <div className="ct-version-head">
        <p className="ct-hint">
          每次保存都会把被覆盖掉的旧内容存一份。误删了段落，可以从这里回到任何一版。
        </p>
        <div className="ct-version-save">
          <Input
            size="small"
            placeholder="给这一版起个名字，如「第三章结尾定稿」"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onPressEnter={snapshot}
          />
          <Button
            type="primary"
            size="small"
            icon={<SaveOutlined />}
            loading={saving}
            onClick={snapshot}
          >
            存档
          </Button>
        </div>
      </div>

      {loading && versions.length === 0 ? (
        <div className="ct-loading">
          <Spin />
        </div>
      ) : versions.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有历史版本。改动正文并保存后，这里会出现记录。"
        />
      ) : (
        <List
          size="small"
          dataSource={versions}
          renderItem={(v) => (
            <List.Item
              actions={[
                <Tooltip title="查看内容" key="view">
                  <button
                    type="button"
                    className="ct-item-act"
                    title="查看内容"
                    aria-label="查看内容"
                    onClick={() => openPreview(v)}
                  >
                    <EyeOutlined />
                  </button>
                </Tooltip>,
                <Tooltip title="回到这一版" key="restore">
                  <button
                    type="button"
                    className="ct-item-act"
                    title="回到这一版"
                    aria-label="回到这一版"
                    onClick={() =>
                      Modal.confirm({
                        title: '回到这一版？',
                        content:
                          '当前内容会先自动存档一份，不会丢。回滚后撤销栈会清空。',
                        okText: '回滚',
                        cancelText: '取消',
                        onOk: () => restore(v),
                      })
                    }
                  >
                    <RollbackOutlined />
                  </button>
                </Tooltip>,
                <Popconfirm
                  key="del"
                  title="删除这一版？"
                  onConfirm={() => remove(v)}
                >
                  <button
                    type="button"
                    className="ct-item-act is-danger"
                    title="删除这一版"
                    aria-label="删除这一版"
                  >
                    <DeleteOutlined />
                  </button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <span className="ct-version-title">
                    {v.label || '未命名版本'}
                    {v.manual ? <span className="ct-badge">手动</span> : null}
                  </span>
                }
                description={
                  <div className="ct-version-meta">
                    {new Date(v.created_at).toLocaleString('zh-CN')}
                    {' · '}
                    {v.word_count || 0} 字
                  </div>
                }
              />
            </List.Item>
          )}
        />
      )}

      <Modal
        open={!!preview}
        title={preview ? `${preview.version.label || '版本内容'}` : ''}
        footer={null}
        width={720}
        onCancel={() => setPreview(null)}
      >
        <div className="ct-version-preview">
          {previewLoading ? (
            <Spin />
          ) : (
            preview?.content || '（这一版没有正文）'
          )}
        </div>
      </Modal>
    </Drawer>
  );
}
