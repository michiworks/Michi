import type { BackSwipePanel } from './backStack';
import { SWIPE_COMMIT_FRACTION, type SwipeTrack } from '../hooks/useEdgeSwipe';
import { prefersReducedMotion } from '../hooks/useReducedMotion';
import './backSwipe.css';

/**
 * What a back swipe shows while the finger is down: the layer itself
 * following the finger (a drawer, the page), or an arrow at the edge for
 * layers that do not slide sideways (a modal, a sheet, a menu, a step back
 * inside a drawer). Both settle back if the swipe is released short.
 */

const SETTLE_MS = 200;
const SLIDE_MS = 180;
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** The arrow's whole swipe: it arms at SWIPE_COMMIT_FRACTION of this (49px). */
const ARROW_DISTANCE = 140;
const ARROW_SIZE = 40;

/** The element follows the finger; see BackSwipePanel for how a commit leaves. */
export function panelTrack(swipe: BackSwipePanel, back: () => void): SwipeTrack | null {
  const el = swipe.panel();
  if (!el) return null;
  const width = el.getBoundingClientRect().width || window.innerWidth;
  const before = { transform: el.style.transform, transition: el.style.transition };
  const restore = () => {
    el.style.transform = before.transform;
    el.style.transition = before.transition;
    delete el.dataset.backSwipe;
  };
  el.style.transition = 'none';
  // Its leading edge casts a shadow over what it uncovers (backSwipe.css).
  el.dataset.backSwipe = '';
  return {
    distance: width,
    move: (travel) => { el.style.transform = `translateX(${Math.min(travel, width)}px)`; },
    commit: () => {
      if (swipe.exit === 'owner' || prefersReducedMotion()) {
        // The owner closes in this task's render; with the inline transform
        // gone, its own transition carries the panel on from the finger.
        back();
        restore();
        return;
      }
      el.style.transition = `transform ${SLIDE_MS}ms ${EASE}`;
      el.style.transform = `translateX(${width}px)`;
      window.setTimeout(() => {
        back();
        el.style.transition = 'none';
        el.style.transform = before.transform;
        delete el.dataset.backSwipe;
        // What comes next appears in place.
        el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 140, easing: 'ease-out' });
        requestAnimationFrame(() => { el.style.transition = before.transition; });
      }, SLIDE_MS);
    },
    cancel: () => {
      if (prefersReducedMotion()) { restore(); return; }
      el.style.transition = `transform ${SETTLE_MS}ms ${EASE}`;
      el.style.transform = before.transform;
      window.setTimeout(restore, SETTLE_MS);
    },
  };
}

/** An arrow comes out of the left edge at the finger's height and arms once the swipe would go back. */
export function arrowTrack(back: () => void, y: number): SwipeTrack {
  const host = document.querySelector('.terminal-shell') ?? document.body;
  const el = document.createElement('div');
  el.className = 'back-swipe-arrow';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3L5 8l5 5"/></svg>';
  el.style.top = `${Math.max(8, Math.min(window.innerHeight - ARROW_SIZE - 8, y - ARROW_SIZE / 2))}px`;
  host.appendChild(el);
  const leave = (state: 'done' | 'cancelled') => {
    el.dataset.state = state;
    window.setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : SETTLE_MS);
  };
  return {
    distance: ARROW_DISTANCE,
    move: (travel) => {
      // Out from behind the edge, then slower: it stops short of the content.
      const x = -ARROW_SIZE + Math.min(travel, 64) + Math.max(0, Math.min(travel - 64, 96)) * 0.25;
      el.style.transform = `translateX(${x}px)`;
      el.style.opacity = String(Math.min(1, travel / 24));
      el.dataset.armed = String(travel >= ARROW_DISTANCE * SWIPE_COMMIT_FRACTION);
    },
    commit: () => {
      back();
      leave('done');
    },
    cancel: () => leave('cancelled'),
  };
}
