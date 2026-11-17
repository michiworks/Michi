import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { PopoverSurface } from '../ui/Popover';
import { Dot } from './primitives';
import { MinimizeIcon } from './icons';

/** A pane the zoom keeps off screen, as its caption would show it. */
export interface ZoomHiddenPane {
  id: string;
  title: string;
  status: 'idle' | 'streaming' | 'error';
}

const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 200;
const LIST_GAP = 6;
const VIEWPORT_MARGIN = 8;

function dotColor(status: ZoomHiddenPane['status']): string {
  if (status === 'streaming') return 'var(--term-run)';
  if (status === 'error') return 'var(--term-danger)';
  return 'var(--term-faint)';
}

interface Props {
  hiddenPanes: readonly ZoomHiddenPane[];
  shortcut: string;
  /** Move the zoom to a hidden pane, or end it with null. */
  onZoom: (id: string | null) => void;
  style?: React.CSSProperties;
}

/**
 * The exit pill a zoomed caption carries. A click ends the zoom; hovering it
 * (or ArrowDown on it) lists the panes the zoom hides, and picking one moves
 * the zoom there.
 */
export default function PaneZoomExit({ hiddenPanes, shortcut, onZoom, style }: Props) {
  const count = hiddenPanes.length;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const focusFirst = useRef(false);
  const listId = useId();

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const later = (fn: () => void, ms: number) => {
    clearTimer();
    timer.current = window.setTimeout(() => { timer.current = null; fn(); }, ms);
  };
  useEffect(() => clearTimer, []);
  useEffect(() => { if (count === 0) setOpen(false); }, [count]);

  const close = useCallback((restoreFocus: boolean) => {
    clearTimer();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const width = list.current?.offsetWidth ?? 0;
    setPosition({
      left: Math.max(VIEWPORT_MARGIN, Math.min(box.left, window.innerWidth - width - VIEWPORT_MARGIN)),
      top: box.bottom + LIST_GAP,
    });
  }, [open, count]);

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      focusFirst.current = false;
      list.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      const current = rows.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(current >= 0);
      } else if (current >= 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        rows[next]?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, close]);

  const hoverIn = () => { if (count > 0) later(() => setOpen(true), open ? 0 : OPEN_DELAY_MS); };
  const hoverOut = () => later(() => setOpen(false), CLOSE_DELAY_MS);
  // The list is portaled to body, but React still bubbles its events through
  // the caption: keep them from focusing the caption or starting its drag.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <>
      <button
        ref={trigger}
        type="button"
        data-testid="pane-zoom-exit"
        aria-label={`Exit zoom, ${count} more ${count === 1 ? 'pane' : 'panes'}`}
        aria-keyshortcuts={count > 0 ? 'ArrowDown' : undefined}
        aria-expanded={count > 0 ? open : undefined}
        aria-controls={open ? listId : undefined}
        title={`Exit zoom (${shortcut})`}
        onClick={(event) => { event.stopPropagation(); close(false); onZoom(null); }}
        onMouseDown={stop}
        onPointerEnter={hoverIn}
        onPointerLeave={hoverOut}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' || count === 0) return;
          event.preventDefault();
          event.stopPropagation();
          focusFirst.current = true;
          clearTimer();
          if (open) list.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
          else setOpen(true);
        }}
        className="pane-caption-zoom-exit"
        style={style}
      >
        <MinimizeIcon />
        {count > 0 && <span>+{count}</span>}
      </button>
      <AnimatePresence>{open && (
        <PopoverSurface
          key="hidden-panes"
          ref={list}
          menuKind="context"
          glass
          role="menu"
          aria-label="Hidden panes"
          left={position?.left ?? -9999}
          top={position?.top ?? -9999}
          minWidth={220}
          maxWidth={360}
          onMouseDown={stop}
          onClick={stop}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onMouseLeave={hoverOut}
          style={{ visibility: position ? undefined : 'hidden' }}
        >
          <div
            id={listId}
            data-testid="pane-zoom-hidden-list"
            onPointerEnter={clearTimer}
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (next && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) close(false);
            }}
          >
            <div className="pane-zoom-list-head">
              <span>Hidden panes</span>
              <span className="michi-menu-keys">{shortcut} exits</span>
            </div>
            {hiddenPanes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                role="menuitem"
                className="ui-menu-item"
                onClick={() => { close(false); onZoom(pane.id); }}
              >
                <Dot color={dotColor(pane.status)} size={6} pulse={pane.status === 'streaming'} />
                <span className="michi-menu-label" title={pane.title}>{pane.title}</span>
              </button>
            ))}
          </div>
        </PopoverSurface>
      )}</AnimatePresence>
    </>
  );
}
