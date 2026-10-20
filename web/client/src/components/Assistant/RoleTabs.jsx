import React from 'react';
import { Tooltip } from 'antd';

/**
 * 五个 AI 角色的切换标签。
 */
export default function RoleTabs({ roles, activeKey, onChange }) {
  if (!roles?.length) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        padding: '8px 10px',
        borderBottom: '1px solid rgba(128,128,128,0.15)',
        overflowX: 'auto',
      }}
    >
      {roles.map((role) => {
        const active = role.key === activeKey;
        return (
          <Tooltip key={role.key} title={role.description}>
            <button
              onClick={() => onChange(role.key)}
              style={{
                border: active ? '1px solid transparent' : '1px solid rgba(128,128,128,0.25)',
                background: active ? role.color : 'transparent',
                color: active ? '#fff' : 'inherit',
                borderRadius: 16,
                padding: '4px 12px',
                fontSize: 13,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                opacity: active ? 1 : 0.7,
              }}
            >
              {role.icon} {role.name}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
