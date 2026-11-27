import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dropdown, Tooltip } from 'antd';
import { ChevronDown } from 'lucide-react';
import RoleMark from './RoleMark';

/**
 * 五个 AI 角色的切换标签。
 *
 * 之前激活态用 role.color 当背景配白字，那套颜色是后端给的固定色，
 * 和主题的墨/朱砂体系完全打架。这里统一走主题色，只用角色图标做区分。
 *
 * 图标按 role.key 用本地线描覆盖：服务端下发的是 emoji，直接渲染会漏出来。
 *
 * 窄栏（右栏收到 336 以下）不再靠隐藏全部名字硬塞五个：
 * 保留前三个带名字的标签，第四个位置做「更多」入口，
 * 被折叠的角色进下拉；当前角色若在折叠区，入口直接显示它，
 * 选中态的下划线也落在入口上，不会不知道自己在哪个角色。
 */
const COMPACT_BELOW = 336;
// 300 以下再让一步：三个名字 + 更多会让折叠区的角色名在入口上被截成「灵…」，
// 宁可少露一个标签，也要让当前角色完整可读。
const TIGHT_BELOW = 300;
const KEEP_WIDE = 3;
const KEEP_TIGHT = 2;

export default function RoleTabs({ roles, activeKey, onChange }) {
  const wrapRef = useRef(null);
  const [tabsWidth, setTabsWidth] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const apply = (width) => setTabsWidth(width);
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      apply(entries[0].target.getBoundingClientRect().width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [roles?.length]);

  if (!roles?.length) return null;

  const compact = tabsWidth > 0 && tabsWidth < COMPACT_BELOW;
  const tight = tabsWidth > 0 && tabsWidth < TIGHT_BELOW;
  const keep = tight ? KEEP_TIGHT : KEEP_WIDE;
  const visible = compact ? roles.slice(0, keep) : roles;
  const folded = compact ? roles.slice(keep) : [];
  const activeFolded = folded.find((role) => role.key === activeKey);

  return (
    <div
      ref={wrapRef}
      className={`ct-role-tabs${folded.length ? ' is-compact' : ''}${folded.length && tight ? ' is-tight' : ''}`}
      role="tablist"
      aria-label="AI 角色"
    >
      {visible.map((role) => {
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
                <RoleMark roleKey={role.key} size={14} />
              </span>
              <span className="ct-role-name">{role.name}</span>
            </button>
          </Tooltip>
        );
      })}

      {folded.length > 0 && (
        <Dropdown
          trigger={['click']}
          placement="bottomRight"
          menu={{
            items: folded.map((role) => ({
              key: role.key,
              label: (
                <span className="ct-role-menu-item">
                  <RoleMark roleKey={role.key} size={14} />
                  <span>{role.name}</span>
                </span>
              ),
            })),
            selectedKeys: [activeKey],
            onClick: ({ key }) => onChange(key),
          }}
        >
          <button
            type="button"
            className={`ct-role-tab is-more${activeFolded ? ' is-active' : ''}`}
            aria-haspopup="menu"
            aria-label={
              activeFolded ? `当前角色 ${activeFolded.name}，展开其余角色` : '更多角色'
            }
            title={activeFolded ? activeFolded.description : '更多角色'}
          >
            {activeFolded ? (
              <>
                <span className="ct-role-icon" aria-hidden="true">
                  <RoleMark roleKey={activeFolded.key} size={14} />
                </span>
                <span className="ct-role-name">{activeFolded.name}</span>
              </>
            ) : (
              <span className="ct-role-name">更多</span>
            )}
            <ChevronDown size={10} className="ct-role-more-caret" aria-hidden="true" />
          </button>
        </Dropdown>
      )}
    </div>
  );
}
