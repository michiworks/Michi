import React from 'react';
import { HoverTip } from '../ui/Popover';
import { MoreIcon } from './icons';

/** Small filled circle; breathes as the running dot (index.css .term-dot-i--run) when `pulse` is set. */
export function Dot({ color, size = 6, pulse = false, extraStyle }: { color: string; size?: number; pulse?: boolean; extraStyle?: React.CSSProperties }) {
  return (
    <span
      className={pulse ? 'term-dot-i term-dot-i--run' : undefined}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: 'var(--ui-radius-pill)',
        background: color,
        color,
        flexShrink: 0,
        boxShadow: pulse ? '0 0 6px 0 currentColor' : undefined,
        ...extraStyle,
      }}
    />
  );
}

/** A disclosure's one ›, turned a quarter while `open`, in place of a ▸ / ▾ swap (index.css .t-chevron). */
export function DisclosureChevron({ open, style }: { open: boolean; style?: React.CSSProperties }) {
  return <span aria-hidden className="t-chevron" data-open={open || undefined} style={style}>›</span>;
}

/** Clickable list row. Hover lifts background to --term-alt unless `active`.
 *  Use for sidebar nav items, thread rows, structure-tree rows, digest entries,
 *  settings options, and palette swatches. */
export function Row({
  active = false,
  className,
  children,
  ...rest
}: { active?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const cls = ['t-row-hover', active && 'is-active', className].filter(Boolean).join(' ');
  return <div className={cls} {...rest}>{children}</div>;
}

/** Bordered button — hover lifts background. For topbar map / digest buttons,
 *  retry, reset. */
export function BorderBtn({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['t-border-btn', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest}>{children}</button>;
}

/** Inline icon button (×, +): a `.t-icon-btn`. Name it with `aria-label`. */
export function IconBtn({
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['t-icon-btn', className].filter(Boolean).join(' ');
  return <button type="button" className={cls} {...rest}>{children}</button>;
}

/** Hover-revealed ⋯ kebab for sidebar rows. Self-anchors to the right edge
 *  of the nearest `position: relative` ancestor and paints a left-fading
 *  gradient (transparent → --term-alt) that masks whatever sits behind it,
 *  matching the Claude Code thread-list hover pattern. The parent row must
 *  show `--term-alt` while hovered or pinned (`open`) so the gradient blends
 *  seamlessly; consumers force that bg when the menu is open. A row with a
 *  hover of its own (`.t-reveal-host`, not `.t-row-hover`) takes it without
 *  the gradient (`fader={false}`). A touch screen hides it and opens the menu
 *  on a long press instead (index.css). The button shows its open state only
 *  for a menu it opened: a right-click or ⇧F10 menu leaves it unlit. */
export function RowKebab({
  open = false,
  onOpen,
  ariaLabel = 'More actions',
  fader = true,
}: {
  open?: boolean;
  onOpen: (anchor: { x: number; y: number }, button: HTMLButtonElement) => void;
  ariaLabel?: string;
  fader?: boolean;
}) {
  const cls = ['row-kebab', open && 'is-open'].filter(Boolean).join(' ');
  const [openedHere, setOpenedHere] = React.useState(false);
  if (openedHere && !open) setOpenedHere(false);
  return (
    <span
      className={cls}
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: fader ? 28 : 4,
        paddingRight: fader ? 10 : 6,
        // 28px transparent-to-alt fade, then a solid alt strip the kebab
        // sits on. Bleeds into the row's hover/active background.
        background: fader
          ? 'linear-gradient(to right, transparent 0%, var(--term-alt) 28px)'
          : undefined,
      }}
    >
      <HoverTip label="More actions">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={(open && openedHere) || undefined}
        onMouseDown={(e) => {
          // Block the row's onMouseDown/onClick.
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpenedHere(!open);
          const r = e.currentTarget.getBoundingClientRect();
          // Anchor menu just below the button's left edge so it reads as
          // attached to the kebab. ContextMenu flips on viewport overflow.
          onOpen({ x: r.left, y: r.bottom + 2 }, e.currentTarget);
        }}
        onContextMenu={(e) => e.preventDefault()}
        // Drawn like the workspace row's ⋯ (22px); the -3px margin keeps the
        // 16px footprint that sidebarRowStyle's KEBAB_FOOTPRINT assumes.
        className="ws-action-btn"
        style={{ margin: -3 }}
      >
        <MoreIcon size="lg" />
      </button>
      </HoverTip>
    </span>
  );
}

/** Bracketed uppercase tag used for status labels. */
export function Tag({
  color = 'var(--term-mid)',
  bg = 'transparent',
  strong = false,
  children,
}: {
  color?: string;
  bg?: string;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-xs)',
        padding: '2px 6px',
        border: `1px solid ${color}`,
        color,
        background: bg,
        fontWeight: strong ? 700 : 500,
        letterSpacing: 'var(--ls-wide)',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}
