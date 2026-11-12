import { useEffect, useRef, type RefObject } from 'react';

/** A finger has to travel this far before the touch counts as a drag. */
const DRAG_PX = 10;

/** Takes focus out of `container`, which lowers the on-screen keyboard it raised. */
export function blurWithin(container: HTMLElement | null | undefined): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && container?.contains(focused)) focused.blur();
}

/**
 * Lowers the keyboard when a finger drags the scroller up or down, as a
 * native chat does: the field `field` returns lets go of focus. A tap, a
 * pinch or a sideways swipe keeps it, and so does a field outside `field`.
 */
export function useDismissKeyboardOnDrag(
  scrollRef: RefObject<HTMLElement | null>,
  active: boolean,
  field: () => HTMLElement | null | undefined,
): void {
  const fieldRef = useRef(field);
  fieldRef.current = field;
  useEffect(() => {
    const el = scrollRef.current;
    if (!active || !el) return;
    // Where the one finger went down; null once this touch is decided or is not one finger.
    let start: { x: number; y: number } | null = null;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      start = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!start || !touch) return;
      if (event.touches.length > 1) { start = null; return; }
      const dx = Math.abs(touch.clientX - start.x);
      const dy = Math.abs(touch.clientY - start.y);
      if (dx < DRAG_PX && dy < DRAG_PX) return;
      start = null;
      if (dy > dx) blurWithin(fieldRef.current());
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
    };
  }, [scrollRef, active]);
}
