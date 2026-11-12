import { useEffect, useRef } from 'react';
import { escLayerOpen } from '../lib/backStack';

/** How far from the left screen edge, in CSS px, a swipe may start. */
const EDGE_SWIPE_ZONE = 24;
/** Travel before the direction counts: vertical or backward first is a scroll. */
const DIRECTION_SLOP = 10;
/** The share of a track's distance that completes it on release. */
export const SWIPE_COMMIT_FRACTION = 0.35;
/** A release this fast (CSS px per ms, forward) completes a shorter swipe. */
const FLING_VELOCITY = 0.45;
/** Velocity reads the samples within this window before the release. */
const VELOCITY_WINDOW_MS = 100;

/**
 * What a swipe moves while the finger is down. The engine reports the
 * travel in the swipe's direction (never below 0) and, on release, either
 * commits (past SWIPE_COMMIT_FRACTION of `distance`, or a forward fling)
 * or cancels (released short, pulled back, or the browser took the touch).
 */
export interface SwipeTrack {
  /** Travel, in CSS px, that is the whole swipe (the dragged panel's width). */
  distance: number;
  move(travel: number): void;
  commit(): void;
  cancel(): void;
}

export interface SwipeStart {
  x: number;
  y: number;
  target: Element | null;
}

/** Content that takes every touch for itself (a map, a drag handle) keeps
 *  its gesture, and so does a text selection being adjusted. */
function swipeAllowed(target: EventTarget | null): boolean {
  const selection = window.getSelection?.();
  if (selection && !selection.isCollapsed) return false;
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (getComputedStyle(el).touchAction === 'none') return false;
  }
  return true;
}

/**
 * Safari and the other browsers on iOS swipe back to the tab's previous page
 * (a Auth sign-in, say) from the left edge, unless the page cancels the
 * touchstart there. A home-screen web app has no such swipe.
 */
function browserSwipesBack(): boolean {
  const { userAgent, maxTouchPoints } = navigator;
  const ios = /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
  return ios && (navigator as Navigator & { standalone?: boolean }).standalone !== true;
}

/** A cancelled touchstart gets no click: a tap at the edge clicks what it touched. */
function clickAt(x: number, y: number) {
  const target = document.elementFromPoint(x, y);
  if (!target) return;
  target.closest<HTMLElement>('input, textarea, select, [contenteditable]:not([contenteditable="false"])')?.focus();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, detail: 1 }));
}

/** Whether a release at `travel`, moving at `velocity`, completes the swipe. */
export function swipeCommits(travel: number, distance: number, velocity: number): boolean {
  if (velocity < -0.1) return false;
  return travel >= distance * SWIPE_COMMIT_FRACTION || (velocity >= FLING_VELOCITY && travel >= DIRECTION_SLOP * 2);
}

/**
 * One finger moving horizontally in `direction` (1 right, -1 left), from
 * the left screen edge or from anywhere, drives the track `begin` returns
 * once the move reads as horizontal. Touch events, not pointer events: the
 * browser cancels a pointer as soon as it starts scrolling something under
 * the finger, and touch events keep arriving. Listeners are passive, so
 * scrolling is never held up, and a mouse never produces a touch event.
 * The exception is an edge swipe on iOS: there the touchstart in the edge
 * zone is cancelled, so the browser's own back swipe cannot take the
 * gesture (and a scroll cannot start in that strip).
 *
 * A tap that closed a menu (menus close on the pointerdown outside them,
 * before the touch starts) belongs to the menu: one layer per gesture.
 */
export function useSwipeTrack(
  enabled: boolean,
  direction: 1 | -1,
  from: 'edge' | 'anywhere',
  begin: (start: SwipeStart) => SwipeTrack | null,
): void {
  const beginRef = useRef(begin);
  useEffect(() => { beginRef.current = begin; }, [begin]);

  useEffect(() => {
    if (!enabled) return;
    let menuAtPointerDown = -Infinity;
    let start: (SwipeStart & { id: number }) | null = null;
    let track: SwipeTrack | null = null;
    let travel = 0;
    let samples: Array<{ t: number; travel: number }> = [];
    const reset = () => { start = null; track = null; travel = 0; samples = []; };
    const end = (commit: boolean) => {
      const current = track;
      reset();
      if (!current) return;
      if (commit) current.commit();
      else current.cancel();
    };
    const velocity = () => {
      const last = samples[samples.length - 1];
      if (!last) return 0;
      const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
      return last.t - first.t < 16 ? 0 : (last.travel - first.travel) / (last.t - first.t);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && escLayerOpen()) menuAtPointerDown = performance.now();
    };
    const guardEdge = from === 'edge' && browserSwipesBack();
    // A touch whose touchstart was cancelled, while it can still be a tap.
    let tap: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      end(false);
      tap = null;
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (from === 'edge' && touch.clientX > EDGE_SWIPE_ZONE) return;
      const allowed = swipeAllowed(e.target);
      if (guardEdge && allowed) {
        e.preventDefault();
        tap = { x: touch.clientX, y: touch.clientY };
      }
      if (performance.now() - menuAtPointerDown < 500 && !escLayerOpen()) return;
      if (!allowed) return;
      start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, target: e.target instanceof Element ? e.target : null };
    };
    const onMove = (e: TouchEvent) => {
      if (tap) {
        const touch = e.touches.length === 1 ? e.touches[0] : undefined;
        if (!touch || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > DIRECTION_SLOP) tap = null;
      }
      if (!start) return;
      const id = start.id;
      const touch = e.touches.length === 1 ? Array.from(e.touches).find(t => t.identifier === id) : undefined;
      if (!touch) { end(false); return; }
      const dx = (touch.clientX - start.x) * direction;
      const dy = Math.abs(touch.clientY - start.y);
      if (!track) {
        if (dx < -DIRECTION_SLOP || (dy > DIRECTION_SLOP && dy >= dx)) { reset(); return; }
        if (dx < DIRECTION_SLOP) return;
        track = beginRef.current(start);
        if (!track) { reset(); return; }
      }
      travel = Math.max(0, dx);
      samples.push({ t: performance.now(), travel });
      if (samples.length > 12) samples.shift();
      track.move(travel);
    };
    const onEnd = () => {
      const tapped = tap;
      tap = null;
      if (!track) {
        reset();
        if (tapped) clickAt(tapped.x, tapped.y);
        return;
      }
      end(swipeCommits(travel, track.distance, velocity()));
    };
    const onCancel = () => { tap = null; end(false); };
    const options = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', onPointerDown, options);
    window.addEventListener('touchstart', onStart, { capture: true, passive: !guardEdge });
    window.addEventListener('touchmove', onMove, options);
    window.addEventListener('touchend', onEnd, options);
    window.addEventListener('touchcancel', onCancel, options);
    return () => {
      end(false);
      window.removeEventListener('pointerdown', onPointerDown, options);
      window.removeEventListener('touchstart', onStart, options);
      window.removeEventListener('touchmove', onMove, options);
      window.removeEventListener('touchend', onEnd, options);
      window.removeEventListener('touchcancel', onCancel, options);
    };
  }, [enabled, direction, from]);
}
