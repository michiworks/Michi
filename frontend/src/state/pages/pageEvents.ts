export interface PageEventIdentity {
  backendConnectionId: string;
  workspaceId?: string;
  pageId?: string;
  databaseId?: string;
  componentId?: string;
  /** A committed page receipt's minimum observable version, not a database revision. */
  viewVersion?: number;
}

type PageListener = (identity: PageEventIdentity) => void;
const listeners = new Set<PageListener>();

export function notifyPageChanged(identity: PageEventIdentity): void {
  for (const listener of listeners) listener(identity);
}

/**
 * Inbound only: a `michi:page-changed` window event dispatched from outside
 * the app's modules (E2E tests drive conflicts with one) reaches the
 * subscribers. Subscribe with subscribePageChanges, never to the window event.
 */
const WINDOW_EVENT = 'michi:page-changed';
function onWindowEvent(event: Event): void {
  const detail = (event as CustomEvent<unknown>).detail as Partial<PageEventIdentity> | null;
  if (detail && typeof detail === 'object' && typeof detail.backendConnectionId === 'string') notifyPageChanged(detail as PageEventIdentity);
}

export function subscribePageChanges(identity: PageEventIdentity, listener: PageListener): () => void {
  const scoped: PageListener = (changed) => {
    if (changed.backendConnectionId !== identity.backendConnectionId || (identity.workspaceId && changed.workspaceId !== identity.workspaceId)) return;
    if (identity.pageId && changed.pageId && changed.pageId !== identity.pageId && !changed.databaseId) return;
    if (identity.databaseId && changed.databaseId && changed.databaseId !== identity.databaseId) return;
    if (identity.componentId && changed.componentId && changed.componentId !== identity.componentId) return;
    // A database mutation can alter the rendered contents of any page that
    // references it. Page subscribers therefore accept database-only events
    // within their workspace; database subscribers still filter by database ID.
    if (identity.databaseId && changed.pageId && !changed.databaseId) return;
    listener(changed);
  };
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener(WINDOW_EVENT, onWindowEvent);
  listeners.add(scoped);
  return () => {
    listeners.delete(scoped);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener(WINDOW_EVENT, onWindowEvent);
  };
}
