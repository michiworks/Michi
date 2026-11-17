import { useSyncExternalStore } from 'react';

let dashboardVisible = false;
let dashboardUncovered = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const notify = () => { for (const listener of listeners) listener(); };
const getSnapshot = () => dashboardVisible;
const getUncovered = () => dashboardUncovered;

export function setPanePresenceDashboardVisible(visible: boolean): void {
  if (dashboardVisible === visible) return;
  dashboardVisible = visible;
  notify();
}

export function usePanePresenceDashboardVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The same flag read outside React: this window shows the Dashboard page. */
export const isPanePresenceDashboardVisible = getSnapshot;

/**
 * The Dashboard page is up and no layer TerminalShell owns lies over it: no
 * shell dialog (Settings, palette, artifacts, background work, new workspace,
 * remote sign-in or recovery) and, in the phone layout, neither the Michi
 * panel nor the drawer. Modals opened elsewhere are not tracked here;
 * isPaneSeenInWindow asks for those separately.
 */
export function setDashboardUncovered(uncovered: boolean): void {
  if (dashboardUncovered === uncovered) return;
  dashboardUncovered = uncovered;
  notify();
}

export function useDashboardUncovered(): boolean {
  return useSyncExternalStore(subscribe, getUncovered, getUncovered);
}

/** The same flag read outside React. */
export const isDashboardUncovered = getUncovered;
