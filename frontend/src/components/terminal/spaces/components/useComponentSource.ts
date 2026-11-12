import { useEffect, useRef, useState } from 'react';
import type { PageComponentVersionSource } from 'michi-shared';
import { readPageComponent } from '../../../../services/api/pageComponents';
import { subscribePageChanges, type PageEventIdentity } from '../../../../state/pages/pageEvents';
import { startVisiblePoll } from '../../../../state/visiblePoll';

export interface ComponentSource { code: string; name: string; version: number; provenance: PageComponentVersionSource }

function isMissingComponentVersion(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const failure = cause as { status?: unknown; code?: unknown; message?: unknown };
  return failure.status === 401 || failure.status === 403 || (failure.status === 404 && failure.code === 'not_found');
}

/**
 * A component's source, re-read on its page events and every 10 s while the
 * window is visible. Reads coalesce; a missing version (or lost access) clears
 * the source and stops the poll until remount, though page events still re-read
 * it. An unchanged version and code keep the same object, so the sandbox frame
 * stays put. An empty componentId reads nothing.
 */
export function useComponentSource(input: {
  componentId: string;
  version?: number;
  workspaceId: string;
  connectionId: string;
  /** Where its page events come from: the page or the database showing it. */
  events: Omit<PageEventIdentity, 'backendConnectionId' | 'workspaceId'>;
  /** Called before the source clears, in the same tick, for a missing version. */
  onMissing?: () => void;
  /** The error shown when a failed read has no message of its own. */
  fallbackError: string;
}): { source: ComponentSource | null; error: string | null } {
  const { componentId, version, workspaceId, connectionId, fallbackError } = input;
  const [source, setSource] = useState<ComponentSource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onMissingRef = useRef(input.onMissing);
  onMissingRef.current = input.onMissing;
  const eventsKey = JSON.stringify(input.events);
  useEffect(() => {
    if (!componentId) return;
    let live = true;
    let reading = false;
    let readAgain = false;
    let unavailable = false;
    const load = async () => {
      if (reading) { readAgain = true; return; }
      reading = true;
      try {
        const result = await readPageComponent(componentId, workspaceId, connectionId, version);
        if (!live) return;
        if (!result.component?.enabled) { setSource(null); setError('This component is disabled or unavailable.'); return; }
        unavailable = false;
        setError(null);
        setSource(previous => previous?.version === result.version.version && previous.code === result.version.code ? previous
          : { code: result.version.code, name: result.component!.name, version: result.version.version, provenance: result.version.source });
      } catch (cause) {
        if (live) {
          if (isMissingComponentVersion(cause)) {
            unavailable = true;
            onMissingRef.current?.();
            setSource(null);
          }
          setError(cause instanceof Error ? cause.message : fallbackError);
        }
      } finally { reading = false; if (live && readAgain && !unavailable) { readAgain = false; void load(); } }
    };
    const events = JSON.parse(eventsKey) as Omit<PageEventIdentity, 'backendConnectionId' | 'workspaceId'>;
    const unsubscribe = subscribePageChanges({ ...events, backendConnectionId: connectionId, workspaceId }, changed => {
      if (!changed.componentId || changed.componentId === componentId) void load();
    });
    void load();
    const stopPolling = startVisiblePoll(() => { if (!unavailable) void load(); }, { intervalMs: 10_000, focus: false });
    return () => { live = false; unsubscribe(); stopPolling(); };
  }, [componentId, connectionId, eventsKey, fallbackError, version, workspaceId]);
  return { source, error };
}
