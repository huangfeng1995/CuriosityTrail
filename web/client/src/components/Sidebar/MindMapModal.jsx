import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select, message } from 'antd';
import api from '../../api/client';
import Markdown from '../Markdown';
import {
  branchContent,
  makeNode,
  parseOutline,
  serializeOutline,
  treeToTable,
  toRoot,
} from './outlineModel';
import { serializeTable } from './tableModel';
import { SETTING_CATEGORIES } from './SettingPanel';

const IMPORTANCE = [
  { value: 1, label: '1 · 偶尔相关' },
  { value: 2, label: '2 · 按需' },
  { value: 3, label: '3 · 常驻' },
  { value: 4, label: '4 · 重要' },
  { value: 5, label: '5 · 核心设定' },
];

let seq = 0;
const nextId = () => {
  seq += 1;
  return `m${Date.now().toString(36)}${seq}`;
};

function setText(node, id, text) {
  if (node.id === id) return { ...node, text };
  let changed = false;
  const children = node.children.map((child) => {
    const next = setText(child, id, text);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function addChild(node, id, child) {
  if (node.id === id) return { ...node, children: [...node.children, child] };
  let changed = false;
  const children = node.children.map((c) => {
    const next = addChild(c, id, child);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function addSibling(node, id, sibling) {
  const index = node.children.findIndex((c) => c.id === id);
  if (index >= 0) {
    const children = [...node.children];
    children.splice(index + 1, 0, sibling);
    return { ...node, children };
  }
  let changed = false;
  const children = node.children.map((c) => {
    const next = addSibling(c, id, sibling);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function removeNode(node, id) {
  const children = node.children
    .filter((c) => c.id !== id)
    .map((c) => removeNode(c, id));
  // 删末尾元素时新数组正好是旧数组的前缀，只比元素会误判成「没变化」
  const same =
    children.length === node.children.length &&
    children.every((c, i) => c === node.children[i]);
  return same ? node : { ...node, children };
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 输入框宽度按「视觉字数」算：一个汉字顶两格，避免文字被截成半个。 */
function textWidth(text) {
  let units = 0;
  for (const ch of String(text || '')) units += CJK.test(ch) ? 2 : 1;
  return Math.min(56, Math.max(8, units + 2));
}

function MindNode({
  node,
  depth,
  collapsed,
  onText,
  onAddChild,
  onAddSibling,
  onRemove,
  onToggle,
}) {
  const hasChildren = node.children.length > 0;
  // 只有确实画得出子级时才收起：空节点没有可折叠的内容
  const isCollapsed = hasChildren && collapsed.has(node.id);
  const showChildren = hasChildren && !isCollapsed;

  return (
    <div className="ct-mm-branch">
      <div
        className={`ct-mm-node${depth === 0 ? ' is-root' : ''}${
          showChildren ? ' has-children' : ''
        }`}
      >
        <input
          data-mm-id={node.id}
          value={node.text}
          placeholder={depth === 0 ? '中心想法' : '分支'}
          aria-label={depth === 0 ? '中心想法' : '分支'}
          title={node.text || undefined}
          style={{ width: `${textWidth(node.text)}ch` }}
          onChange={(e) => onText(node.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onAddSibling(node.id);
            } else if (e.key === 'Tab') {
              e.preventDefault();
              onAddChild(node.id);
            } else if (e.key === 'Backspace' && depth > 0 && !node.text) {
              // 空节点上按退格直接删掉，不用去点小叉
              e.preventDefault();
              onRemove(node.id);
            }
          }}
        />
        <span className="ct-mm-ops">
          {hasChildren && (
            <button
              type="button"
              className="ct-mm-toggle"
              title={isCollapsed ? '展开分支' : '收起分支'}
              aria-label={isCollapsed ? '展开分支' : '收起分支'}
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(node.id)}
            >
              {isCollapsed ? '+' : '−'}
            </button>
          )}
          <button
            type="button"
            title="加一层分支（Tab）"
            aria-label="加一层分支"
            onClick={() => onAddChild(node.id)}
          >
            +
          </button>
          {depth > 0 && (
            <button
              type="button"
              className="is-danger"
              title="删掉这个分支"
              aria-label="删掉这个分支"
              onClick={() => onRemove(node.id)}
            >
              ×
            </button>
          )}
        </span>
      </div>

      {showChildren && (
        <div className="ct-mm-children">
          {node.children.map((child) => (
            <MindNode
              key={child.id}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              onText={onText}
              onAddChild={onAddChild}
              onAddSibling={onAddSibling}
              onRemove={onRemove}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 灵感的脑图。
 *
 * 一屏里做三件事：把发散的节点摆出来、存回这条灵感、把结构转成设定。
 * 存的是缩进大纲，所以关掉脑图之后，列表里、AI 上下文里读到的仍是可读文字。
 */
export default function MindMapModal({ item, workId, onClose, onSaved }) {
  const open = item !== undefined;

  const initialRoot = useMemo(() => {
    if (!open) return null;
    const text = String(item?.text || '');
    const firstLine = text.split('\n').find((line) => line.trim()) || '新想法';
    return toRoot(parseOutline(text), firstLine.trim());
  }, [open, item]);

  const [root, setRoot] = useState(initialRoot);
  const [focusId, setFocusId] = useState('');
  // 收起来的分支：只影响画面，不影响写回大纲的结构
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [mode, setMode] = useState('branches');
  // 作者手动选过转换方式之后，不再自动跟着结构切
  const [modeTouched, setModeTouched] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('其他');
  const [importance, setImportance] = useState(3);
  const [working, setWorking] = useState(false);

  // 每次打开重新落一次初始值：脑图关掉再开另一条灵感时不能带着上一条的树。
  useEffect(() => {
    if (!open) return;
    setRoot(initialRoot);
    setFocusId('');
    setCollapsed(new Set());
    // 设定名留空，转换时默认取中心想法；作者填了才用填的
    setName('');
    setCategory('其他');
    setImportance(3);
    setModeTouched(false);
    setMode(treeToTable(initialRoot) ? 'table' : 'branches');
  }, [open, item, initialRoot]);

  useEffect(() => {
    if (!focusId) return;
    const el = document.querySelector(`[data-mm-id="${focusId}"]`);
    if (el) {
      el.focus();
      el.select?.();
    }
    setFocusId('');
  }, [focusId, root]);

  const branches = (root?.children || []).filter((b) => String(b.text || '').trim());
  const table = useMemo(() => (root ? treeToTable(root) : null), [root]);

  // 结构一旦能收成表，默认就切到「收成一张表」：这是作者画这张图的目的。
  // 一旦他自己点过，就不再抢他的选择。
  useEffect(() => {
    if (!modeTouched && table) setMode('table');
  }, [table, modeTouched]);

  if (!open || !root) return null;

  const patchText = (id, text) => setRoot((prev) => setText(prev, id, text));
  const patchAddChild = (id) => {
    const child = makeNode('');
    setRoot((prev) => addChild(prev, id, child));
    // 往收起的分支里加节点时自动展开，否则新框看不见
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setFocusId(child.id);
  };
  const patchAddSibling = (id) => {
    const sibling = makeNode('');
    if (id === root.id) {
      setRoot((prev) => addChild(prev, id, sibling));
    } else {
      setRoot((prev) => addSibling(prev, id, sibling));
    }
    setFocusId(sibling.id);
  };
  const patchRemove = (id) => setRoot((prev) => removeNode(prev, id));
  const patchToggle = (id) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 把当前的树写回灵感。返回落库后的 id；转设定前必须先调一次。 */
  const persist = async () => {
    const text = serializeOutline(root);
    if (!text.trim()) return null;
    if (item?.id) {
      await api.put(`/inspirations/${item.id}`, { text });
      return item.id;
    }
    const res = await api.post('/inspirations', { text });
    return res.data?.id;
  };

  const save = async () => {
    if (!serializeOutline(root).trim()) {
      message.warning('先写下中心想法');
      return;
    }
    setWorking(true);
    try {
      await persist();
      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || '保存失败');
    } finally {
      setWorking(false);
    }
  };

  const convert = async () => {
    if (!workId) {
      message.warning('先选一个作品，设定要挂在作品下');
      return;
    }
    setWorking(true);
    try {
      // 先存脑图再建设定：转换完后这张图还得留在灵感里，
      // 否则作者回头看不到自己是怎么推出来的。
      let savedId = null;
      try {
        savedId = await persist();
        onSaved?.();
      } catch (e) {
        message.error(e.response?.data?.error || '脑图没存上，暂不转设定');
        return;
      }

      if (mode === 'table') {
        if (!table) {
          message.warning('至少要有两层分支才能收成表');
          return;
        }
        await api.post('/settings', {
          workId,
          name: String(name || '').trim() || root.text.trim() || '未命名设定',
          category,
          importance,
          content: serializeTable(table),
        });
        message.success('已建一条设定，对照表在「设定」里');
      } else {
        if (!branches.length) {
          message.warning('先写下一级分支');
          return;
        }
        for (const branch of branches) {
          // 顺序写：一次建多条时，任何一条失败都能停下来，不会留下半套卡片
          await api.post('/settings', {
            workId,
            name: String(branch.text).trim(),
            category,
            importance,
            content: branchContent(branch),
          });
        }
        message.success(`已建 ${branches.length} 条设定，在「设定」里`);
      }

      // 已经变成设定的灵感不再算「待用」：在列表里归到「已用」，
      // 也不再把同一份念头重复喂给 AI。作者随时可以点回来。
      if (savedId) {
        try {
          await api.put(`/inspirations/${savedId}`, { consumed: 1 });
        } catch (e) {
          /* 标记失败不影响设定已经建好 */
        }
      }

      onSaved?.();
      onClose?.();
    } catch (e) {
      message.error(e.response?.data?.error || '转为设定失败');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Modal
      open
      title="脑图"
      width="min(1120px, 94vw)"
      footer={null}
      onCancel={() => onClose?.()}
      destroyOnClose
    >
      <div className="ct-mm">
        <div className="ct-mm-canvas">
          <div className="ct-mm-stage">
            <MindNode
              node={root}
              depth={0}
              collapsed={collapsed}
              onText={patchText}
              onAddChild={patchAddChild}
              onAddSibling={patchAddSibling}
              onRemove={patchRemove}
              onToggle={patchToggle}
            />
          </div>
        </div>

        <div className="ct-mm-foot">
          <div className="ct-mm-seg" role="group" aria-label="转为设定的方式">
            <button
              type="button"
              className={mode === 'branches' ? 'is-on' : ''}
              onClick={() => {
                setModeTouched(true);
                setMode('branches');
              }}
            >
              每个分支一条设定
            </button>
            <button
              type="button"
              className={mode === 'table' ? 'is-on' : ''}
              disabled={!table}
              onClick={() => {
                setModeTouched(true);
                setMode('table');
              }}
            >
              收成一张表
            </button>
          </div>

          <div className="ct-mm-fields">
            {mode === 'table' && (
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={root.text?.trim() || '设定名'}
                aria-label="设定名"
                className="ct-mm-name"
              />
            )}
            <Select
              value={category}
              onChange={setCategory}
              options={SETTING_CATEGORIES.map((c) => ({ value: c, label: c }))}
              aria-label="分类"
              className="ct-mm-cat"
            />
            <Select
              value={importance}
              onChange={setImportance}
              options={IMPORTANCE}
              aria-label="重要度"
              className="ct-mm-imp"
            />
          </div>

          <div className="ct-mm-preview">
            {mode === 'table'
              ? table && <Markdown>{serializeTable(table)}</Markdown>
              : branches.length > 0 && (
                  <ul className="ct-mm-branch-list">
                    {branches.map((branch) => (
                      <li key={branch.id}>
                        <span>{branch.text}</span>
                        <em>
                          {branch.children.filter((c) => c.text.trim()).length} 项
                        </em>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        </div>

        <div className="ct-mm-actions">
          <Button onClick={() => onClose?.()}>取消</Button>
          <Button onClick={save} loading={working}>
            保存脑图
          </Button>
          <Button type="primary" onClick={convert} loading={working}>
            转为设定
          </Button>
        </div>
      </div>
    </Modal>
  );
}
