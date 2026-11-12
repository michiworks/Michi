import { useSyncExternalStore } from 'react';
import type { WorkspaceStructureChange } from 'michi-shared';

/**
 * Workspaces whose unsaved changes the backend keeps refusing, one notice
 * each (see the command flush in workspacePersistence). The actions close over
 * the persistence hook that raised the notice.
 */
export interface WorkspaceSyncNotice {
  workspaceId: string;
  workspaceName: string;
  /** What the backend said, as it said it. */
  message: string;
  /** Rejected: no longer sent until Retry. Conflict: still retried in the background. */
  kind: 'rejected' | 'conflict';
  retry: () => void;
  discard: () => void;
}

let notices: readonly WorkspaceSyncNotice[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const getWorkspaceSyncNotices = (): readonly WorkspaceSyncNotice[] => notices;

export function subscribeWorkspaceSyncNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Show (or replace) the one notice for this workspace. */
export function showWorkspaceSyncNotice(notice: WorkspaceSyncNotice): void {
  const index = notices.findIndex((candidate) => candidate.workspaceId === notice.workspaceId);
  notices = index < 0 ? [...notices, notice] : notices.map((candidate, i) => (i === index ? notice : candidate));
  emit();
}

export function clearWorkspaceSyncNotice(workspaceId: string): void {
  const next = notices.filter((notice) => notice.workspaceId !== workspaceId);
  if (next.length === notices.length) return;
  notices = next;
  emit();
}

export function useWorkspaceSyncNotices(): readonly WorkspaceSyncNotice[] {
  return useSyncExternalStore(subscribeWorkspaceSyncNotices, getWorkspaceSyncNotices, getWorkspaceSyncNotices);
}

/**
 * Ask the structure sync (useStructureSync) to re-read workspaces now, as a
 * workspace_structure_changed frame naming them would. `changes` carry the
 * removals to report (a tree deleted, a node purged): the re-read drops
 * those only where the backend lacks them.
 */
export const WORKSPACE_STRUCTURE_READ_EVENT = 'michi:workspace-structure-read';

export interface WorkspaceStructureReadRequest {
  connectionId: string;
  changes: WorkspaceStructureChange[];
}

export function requestWorkspaceStructureRead(request: WorkspaceStructureReadRequest): void {
  if (typeof window === 'undefined' || request.changes.length === 0) return;
  window.dispatchEvent(new CustomEvent<WorkspaceStructureReadRequest>(WORKSPACE_STRUCTURE_READ_EVENT, { detail: request }));
}
