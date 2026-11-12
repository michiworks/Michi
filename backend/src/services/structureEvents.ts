import { randomUUID } from 'node:crypto';
import {
  WINDOW_ID_HEADER,
  WORKSPACE_STRUCTURE_CHANGED_EVENT,
  isArchiveGroupId,
  isWindowId,
  type WorkspaceStructureChange,
  type WorkspaceStructureChangedEvent,
  type WorkspaceStructureCursor,
} from 'michi-shared';
import { getDb, runAfterCommit } from './db';

/**
 * Structure invalidation fan-out (workspace_structure_changed frames).
 *
 * Repository writes record what they changed; the record waits for the
 * transaction that made it to commit, then joins a short coalescing window so
 * a burst (a subtree trash, a backup restore) reaches each subscriber as one
 * frame. Frames are invalidation signals: a window re-reads the workspaces
 * they name. `epoch` changes with every backend process and `seq` counts the
 * frames of one scope (every change on desktop, one owner's in cloud mode), so
 * a window that sees a new epoch or a skipped number re-reads everything.
 */

export interface StructureChangeInput extends Omit<WorkspaceStructureChange, 'originWindowId'> {
  /** The workspace owner (cloud scoping). Looked up from the workspace row when omitted. */
  ownerUserId?: string | null;
}

export interface StructureSubscriber {
  /** Only this owner's changes (cloud). Undefined receives every change (desktop). */
  ownerUserId?: string;
  send(event: WorkspaceStructureChangedEvent): void;
}

export interface StructureEventBusOptions {
  epoch?: string;
  coalesceMs?: number;
  maxChangesPerFrame?: number;
  /** Whether changes are partitioned per owner. Default: cloud mode. */
  ownerScoped?: () => boolean;
  /** Owner of a workspace when a record does not carry one. */
  resolveOwner?: (workspaceId: string) => string | null;
}

const ALL_SCOPE = '*';
const DEFAULT_COALESCE_MS = 100;
const DEFAULT_MAX_CHANGES_PER_FRAME = 200;

function scopeOf(ownerUserId: string | undefined): string {
  return ownerUserId === undefined ? ALL_SCOPE : `u:${ownerUserId}`;
}

function changeKey(change: WorkspaceStructureChange): string {
  return [change.entity, change.op, change.workspaceId, change.treeId ?? '', change.nodeId ?? '',
    change.fromWorkspaceId ?? '', change.originWindowId ?? ''].join('\u0000');
}

