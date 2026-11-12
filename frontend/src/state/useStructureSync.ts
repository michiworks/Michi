import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { WorkspaceStructureChangedEvent } from 'michi-shared';
import { fetchAllWorkspacesMeta, fetchWorkspaceStructure, takeHydrationStructureCursor } from '../services/api';
import { ORIGIN_WINDOW_ID } from '../config/windowIdentity';
import { projectConnectionId } from '../config/backendConnections';
import type { ChatNodeState, Project } from './chatTypes';
import { firstLiveUserWorkspaceId } from './assistant/systemWorkspace';
import type { StructureAdoption } from './structureAdoption';
import {
  reconcileWorkspaceStructure,
  type StructureEditGuards,
  type StructureMergeResult,
  type StructureReadSnapshot,
} from './structureMerge';
import {
  StructureFeedTracker,
  StructureRefreshScheduler,
  planStructureRead,
  type StructureRefreshRequest,
} from './structureSync';
import { WORKSPACE_STRUCTURE_READ_EVENT, type WorkspaceStructureReadRequest } from './workspaceSyncNotices';

export interface StructureSyncPersistence {
  adoptBackendStructure(adoption: StructureAdoption): void;
  structureGuards: StructureEditGuards;
  workspacesBusy(projectIds: Iterable<string>): boolean;
  whenWorkspacesSettled(projectIds: Iterable<string>): Promise<void>;
}

export interface StructureSyncDeps {
  hydrated: boolean;
  projectsRef: MutableRefObject<Project[]>;
  nodesRef: MutableRefObject<Record<string, ChatNodeState>>;
  activeProjectIdRef: MutableRefObject<string | null>;
  /** Must update projectsRef synchronously (ChatProvider's setProjects does). */
  setProjects: Dispatch<SetStateAction<Project[]>>;
  setNodes: Dispatch<SetStateAction<Record<string, ChatNodeState>>>;
  setActiveProjectId: (projectId: string | null) => void;
  structureVersionRef: MutableRefObject<number>;
  prunePaneIds: (nodeIds: ReadonlySet<string>) => void;
  persistence: StructureSyncPersistence;
  debounceMs?: number;
  retryDelayMs?: number;
}

/** A write of this window that overlaps the re-read is read again, this many times per attempt. */
const MAX_OVERLAPPING_READS = 5;
/** More named workspaces than this are read in the one batched request instead of one request each. */
const TARGETED_READ_LIMIT = 5;

function workspaceIdOf(raw: unknown): string | null {
  const id = (raw as { workspace?: { id?: unknown } } | null)?.workspace?.id;
  return typeof id === 'string' && id ? id : null;
}

export function applyStructureMerge(deps: StructureSyncDeps, result: StructureMergeResult | null): void {
  if (!result) return;
  // Before the store changes: the scan that renders it takes it as durable.
  for (const adoption of result.adoptions) deps.persistence.adoptBackendStructure(adoption);
  deps.setProjects(result.projects);
  if (result.nodes !== deps.nodesRef.current) {
    deps.nodesRef.current = result.nodes;
    deps.structureVersionRef.current += 1;
    deps.setNodes(result.nodes);
  }
  // Threads gone for good close their panes; trashed ones close through deletedAt.
  if (result.removedNodeIds.length > 0) deps.prunePaneIds(new Set(result.removedNodeIds));
  // Only a workspace that no longer exists moves the window elsewhere.
  const active = deps.activeProjectIdRef.current;
  if (active && result.removedProjectIds.includes(active)) {
    const next = firstLiveUserWorkspaceId(result.projects);
    deps.activeProjectIdRef.current = next;
    deps.setActiveProjectId(next);
  }
}

