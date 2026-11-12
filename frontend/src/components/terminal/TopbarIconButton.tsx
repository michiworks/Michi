import React from 'react';
import { HoverTip } from '../ui/Popover';

/** Every hint in the top bar appears after the same hover dwell. */
export const TOPBAR_TIP_DELAY_MS = 0;

export const TOPBAR_BUTTON_W = 26;

/** A top-bar icon button with its hint; `dot` marks something unread. */
export function TopbarIconButton({
  onClick,
  label,
  tooltip,
  tooltipKbd,
  active,
  disabled,
  dot,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  tooltip: string;
  tooltipKbd?: string;
  active?: boolean;
  disabled?: boolean;
  dot?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <HoverTip label={tooltip} kbd={tooltipKbd} delayMs={TOPBAR_TIP_DELAY_MS} disabled={disabled}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-disabled={disabled || undefined}
        className={['t-icon-btn', active && 'is-on', className].filter(Boolean).join(' ')}
        style={{
          position: 'relative',
          minWidth: TOPBAR_BUTTON_W,
          height: TOPBAR_BUTTON_W,
          padding: '0 6px',
          color: active ? undefined : 'var(--term-faint)',
          opacity: disabled ? 0.3 : undefined,
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