function lookupWorkspaceOwner(workspaceId: string): string | null {
  try {
    const row = getDb().prepare('SELECT owner_user_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { owner_user_id: string | null } | undefined;
    return row?.owner_user_id ?? null;
  } catch {
    return null;
  }
}

// ── Origin window ─────────────────────────────────────────────────────────
// A change names the window that made it (so that window skips it) only when
// the write applies that window's own payload, which its store already holds:
// the route opts in with runWithStructureOrigin(structureOriginOf(req), write).
// The scope is synchronous. Timers, promise continuations, child processes
// and agent turns a request starts run after it has ended, untagged, so the
// window that clicked still hears what they create (continue-as-branch, a
// run started from a request, a spawned agent's threads). Everything else a
// request does is untagged too: the requesting window then re-reads its own
// change, which costs a read and never hides one.

let currentOrigin: string | undefined;

/** The window whose own payload the running write applies, when its route opted in. */
export function currentStructureOrigin(): string | undefined {
  return currentOrigin;
}

/**
 * Run `fn`; the changes it records synchronously name `windowId` as their
 * origin (a missing or malformed id names none). Work `fn` leaves pending
 * (a promise, a timer) is not tagged unless it re-enters a scope itself.
 */
export function runWithStructureOrigin<T>(windowId: string | undefined, fn: () => T): T {
  const outer = currentOrigin;
  currentOrigin = isWindowId(windowId) ? windowId : undefined;
  try {
    return fn();
  } finally {
    currentOrigin = outer;
  }
}

/** The window a request names (X-Michi-Window-Id), for a write that applies its own payload. */
export function structureOriginOf(req: { headers?: Record<string, unknown> }): string | undefined {
  const header = req.headers?.[WINDOW_ID_HEADER];
  return typeof header === 'string' && isWindowId(header) ? header : undefined;
}

// ── Bus ───────────────────────────────────────────────────────────────────

export function encodeWorkspaceStructureChangedEvent(event: WorkspaceStructureChangedEvent): string {
  return `event: ${WORKSPACE_STRUCTURE_CHANGED_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

interface StagedChange {
  change: WorkspaceStructureChange;
  owner: string | null;
}

export class WorkspaceStructureEventBus {
  readonly epoch: string;
  private readonly coalesceMs: number;
  private readonly maxChangesPerFrame: number;
  private readonly ownerScoped: () => boolean;
  private readonly resolveOwner: (workspaceId: string) => string | null;
  private readonly seqByScope = new Map<string, number>();
  private readonly subscribers = new Set<StructureSubscriber>();
  private pending: StagedChange[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StructureEventBusOptions = {}) {
    this.epoch = options.epoch ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.maxChangesPerFrame = options.maxChangesPerFrame ?? DEFAULT_MAX_CHANGES_PER_FRAME;
    this.ownerScoped = options.ownerScoped ?? (() => process.env.MICHI_CLOUD === '1');
    this.resolveOwner = options.resolveOwner ?? lookupWorkspaceOwner;
  }

  /**
   * Record one committed (or committing) change. Inside runInTransaction it
   * is delivered only if that transaction commits.
   */
  record(input: StructureChangeInput): void {
    const { ownerUserId, ...fields } = input;
    const origin = currentStructureOrigin();
    const change: WorkspaceStructureChange = {
      entity: fields.entity,
      op: fields.op,
      workspaceId: fields.workspaceId,
      ...(fields.treeId ? { treeId: fields.treeId } : {}),
      ...(fields.nodeId ? { nodeId: fields.nodeId } : {}),
      ...(fields.fromWorkspaceId && fields.fromWorkspaceId !== fields.workspaceId
        ? { fromWorkspaceId: fields.fromWorkspaceId } : {}),
      ...(origin ? { originWindowId: origin } : {}),
    };
    const owner = !this.ownerScoped()
      ? null
      : ownerUserId !== undefined ? ownerUserId : this.resolveOwner(change.workspaceId);
    runAfterCommit(() => this.stage({ change, owner }));
  }

  /** The scope's latest frame: what a read made now has seen. */
  cursor(ownerUserId?: string): WorkspaceStructureCursor {
    return { epoch: this.epoch, seq: this.seqByScope.get(scopeOf(ownerUserId)) ?? 0 };
  }

  /** Subscribe; the first frame, sent now, carries no changes: the current cursor. */
  subscribe(subscriber: StructureSubscriber): () => void {
    this.subscribers.add(subscriber);
    try {
      subscriber.send({ ...this.cursor(subscriber.ownerUserId), changes: [] });
    } catch {
      // A broken stream detaches through its own close path.
    }
    return () => { this.subscribers.delete(subscriber); };
  }

  /** Deliver everything staged now. The coalescing timer calls this. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const staged = this.pending;
    this.pending = [];
    if (staged.length === 0) return;
    const byScope = new Map<string, Map<string, WorkspaceStructureChange>>();
    const add = (scope: string, change: WorkspaceStructureChange) => {
      let changes = byScope.get(scope);
      if (!changes) byScope.set(scope, changes = new Map());
      const key = changeKey(change);
      if (!changes.has(key)) changes.set(key, change);
    };
    for (const { change, owner } of staged) {
      add(ALL_SCOPE, change);
      if (owner !== null) add(scopeOf(owner), change);
    }
    for (const [scope, changes] of byScope) {
      const seq = (this.seqByScope.get(scope) ?? 0) + 1;
      this.seqByScope.set(scope, seq);
      const event: WorkspaceStructureChangedEvent = changes.size > this.maxChangesPerFrame
        ? { epoch: this.epoch, seq, changes: [], resync: true }
        : { epoch: this.epoch, seq, changes: [...changes.values()] };
      for (const subscriber of [...this.subscribers]) {
        if (scopeOf(subscriber.ownerUserId) !== scope) continue;
        try {
          subscriber.send(event);
        } catch {
          // One broken stream must not stop the others.
        }
      }
    }
  }

  private stage(staged: StagedChange): void {
    this.pending.push(staged);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.coalesceMs);
    this.timer.unref?.();
  }
}

export const structureEvents = new WorkspaceStructureEventBus();

export function recordStructureChange(input: StructureChangeInput): void {
  structureEvents.record(input);
}

// ── Row diffs ─────────────────────────────────────────────────────────────
// Writers pass the row as it was (null: it did not exist) and as written.

interface WorkspaceStructureRow {
  id: string;
  name: string;
  deleted_at?: number | null;
  archived_at?: number | null;
}

export function recordWorkspaceRowChange(before: Omit<WorkspaceStructureRow, 'id'> | null, after: WorkspaceStructureRow): void {
  const workspaceId = after.id;
  if (!before) {
    recordStructureChange({ entity: 'workspace', op: 'created', workspaceId });
    return;
  }
  if (before.name !== after.name) recordStructureChange({ entity: 'workspace', op: 'renamed', workspaceId });
  if ((before.deleted_at ?? null) === null && (after.deleted_at ?? null) !== null) {
    recordStructureChange({ entity: 'workspace', op: 'deleted', workspaceId });
  } else if ((before.deleted_at ?? null) !== null && (after.deleted_at ?? null) === null) {
    recordStructureChange({ entity: 'workspace', op: 'restored', workspaceId });
  }
  if ((before.archived_at ?? null) === null && (after.archived_at ?? null) !== null) {
    recordStructureChange({ entity: 'workspace', op: 'archived', workspaceId });
  } else if ((before.archived_at ?? null) !== null && (after.archived_at ?? null) === null) {
    recordStructureChange({ entity: 'workspace', op: 'unarchived', workspaceId });
  }
}

interface TreeStructureRow {
  id: string;
  workspace_id: string;
  name?: string | null;
  archived_at?: number | null;
}

export function recordTreeRowChange(before: Omit<TreeStructureRow, 'id'> | null, after: TreeStructureRow): void {
  const base = { entity: 'tree' as const, workspaceId: after.workspace_id, treeId: after.id };
  if (!before) {
    recordStructureChange({ ...base, op: 'created' });
    return;
  }
  if (before.workspace_id !== after.workspace_id) {
    recordStructureChange({ ...base, op: 'moved', fromWorkspaceId: before.workspace_id });
  }
  if ((before.name ?? null) !== (after.name ?? null)) recordStructureChange({ ...base, op: 'renamed' });
  if ((before.archived_at ?? null) === null && (after.archived_at ?? null) !== null) {
    recordStructureChange({ ...base, op: 'archived' });
  } else if ((before.archived_at ?? null) !== null && (after.archived_at ?? null) === null) {
    recordStructureChange({ ...base, op: 'unarchived' });
  }
}

interface NodeStructureRow {
  id: string;
  workspace_id: string;
  tree_id?: string | null;
  parent_node_id?: string | null;
  title?: string | null;
  deleted_at?: number | null;
  deletion_group_id?: string | null;
}

export function recordNodeRowChange(before: Omit<NodeStructureRow, 'id'> | null, after: NodeStructureRow): void {
  const base = {
    entity: 'node' as const,
    workspaceId: after.workspace_id,
    nodeId: after.id,
    ...(after.tree_id ? { treeId: after.tree_id } : {}),
  };
  if (!before) {
    recordStructureChange({ ...base, op: 'created' });
    return;
  }
  if (before.workspace_id !== after.workspace_id
    || (before.tree_id ?? null) !== (after.tree_id ?? null)
    || (before.parent_node_id ?? null) !== (after.parent_node_id ?? null)) {
    recordStructureChange({ ...base, op: 'moved', fromWorkspaceId: before.workspace_id });
  }
  if ((before.title ?? null) !== (after.title ?? null)) recordStructureChange({ ...base, op: 'renamed' });
  const wasDeleted = (before.deleted_at ?? null) !== null;
  const isDeleted = (after.deleted_at ?? null) !== null;
  if (!wasDeleted && isDeleted) {
    recordStructureChange({
      ...base,
      op: isArchiveGroupId(after.deletion_group_id) ? 'archived' : 'deleted',
    });
  } else if (wasDeleted && !isDeleted) {
    recordStructureChange({ ...base, op: 'restored' });
  }
}
