import { useSyncExternalStore } from 'react';

let dashboardVisible = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => dashboardVisible;

export function setPanePresenceDashboardVisible(visible: boolean): void {
  if (dashboardVisible === visible) return;
  dashboardVisible = visible;
  for (const listener of listeners) listener();
}

export function usePanePresenceDashboardVisible(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The same flag read outside React: this window shows the Dashboard page. */
export const isPanePresenceDashboardVisible = getSnapshot;
