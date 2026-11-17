/**
 * When a streaming turn's checkpoints are written (11-09 performance audit
 * P1-5). A checkpoint rewrites the whole assistant row, tool calls included:
 * 18 h of turns rewrote 8.83 GB for 54.7 MB of final data. Events only mark
 * their turn dirty; one scheduler per turn decides when the snapshot is read
 * and written:
 *  - at most once per interval, which grows with the bytes the last write
 *    rewrote, so a large row is rewritten less often;
 *  - on the next event-loop turn for what a reload must show promptly
 *    (ChatHub's checkpointsSoon); the events of one tick share that write;
 *  - by a trailing timer, so text that stops streaming is saved without
 *    waiting for another event;
 *  - one write in flight at a time, so a slow store queues at most one
 *    checkpoint per turn; the max dirty age bounds how long newer events
 *    wait on it.
 * A crash loses up to about 5 s of a turn (10 s of a maintenance turn).
 * finalize writes the terminal snapshot itself and cancels what is pending.
 */

export interface CheckpointPacing {
  /** The interval between two checkpoints of a turn is between these. */
  minIntervalMs: number;
  maxIntervalMs: number;
  /** How long an event may wait on a write still in flight before the next is written anyway. */
  maxDirtyMs: number;
}

/** The rewrite rate the interval keeps a turn under, once past the minimum interval. */
export const CHECKPOINT_BYTES_PER_SECOND = 256 * 1024;

export const TURN_CHECKPOINT_PACING: Readonly<CheckpointPacing> = {
  minIntervalMs: 1_500,
  maxIntervalMs: 5_000,
  maxDirtyMs: 5_000,
};

/**
 * Pages maintenance turns: nobody watches them stream, and they read many
 * pages (346 KB rows at p50, 91 checkpoints a turn at p50 in the audit).
 */
export const MAINTENANCE_CHECKPOINT_PACING: Readonly<CheckpointPacing> = {
  minIntervalMs: 5_000,
  maxIntervalMs: 10_000,
  maxDirtyMs: 10_000,
};

/** The interval after a write of `lastBytes` (unknown before the first). */
export function checkpointIntervalMs(lastBytes: number | null, pacing: Readonly<CheckpointPacing>): number {
  const byRate = ((lastBytes ?? 0) / CHECKPOINT_BYTES_PER_SECOND) * 1_000;
  return Math.min(pacing.maxIntervalMs, Math.max(pacing.minIntervalMs, byRate));
}

/**
 * Reads the turn's snapshot and writes it. Resolves the bytes written, or
 * null when unknown or nothing was written; a failure is the writer's to
 * report, and is not retried until another event dirties the turn.
 */
export type CheckpointWrite = () => number | null | PromiseLike<number | null>;

export class TurnCheckpointScheduler {
  /** When the oldest event not yet in a written checkpoint was applied. */
  private dirtySince: number | null = null;
  private soon = false;
  private inFlight = 0;
  private lastWriteAt: number;
  private lastBytes: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private immediate: ReturnType<typeof setImmediate> | null = null;
  private cancelled = false;

  /** `startedAt`: when the turn's begin was written, which starts the first interval. */
  constructor(
    private readonly write: CheckpointWrite,
    private readonly pacing: Readonly<CheckpointPacing>,
    startedAt: number,
  ) {
    this.lastWriteAt = startedAt;
  }

  /** An event changed the turn's snapshot; `soon` writes it on the next tick. */
  markDirty(soon = false): void {
    if (this.cancelled) return;
    this.dirtySince ??= Date.now();
    if (soon) this.soon = true;
    this.arm();
  }

  /** Nothing pending is written after this, and later events write nothing. */
  cancel(): void {
    this.cancelled = true;
    this.dirtySince = null;
    this.soon = false;
    this.clearTimers();
  }

  private dueAt(now: number, dirtySince: number): number {
    const forcedAt = dirtySince + this.pacing.maxDirtyMs;
    if (this.inFlight > 0) return forcedAt;
    if (this.soon) return now;
    return Math.min(this.lastWriteAt + checkpointIntervalMs(this.lastBytes, this.pacing), forcedAt);
  }

  private arm(): void {
    if (this.cancelled || this.dirtySince === null) return;
    const now = Date.now();
    const dueAt = this.dueAt(now, this.dirtySince);
    if (dueAt <= now) {
      this.immediate ??= setImmediate(this.fire);
      return;
    }
    if (this.timer && this.timerAt <= dueAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = dueAt;
    this.timer = setTimeout(this.fire, dueAt - now);
    // A turn left streaming must not keep the process alive.
    this.timer.unref?.();
  }

  private readonly fire = (): void => {
    this.clearTimers();
    if (this.cancelled || this.dirtySince === null) return;
    const now = Date.now();
    if (this.dueAt(now, this.dirtySince) > now) {
      this.arm();
      return;
    }
    this.dirtySince = null;
    this.soon = false;
    this.lastWriteAt = now;
    this.inFlight += 1;
    let written: ReturnType<CheckpointWrite>;
    try {
      written = this.write();
    } catch {
      written = null;
    }
    if (written !== null && typeof written === 'object' && typeof written.then === 'function') {
      written.then((bytes) => this.settle(bytes), () => this.settle(null));
    } else {
      this.settle(written as number | null);
    }
  };

  private settle(bytes: number | null): void {
    this.inFlight -= 1;
    if (typeof bytes === 'number') this.lastBytes = bytes;
    this.arm();
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.immediate) clearImmediate(this.immediate);
    this.timer = null;
    this.immediate = null;
  }
}
