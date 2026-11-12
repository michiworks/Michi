import type {
  WorkspaceStructureChange,
  WorkspaceStructureChangedEvent,
  WorkspaceStructureCursor,
} from 'michi-shared';
import type { StructureRemovals } from './structureMerge';

/**
 * Client side of the workspace_structure_changed feed: which frames call for
 * a re-read (StructureFeedTracker), when the re-read runs (StructureRefreshScheduler),
 * and what it reads (planStructureRead). Frames are invalidation signals:
 * a new epoch, a skipped seq, a resync frame, or an opening cursor this
 * window has not caught up to all mean "re-read everything".
 */

export type StructureFeedDecision =
  | { kind: 'none' }
  | { kind: 'changes'; changes: WorkspaceStructureChange[] }
  | { kind: 'full' };

function sameCursor(a: WorkspaceStructureCursor | undefined, b: WorkspaceStructureCursor): boolean {
  return !!a && a.epoch === b.epoch && a.seq === b.seq;
}

export class StructureFeedTracker {
  private readonly cursors = new Map<string, WorkspaceStructureCursor>();

  constructor(private readonly options: {
    /** This window's origin id; its own changes are already in its store. */
    windowId: string | null;
    /** The cursor a hydration read of `connectionId` was taken at, consumed once. */
    takeHydrationCursor?: (connectionId: string) => WorkspaceStructureCursor | undefined;
  }) {}

  accept(connectionId: string, event: WorkspaceStructureChangedEvent): StructureFeedDecision {
    const last = this.cursors.get(connectionId);
    const cursor = { epoch: event.epoch, seq: event.seq };
    // Each subscription opens with a cursor-only frame. Nothing was missed
    // only if this window has seen exactly that much, by frames or by a load.
    if (event.changes.length === 0 && !event.resync) {
      const hydrated = this.options.takeHydrationCursor?.(connectionId);
      this.cursors.set(connectionId, cursor);
      return sameCursor(last, cursor) || sameCursor(hydrated, cursor) ? { kind: 'none' } : { kind: 'full' };
    }
    if (last && last.epoch === event.epoch && event.seq <= last.seq) return { kind: 'none' };
    this.cursors.set(connectionId, cursor);
    if (!last || last.epoch !== event.epoch || event.seq !== last.seq + 1 || event.resync) return { kind: 'full' };
    const windowId = this.options.windowId;
    const changes = windowId ? event.changes.filter((change) => change.originWindowId !== windowId) : event.changes;
    return changes.length > 0 ? { kind: 'changes', changes } : { kind: 'none' };
  }
}

export interface StructureRefreshRequest {
  full: boolean;
  changes: WorkspaceStructureChange[];
}

export interface StructureRefreshSchedulerOptions {
  /** Quiet time before a re-read starts. */
  debounceMs?: number;
  /** A steady stream of frames still re-reads at least this often. */
  maxWaitMs?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  run: (connectionId: string, request: StructureRefreshRequest) => Promise<void>;
}

interface ConnectionSchedule {
  pending: StructureRefreshRequest | null;
  firstPendingAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  failures: number;
}

function mergeRequests(a: StructureRefreshRequest | null, b: StructureRefreshRequest): StructureRefreshRequest {
  if (!a) return { full: b.full, changes: b.full ? [] : [...b.changes] };
  const full = a.full || b.full;
  return { full, changes: full ? [] : [...a.changes, ...b.changes] };
}

/**
 * Debounced, one-at-a-time re-reads per connection. Requests that arrive
 * while one runs wait for it and then run together. A failed re-read (an
 * unreachable backend is not an empty one) is retried with backoff.
 */
export class StructureRefreshScheduler {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly retryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly schedules = new Map<string, ConnectionSchedule>();
  private stopped = false;

  constructor(private readonly options: StructureRefreshSchedulerOptions) {
    this.debounceMs = options.debounceMs ?? 150;
    this.maxWaitMs = options.maxWaitMs ?? 1_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  }

