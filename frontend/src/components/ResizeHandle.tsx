import React, { useCallback, useEffect, useRef } from 'react';
import './ResizeHandle.css';

interface ResizeHandleProps {
  /** Current pane element ref — used to read its width at drag start. */
  paneRef: React.RefObject<HTMLElement | null>;
  /** What the edge resizes, for its accessible name ("Resize sidebar"). */
  label: string;
  /** Called on every pointer move during drag with the current width. */
  onResize: (width: number) => void;
  /** Called on double-click to reset width. */
  onReset: () => void;
  /** Called when drag begins. */
  onResizeStart?: () => void;
  /** Called when drag ends. */
  onResizeEnd?: () => void;
  /** Min width in px. */
  min?: number;
  /** The widest the edge allows, read when needed. With it a click switches
   *  between the narrowest and widest widths; without it (dashboard panes,
   *  whose widths the pane sizing settings set) a click does nothing. */
  max?: () => number;
  side?: 'left' | 'right';
}

const MIN_DEFAULT = 280;
/** ←/→ move a focused resize edge this far. */
export const RESIZE_KEY_STEP = 24;
/** A press that moves less than this is a click, not a drag. */
export const RESIZE_CLICK_SLOP_PX = 3;
/** A click waits this long before it resizes, so the second press of a
 *  double-click resets instead, with no step showing first. */
const CLICK_STEP_DELAY_MS = 300;

/**
 * The click path of a resize edge (WCAG 2.5.7): a click calls `step` once a
 * double-click can be ruled out, a double-click calls `reset`, and the release
 * of a press the drag code marked as a drag is neither. A key press that
 * clicks a button edge steps at once.
 */
export function useResizeEdgeClicks(step: (() => void) | null, reset: () => void) {
  const timer = useRef<number | null>(null);
  const dragged = useRef(false);
  const cancel = useCallback(() => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const markDragged = useCallback(() => { dragged.current = true; }, []);
  return {
    /** A new press drops what an earlier click had pending. */
    onPointerDown: () => {
      cancel();
      dragged.current = false;
    },
    /** The press moved past RESIZE_CLICK_SLOP_PX: its release is no click. */
    markDragged,
    onClick: (event: React.MouseEvent) => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      if (!step) return;
      if (event.detail === 0) {
        step();
        return;
      }
      cancel();
      if (event.detail > 1) return;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        step();
      }, CLICK_STEP_DELAY_MS);
    },
    onDoubleClick: (event: React.MouseEvent) => {
      cancel();
      event.stopPropagation();
      reset();
    },
  };
}

/** The width a click on an edge goes to: the widest, or from there the narrowest. */
export function clickedEdgeWidth(current: number, min: number, max: number): number {
  const widest = Math.max(min, Math.round(max));
  return current >= widest - 1 ? min : widest;
}

/**
 * Vertical resize handle rendered at the edge of a pane: a focusable
 * separator. Drag to resize (live updates once per frame), ←/→ to step by
 * RESIZE_KEY_STEP, click to switch between the narrowest and widest widths
 * (when `max` is given), double-click to reset.
 */
export default function ResizeHandle({
  paneRef,
  label,
  onResize,
  onReset,
  onResizeStart,
  onResizeEnd,
  min = MIN_DEFAULT,
  max,
  side = 'right',
}: ResizeHandleProps) {
  const handleRef = useRef<HTMLDivElement>(null);
  const currentWidth = () => paneRef.current?.getBoundingClientRect().width ?? null;

  // The value is read from layout when the edge is focused or has stepped,
  // never in render, and written straight onto the separator.
  const showValue = () => {
    const handle = handleRef.current;
    const width = currentWidth();
    if (!handle || width === null) return;
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
    const widest = max?.() ?? paneRef.current?.parentElement?.clientWidth;
    if (widest !== undefined) handle.setAttribute('aria-valuemax', String(Math.max(min, Math.round(widest))));
  };

  /** One committed width, as a drag that ends at once would give. */
  const resizeTo = (width: number) => {
    onResizeStart?.();
    onResize(Math.round(Math.max(min, width)));
    onResizeEnd?.();
    requestAnimationFrame(showValue);
  };

  const clicks = useResizeEdgeClicks(max ? () => {
    const width = currentWidth();
    if (width !== null) resizeTo(clickedEdgeWidth(width, min, max()));
  } : null, onReset);
  const { markDragged } = clicks;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const el = paneRef.current;
      if (!el) return;
      const startX = e.clientX;
      const startW = el.getBoundingClientRect().width;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      let moved = false;
      let pendingW: number | null = null;
      let rafId: number | null = null;
      const flush = () => {
        rafId = null;
        if (pendingW != null) {
          onResize(pendingW);
          pendingW = null;
        }
      };
      const onMove = (ev: PointerEvent) => {
        if (!moved) {
          // A press that stays put is a click (useResizeEdgeClicks), not a drag.
          if (Math.abs(ev.clientX - startX) < RESIZE_CLICK_SLOP_PX) return;
          moved = true;
          markDragged();
          handle.setAttribute('data-dragging', '');
          onResizeStart?.();
        }
        pendingW = Math.round(Math.max(min, startW + (ev.clientX - startX) * (side === 'left' ? -1 : 1)));
        if (rafId == null) rafId = requestAnimationFrame(flush);
      };
      const onUp = () => {
        if (rafId != null) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (pendingW != null) {
          onResize(pendingW);
          pendingW = null;
        }
        if (moved) {
          handle.removeAttribute('data-dragging');
          onResizeEnd?.();
        }
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('lostpointercapture', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('lostpointercapture', onUp);
    },
    [paneRef, onResize, min, side, onResizeStart, onResizeEnd, markDragged],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const toward = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!toward) return;
    e.preventDefault();
    e.stopPropagation();
    const width = currentWidth();
    // The arrow moves the edge: on a left edge, ← widens.
    if (width !== null) resizeTo(width + toward * (side === 'left' ? -1 : 1) * RESIZE_KEY_STEP);
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      tabIndex={0}
      className="resize-handle"
      data-side={side}
      onPointerDown={(e) => {
        clicks.onPointerDown();
        onPointerDown(e);
      }}
      onClick={clicks.onClick}
      onDoubleClick={clicks.onDoubleClick}
      onKeyDown={onKeyDown}
      onFocus={showValue}
      title={max ? 'Drag or click to resize · Double-click to reset' : 'Drag to resize · Double-click to reset'}
    >
      <div className="resize-handle__grip" />
    </div>
  );
}
