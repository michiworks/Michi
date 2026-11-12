/**
 * Storage for send_to_thread wakes (migration 0065) and the turn facts the
 * delivery reads. The delivery itself lives in agents/threadMessageWakes.ts.
 *
 * A record is keyed by the target turn its message started and carries the
 * sender's reply turn id. State moves pending -> delivering (claimed once,
 * compare-and-set) -> delivered | undeliverable. A delivery that cannot
 * finish now hands its claim back (delivering -> pending) for the next
 * startup: this process is shutting down, or the sender's session did not
 * open or its turn did not begin. The last two count an attempt, and at the
 * delivery's limit the record is undeliverable instead.
 */
import { parseThreadMessageSource, userTurnAssistantId } from 'michi-shared';
import { getDb } from './db';

export type ThreadWakeState = 'pending' | 'delivering' | 'delivered' | 'undeliverable';

export interface ThreadWakeRecord {
  targetTurnId: string;
  requestedTurnId: string;
  /** The sending session's owner as its own turns record it (null on desktop). */
  ownerUserId: string | null;
  /** The sender's workspace. */
  workspaceId: string;
  callerNodeId: string;
  /** The sender's turn that asked for the wake, when it could be identified. */
  callerTurnId: string | null;
  targetNodeId: string;
  /** The reply turn's hop (ThreadMessageSource.hop). */
  hop: number;
  state: ThreadWakeState;
  detail: string | null;
  /** Deliveries that failed in a way a later startup may get past. */
  attempts: number;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

export type NewThreadWake = Pick<ThreadWakeRecord,
  'targetTurnId' | 'requestedTurnId' | 'ownerUserId' | 'workspaceId' | 'callerNodeId' | 'callerTurnId' | 'targetNodeId' | 'hop'>;

interface WakeRow {
  target_turn_id: string;
  requested_turn_id: string;
  owner_user_id: string | null;
  workspace_id: string;
  caller_node_id: string;
  caller_turn_id: string | null;
  target_node_id: string;
  hop: number;
  state: ThreadWakeState;
  detail: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

function toRecord(row: WakeRow): ThreadWakeRecord {
  return {
    targetTurnId: row.target_turn_id,
    requestedTurnId: row.requested_turn_id,
    ownerUserId: row.owner_user_id,
    workspaceId: row.workspace_id,
    callerNodeId: row.caller_node_id,
    callerTurnId: row.caller_turn_id,
    targetNodeId: row.target_node_id,
    hop: row.hop,
    state: row.state,
    detail: row.detail,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

/** Records a pending wake. Throws if the target turn already has one. */
export function createThreadWake(input: NewThreadWake, now = Date.now()): ThreadWakeRecord {
  getDb().prepare(`INSERT INTO thread_message_wakes (target_turn_id, requested_turn_id, owner_user_id, workspace_id,
      caller_node_id, caller_turn_id, target_node_id, hop, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(
    input.targetTurnId, input.requestedTurnId, input.ownerUserId, input.workspaceId,
    input.callerNodeId, input.callerTurnId, input.targetNodeId, input.hop, now, now,
  );
  return getThreadWake(input.targetTurnId)!;
}

export function getThreadWake(targetTurnId: string): ThreadWakeRecord | null {
  const row = getDb().prepare('SELECT * FROM thread_message_wakes WHERE target_turn_id = ?')
    .get(targetTurnId) as WakeRow | undefined;
  return row ? toRecord(row) : null;
}

/** pending -> delivering. True for exactly one caller. */
export function claimThreadWake(targetTurnId: string, now = Date.now()): boolean {
  return getDb().prepare(`UPDATE thread_message_wakes SET state = 'delivering', updated_at = ?
    WHERE target_turn_id = ? AND state = 'pending'`).run(now, targetTurnId).changes === 1;
}

/** An open wake's final state. False when it was already settled. */
export function settleThreadWake(
  targetTurnId: string,
  state: 'delivered' | 'undeliverable',
  detail: string | null,
  now = Date.now(),
): boolean {
  return getDb().prepare(`UPDATE thread_message_wakes
    SET state = ?, detail = ?, updated_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
    WHERE target_turn_id = ? AND state IN ('pending', 'delivering')`)
    .run(state, detail, now, state, now, targetTurnId).changes === 1;
}

/**
 * delivering -> pending, for the next startup: the claim goes back. With
 * `failure`, the delivery failed: it counts an attempt and becomes the
 * detail, and the attempt that reaches `maxAttempts` makes the record
 * undeliverable instead. Without, the delivery was only cut short (this
 * process is shutting down). The record's state afterwards; null when it was
 * not being delivered.
 */
export function releaseThreadWake(
  targetTurnId: string,
  failure: { detail: string; maxAttempts: number } | null,
  now = Date.now(),
): ThreadWakeState | null {
  const counted = failure ? 1 : 0;
  // SET expressions read the row as it was: attempts + ? is the new count.
  const changed = getDb().prepare(`UPDATE thread_message_wakes
    SET attempts = attempts + ?,
        state = CASE WHEN ? = 1 AND attempts + 1 >= ? THEN 'undeliverable' ELSE 'pending' END,
        detail = COALESCE(?, detail), updated_at = ?
    WHERE target_turn_id = ? AND state = 'delivering'`)
    .run(counted, counted, failure?.maxAttempts ?? 0, failure?.detail ?? null, now, targetTurnId).changes === 1;
  return changed ? getThreadWake(targetTurnId)?.state ?? null : null;
}

/**
 * The user stopped `turnId` (ChatHub.cancel). The wakes that turn asked for
 * (caller_turn_id) settle `caller_cancelled` unless their reply turn already
 * began; the wake of the message it was answering (target_turn_id) settles
 * `target_cancelled` unless its delivery already started. Returns how many
 * settled.
 */
export function settleStoppedTurnWakes(turnId: string, now = Date.now()): { callerCancelled: number; targetCancelled: number } {
  const db = getDb();
  const callerCancelled = Number(db.prepare(`UPDATE thread_message_wakes
    SET state = 'undeliverable', detail = 'caller_cancelled', updated_at = ?
    WHERE caller_turn_id = ? AND state IN ('pending', 'delivering')
      AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.turn_id = thread_message_wakes.requested_turn_id)`)
    .run(now, turnId).changes);
  const targetCancelled = Number(db.prepare(`UPDATE thread_message_wakes
    SET state = 'undeliverable', detail = 'target_cancelled', updated_at = ?
    WHERE target_turn_id = ? AND state = 'pending'`).run(now, turnId).changes);
  return { callerCancelled, targetCancelled };
}

/** Open (pending or delivering) wakes after `afterTargetTurnId`, in key order. */
export function listOpenThreadWakes(afterTargetTurnId: string | null, limit: number): ThreadWakeRecord[] {
  return (getDb().prepare(`SELECT * FROM thread_message_wakes
    WHERE state IN ('pending', 'delivering') AND target_turn_id > ?
    ORDER BY target_turn_id LIMIT ?`).all(afterTargetTurnId ?? '', limit) as unknown as WakeRow[]).map(toRecord);
}

/** Deletes settled wakes last changed before `before`. Returns how many. */
export function pruneSettledThreadWakes(before: number): number {
  return Number(getDb().prepare(`DELETE FROM thread_message_wakes
    WHERE state IN ('delivered', 'undeliverable') AND updated_at < ?`).run(before).changes);
}

export interface ThreadTurnReceipt {
  nodeId: string;
  status: 'active' | 'completed' | 'cancelled' | 'error';
  error: string | null;
}

/** A turn's durable receipt; null when no turn with this id began. */
export function threadTurnReceipt(turnId: string): ThreadTurnReceipt | null {
  const row = getDb().prepare('SELECT node_id, status, error FROM turns WHERE turn_id = ?').get(turnId) as
    { node_id: string; status: ThreadTurnReceipt['status']; error: string | null } | undefined;
  return row ? { nodeId: row.node_id, status: row.status, error: row.error } : null;
}

/** Earlier turns read for the hop a turn inherits; past them the hop is unknown. */
const HOP_LOOKBACK_TURNS = 200;

interface HopRow {
  turn_id: string;
  node_id: string;
  assistant_message_id: string;
  started_at: number;
  metadata: string | null;
}

/**
 * What a turn itself says about its hop: 0 when a person started it, the
 * thread message's or reply's hop when one started it (null if that message
 * carries none: an agent sent it, so the distance is unknown), and
 * undefined when it says nothing (it continues the work before it).
 *
 * ChatHub.startTurn names a turn's assistant message with userTurnAssistantId
 * and every self-turn's with selfTurnAssistantId. Only the composer route
 * (POST /message) calls startTurn, so the first is a person's turn.
 */
function ownHop(row: HopRow): number | null | undefined {
  if (row.assistant_message_id === userTurnAssistantId(row.node_id, row.turn_id)) return 0;
  let metadata: unknown = null;
  try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { /* unreadable metadata: no source */ }
  const source = metadata && typeof metadata === 'object'
    ? parseThreadMessageSource((metadata as { threadMessage?: unknown }).threadMessage)
    : undefined;
  if (source) return source.hop ?? null;
  return undefined;
}

/**
 * Where a chat's current work stands in a chain of thread messages: its
 * running turn (the one calling send_to_thread; null when none runs) and its
 * hop, the agent hand-offs since a person last started a turn here.
 *
 * Only a person's turn resets the hop to 0, and a thread message or reply
 * carries its own. Any other turn (one the runtime started by itself, such
 * as a background task finishing; an Agent Run watch; a scheduled job; the
 * Michi assistant's opening message), and a call while no turn runs, has the
 * hop of the node's latest earlier turn that says. Null when none does (or
 * none of the last HOP_LOOKBACK_TURNS): unknown, which the tool treats as
 * the limit.
 */
export function threadChainHop(nodeId: string): { turnId: string | null; hop: number | null } {
  const db = getDb();
  const running = db.prepare(`SELECT t.turn_id, t.node_id, t.assistant_message_id, t.started_at, m.metadata FROM turns t
    LEFT JOIN messages m ON m.id = t.user_message_id
    WHERE t.node_id = ? AND t.status = 'active'
    ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1`).get(nodeId) as HopRow | undefined;
  if (running) {
    const hop = ownHop(running);
    if (hop !== undefined) return { turnId: running.turn_id, hop };
  }
  // Turns without a user message say nothing, so only those with one are read.
  const earlier = db.prepare(`SELECT t.turn_id, t.node_id, t.assistant_message_id, t.started_at, m.metadata FROM turns t
    JOIN messages m ON m.id = t.user_message_id
    WHERE t.node_id = ? AND t.turn_id <> ? AND t.started_at <= ?
    ORDER BY t.started_at DESC, t.rowid DESC LIMIT ?`)
    .all(nodeId, running?.turn_id ?? '', running?.started_at ?? Number.MAX_SAFE_INTEGER, HOP_LOOKBACK_TURNS) as unknown as HopRow[];
  for (const row of earlier) {
    const hop = ownHop(row);
    if (hop !== undefined) return { turnId: running?.turn_id ?? null, hop };
  }
  return { turnId: running?.turn_id ?? null, hop: null };
}
