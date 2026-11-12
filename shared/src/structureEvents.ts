/**
 * Workspace structure invalidation feed.
 *
 * The backend pushes one `workspace_structure_changed` frame on every
 * window's background feed when workspaces, trees or threads are created,
 * renamed, moved, archived, deleted or restored. Frames are invalidation
 * signals, not state: a window re-reads the affected workspaces. `epoch`
 * names the backend process and `seq` counts frames within it (per owner in
 * cloud mode), so a window that sees a new epoch or skips a number re-reads
 * everything. Each subscription opens with a frame that carries no changes:
 * the current cursor.
 */
export const WORKSPACE_STRUCTURE_CHANGED_EVENT = 'workspace_structure_changed';

/** Request header naming the window that made a change (lower-case, as Node reads it). */
export const WINDOW_ID_HEADER = 'x-michi-window-id';

export type WorkspaceStructureEntity = 'workspace' | 'tree' | 'node';

export type WorkspaceStructureOp =
  | 'created'
  | 'renamed'
  | 'moved'
  | 'archived'
  | 'unarchived'
  | 'deleted'
  | 'restored'
  | 'purged';

export interface WorkspaceStructureChange {
  entity: WorkspaceStructureEntity;
  op: WorkspaceStructureOp;
  /** The workspace that holds the entity now (for a move: its destination). */
  workspaceId: string;
  treeId?: string;
  nodeId?: string;
  /** A move between workspaces: the workspace the entity left. */
  fromWorkspaceId?: string;
  /** The window whose request made the change, when it sent one. */
  originWindowId?: string;
}

export interface WorkspaceStructureCursor {
  epoch: string;
  seq: number;
}

export interface WorkspaceStructureChangedEvent extends WorkspaceStructureCursor {
  changes: WorkspaceStructureChange[];
  /** More changes than one frame carries were coalesced: re-read everything. */
  resync?: true;
}

const ENTITIES: ReadonlySet<string> = new Set<WorkspaceStructureEntity>(['workspace', 'tree', 'node']);
const OPS: ReadonlySet<string> = new Set<WorkspaceStructureOp>([
  'created', 'renamed', 'moved', 'archived', 'unarchived', 'deleted', 'restored', 'purged',
]);
const WINDOW_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

/** A window id a request may carry: what the renderer mints (a UUID, or `w-…`). */
export function isWindowId(value: unknown): value is string {
  return typeof value === 'string' && WINDOW_ID_PATTERN.test(value);
}

function optionalId(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

export function isWorkspaceStructureChange(value: unknown): value is WorkspaceStructureChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as Record<string, unknown>;
  return typeof change.entity === 'string' && ENTITIES.has(change.entity)
    && typeof change.op === 'string' && OPS.has(change.op)
    && typeof change.workspaceId === 'string' && change.workspaceId.length > 0
    && optionalId(change.treeId)
    && optionalId(change.nodeId)
    && optionalId(change.fromWorkspaceId)
    && (change.originWindowId === undefined || isWindowId(change.originWindowId));
}

export function isWorkspaceStructureCursor(value: unknown): value is WorkspaceStructureCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.epoch === 'string' && cursor.epoch.length > 0
    && typeof cursor.seq === 'number' && Number.isSafeInteger(cursor.seq) && cursor.seq >= 0;
}

export function isWorkspaceStructureChangedEvent(value: unknown): value is WorkspaceStructureChangedEvent {
  if (!isWorkspaceStructureCursor(value)) return false;
  const event = value as unknown as Record<string, unknown>;
  return Array.isArray(event.changes)
    && event.changes.every(isWorkspaceStructureChange)
    && (event.resync === undefined || event.resync === true);
}
