import React from 'react';
import {
  UserOutlined,
  BookOutlined,
  PartitionOutlined,
  BulbOutlined,
} from '@ant-design/icons';

/**
 * 左栏面板导航。
 *
 * 之前用 antd Tabs 承载这些面板，但左栏只有 260px 宽，
 * Tabs 溢出后 antd 会把靠后的几个 tab 塞进「更多」下拉里——
 * 功能就这么被藏起来了，用户根本不知道它们存在。
 *
 * 改成纵向分段：图标 + 文字，全部露出来，一眼扫完。
 *
 * 「作品」「进度」已经挪到设置页「作品」：书名/题材/简介/大纲/目标字数/模板
 * 都是配置一次的东西，写作时不该占左栏一格。
 * 知情边界同样不在写作页，收进了设置页的「历史悬疑」。
 *
 * 「检查」面板已移除：它和右栏审稿人重复，规则检查改为后台静默跑，
 * 只有高优先级问题时才在章节行点一个圆点。
 */
const PANELS = [
  { key: 'characters', label: '人物', icon: <UserOutlined /> },
  { key: 'settings', label: '设定', icon: <BookOutlined /> },
  { key: 'plot', label: '情节', icon: <PartitionOutlined /> },
  { key: 'inspirations', label: '灵感', icon: <BulbOutlined /> },
];

export default function PanelNav({ activeKey, onChange, badges = {} }) {
  return (
    <nav className="ct-panel-nav" role="tablist" aria-label="作品资料面板">
      {PANELS.map((p) => {
        const active = p.key === activeKey;
        const count = Number(badges[p.key] || 0);
        return (
          <button
            key={p.key}
            role="tab"
            aria-selected={active}
            className={`ct-panel-tab${active ? ' is-active' : ''}`}
            onClick={() => onChange(p.key)}
            title={count > 0 ? `${p.label}（${count} 条待确认）` : p.label}
          >
            <span className="ct-panel-tab-icon">
              {p.icon}
              {count > 0 && (
                <span
                  className="ct-panel-tab-badge"
                  aria-label={`${count} 条待确认`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span className="ct-panel-tab-label">{p.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
