import { useCallback, useEffect, useRef } from 'react';
import type {
  ProgressCardDto,
  SpaceActivityItem,
  SpacesHomeDto,
  SpacesHomeSectionsDto,
  WorkspaceHomeDto,
  WorkspaceHomeSummaryDto,
} from 'michi-shared';
import {
  fetchHomeSections,
  fetchProgressCards,
  fetchSpaceActivity,
  fetchSpacesHome,
  fetchWorkspaceHome,
  fetchWorkspaceHomes,
} from '../../services/api/spacesHome';
import { remoteFirstPainted, whenRemoteFirstPaint } from '../remoteFirstPaint';
import { subscribePageChanges } from './pageEvents';
import { loadResource, pollResource, resourceKey, useResource } from './resourceCache';

export interface HomeResource<T> {
  data: T | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** The last confirmed data is shown while the backend cannot be read. */
  stale: boolean;
  refresh: () => void;
}

const HOME_POLL_MS = 15_000;

/**
 * Reads one backend-scoped resource into the shared cache and keeps it fresh:
 * on mount, on page events from the same backend, on window focus and on a
 * visible-tab poll. A failed read keeps the last confirmed data (marked
 * stale) instead of replacing it with an empty answer.
 */
function useHomeResource<T>(
  key: string,
  connectionId: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
  deferToFirstPaint = false,
): HomeResource<T> {
  const snapshot = useResource<T>(key);
  const loadRef = useRef(load);
  loadRef.current = load;
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    if (!enabled) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // A background reader (not the page the user opened) lets a remote paint its conversation first.
    void loadResource(key, () => (deferToFirstPaint && !remoteFirstPainted(connectionId)
      ? whenRemoteFirstPaint(connectionId).then(() => {
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return loadRef.current(controller.signal);
      })
      : loadRef.current(controller.signal)), controller.signal);
  }, [enabled, key, connectionId, deferToFirstPaint]);

  useEffect(() => {
    refresh();
    return () => controllerRef.current?.abort();
  }, [refresh]);
  useEffect(() => (enabled ? subscribePageChanges({ backendConnectionId: connectionId }, refresh) : undefined), [connectionId, enabled, refresh]);
  useEffect(() => (enabled ? pollResource(key, HOME_POLL_MS, refresh, { deferred: deferToFirstPaint }) : undefined), [deferToFirstPaint, enabled, key, refresh]);

  return { data: snapshot.data, status: snapshot.status, error: snapshot.error, stale: snapshot.stale, refresh };
}

export const spacesHomeResourceKey = (connectionId: string) => resourceKey('spaces-home', connectionId);

/** The Spaces Home page of one backend connection, with its layout rules. */
export function useSpacesHome(connectionId: string): HomeResource<SpacesHomeDto> {
  return useHomeResource(spacesHomeResourceKey(connectionId), connectionId, (signal) => fetchSpacesHome(connectionId, signal));
}

/** Every live workspace of the connection with its home page id and first-run progress. */
export function useSpacesHomeWorkspaces(connectionId: string): HomeResource<WorkspaceHomeSummaryDto[]> {
  return useHomeResource(resourceKey('spaces-home-workspaces', connectionId), connectionId, (signal) => fetchWorkspaceHomes(connectionId, signal));
}

/** One workspace's default home page. */
export function useWorkspaceHome(workspaceId: string, connectionId: string): HomeResource<WorkspaceHomeDto> {
  return useHomeResource(
    resourceKey('workspace-home', connectionId, workspaceId),
    connectionId,
    (signal) => fetchWorkspaceHome(workspaceId, connectionId, signal),
    Boolean(workspaceId),
  );
}

/** Waiting, Stalled and Done, counted from Michi's own conversations. */
export function useHomeSections(connectionId: string): HomeResource<SpacesHomeSectionsDto> {
  return useHomeResource(resourceKey('spaces-home-sections', connectionId), connectionId, (signal) => fetchHomeSections(connectionId, { signal }));
}

/** Recent page changes and conversations started from a Space. */
export function useSpaceActivity(connectionId: string, limit?: number): HomeResource<SpaceActivityItem[]> {
  return useHomeResource(
    resourceKey('spaces-home-activity', connectionId, limit === undefined ? '' : String(limit)),
    connectionId,
    (signal) => fetchSpaceActivity(connectionId, { limit, signal }),
  );
}

/** Conversations started from a Space, shown as cards until a day after they are seen. */
export function useProgressCards(connectionId: string, opts?: { deferToFirstPaint?: boolean }): HomeResource<ProgressCardDto[]> {
  return useHomeResource(resourceKey('spaces-home-progress', connectionId), connectionId, (signal) => fetchProgressCards(connectionId, signal), true, opts?.deferToFirstPaint === true);
}
