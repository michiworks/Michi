import { modalOpen } from '../../lib/backStack';
import { isCompanionPanelShowing } from '../companion/companionPanel';
import { isDashboardUncovered, isPanePresenceDashboardVisible } from '../panePresenceVisibility';

/** Share of a pane's width that must be inside the strip, as Dashboard's paneOnScreen. */
const ON_SCREEN_SHARE = 0.6;

/**
 * How the Dashboard strip paints a pane: 'hidden' when it hides the pane
 * (phone layout, exiting) or keeps it scrolled out of view; 'unmeasured' when
 * it is painted without a layout to measure (jsdom, first frame).
 */
function panePaint(paneId: string): 'shown' | 'hidden' | 'unmeasured' | 'unpainted' {
  if (typeof document === 'undefined') return 'unpainted';
  const strip = document.querySelector<HTMLElement>('[data-pane-strip]');
  if (!strip) return 'unpainted';
  const pane = Array.from(strip.children).find((child): child is HTMLElement =>
    child instanceof HTMLElement && child.dataset.nodeId === paneId);
  if (!pane) return 'unpainted';
  if (pane.hasAttribute('data-pane-exiting') || pane.getAttribute('aria-hidden') === 'true'
    || pane.style.visibility === 'hidden') return 'hidden';
  const paneBox = pane.getBoundingClientRect();
  const stripBox = strip.getBoundingClientRect();
  if (paneBox.width <= 0 || stripBox.width <= 0) return 'unmeasured';
  const inside = Math.min(paneBox.right, stripBox.right) - Math.max(paneBox.left, stripBox.left);
  return inside >= Math.min(paneBox.width, stripBox.width) * ON_SCREEN_SHARE ? 'shown' : 'hidden';
}

/**
 * This window shows the pane: the Dashboard page is up, the strip does not
 * hide it or keep it scrolled away, and it is open in the active tree's
 * layout — `openPanes` from usePaneState (single-page mode already reduces it
 * to its page) or, without that list, painted in the strip.
 */
export function isPaneShownInWindow(paneId: string, openPanes?: readonly string[]): boolean {
  if (!isPanePresenceDashboardVisible()) return false;
  const paint = panePaint(paneId);
  if (paint === 'hidden') return false;
  return openPanes ? openPanes.includes(paneId) : paint !== 'unpainted';
}

/**
 * The panes of `openPanes` (the active tree's layout, as for isPaneShownInWindow) this window
 * shows right now: what presence reports as `visible` (usePanePresenceIntegration.ts), so the
 * server's "on screen" is the same as this window's.
 */
export function panesShownInWindow(openPanes: readonly string[]): string[] {
  return openPanes.filter((paneId) => isPaneShownInWindow(paneId, openPanes));
}

/**
 * Stricter than isPaneShownInWindow, for a mark that is saved (a failure
 * viewed, useFailureSeen): nothing lies over the Dashboard, neither a layer
 * the shell owns (isDashboardUncovered) nor any other modal (a confirm, the
 * first-run or key gate, a lightbox, a bottom sheet: backStack's modalOpen),
 * the pane is open in `openPanes`, and the strip has laid it out with at
 * least 60% inside. A pane not painted or measured yet does not count.
 */
export function isPaneSeenInWindow(paneId: string, openPanes: readonly string[]): boolean {
  return isDashboardUncovered() && !modalOpen() && openPanes.includes(paneId) && panePaint(paneId) === 'shown';
}

/** The pane strip settles (a scroll, a resize) for this long before what it shows is measured. */
export const PANE_STRIP_SETTLE_MS = 300;
/** A second look after the layout changes, once the strip's open/close motion is over. */
const PANE_STRIP_RECHECK_MS = 1_000;

/**
 * Calls `look` once the pane strip has had time to settle: PANE_STRIP_SETTLE_MS
 * and PANE_STRIP_RECHECK_MS from now, and PANE_STRIP_SETTLE_MS after it last
 * moved (a strip scroll, `michi:dashboard-scroll`; a window resize; a size
 * change of the strip or its panes, such as a dragged pane width). Returns
 * the cleanup. Presence (usePanePresenceIntegration) and useFailureSeen measure
 * what the strip shows on these beats.
 */
export function watchPaneStrip(look: () => void): () => void {
  const timers = [setTimeout(look, PANE_STRIP_SETTLE_MS), setTimeout(look, PANE_STRIP_RECHECK_MS)];
  let settling: ReturnType<typeof setTimeout> | null = null;
  const moved = () => {
    if (settling) clearTimeout(settling);
    settling = setTimeout(() => { settling = null; look(); }, PANE_STRIP_SETTLE_MS);
  };
  window.addEventListener('michi:dashboard-scroll', moved);
  window.addEventListener('resize', moved);
  const strip = document.querySelector<HTMLElement>('[data-pane-strip]');
  const resizes = strip && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(moved) : null;
  if (strip && resizes) {
    resizes.observe(strip);
    for (const pane of Array.from(strip.children)) resizes.observe(pane);
  }
  return () => {
    for (const timer of timers) clearTimeout(timer);
    if (settling) clearTimeout(settling);
    window.removeEventListener('michi:dashboard-scroll', moved);
    window.removeEventListener('resize', moved);
    resizes?.disconnect();
  };
}

/** Its pane is shown, or the panel shows the conversation (V, open on Chat). */
export function isNodeShownInWindow(nodeId: string, openPanes?: readonly string[]): boolean {
  return isCompanionPanelShowing(nodeId) || isPaneShownInWindow(nodeId, openPanes);
}
