import React from 'react';
import {
  UserOutlined,
  BookOutlined,
  PartitionOutlined,
  LineChartOutlined,
  SafetyOutlined,
  InfoCircleOutlined,
  BulbOutlined,
} from '@ant-design/icons';

/**
 * 左栏面板导航。
 *
 * 之前用 antd Tabs 承载这 7 个面板，但左栏只有 260px 宽，
 * Tabs 溢出后 antd 会把「检查/作品/灵感」塞进「更多」下拉里——
 * 功能就这么被藏起来了，用户根本不知道它们存在。
 *
 * 改成纵向分段：图标 + 文字，7 个全露出来，一眼扫完。
 */
const PANELS = [
  { key: 'characters', label: '人物', icon: <UserOutlined /> },
  { key: 'settings', label: '设定', icon: <BookOutlined /> },
  { key: 'plot', label: '情节', icon: <PartitionOutlined /> },
  { key: 'progress', label: '进度', icon: <LineChartOutlined /> },
  { key: 'check', label: '检查', icon: <SafetyOutlined /> },
  { key: 'work', label: '作品', icon: <InfoCircleOutlined /> },
  { key: 'inspirations', label: '灵感', icon: <BulbOutlined /> },
];

export default function PanelNav({ activeKey, onChange }) {
  return (
    <nav className="ct-panel-nav" role="tablist" aria-label="作品资料面板">
      {PANELS.map((p) => {
        const active = p.key === activeKey;
        return (
          <button
            key={p.key}
            role="tab"
            aria-selected={active}
            className={`ct-panel-tab${active ? ' is-active' : ''}`}
            onClick={() => onChange(p.key)}
            title={p.label}
          >
            <span className="ct-panel-tab-icon">{p.icon}</span>
            <span className="ct-panel-tab-label">{p.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