  request(connectionId: string, decision: StructureFeedDecision): void {
    if (this.stopped || decision.kind === 'none') return;
    const schedule = this.scheduleFor(connectionId);
    const incoming: StructureRefreshRequest = decision.kind === 'full'
      ? { full: true, changes: [] }
      : { full: false, changes: decision.changes };
    if (!schedule.pending) schedule.firstPendingAt = Date.now();
    schedule.pending = mergeRequests(schedule.pending, incoming);
    // A running re-read picks it up when done; a retry waiting out its backoff takes it along.
    if (schedule.running || (schedule.failures > 0 && schedule.timer)) return;
    this.arm(connectionId, schedule, this.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    for (const schedule of this.schedules.values()) {
      if (schedule.timer) clearTimeout(schedule.timer);
      schedule.timer = null;
      schedule.pending = null;
    }
  }

  private scheduleFor(connectionId: string): ConnectionSchedule {
    let schedule = this.schedules.get(connectionId);
    if (!schedule) {
      schedule = { pending: null, firstPendingAt: 0, timer: null, running: false, failures: 0 };
      this.schedules.set(connectionId, schedule);
    }
    return schedule;
  }

  private arm(connectionId: string, schedule: ConnectionSchedule, delay: number): void {
    if (schedule.timer) clearTimeout(schedule.timer);
    const waited = Date.now() - schedule.firstPendingAt;
    const wait = schedule.failures > 0 ? delay : Math.max(0, Math.min(delay, this.maxWaitMs - waited));
    schedule.timer = setTimeout(() => {
      schedule.timer = null;
      void this.runPending(connectionId, schedule);
    }, wait);
  }

  private async runPending(connectionId: string, schedule: ConnectionSchedule): Promise<void> {
    const request = schedule.pending;
    if (this.stopped || !request || schedule.running) return;
    schedule.pending = null;
    schedule.running = true;
    let failed = false;
    try {
      await this.options.run(connectionId, request);
      schedule.failures = 0;
    } catch {
      failed = true;
      schedule.failures += 1;
      // What failed is still unread: put it back in front of anything newer.
      schedule.pending = mergeRequests(request, schedule.pending ?? { full: false, changes: [] });
      if (schedule.failures === 1) schedule.firstPendingAt = Date.now();
    } finally {
      schedule.running = false;
    }
    if (this.stopped || !schedule.pending) return;
    if (failed) {
      this.arm(connectionId, schedule, Math.min(this.maxRetryDelayMs, this.retryDelayMs * (2 ** (schedule.failures - 1))));
    } else {
      schedule.firstPendingAt = Date.now();
      this.arm(connectionId, schedule, this.debounceMs);
    }
  }
}

export interface StructureReadPlan {
  /** Renderer ids of the workspaces to re-read. */
  workspaceIds: Set<string>;
  removals: StructureRemovals;
}

/** What a set of changes asks to re-read, and which removals it reports. */
export function planStructureRead(changes: readonly WorkspaceStructureChange[]): StructureReadPlan {
  const workspaceIds = new Set<string>();
  const removedWorkspaces = new Set<string>();
  const removedTrees = new Set<string>();
  const removedNodes = new Set<string>();
  for (const change of changes) {
    workspaceIds.add(change.workspaceId);
    if (change.fromWorkspaceId) workspaceIds.add(change.fromWorkspaceId);
    if (change.entity === 'workspace' && change.op === 'purged') removedWorkspaces.add(change.workspaceId);
    if (change.entity === 'tree' && (change.op === 'deleted' || change.op === 'purged') && change.treeId) removedTrees.add(change.treeId);
    if (change.entity === 'node' && change.op === 'purged' && change.nodeId) removedNodes.add(change.nodeId);
  }
  return {
    workspaceIds,
    removals: { workspaceIds: removedWorkspaces, treeIds: removedTrees, nodeIds: removedNodes },
  };
}
