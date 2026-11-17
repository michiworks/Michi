import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

/** Messages a pane mounts first: about a screenful and the turns above it. */
export const PROGRESSIVE_INITIAL = 16;
/** Messages each later batch mounts above them. */
export const PROGRESSIVE_BATCH = 16;
/** A history this much longer than the first batch mounts at once. */
const PROGRESSIVE_SLACK = 8;
/** Messages kept mounted above a message the pane goes to, so it has room above it. */
const ABOVE_TARGET = 3;
/**
 * How long a batch's anchor is held at most. The frames it mounts settle from
 * content-visibility estimates over a few paints; the hold ends sooner once
 * the anchor stops moving, or when the reader scrolls.
 */
const HOLD_MAX_MS = 1000;
const HOLD_STABLE_FRAMES = 3;

type MountWindow =
  | { nodeId: string; all: true }
  /** From `id` (its index as last seen, for when it goes). */
  | { nodeId: string; all: false; id: string; index: number };

interface MountMessage { id: string; role: string }

/** Back to the user message that starts the turn at `index`, so a window opens on a question. */
function turnStart(messages: readonly MountMessage[], index: number): number {
  let i = index;
  while (i > 0 && messages[i].role !== 'user') i--;
  return i;
}

function windowFrom(nodeId: string, messages: readonly MountMessage[], start: number): MountWindow {
  const from = turnStart(messages, Math.max(0, start));
  return from <= 0 ? { nodeId, all: true } : { nodeId, all: false, id: messages[from].id, index: from };
}

function firstWindow(nodeId: string, messages: readonly MountMessage[], targetId: string | undefined): MountWindow {
  const length = messages.length;
  if (length <= PROGRESSIVE_INITIAL + PROGRESSIVE_SLACK) return { nodeId, all: true };
  let start = length - PROGRESSIVE_INITIAL;
  const target = targetId ? messages.findIndex((message) => message.id === targetId) : -1;
  if (target >= 0) start = Math.min(start, target - ABOVE_TARGET);
  return windowFrom(nodeId, messages, start);
}

function windowStart(win: MountWindow, messages: readonly MountMessage[]): number {
  if (win.all) return 0;
  const at = messages.findIndex((message) => message.id === win.id);
  return at >= 0 ? at : Math.min(win.index, messages.length);
}

export interface ProgressiveMount {
  /** Index of the first message mounted; 0 when all are. */
  from: number;
  /** Mount through this message and a few above it; a message not loaded yet is mounted when it arrives. */
  ensure(messageId: string): void;
  mountAll(): void;
  /** The next batch now, ahead of the idle ones (the reader scrolled up to the edge). */
  mountMore(): void;
  /** Lets go of the view a batch is holding: the pane is moving it (a jump). */
  release(): void;
}

const idle = (run: () => void): (() => void) => {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 250 });
    return () => cancelIdleCallback(handle);
  }
  const handle = setTimeout(run, 32);
  return () => clearTimeout(handle);
};

/**
 * A long transcript mounts its newest messages first and the rest in batches
 * above them while the page is idle, never unmounting any: find, the
 * scrubber and selections keep every message in the DOM once mounted. Each
 * batch keeps the reader's view where it was (scroll anchored on the first
 * message mounted before it). The first window reaches the message the pane
 * will be restored to (`initialTarget`, read once when messages first come).
 * `paused` holds batches while another pass owns the scroll position.
 */
