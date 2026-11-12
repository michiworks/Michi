/**
 * A long press opens the right-click menu on a touch screen.
 *
 * A touch or pen held still for LONG_PRESS_MS on anything inside a
 * `[data-context-target]` element dispatches a `contextmenu` event where the
 * finger is, so the element's own onContextMenu handler opens its menu: the
 * same path a mouse right-click takes. Android also fires a `contextmenu` of
 * its own on a long press; whichever comes first opens the menu and the other
 * is dropped. iOS fires none, so there the timer is the only path.
 *
 * While the finger is held the target takes the pressed fill and sinks a
 * little (iOS shrinks a context-menu target the same way), so the wait reads
 * as a gesture rather than a lag. A finger that drifts LONG_PRESS_SLOP is a
 * scroll and cancels the press.
 *
 * The click that ends a long press belongs to the same pointer sequence and is
 * dropped wherever it lands: on the row (which would open it), on the menu's
 * scrim, or on a menu item that appeared under the finger.
 */

import { prefersReducedMotion } from '../hooks/useReducedMotion';

export const LONG_PRESS_MS = 400;
/** How far a finger may drift before the press counts as a scroll. */
const LONG_PRESS_SLOP = 10;
/** The pressed fill comes on late enough not to flash under a scroll. */
const PRESSED_MS = 90;
/** Then the target sinks toward PRESS_SCALE for the rest of the hold. */
const SINK_FROM_MS = 110;
const PRESS_SCALE = 0.97;
/** The click ending a long press arrives right after the finger lifts. */
const RELEASE_CLICK_MS = 700;
/** A menu that opens this soon after a press on a target belongs to it. */
const ANCHOR_RECENT_MS = 1500;

const TARGET = '[data-context-target]';
/** Fields keep their own long press (selecting text, the edit callout). */
const OWN_LONG_PRESS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

type HoldPoint = { clientX: number; clientY: number };
type HoldListener = (point: HoldPoint, phase: 'move' | 'up') => void;

interface Press {
  pointerId: number;
  pointerType: string;
  /** What the finger went down on; the contextmenu bubbles up from it. */
  target: Element;
  /** The `[data-context-target]` around it: the element the menu belongs to. */
  anchor: HTMLElement;
  x: number;
  y: number;
  timers: number[];
  sink: Animation | null;
  fired: boolean;
}

let installs = 0;
let press: Press | null = null;
let pointerSeq = 0;
let firedSeq = -1;
let releasedAt = 0;
let holding: number | null = null;
/** A touch is followed by touch events, which keep coming (passively) after
 *  the browser takes the slide as a scroll and cancels the pointer. */
let holdBy: 'touch' | 'pointer' = 'pointer';
let lastAnchor: { el: HTMLElement; at: number } | null = null;
/** The contextmenu events this module dispatched itself. */
const dispatched = new WeakSet<Event>();
const holdListeners = new Set<HoldListener>();

function near(el: HTMLElement, x: number, y: number, pad = 12): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}

/**
 * The element a menu opening at (x, y) belongs to: the target the last press
 * went down on (a long press, or a tap on the row's ⋯), else whatever target
 * is under the point. Null when the menu has nothing to anchor to.
 */
export function contextMenuAnchor(x: number, y: number): HTMLElement | null {
  const recent = lastAnchor && lastAnchor.el.isConnected && performance.now() - lastAnchor.at < ANCHOR_RECENT_MS
    ? lastAnchor.el
    : null;
  if (recent && near(recent, x, y)) return recent;
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  return hit?.closest<HTMLElement>(TARGET) ?? null;
}

/** True while the finger that opened a menu by holding is still down. */
export function isLongPressHolding(): boolean {
  return holding !== null;
}

/** Follow the finger that opened a menu until it lifts (slide to choose). */
export function onLongPressHold(listener: HoldListener): () => void {
  holdListeners.add(listener);
  return () => { holdListeners.delete(listener); };
}

/** A menu that took over the target (hid it behind a lifted copy) ends its press-in at once. */
export function releasePressFeedback(el: Element): void {
  if (press?.anchor !== el) return;
  press.sink?.cancel();
  press.sink = null;
}

function notifyHold(point: HoldPoint, phase: 'move' | 'up'): void {
  holdListeners.forEach((listener) => listener(point, phase));
}

function onHoldTouchMove(event: TouchEvent): void {
  const touch = event.touches[0];
  if (touch) notifyHold(touch, 'move');
}

function onHoldTouchEnd(event: TouchEvent): void {
  const touch = event.changedTouches[0];
  endHold();
  if (event.type === 'touchend' && touch) notifyHold(touch, 'up');
}

/** iOS starts its own text selection on a held finger about 100ms after the
 *  menu opened under it, and sweeps the whole screen into it. */
function onHoldSelectStart(event: Event): void {
  event.preventDefault();
}

function onHoldSelectionChange(): void {
  const selection = document.getSelection();
  if (selection && !selection.isCollapsed) selection.removeAllRanges();
}

function startHold(p: Press, pointerType: string): void {
  holding = p.pointerId;
  holdBy = pointerType === 'touch' && 'ontouchstart' in window ? 'touch' : 'pointer';
  document.addEventListener('selectstart', onHoldSelectStart, true);
  document.addEventListener('selectionchange', onHoldSelectionChange);
  if (holdBy !== 'touch') return;
  // Passive: these never hold up a scroll.
  document.addEventListener('touchmove', onHoldTouchMove, { passive: true });
  document.addEventListener('touchend', onHoldTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onHoldTouchEnd, { passive: true });
}

