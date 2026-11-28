import React, { useEffect, useState } from 'react';
import { Button, Input, Modal, Dropdown, message } from 'antd';
import {
  PlusOutlined,
  BookOutlined,
  FileTextOutlined,
  MoreOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { useWorkspace } from '../../store/workspace';

/**
 * 章节行的悬停提示：有摘要就顺带把摘要摊开，没有就只显示标题。
 *
 * 摘要存的是 JSON（推进 / 未解 / 时间地点 / 人物），这里只做展示，
 * 解析失败一律退回标题，不让坏数据影响导航。
 */
function chapterTooltip(chapter) {
  let summary = null;
  try {
    summary = JSON.parse(chapter.summary || 'null');
  } catch (e) {
    summary = null;
  }
  if (!summary || !summary.progress) return chapter.title;

  const lines = [chapter.title, summary.progress];
  if (summary.open_threads) lines.push(`未解：${summary.open_threads}`);
  if (summary.setting) lines.push(`时间地点：${summary.setting}`);
  if (Array.isArray(summary.characters) && summary.characters.length) {
    lines.push(`人物：${summary.characters.join('、')}`);
  }
  return lines.join('\n');
}

/** 手动生成摘要失败时，把服务端 reason 翻成作者能懂的一句话。 */
function summaryFailureText(reason) {
  const map = {
    chapter: '章节不存在',
    provider: '没有可用的 AI 配置，请到设置页检查',
    request: '模型请求失败，请稍后重试',
    parse: '模型返回格式不对，请稍后重试',
    'auto-off': '摘要功能未启用',
  };
  return map[reason] || '摘要生成失败，请稍后重试';
}

/**
 * 作品与章节的导航树。
 */
export default function WorkTree({
  currentWorkId,
  currentChapterId,
  issueCounts,
  onShowIssues,
}) {
  const { loadWork, loadChapter, dispatch } = useWorkspace();
  const navigate = useNavigate();
  const [works, setWorks] = useState([]);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const loadWorks = async () => {
    try {
      const res = await api.get('/works');
      setWorks(res.data);
    } catch (e) {
      message.error('作品列表加载失败');
    }
  };

  useEffect(() => {
    loadWorks();
  }, []);

  const createWork = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      const res = await api.post('/works', { title });
      setNewTitle('');
      setCreating(false);
      await loadWorks();
      navigate(`/works/${res.data.id}`);
    } catch (e) {
      message.error(e.response?.data?.error || '创建失败');
    }
  };

  const deleteWork = async (work) => {
    Modal.confirm({
      title: `删除《${work.title}》？`,
      content: '作品、章节、人物卡与设定都会一并删除，无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await api.delete(`/works/${work.id}`);
        message.success('已删除');
        await loadWorks();
        // 「我的作品」页有自己的列表状态，不重新挂载就不会变；广播一次让它刷新。
        window.dispatchEvent(new CustomEvent('works:changed'));
        if (work.id === currentWorkId) {
          dispatch({ type: 'work/loaded', work: null, chapters: [] });
          dispatch({ type: 'chapter/loaded', chapter: null, blocks: [] });
          navigate('/works');
        }
      },
    });
  };

  const createChapter = async (workId) => {
    try {
      const res = await api.post(`/works/${workId}/chapters`, {});
      if (workId === currentWorkId) {
        await loadWork(workId);
      }
      await loadChapter(res.data.id);
    } catch (e) {
      message.error(e.response?.data?.error || '创建章节失败');
    }
  };

  return (
    <div className="ct-tree">
      <div className="ct-tree-head">
        <span className="ct-stat-label" style={{ marginBottom: 0 }}>
          我的作品
        </span>
        <Button
          type="text"
          size="small"
          icon={<PlusOutlined />}
          title="新建作品"
          onClick={() => setCreating(true)}
        />
      </div>

      {works.map((work) => {
        const expanded = work.id === currentWorkId;
        return (
          <div key={work.id} className="ct-tree-node">
            <div className={`ct-tree-row${expanded ? ' is-active' : ''}`}>
              <BookOutlined className="ct-tree-icon" />
              <button
                type="button"
                className="ct-tree-label"
                onClick={() => {
                  navigate(`/works/${work.id}`);
                  loadWork(work.id);
                }}
                title={work.title}
              >
                {work.title}
              </button>
              <span className="ct-tree-count">{work.chapter_count}</span>
              <Dropdown
                menu={{
                  items: [
                    {
                      key: 'delete',
                      icon: <DeleteOutlined />,
                      label: '删除作品',
                      danger: true,
                      onClick: () => deleteWork(work),
                    },
                  ],
                }}
                trigger={['click']}
              >
                <button type="button" className="ct-item-act" title="更多操作" aria-label="更多操作">
                  <MoreOutlined />
                </button>
              </Dropdown>
            </div>

            {expanded && (
              <ChapterList
                workId={work.id}
                currentChapterId={currentChapterId}
                issueCounts={issueCounts}
                onShowIssues={onShowIssues}
              />
            )}
          </div>
        );
      })}

      {creating && (
        <Modal
          open
          title="新建作品"
          okText="创建"
          cancelText="取消"
          onOk={createWork}
          onCancel={() => setCreating(false)}
        >
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onPressEnter={createWork}
            placeholder="书名"
          />
        </Modal>
      )}
    </div>
  );
}

