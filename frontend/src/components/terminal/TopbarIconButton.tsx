import React from 'react';
import { HoverTip } from '../ui/Popover';

/** Every hint in the top bar appears after the same hover dwell. */
export const TOPBAR_TIP_DELAY_MS = 0;

export const TOPBAR_BUTTON_W = 26;

/**
 * A top-bar icon button with its hint; `dot` marks something unread. A toggle
 * passes `pressed`, a panel opener `expanded`, a page link `current`: each
 * sets its ARIA state and the on look (.is-on), which `active` gives alone.
 * A button that opens a menu or dialog also passes `hasPopup`; its
 * aria-expanded then always says whether that is open.
 */
export function TopbarIconButton({
  onClick,
  label,
  tooltip,
  tooltipKbd,
  active: on,
  pressed,
  expanded,
  current,
  disabled,
  dot,
  hasPopup,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  tooltip: string;
  tooltipKbd?: string;
  active?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  current?: boolean;
  disabled?: boolean;
  dot?: boolean;
  /** The menu or dialog the button opens. */
  hasPopup?: 'menu' | 'dialog';
  className?: string;
  children: React.ReactNode;
}) {
  const active = on || pressed || expanded || current;
  return (
    <HoverTip label={tooltip} kbd={tooltipKbd} delayMs={TOPBAR_TIP_DELAY_MS} disabled={disabled}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-disabled={disabled || undefined}
        aria-pressed={pressed}
        aria-haspopup={hasPopup}
        aria-expanded={hasPopup ? !!expanded : expanded}
        aria-current={current ? 'page' : undefined}
        className={['t-icon-btn', 'topbar-icon-btn', active && 'is-on', className].filter(Boolean).join(' ')}
        style={{
          position: 'relative',
          minWidth: TOPBAR_BUTTON_W,
          height: TOPBAR_BUTTON_W,
          padding: '0 6px',
          flexShrink: 0,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {children}
        {dot && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              width: 5,
              height: 5,
              borderRadius: 'var(--ui-radius-pill)',
              background: 'var(--term-accent)',
            }}
          />
        )}
      </button>
    </HoverTip>
  );
}
