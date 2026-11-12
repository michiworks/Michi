import { animate } from 'motion/react';

/**
 * The transcript's move when a message is sent: the thread rises by what the
 * send added (the user's message and the reply's placeholder) on one
 * decelerating curve, the way a messaging app's thread makes room. The new
 * bubble rides up with it from behind the composer; it only fades in
 * (MessageBlock's USER_ENTRANCE), so nothing travels further than the room it
 * needs. A phone send that lowers the keyboard glides on the keyboard's own
 * curve instead (KEYBOARD_MOVE): Safari carries the page down as the keyboard
 * leaves, and a thread rising on a curve of its own read as a message flying
 * up and then falling.
 */
export const SEND_GLIDE = { duration: 0.48, ease: [0.25, 1, 0.5, 1] as [number, number, number, number] };

/** A send from far up the history starts this close to the end instead of travelling all of it. */
const FAR_START_PX = 240;

export interface SendGlideOptions {
  /** Where the glide ends, read every frame: content that lands mid-glide (a first token, a composer that resizes) moves the end with it. */
  target: () => number;
  /** After every scrollTop write, so the caller can mark it programmatic. */
  onFrame?: () => void;
  /** The glide reached its end. */
  onDone?: () => void;
  /** The reader took the scroll (wheel or touch) mid-glide; the scroll stays where they put it. */
  onInterrupt?: () => void;
  /** Reduced motion: land at once. */
  reduce?: boolean;
  /** Seconds and curve; SEND_GLIDE unless given. */
  timing?: { duration: number; ease: [number, number, number, number] };
}

/**
 * Glide `el` to `target()`. Returns a cancel that stops it where it is,
 * without calling onDone or onInterrupt.
 */
export function glideToTail(el: HTMLElement, opts: SendGlideOptions): () => void {
  const end = opts.target();
  if (opts.reduce || end <= el.scrollTop) {
    if (end > el.scrollTop) el.scrollTop = end;
    opts.onFrame?.();
    opts.onDone?.();
    return () => {};
  }
  let from = el.scrollTop;
  if (end - from > Math.min(el.clientHeight, FAR_START_PX * 2)) {
    from = end - Math.min(el.clientHeight / 3, FAR_START_PX);
    el.scrollTop = from;
    opts.onFrame?.();
  }
  let settled = false;
  // Assigned once the animation starts; stop() can run before (an early wheel).
  const anim: { controls?: { stop: () => void } } = {};
  const offs: Array<() => void> = [];
  const stop = (): boolean => {
    if (settled) return false;
    settled = true;
    anim.controls?.stop();
    for (const off of offs) off();
    return true;
  };
  const interrupt = () => {
    if (stop()) opts.onInterrupt?.();
  };
  for (const type of ['wheel', 'touchmove'] as const) {
    el.addEventListener(type, interrupt, { passive: true });
    offs.push(() => el.removeEventListener(type, interrupt));
  }
  anim.controls = animate(0, 1, {
    duration: (opts.timing ?? SEND_GLIDE).duration,
    ease: (opts.timing ?? SEND_GLIDE).ease,
    onUpdate: (p) => {
      if (settled) return;
      el.scrollTop = from + (opts.target() - from) * p;
      opts.onFrame?.();
    },
    onComplete: () => {
      if (settled) return;
      el.scrollTop = opts.target();
      opts.onFrame?.();
      if (stop()) opts.onDone?.();
    },
  });
  return () => {
    stop();
  };
}
