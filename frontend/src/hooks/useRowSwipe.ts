import { useEffect, useRef, type RefObject } from 'react';
import { escLayerOpen, modalOpen } from '../lib/backStack';
import { EASE_OUT_CSS, SETTLE_MS, SLIDE_MS } from '../lib/backSwipeTracks';
import { prefersReducedMotion } from './useReducedMotion';
import {
  DIRECTION_SLOP, EDGE_SWIPE_ZONE, SWIPE_COMMIT_FRACTION, swipeAllowed, swipeCommits, swipeVelocity,
} from './useEdgeSwipe';

/** What a swipe toward each side does: it runs once the row has slid out, and a row still there when it settles (it failed) slides back. */
export interface RowSwipeActions {
  left(): Promise<unknown>;
  right(): Promise<unknown>;
}

/**
 * One finger swiping a list row sideways, as in iOS Mail. The row carries
 * the gesture for its CSS: `data-swipe` is the side it moves toward,
 * `--swipe-x` its offset, `--swipe-settle` the timing of a settle, and
 * `data-swipe-armed` says a release now would act (past
 * SWIPE_COMMIT_FRACTION of the row's width; a fling acts too). A move that
 * starts vertical is a scroll, a touch in the left edge strip is the back
 * swipe, and a mouse never swipes: the buttons stay the way without one.
 */
export function useRowSwipe(ref: RefObject<HTMLElement | null>, enabled: boolean, actions: RowSwipeActions): void {
  const live = useRef({ enabled, actions });
  useEffect(() => { live.current = { enabled, actions }; });

  useEffect(() => {
    const row = ref.current;
    if (!row) return undefined;
    let start: { id: number; x: number; y: number } | null = null;
    let side: 'left' | 'right' | null = null;
    let width = 0;
    let travel = 0;
    let samples: Array<{ t: number; travel: number }> = [];
    let timer = 0;

    const place = (x: number, ms = 0) => {
      row.style.setProperty('--swipe-settle', ms ? `${ms}ms ${EASE_OUT_CSS}` : '0s');
      row.style.setProperty('--swipe-x', `${x}px`);
    };
    const clear = () => {
      delete row.dataset.swipe;
      delete row.dataset.swipeArmed;
      row.style.removeProperty('--swipe-x');
      row.style.removeProperty('--swipe-settle');
    };
    // Under reduced motion a released swipe lands at once.
    const settle = (x: number, ms: number, then: () => void) => {
      if (prefersReducedMotion()) { place(x); then(); return; }
      place(x, ms);
      timer = window.setTimeout(then, ms);
    };
    const release = (commit: boolean) => {
      const current = side;
      start = null;
      side = null;
      samples = [];
      if (!current) return;
      if (!commit) { settle(0, SETTLE_MS, clear); return; }
      settle(current === 'left' ? -width : width, SLIDE_MS, () => {
        void live.current.actions[current]().finally(() => {
          // After the commit that drops a row its action took away, so only a row that stays comes back.
          timer = window.setTimeout(() => { if (row.isConnected) settle(0, SETTLE_MS, clear); });
        });
      });
    };

    const onStart = (event: TouchEvent) => {
      if (side) { release(false); return; }
      start = null;
      if (event.touches.length !== 1 || row.dataset.swipe !== undefined || !live.current.enabled) return;
      const touch = event.touches[0];
      if (touch.clientX <= EDGE_SWIPE_ZONE || escLayerOpen() || modalOpen() || !swipeAllowed(event.target)) return;
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const id = start.id;
      const touch = event.touches.length === 1 && event.touches[0].identifier === id ? event.touches[0] : undefined;
      if (!touch) { release(false); return; }
      const dx = touch.clientX - start.x;
      if (!side) {
        const dy = Math.abs(touch.clientY - start.y);
        // Vertical first is a scroll; one the browser has started is its own.
        if ((dy > DIRECTION_SLOP && dy >= Math.abs(dx)) || !event.cancelable) { start = null; return; }
        if (Math.abs(dx) < DIRECTION_SLOP) return;
        side = dx < 0 ? 'left' : 'right';
        width = row.getBoundingClientRect().width;
        row.dataset.swipe = side;
      }
      // The list holds still under a sideways swipe.
      if (event.cancelable) event.preventDefault();
      travel = Math.min(width, Math.max(0, side === 'left' ? -dx : dx));
      samples.push({ t: performance.now(), travel });
      if (samples.length > 12) samples.shift();
      place(side === 'left' ? -travel : travel);
      const armed = travel >= width * SWIPE_COMMIT_FRACTION;
      if (armed !== (row.dataset.swipeArmed !== undefined)) {
        if (armed) row.dataset.swipeArmed = '';
        else delete row.dataset.swipeArmed;
      }
    };
    const onEnd = () => { release(side !== null && swipeCommits(travel, width, swipeVelocity(samples))); };
    const onCancel = () => { release(false); };

    row.addEventListener('touchstart', onStart, { passive: true });
    row.addEventListener('touchmove', onMove, { passive: false });
    row.addEventListener('touchend', onEnd, { passive: true });
    row.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      window.clearTimeout(timer);
      row.removeEventListener('touchstart', onStart);
      row.removeEventListener('touchmove', onMove);
      row.removeEventListener('touchend', onEnd);
      row.removeEventListener('touchcancel', onCancel);
    };
  }, [ref]);
}
