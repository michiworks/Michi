import { isCompanionPanelShowing } from '../companion/companionPanel';
import { isPanePresenceDashboardVisible } from '../panePresenceVisibility';

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

/** Its pane is shown, or the panel shows the conversation (V, open on Chat). */
export function isNodeShownInWindow(nodeId: string, openPanes?: readonly string[]): boolean {
  return isCompanionPanelShowing(nodeId) || isPaneShownInWindow(nodeId, openPanes);
}
