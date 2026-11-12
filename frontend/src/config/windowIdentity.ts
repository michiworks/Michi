/**
 * Window identity.
 *
 * WINDOW_ID names one window (a browser tab, an Electron window) across its
 * reloads. Composer drafts saved per window (composer_draft_window_id), the
 * active workspace per window, pane presence leases and their focus slot, and
 * attention claims ("this window showed it before a reload") all key on it.
 * Electron injects one per BrowserWindow. A browser tab keeps its id in
 * sessionStorage, which a duplicated tab copies; so each live page claims its
 * id in localStorage (refreshed while it runs, released when it unloads), and
 * a page that finds its id claimed by another live page mints its own. A
 * reload keeps the id (the old page releases its claim as it unloads, and a
 * reload trusts a claim it finds); so does a tab the browser discarded.
 *
 * ORIGIN_WINDOW_ID names one page load: the X-Michi-Window-Id its writes
 * carry so that it can skip its own structure changes. No two pages share it,
 * and a reloaded page has not seen what its previous load wrote.
 */
import { randomUuid } from 'michi-shared';

const SESSION_KEY = 'michi:windowId';
const CLAIM_PREFIX = 'michi:windowClaim:';
/** A live page refreshes its claim this often. */
const CLAIM_REFRESH_MS = 30_000;
/**
 * An older claim belonged to a page that died without unloading (a crash).
 * Browsers may throttle a background tab's timers to one run a minute.
 */
const CLAIM_STALE_MS = 3 * 60_000;
/** Claims this old are swept when a page starts. */
const CLAIM_SWEEP_MS = 24 * 60 * 60_000;

export interface WindowIdentity {
  windowId: string;
  originWindowId: string | null;
}

interface Claim {
  page: string;
  at: number;
}

function randomId(): string {
  try {
    return randomUuid();
  } catch {
    // The page must start even where Web Crypto throws.
    return `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function readClaim(storage: Storage, key: string): Claim | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const claim = JSON.parse(raw) as Partial<Claim>;
    return typeof claim.page === 'string' && typeof claim.at === 'number' ? { page: claim.page, at: claim.at } : null;
  } catch {
    return null;
  }
}

function sweepClaims(storage: Storage, now: number): void {
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(CLAIM_PREFIX)) continue;
    const claim = readClaim(storage, key);
    if (!claim || now - claim.at > CLAIM_SWEEP_MS) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

/** Hold `windowId` for this page while it lives. */
function keepClaim(win: Window, storage: Storage, windowId: string, page: string): void {
  const key = CLAIM_PREFIX + windowId;
  const write = () => {
    try {
      storage.setItem(key, JSON.stringify({ page, at: Date.now() } satisfies Claim));
    } catch {
      // Quota or private mode: duplicates go undetected, nothing else changes.
    }
  };
  write();
  win.setInterval(write, CLAIM_REFRESH_MS);
  win.document?.addEventListener('visibilitychange', () => { if (win.document.visibilityState === 'visible') write(); });
  // Unloading (a reload, a close, a navigation): the next page may take the id.
  win.addEventListener('pagehide', () => {
    try {
      if (readClaim(storage, key)?.page === page) storage.removeItem(key);
    } catch {
      // Best effort: the claim goes stale instead.
    }
  });
  // Restored from the back/forward cache: the tab's page again.
  win.addEventListener('pageshow', (event) => { if ((event as PageTransitionEvent).persisted) write(); });
}

/** How this page load came about ('reload', 'navigate', 'back_forward' for a restored or duplicated tab). */
function navigationType(win: Window): string | undefined {
  try {
    return (win.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
  } catch {
    return undefined;
  }
}

/** This page's identity (see the module comment). Exported for tests. */
export function resolveWindowIdentity(win: Window): WindowIdentity {
  const originWindowId = randomId();
  const injected = (win as unknown as { electron?: { michiWindowId?: string } }).electron?.michiWindowId;
  // Electron names each BrowserWindow itself; it has no duplicated tabs.
  if (typeof injected === 'string' && injected.length > 0) return { windowId: injected, originWindowId };
  let session: Storage;
  let windowId: string | null;
  try {
    session = win.sessionStorage;
    windowId = session.getItem(SESSION_KEY);
  } catch {
    // No session storage at all: one shared id, as before claims existed.
    return { windowId: 'default', originWindowId };
  }
  let local: Storage | null = null;
  try {
    local = win.localStorage;
  } catch {
    local = null;
  }
  const now = Date.now();
  if (windowId && local) {
    const claim = readClaim(local, CLAIM_PREFIX + windowId);
    // The claim of a reloaded page may outlive it a moment, and a tab the
    // browser discarded never released its own: both are this tab's.
    const ownClaim = navigationType(win) === 'reload'
      || (win.document as Document & { wasDiscarded?: boolean } | undefined)?.wasDiscarded === true;
    // Another live page holds it (this page load is new): this tab is a duplicate.
    if (claim && now - claim.at < CLAIM_STALE_MS && !ownClaim) windowId = null;
  }
  if (!windowId) {
    windowId = randomId();
    try {
      session.setItem(SESSION_KEY, windowId);
    } catch {
      // Unsaved: this load keeps it, a reload mints another.
    }
  }
  if (local) {
    try {
      sweepClaims(local, now);
    } catch {
      // Best effort.
    }
    keepClaim(win, local, windowId, originWindowId);
  }
  return { windowId, originWindowId };
}

const identity: WindowIdentity = typeof window !== 'undefined'
  ? resolveWindowIdentity(window)
  : { windowId: 'default', originWindowId: null };

export const WINDOW_ID = identity.windowId;

/**
 * The id this page load names its writes with (X-Michi-Window-Id), so it can
 * skip its own structure changes. Null outside a browser.
 */
export const ORIGIN_WINDOW_ID: string | null = identity.originWindowId;
