import { useCallback, useEffect, useState } from 'react';
import type { AllTasksDto } from 'michi-shared';
import { fetchAllTasks } from '../../../../services/api/taskDatabase';
import { subscribePageChanges } from '../../../../state/pages/pageEvents';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { useVisiblePoll } from '../../../../state/visiblePoll';

/** How often a visible All tasks reads every task database again; focusing the window and a database change read them too. */
const REFRESH_MS = 60_000;

export interface AllTasksState {
  dto: AllTasksDto | null;
  /** Why the last read failed; what an earlier read said stays. */
  error: string | null;
  refresh: () => void;
  /** All tasks as a write answered, until the next read. */
  replace: (update: (dto: AllTasksDto) => AllTasksDto) => void;
}

/** Every task database on this computer, for All tasks. */
export function useAllTasks(): AllTasksState {
  const [dto, setDto] = useState<AllTasksDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    fetchAllTasks(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        // A save answered while this read was out: the read still has the views from before it, but its rows are the fresh ones.
        setDto((current) => (current && next.viewsRevision < current.viewsRevision
          ? { ...next, views: current.views, viewsRevision: current.viewsRevision }
          : next));
        setError(null);
      },
      (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Couldn't read the tasks just now."); },
    );
    return () => controller.abort();
  }, [reads]);
  useEffect(() => {
    // Any database may be a task database; a change to a page's own blocks is not.
    return subscribePageChanges({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID }, (changed) => { if (changed.databaseId) refresh(); });
  }, [refresh]);
  useVisiblePoll(refresh, { intervalMs: REFRESH_MS });
  const replace = useCallback((update: (dto: AllTasksDto) => AllTasksDto) => setDto((current) => (current ? update(current) : current)), []);
  return { dto, error, refresh, replace };
}
