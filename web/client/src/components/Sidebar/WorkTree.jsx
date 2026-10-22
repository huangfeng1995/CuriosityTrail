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
 * 作品与章节的导航树。
 */
export default function WorkTree({ currentWorkId, currentChapterId }) {
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
                      key: 'chapter',
                      icon: <PlusOutlined />,
                      label: '新建章节',
                      onClick: () => createChapter(work.id),
                    },
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

            {expanded && <ChapterList workId={work.id} currentChapterId={currentChapterId} />}
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

function ChapterList({ workId, currentChapterId }) {
  const { chapters, loadChapter, loadWork } = useWorkspace();

  const list = chapters.filter((c) => c.work_id === workId);

  return (
    <div className="ct-tree-children">
      {list.map((chapter) => (
        <div
          key={chapter.id}
          className={`ct-tree-row${chapter.id === currentChapterId ? ' is-active' : ''}`}
        >
          <FileTextOutlined className="ct-tree-icon" />
          <button
            type="button"
            className="ct-tree-label"
            onClick={() => loadChapter(chapter.id)}
            title={chapter.title}
          >
            {chapter.title}
          </button>
          <Dropdown
            menu={{
              items: [
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
                        await api.put(`/chapters/${chapter.id}`, { title: title.trim() });
                        await loadWork(workId);
                      },
                    });
                  },
                },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  label: '删除',
                  danger: true,
                  onClick: async () => {
                    await api.delete(`/chapters/${chapter.id}`);
                    await loadWork(workId);
                  },
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
      ))}

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
