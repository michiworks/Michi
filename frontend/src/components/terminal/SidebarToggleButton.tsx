import React from 'react';
import { kbd } from '../../lib/platform';
import { HoverTip } from '../ui/Popover';
import { TOPBAR_TIP_DELAY_MS } from './TopbarIconButton';

export interface SidebarToggleButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  style?: React.CSSProperties;
}

export default function SidebarToggleButton({ collapsed, onToggle, style }: SidebarToggleButtonProps) {
  const label = collapsed ? 'Open sidebar' : 'Collapse sidebar';
  const [hover, setHover] = React.useState(false);
  return (
    <HoverTip label={label} kbd={kbd('mod', 'B')} delayMs={TOPBAR_TIP_DELAY_MS}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        // The button discloses the sidebar: expanded while it is open.
        aria-expanded={!collapsed}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          width: 26,
          height: 26,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: hover ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
          border: 'none',
          borderRadius: 'var(--ui-radius)',
          color: hover ? 'var(--term-mid)' : 'var(--term-faint)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease)',
          ...style,
        }}
        className="t-sidebar-toggle"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="3" width="12" height="10" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>
    </HoverTip>
  );
}