export function useProgressiveMount({ nodeId, messages, scrollRef, initialTarget, paused, following, adjustScroll }: {
  nodeId: string;
  messages: readonly MountMessage[];
  scrollRef: RefObject<HTMLElement | null>;
  initialTarget: () => string | undefined;
  paused: () => boolean;
  /** The pane is following its tail: after the batch's own correction, its follow pins keep the view. */
  following: () => boolean;
  /** Moves the viewport by `delta` px as the pane's own scroll (not the reader's). */
  adjustScroll: (delta: number) => void;
}): ProgressiveMount {
  const [state, setState] = useState<MountWindow | null>(null);
  let win = state && state.nodeId === nodeId ? state : null;
  if (!win && messages.length > 0) {
    win = firstWindow(nodeId, messages, initialTarget());
    setState(win);
  }
  const from = win ? windowStart(win, messages) : 0;

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const latest = useRef({ paused, following, adjustScroll, nodeId });
  latest.current = { paused, following, adjustScroll, nodeId };
  // The first mounted message's place in the viewport before a batch went above it.
  const anchorRef = useRef<{ id: string; top: number } | null>(null);
  const holdingRef = useRef(false);
  const finishHoldRef = useRef<(() => void) | null>(null);
  const pendingTargetRef = useRef<string | null>(null);

  const frameOf = useCallback((id: string) => scrollRef.current
    ?.querySelector<HTMLElement>(`[data-msg-id="${id.replace(/["\\]/g, '\\$&')}"]`) ?? null, [scrollRef]);
  const viewTop = useCallback((id: string): number | null => {
    const el = scrollRef.current;
    const frame = frameOf(id);
    if (!el || !frame) return null;
    return frame.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, [scrollRef, frameOf]);

  const grow = useCallback((next: (win: MountWindow, messages: readonly MountMessage[]) => MountWindow, urgent: boolean) => {
    const apply = () => setState((current) => {
      if (!current || current.nodeId !== latest.current.nodeId || current.all) return current;
      const list = messagesRef.current;
      const nextWin = next(current, list);
      if (windowStart(nextWin, list) >= windowStart(current, list)) return current;
      const top = viewTop(current.id);
      anchorRef.current = top === null ? null : { id: current.id, top };
      return nextWin;
    });
    if (urgent) apply();
    else startTransition(apply);
  }, [viewTop]);

  const mountMore = useCallback(() => {
    grow((current, list) => windowFrom(current.nodeId, list, windowStart(current, list) - PROGRESSIVE_BATCH), true);
  }, [grow]);
  const mountAll = useCallback(() => grow((current) => ({ nodeId: current.nodeId, all: true }), true), [grow]);
  const ensure = useCallback((messageId: string) => {
    const at = messagesRef.current.findIndex((message) => message.id === messageId);
    if (at < 0) { pendingTargetRef.current = messageId; return; }
    pendingTargetRef.current = null;
    grow((current, list) => windowFrom(current.nodeId, list, at - ABOVE_TARGET), true);
  }, [grow]);

  // A target that was still loading: mount through it once it is here.
  useEffect(() => {
    const pending = pendingTargetRef.current;
    if (pending && messages.some((message) => message.id === pending)) ensure(pending);
  }, [messages, ensure]);

  // Keep the reader's view through the batch that just went above it: the
  // anchor goes back where it was, and is held there while the new frames
  // settle (HOLD_MAX_MS).
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const el = scrollRef.current;
    if (!anchor || !el) return;
    let frame = 0;
    let stable = 0;
    let done = false;
    const started = performance.now();
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const finish = () => {
      if (done) return;
      done = true;
      holdingRef.current = false;
      if (finishHoldRef.current === finish) finishHoldRef.current = null;
      cancelAnimationFrame(frame);
      for (const event of events) el.removeEventListener(event, finish);
    };
    const hold = () => {
      if (done) return;
      const top = viewTop(anchor.id);
      if (top === null) { finish(); return; }
      if (Math.abs(top - anchor.top) > 0.5) {
        latest.current.adjustScroll(top - anchor.top);
        stable = 0;
      } else {
        stable += 1;
      }
      // Following the tail, the follow pins move the view on from here.
      if (latest.current.following() || stable >= HOLD_STABLE_FRAMES || performance.now() - started >= HOLD_MAX_MS) finish();
      else frame = requestAnimationFrame(hold);
    };
    holdingRef.current = true;
    finishHoldRef.current = finish;
    for (const event of events) el.addEventListener(event, finish, { passive: true });
    hold();
    return finish;
  }, [from, scrollRef, viewTop]);

  // The rest, a batch at a time while the page is idle.
  const done = !win || win.all || from === 0;
  useEffect(() => {
    if (done) return;
    let cancel = () => {};
    let retry: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      if (latest.current.paused() || holdingRef.current) { retry = setTimeout(() => { cancel = idle(step); }, 100); return; }
      grow((current, list) => windowFrom(current.nodeId, list, windowStart(current, list) - PROGRESSIVE_BATCH), false);
    };
    cancel = idle(step);
    return () => { cancel(); clearTimeout(retry); };
  }, [done, from, grow]);

  const release = useCallback(() => finishHoldRef.current?.(), []);
  return useMemo(() => ({ from, ensure, mountAll, mountMore, release }), [from, ensure, mountAll, mountMore, release]);
}
