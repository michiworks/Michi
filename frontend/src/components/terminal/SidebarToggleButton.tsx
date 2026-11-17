import React from 'react';
import { kbd } from '../../lib/platform';
import { HoverTip } from '../ui/Popover';
import { TOPBAR_TIP_DELAY_MS } from './TopbarIconButton';
import { ICON_PX, strokeFor } from './icons';

export interface SidebarToggleButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  style?: React.CSSProperties;
  /** The phone's top bar draws solid glyphs: the frame with its sidebar filled in. */
  filled?: boolean;
}

export default function SidebarToggleButton({ collapsed, onToggle, style, filled = false }: SidebarToggleButtonProps) {
  const label = collapsed ? 'Open sidebar' : 'Collapse sidebar';
  return (
    <HoverTip label={label} kbd={kbd('mod', 'B')} delayMs={TOPBAR_TIP_DELAY_MS}>
      <button
        type="button"
        onClick={onToggle}
        aria-label={label}
        // The button discloses the sidebar: expanded while it is open.
        aria-expanded={!collapsed}
        // Its colours and hover are .t-sidebar-toggle's (index.css).
        style={{
          width: 26,
          height: 26,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--ui-radius)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          ...style,
        }}
        className="t-sidebar-toggle"
      >
        {filled ? (
          <svg width={ICON_PX.md} height={ICON_PX.md} viewBox="0 0 16 16" aria-hidden="true">
            <path fill="currentColor" fillRule="evenodd" d="M3 2.5h10a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4A1.5 1.5 0 0 1 3 2.5ZM7 4v8h5.5a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5Z" />
          </svg>
        ) : (
          <svg
            width={ICON_PX.md}
            height={ICON_PX.md}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeFor(ICON_PX.md)}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" />
            <line x1="6" y1="3" x2="6" y2="13" />
          </svg>
        )}
      </button>
    </HoverTip>
  );
}
