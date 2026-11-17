import React, { useEffect, useRef, useState } from 'react';
import { useIsPresent } from 'motion/react';
import { measureSurface, PopoverSurface } from '../../../ui/Popover';
import { useBackLayer } from '../../../../lib/backStack';
import { placeBelowAnchor, useAnchoredPosition } from '../../../ui/useAnchoredPosition';
import { isImeComposing } from '../../../../lib/ime';

const GAP = 4;

interface Entry { surface: () => HTMLElement | null }
/** Open popovers, innermost last: Esc and outside clicks belong to the innermost. */
const stack: Entry[] = [];

export type DbAnchor = HTMLElement | { x: number; y: number };

function anchorRect(anchor: DbAnchor): { left: number; right: number; top: number; bottom: number } {
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
}

/**
 * A floating panel for the database UI (menus, filter/sort/group panels,
 * pickers): hangs under its anchor (above when the viewport runs out),
 * focuses its first control, and closes on Esc or a press outside. Nested
 * panels close innermost first. Keys inside never reach the page's own
 * shortcuts (Esc leaving the page, ↑/↓ moving the peek).
 */
export function DbPopover({
  anchor,
  onClose,
  align = 'start',
  width,
  role = 'dialog',
  label,
  className,
  restoreFocus = true,
  children,
}: {
  anchor: DbAnchor;
  /** `escape`: Esc (give up); `outside`: a press elsewhere (keep what was picked). */
  onClose: (reason: 'escape' | 'outside') => void;
  align?: 'start' | 'end';
  width?: number;
  role?: 'dialog' | 'menu';
  label: string;
  className?: string;
  restoreFocus?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Inside the caller's <AnimatePresence> a closed panel fades out for a moment
  // (PopoverSurface); meanwhile it is off the stack and takes no keys, presses or Back.
  const present = useIsPresent();
  // Focus goes back to the anchor, or, for a panel opened at a point (a
  // right-click), to what had it before the panel took it.
  const [focusedBefore] = useState(() => document.activeElement);
  useBackLayer(present, { back: () => onCloseRef.current('escape') });

  useAnchoredPosition({ anchor: anchor instanceof HTMLElement ? anchor : null, surfaceRef: ref, dependencies: [anchor, align, width], measure: () => {
    // The size it settles to, not the scaled box it grows in from.
    const size = ref.current ? measureSurface(ref.current) : null;
    const { left, top } = placeBelowAnchor(anchorRect(anchor), { width: size?.width || width || 240, height: size?.height || 0 }, { align, gap: GAP });
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  } });

  useEffect(() => {
    if (!present) return;
    const entry: Entry = { surface: () => ref.current };
    stack.push(entry);
    const top = () => stack[stack.length - 1] === entry;
    const anchorElement = anchor instanceof HTMLElement ? anchor : null;
    const returnTo = anchorElement ?? (focusedBefore instanceof HTMLElement && focusedBefore !== document.body ? focusedBefore : null);
    const focusable = ref.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button, [tabindex="0"], [role="menuitem"], [role="menuitemradio"]');
    (focusable ?? ref.current)?.focus({ preventScroll: true });

    const onKey = (event: KeyboardEvent) => {
      if (!top() || isImeComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current('escape');
        if (restoreFocus) returnTo?.focus({ preventScroll: true });
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!top()) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (anchorElement?.contains(target)) return;
      onCloseRef.current('outside');
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      // A choice or Enter closes the panel with focus inside it, which drops
      // focus to <body> (ST-10). Once the commit is done, give it back,
      // unless it went somewhere on purpose, such as a panel opened next.
      if (restoreFocus && returnTo) queueMicrotask(() => {
        if (returnTo.isConnected && (!document.activeElement || document.activeElement === document.body)) returnTo.focus({ preventScroll: true });
      });
    };
    // Armed while present: the anchor of an open panel does not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  return (
    <PopoverSurface
      ref={ref}
      menuKind="context"
      role={role}
      aria-label={label}
      escapeLayer="over"
      width={width}
      left={pos?.left ?? 0}
      top={pos?.top ?? 0}
      zIndex="var(--z-context-menu)"
      className={`michi-db-pop${className ? ` ${className}` : ''}`}
      style={pos ? undefined : { visibility: 'hidden' }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div
        className="michi-db-pop__body"
        tabIndex={-1}
        // Keys typed here are the panel's: the page's shortcuts never see them.
        onKeyDown={(event) => {
          if (event.key !== 'Escape') event.stopPropagation();
        }}
      >
        {children}
      </div>
    </PopoverSurface>
  );
}

/** One row of a database menu: icon, label, optional right-hand hint. With `checked` it is one choice of several (a radio item). */
export function DbMenuItem({
  icon,
  label,
  hint,
  danger,
  disabled,
  checked,
  onSelect,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: (item: HTMLElement) => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      className="michi-db-mi"
      data-danger={danger ? 'true' : undefined}
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => onSelect(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.closest('.michi-db-pop__body')?.querySelectorAll<HTMLButtonElement>('.michi-db-mi:not(:disabled)') ?? []);
        const at = items.indexOf(event.currentTarget);
        items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      <span className="michi-db-mi__icon" aria-hidden="true">{icon}</span>
      <span className="michi-db-mi__label">{label}</span>
      {hint !== undefined && <span className="michi-db-mi__hint">{hint}</span>}
    </button>
  );
}

/** A toggle switch row, as the group panel's options. */
export function DbSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="michi-db-switch" onClick={() => onChange(!checked)}>
      <span className="michi-db-switch__label">{label}</span>
      <span className="michi-db-switch__track" aria-hidden="true" />
    </button>
  );
}
