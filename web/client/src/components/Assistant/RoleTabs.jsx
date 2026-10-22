import React from 'react';
import { Tooltip } from 'antd';

/**
 * 五个 AI 角色的切换标签。
 *
 * 之前激活态用 role.color 当背景配白字，那套颜色是后端给的固定色，
 * 和主题的墨/朱砂体系完全打架。这里统一走主题色，只用角色图标做区分。
 */
export default function RoleTabs({ roles, activeKey, onChange }) {
  if (!roles?.length) return null;

  return (
    <div className="ct-role-tabs" role="tablist" aria-label="AI 角色">
      {roles.map((role) => {
        const active = role.key === activeKey;
        return (
          <Tooltip key={role.key} title={role.description}>
            <button
              role="tab"
              aria-selected={active}
              onClick={() => onChange(role.key)}
              className={`ct-role-tab${active ? ' is-active' : ''}`}
            >
              <span className="ct-role-icon" aria-hidden="true">
                {role.icon}
              </span>
              <span className="ct-role-name">{role.name}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