/** One re-read of a connection's workspaces, merged into the store. */
export async function refreshWorkspaceStructure(
  deps: StructureSyncDeps,
  connectionId: string,
  request: StructureRefreshRequest,
): Promise<void> {
  const plan = request.full ? null : planStructureRead(request.changes);
  // Everything (a gap), or more named workspaces than requests worth sending
  // one by one: the single batched read of the connection, which is complete.
  const batched = !plan || plan.workspaceIds.size > TARGETED_READ_LIMIT;
  for (let attempt = 0; attempt < MAX_OVERLAPPING_READS; attempt++) {
    const ofConnection = (project: Project) => projectConnectionId(project) === connectionId;
    const targets = plan && !batched ? [...plan.workspaceIds] : [...new Set([
      ...deps.projectsRef.current.filter(ofConnection).map((project) => project.id),
      ...(plan?.workspaceIds ?? []),
    ])];
    // Let this window's own writes land first: the read then sees them.
    await deps.persistence.whenWorkspacesSettled(targets);
    const readStartedAt = Date.now();
    let snapshots: StructureReadSnapshot[];
    if (!batched) {
      snapshots = await Promise.all(targets.map(async (workspaceId) => ({
        workspaceId,
        raw: await fetchWorkspaceStructure(workspaceId),
      })));
    } else {
      const raws = await fetchAllWorkspacesMeta(connectionId);
      snapshots = raws.flatMap((raw) => {
        const workspaceId = workspaceIdOf(raw);
        return workspaceId ? [{ workspaceId, raw }] : [];
      });
      // A named workspace the backend no longer lists is gone (as a 404 says for one read).
      const listed = new Set(snapshots.map((snapshot) => snapshot.workspaceId));
      for (const workspaceId of plan?.workspaceIds ?? []) {
        if (!listed.has(workspaceId)) snapshots.push({ workspaceId, raw: null });
      }
    }
    // A write that started meanwhile may or may not be in the read.
    if (deps.persistence.workspacesBusy([...targets, ...snapshots.map((snapshot) => snapshot.workspaceId)])) continue;
    applyStructureMerge(deps, reconcileWorkspaceStructure({
      currentProjects: deps.projectsRef.current,
      currentNodes: deps.nodesRef.current,
      snapshots,
      connectionId,
      removals: plan?.removals ?? { workspaceIds: new Set(), treeIds: new Set(), nodeIds: new Set() },
      // It succeeded and lists everything: what it lacks that the backend held is gone.
      complete: batched,
      readStartedAt,
      guards: deps.persistence.structureGuards,
    }));
    return;
  }
  throw new Error('This window kept writing the workspaces being re-read');
}

/**
 * Keep the store in step with structure changes other windows, devices,
 * tools and scheduled runs make. Returns the background feed's handler for
 * workspace_structure_changed frames, per connection.
 */
export function useStructureSync(deps: StructureSyncDeps): (connectionId: string, event: WorkspaceStructureChangedEvent) => void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const machineRef = useRef<{ tracker: StructureFeedTracker; scheduler: StructureRefreshScheduler } | null>(null);
  const machine = useCallback(() => {
    if (!machineRef.current) {
      machineRef.current = {
        tracker: new StructureFeedTracker({ windowId: ORIGIN_WINDOW_ID, takeHydrationCursor: takeHydrationStructureCursor }),
        scheduler: new StructureRefreshScheduler({
          debounceMs: depsRef.current.debounceMs,
          retryDelayMs: depsRef.current.retryDelayMs,
          run: (connectionId, request) => refreshWorkspaceStructure(depsRef.current, connectionId, request),
        }),
      };
    }
    return machineRef.current;
  }, []);
  useEffect(() => () => {
    machineRef.current?.scheduler.stop();
    machineRef.current = null;
  }, []);
  // The persistence layer asks for a re-read to rebase (a conflict) or to
  // take the backend's state back (discarded unsaved changes).
  useEffect(() => {
    const onRead = (event: Event) => {
      const request = (event as CustomEvent<WorkspaceStructureReadRequest>).detail;
      if (!depsRef.current.hydrated || !request?.connectionId || !request.changes?.length) return;
      machine().scheduler.request(request.connectionId, { kind: 'changes', changes: request.changes });
    };
    window.addEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
    return () => window.removeEventListener(WORKSPACE_STRUCTURE_READ_EVENT, onRead);
  }, [machine]);
  return useCallback((connectionId: string, event: WorkspaceStructureChangedEvent) => {
    // The hydration barrier: nothing merges into a store that has not loaded.
    if (!depsRef.current.hydrated) return;
    const { tracker, scheduler } = machine();
    scheduler.request(connectionId, tracker.accept(connectionId, event));
  }, [machine]);
}