function ChapterList({ workId, currentChapterId, issueCounts, onShowIssues }) {
  const { chapters, loadChapter, loadWork, renameChapter, dispatch, dropPending } =
    useWorkspace();

  const list = chapters.filter((c) => c.work_id === workId);

  const deleteChapter = (chapter) => {
    Modal.confirm({
      title: `删除「${chapter.title}」？`,
      content: '这一章会删除，无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await api.delete(`/chapters/${chapter.id}`);
        } catch (e) {
          message.error(e.response?.data?.error || '删除章节失败');
          return;
        }
        // 这一章的待存快照必须一起丢掉：防抖保存会继续 PUT 到已删除的 id。
        dropPending(chapter.id);
        await loadWork(workId);
        if (chapter.id !== currentChapterId) return;

        // 正在编辑的章被删掉：先清空编辑器，再切到原位置的后一章
        // （删的是最后一章就用前一章；一章不剩就停在空态）。
        const index = chapters.findIndex((c) => c.id === chapter.id);
        const rest = chapters.filter((c) => c.id !== chapter.id);
        const next = rest[index] || rest[index - 1] || null;
        dispatch({ type: 'chapter/loaded', chapter: null, blocks: [] });
        if (next) await loadChapter(next.id);
      },
    });
  };

  return (
    <div className="ct-tree-children">
      {list.map((chapter) => {
        const issueCount = issueCounts?.get(chapter.id)?.length || 0;
        return (
        <div
          key={chapter.id}
          className={`ct-tree-row${chapter.id === currentChapterId ? ' is-active' : ''}`}
        >
          <FileTextOutlined className="ct-tree-icon" />
          <button
            type="button"
            className="ct-tree-label"
            onClick={() => loadChapter(chapter.id)}
            title={chapterTooltip(chapter)}
          >
            {chapter.title}
          </button>
          {/* 高优先级规则问题：没有问题时什么都不显示，不做常驻提示。 */}
          {issueCount > 0 && (
            <button
              type="button"
              className="ct-tree-issue"
              onClick={(e) => {
                e.stopPropagation();
                onShowIssues?.(chapter.id);
              }}
              title={`${issueCount} 条高优先级问题，点击在右侧查看`}
              aria-label={`查看「${chapter.title}」的 ${issueCount} 条高优先级问题`}
            >
              <span className="ct-tree-issue-dot" aria-hidden="true" />
              <span className="ct-tree-issue-count">{issueCount}</span>
            </button>
          )}
          <Dropdown
            menu={{
              items: [
                {
                  key: 'summary',
                  icon: <FileTextOutlined />,
                  label: chapter.summary ? '重新生成摘要' : '生成摘要',
                  onClick: async () => {
                    const hide = message.loading('正在生成摘要…', 0);
                    try {
                      const res = await api.post(`/chapters/${chapter.id}/summary`, {});
                      hide();
                      if (res.data?.ok) {
                        message.success('摘要已更新');
                        await loadWork(workId);
                      } else {
                        message.warning(summaryFailureText(res.data?.reason));
                      }
                    } catch (e) {
                      hide();
                      message.error(e.response?.data?.error || '摘要生成失败');
                    }
                  },
                },
                {
                  key: 'rename',
                  icon: <EditOutlined />,
                  label: '重命名',
                  onClick: () => {
                    let title = chapter.title;
                    Modal.confirm({
                      title: '重命名章节',
                      content: (
                        <Input
                          defaultValue={chapter.title}
                          onChange={(e) => (title = e.target.value)}
                        />
                      ),
                      okText: '保存',
                      cancelText: '取消',
                      onOk: async () => {
                        if (!title.trim()) return;
                        // 走 store：章节树与正在编辑的标题栏一起更新
                        await renameChapter(chapter.id, title);
                      },
                    });
                  },
                },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: '删除',
                  danger: true,
                  onClick: () => deleteChapter(chapter),
                },
              ],
            }}
            trigger={['click']}
          >
            <button type="button" className="ct-item-act" title="更多操作" aria-label="更多操作">
              <MoreOutlined />
            </button>
          </Dropdown>
        </div>
        );
      })}

      <button
        type="button"
        className="ct-tree-add"
        onClick={async () => {
          const res = await api.post(`/works/${workId}/chapters`, {});
          await loadWork(workId);
          await loadChapter(res.data.id);
        }}
      >
        <PlusOutlined />
        新建章节
      </button>
    </div>
  );
}
