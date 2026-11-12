import { useSyncExternalStore } from 'react';

/**
 * The digest the Digest page opens on: one picked on the Map or a digest
 * pane's "↗ detail". The page mounts after the request, so it is held until
 * the page takes it.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();

function setRequested(next: string | null): void {
  requested = next;
  for (const listener of [...listeners]) listener();
}

export function requestDigestFocus(nodeId: string): void { setRequested(nodeId); }

export function clearRequestedDigest(): void { if (requested !== null) setRequested(null); }

export function useRequestedDigest(): string | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => requested,
    () => requested,
  );
}
