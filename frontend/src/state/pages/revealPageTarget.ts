import { serverEntityId } from '../../config/backendIdentity';
import { smoothScrollBehavior } from '../../hooks/useReducedMotion';

/** A block, or a row of a database, to show once its page has rendered it. */
export interface PageRevealTarget {
  /** A block id; a row id when `databaseId` is set. */
  targetId: string;
  /** The row's database. A target that names the database itself shows the whole database. */
  databaseId?: string;
  /** Only inside the page pane showing this page (beside a chat); otherwise the page on screen. */
  pane?: { pageId: string; workspaceId: string; backendConnectionId: string };
}

export interface PageRevealOptions {
  /**
   * 'glide' (default) for a pick inside the page on screen (its outline);
   * 'instant' for a jump from another surface, which lands at once (TR-27).
   */
  land?: 'instant' | 'glide';
  timeoutMs?: number;
}

const REVEAL_WAIT_MS = 8_000;
const POLL_MS = 100;
/** Outlasts the CSS animation of data-reveal-flash (michiPage.css); the Contents block's flash (use-peek.ts) lasts as long. */
export const REVEAL_FLASH_MS = 1_600;

/** The timer that ends each lit element's flash, one per element whoever lit it, so a new flash restarts it. */
const flashEnds = new WeakMap<Element, { timer?: number }>();
/**
 * Lights `el` with data-reveal-flash for REVEAL_FLASH_MS, restarting the flash
 * when it is already lit, whether a reveal or a Contents pick lit it, so an
 * older timer never cuts a newer flash short. Returns what puts this flash out
 * early; it does nothing once a newer flash owns the element.
 */
export function flashRevealed(el: Element): () => void {
  window.clearTimeout(flashEnds.get(el)?.timer);
  el.removeAttribute('data-reveal-flash');
  void (el as HTMLElement).offsetWidth;
  el.setAttribute('data-reveal-flash', '');
  const own: { timer?: number } = {};
  const end = () => {
    if (flashEnds.get(el) !== own) return;
    window.clearTimeout(own.timer);
    flashEnds.delete(el);
    el.removeAttribute('data-reveal-flash');
  };
  own.timer = window.setTimeout(end, REVEAL_FLASH_MS);
  flashEnds.set(el, own);
  return end;
}
/** A jump holds its target until its top keeps still this many frames (TPane jumpToMessage)… */
const STABLE_FRAMES = 3;
/** …or this many frames pass. */
const HOLD_FRAMES = 60;
/** What the user does to take the scroll back from a hold. */
const LET_GO = ['wheel', 'touchstart', 'keydown'] as const;

let cancelPending: (() => void) | null = null;

function owners(pane: PageRevealTarget['pane']): ParentNode[] {
  if (!pane) return [document];
  return Array.from(document.querySelectorAll<HTMLElement>('[data-native-page-pane]'))
    .filter((element) => element.dataset.pageId === pane.pageId
      && element.dataset.workspaceId === pane.workspaceId
      && element.dataset.backendConnectionId === pane.backendConnectionId);
}

function find(target: PageRevealTarget): { element: HTMLElement; block: boolean } | null {
  const { targetId, databaseId, pane } = target;
  for (const owner of owners(pane)) {
    if (!databaseId) {
      // The chat window can show the same block; the reveal is for the page.
      const block = Array.from(owner.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find((element) => element.dataset.blockId === targetId && !element.closest('.meta-chat-panel'));
      if (block) return { element: block.closest<HTMLElement>('.michi-doc-block') ?? block, block: true };
      continue;
    }
    const row = Array.from(owner.querySelectorAll<HTMLElement>('[data-row-id]'))
      .find((element) => element.dataset.rowId === targetId
        && element.closest<HTMLElement>('[data-native-database]')?.dataset.databaseId === databaseId);
    if (row) return { element: row, block: false };
    const wholeDatabase = pane && targetId === serverEntityId(databaseId, pane.backendConnectionId);
    const database = wholeDatabase
      ? Array.from(owner.querySelectorAll<HTMLElement>('[data-native-database]')).find((element) => element.dataset.databaseId === databaseId)
      : undefined;
    if (database) return { element: database, block: false };
  }
  return null;
}

/**
 * Centres `element` at once and holds it there each frame while the page
 * around it settles, until its top keeps still or HOLD_FRAMES pass; a wheel,
 * touch or key lets go at once. Calls `onEnd` once, however it ends.
 */
function holdCentred(element: HTMLElement, onEnd: () => void): () => void {
  let frame = 0;
  let frames = 0;
  let stable = 0;
  let last = Number.NaN;
  let holding = true;
  const stop = () => {
    if (!holding) return;
    holding = false;
    cancelAnimationFrame(frame);
    for (const type of LET_GO) window.removeEventListener(type, stop, true);
    onEnd();
  };
  const hold = () => {
    element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    const top = element.getBoundingClientRect().top;
    stable = Math.abs(top - last) < 1 ? stable + 1 : 0;
    last = top;
    if (stable < STABLE_FRAMES && ++frames < HOLD_FRAMES) frame = requestAnimationFrame(hold);
    else stop();
  };
  for (const type of LET_GO) window.addEventListener(type, stop, { capture: true, passive: true });
  hold();
  return stop;
}

/**
 * Scrolls to a block or row once its page has rendered it, and flashes a block
 * once. Opening a page replaces what was on screen, so it waits for the page
 * to load, up to `timeoutMs`; a newer reveal replaces one still waiting or
 * holding. Returns a function that stops the wait and the hold.
 */
export function revealPageTarget(target: PageRevealTarget, { land = 'glide', timeoutMs = REVEAL_WAIT_MS }: PageRevealOptions = {}): () => void {
  cancelPending?.();
  const deadline = Date.now() + timeoutMs;
  let timer: number | undefined;
  let stopHold: (() => void) | undefined;
  const cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    stopHold?.();
    if (cancelPending === cancel) cancelPending = null;
  };
  const attempt = () => {
    timer = undefined;
    const found = find(target);
    if (!found) {
      if (Date.now() < deadline) timer = window.setTimeout(attempt, POLL_MS);
      else cancel();
      return;
    }
    if (land === 'instant') stopHold = holdCentred(found.element, cancel);
    else {
      cancel();
      found.element.scrollIntoView?.({ behavior: smoothScrollBehavior(), block: 'center', inline: 'nearest' });
    }
    if (!found.block) return;
    flashRevealed(found.element);
  };
  cancelPending = cancel;
  attempt();
  return cancel;
}
