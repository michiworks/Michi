import { useLayoutEffect, useRef, type RefObject } from 'react';

/** = DUR.collapse-ish on EASE.drawer: the held room gives way like a panel closing. */
const RELEASE_MS = 220;
const RELEASE_EASE = 'cubic-bezier(.32, .72, 0, 1)';

/**
 * While `live`, the element never gets shorter. A live turn folds its own
 * work as it goes (the Working card's body closes when the answer starts), and
 * a transcript pinned to its tail would answer each fold by sliding everything
 * above it down, then back up as the answer streams in. Holding the height
 * instead keeps the room a fold frees for the answer that fills it: the
 * thread only ever grows down.
 *
 * The hold is a `min-height` that follows the tallest the element has been
 * this turn. When the turn ends, any room the answer did not fill eases away
 * (instantly under reduced motion).
 */
export function useHoldHeightWhileLive(
  ref: RefObject<HTMLElement | null>,
  live: boolean,
  reduceMotion: boolean,
): void {
  const releaseTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !live || typeof ResizeObserver === 'undefined') return undefined;
    if (releaseTimer.current !== null) {
      window.clearTimeout(releaseTimer.current);
      releaseTimer.current = null;
    }
    el.style.transition = '';
    const cs = getComputedStyle(el);
    // min-height sizes the box its box-sizing names; offsetHeight is the
    // border box, and ignores transforms on the way in.
    const chrome = cs.boxSizing === 'border-box'
      ? 0
      : (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
        + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    let held = 0;
    const hold = () => {
      const height = el.offsetHeight - chrome;
      if (height <= held) return;
      held = height;
      el.style.minHeight = `${held}px`;
    };
    hold();
    const observer = new ResizeObserver(hold);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (!el.style.minHeight) return;
      if (reduceMotion) {
        el.style.minHeight = '';
        return;
      }
      el.style.transition = `min-height ${RELEASE_MS}ms ${RELEASE_EASE}`;
      el.style.minHeight = '0px';
      releaseTimer.current = window.setTimeout(() => {
        releaseTimer.current = null;
        el.style.transition = '';
        el.style.minHeight = '';
      }, RELEASE_MS + 40);
    };
  }, [ref, live, reduceMotion]);
}