function endHold(): void {
  holding = null;
  document.removeEventListener('selectstart', onHoldSelectStart, true);
  document.removeEventListener('selectionchange', onHoldSelectionChange);
  document.removeEventListener('touchmove', onHoldTouchMove);
  document.removeEventListener('touchend', onHoldTouchEnd);
  document.removeEventListener('touchcancel', onHoldTouchEnd);
}

function clearPress(p: Press, settle: boolean): void {
  p.timers.forEach((timer) => window.clearTimeout(timer));
  p.timers = [];
  p.anchor.removeAttribute('data-press');
  const sink = p.sink;
  p.sink = null;
  if (!sink) return;
  if (!settle) { sink.cancel(); return; }
  sink.onfinish = () => sink.cancel();
  sink.reverse();
}

function cancelPress(): void {
  if (!press) return;
  clearPress(press, true);
  press = null;
}

function fire(p: Press): void {
  if (press !== p) return;
  p.fired = true;
  firedSeq = pointerSeq;
  startHold(p, p.pointerType);
  p.timers.forEach((timer) => window.clearTimeout(timer));
  p.timers = [];
  p.anchor.removeAttribute('data-press');
  try { navigator.vibrate?.(10); } catch { /* not allowed here */ }
  const from = p.target.isConnected ? p.target : p.anchor;
  const menuEvent = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 2,
    clientX: p.x,
    clientY: p.y,
  });
  dispatched.add(menuEvent);
  from.dispatchEvent(menuEvent);
  // A menu that lifts the target releases the press-in as it measures; any
  // other menu leaves the target to spring back by itself.
  window.setTimeout(() => {
    const sink = p.sink;
    p.sink = null;
    if (sink) { sink.onfinish = () => sink.cancel(); sink.reverse(); }
  }, 0);
}

function onPointerDown(event: PointerEvent): void {
  if (!event.isPrimary) return;
  pointerSeq += 1;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest<HTMLElement>(TARGET) ?? null;
  if (anchor) lastAnchor = { el: anchor, at: performance.now() };
  // The mouse asks with its right button instead.
  if (!target || !anchor || event.pointerType === 'mouse' || event.button !== 0) return;
  if (target.closest(OWN_LONG_PRESS)) return;
  cancelPress();
  const p: Press = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    target,
    anchor,
    x: event.clientX,
    y: event.clientY,
    timers: [],
    sink: null,
    fired: false,
  };
  p.timers.push(
    window.setTimeout(() => anchor.setAttribute('data-press', ''), PRESSED_MS),
    window.setTimeout(() => {
      if (prefersReducedMotion() || typeof anchor.animate !== 'function') return;
      p.sink = anchor.animate([{ scale: '1' }, { scale: String(PRESS_SCALE) }], {
        duration: LONG_PRESS_MS - SINK_FROM_MS,
        easing: 'cubic-bezier(.3, .1, .3, 1)',
        fill: 'forwards',
      });
    }, SINK_FROM_MS),
    window.setTimeout(() => fire(p), LONG_PRESS_MS),
  );
  press = p;
}

function onPointerMove(event: PointerEvent): void {
  const p = press;
  if (p && !p.fired && event.pointerId === p.pointerId
    && Math.hypot(event.clientX - p.x, event.clientY - p.y) > LONG_PRESS_SLOP) {
    cancelPress();
  }
  if (holding === event.pointerId && holdBy === 'pointer') notifyHold(event, 'move');
}

function onPointerEnd(event: PointerEvent): void {
  const p = press;
  if (p && event.pointerId === p.pointerId) {
    if (p.fired) {
      press = null;
      releasedAt = performance.now();
    } else cancelPress();
  }
  if (holding === event.pointerId && holdBy === 'pointer') {
    endHold();
    if (event.type === 'pointerup') notifyHold(event, 'up');
  }
}

function onContextMenu(event: MouseEvent): void {
  // Our own dispatch, or a right-click (no touch press): nothing to fold together.
  if (dispatched.has(event)) return;
  const p = press;
  if (!p) return;
  if (p.fired) {
    // The timer opened the menu already; this is the browser's own long press.
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  // The browser's long press came first (Android): it opens the menu, and the
  // press is spent the same way the timer would have spent it.
  p.fired = true;
  firedSeq = pointerSeq;
  startHold(p, p.pointerType);
  p.timers.forEach((timer) => window.clearTimeout(timer));
  p.timers = [];
  p.anchor.removeAttribute('data-press');
}

function onClick(event: MouseEvent): void {
  if (firedSeq !== pointerSeq) return;
  // Only the click the lifting finger produces; a later keyboard click is the user's.
  if (press?.fired || performance.now() - releasedAt > RELEASE_CLICK_MS) return;
  firedSeq = -1;
  event.preventDefault();
  event.stopPropagation();
}

/** Install the long press once for the app; returns the uninstaller. */
export function installTouchContextMenu(): () => void {
  installs += 1;
  if (installs === 1) {
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerEnd, true);
    window.addEventListener('pointercancel', onPointerEnd, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('click', onClick, true);
    // No touchmove listener up front: a non-passive one would make every
    // scroll wait for the main thread. A held finger is followed passively.
  }
  return () => {
    installs -= 1;
    if (installs > 0) return;
    cancelPress();
    endHold();
    firedSeq = -1;
    lastAnchor = null;
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerEnd, true);
    window.removeEventListener('pointercancel', onPointerEnd, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('click', onClick, true);
  };
}
