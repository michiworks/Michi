import type { DurableTurnSnapshot } from 'michi-shared';
import { prepareCached, runInTransaction } from '../db';
import { BACKEND_RESTARTED_ERROR } from '../turnPersistence.recipes';
import { mainThreadDb } from '../turnPersistence.mainAdapter';
import { coreBeginTurn, coreCheckpointTurn, coreFinalizeTurn } from '../turnPersistence.core';
import type { MessageRow } from './messages';

// ── Turn lifecycle — delegated to turnPersistence.core ──────────────────────
//
// The business logic lives in turnPersistence.core.ts. This file provides
// the main-thread adapter (DbPrimitives over prepareCached / runInTransaction)
// and thin wrappers that preserve the existing export signatures.

export interface TurnRow {
  turn_id: string;
  node_id: string;
  user_message_id: string | null;
  assistant_message_id: string;
  status: DurableTurnSnapshot['status'];
  last_seq: number;
  stop_reason: string | null;
  error: string | null;
  started_at: number;
  checkpoint_at: number | null;
  completed_at: number | null;
  completion_seq: number | null;
  updated_at: number;
}

/** Insert deterministic provisional messages and the turn receipt atomically. */
export function beginTurn(snapshot: DurableTurnSnapshot): TurnRow {
  return coreBeginTurn(mainThreadDb, snapshot) as unknown as TurnRow;
}

/** Persist a bounded partial snapshot without marking the turn terminal. */
export function checkpointTurn(snapshot: DurableTurnSnapshot): TurnRow {
  return coreCheckpointTurn(mainThreadDb, snapshot) as unknown as TurnRow;
}

/** Atomically materialize the canonical terminal snapshot before SSE success. */
export function finalizeTurn(snapshot: DurableTurnSnapshot): TurnRow {
  return coreFinalizeTurn(mainThreadDb, snapshot) as unknown as TurnRow;
}

/** One turn receipt of this node and its stored assistant row, owner-scoped
 *  like listMessages. Read when the turn's live replay is gone. */
export function getSavedTurn(
  nodeId: string,
  turnId: string,
  userId?: string,
): { turn: TurnRow; message: MessageRow | null } | null {
  const turn = (process.env.MICHI_CLOUD === '1' && userId !== undefined
    ? prepareCached(`SELECT t.* FROM turns t JOIN nodes n ON t.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id
        WHERE t.node_id = ? AND t.turn_id = ? AND w.owner_user_id = ?`).get(nodeId, turnId, userId)
    : prepareCached('SELECT * FROM turns WHERE node_id = ? AND turn_id = ?').get(nodeId, turnId)) as TurnRow | undefined;
  if (!turn) return null;
  const message = prepareCached('SELECT * FROM messages WHERE id = ? AND node_id = ?')
    .get(turn.assistant_message_id, nodeId) as MessageRow | undefined;
  return { turn, message: message ?? null };
}

/** Newest turn first: by start, then by last write when two started at once. */
export const LATEST_TURN_ORDER = 't.started_at DESC, t.updated_at DESC';

/** This node's newest turn receipt, or its newest with `status`; owner-scoped like getSavedTurn. */
export function getLatestTurn(nodeId: string, userId?: string, status?: TurnRow['status']): TurnRow | null {
  const statusClause = status === undefined ? '' : ' AND t.status = ?';
  const statusArgs = status === undefined ? [] : [status];
  const row = process.env.MICHI_CLOUD === '1' && userId !== undefined
    ? prepareCached(`SELECT t.* FROM turns t JOIN nodes n ON t.node_id = n.id JOIN workspaces w ON n.workspace_id = w.id
        WHERE t.node_id = ? AND w.owner_user_id = ?${statusClause} ORDER BY ${LATEST_TURN_ORDER} LIMIT 1`).get(nodeId, userId, ...statusArgs)
    : prepareCached(`SELECT t.* FROM turns t WHERE t.node_id = ?${statusClause} ORDER BY ${LATEST_TURN_ORDER} LIMIT 1`)
      .get(nodeId, ...statusArgs);
  return (row as TurnRow | undefined) ?? null;
}

/**
 * Mark checkpointed turns left active by a previous process as interrupted.
 *
 * The receipt gets the same restart marker `chatHub.persistError` writes when
 * the shutdown path finalizes before the database closes. `last_seq` stays at
 * the last checkpoint: after a restart no stream frame of the turn exists to
 * name, and readers of an error receipt (the hydration summary, the saved-turn
 * read) do not use it.
 */
export function recoverInterruptedTurns(now = Date.now(), preserveTurnIds: ReadonlySet<string> = new Set()): number {
  return runInTransaction(() => {
    const active = prepareCached("SELECT turn_id, node_id FROM turns WHERE status = 'active'")
      .all() as Array<{ turn_id: string; node_id: string }>;
    const interrupted = active.filter((turn) => !preserveTurnIds.has(turn.turn_id));
    if (interrupted.length === 0) return 0;
    const updateTurn = prepareCached(`UPDATE turns
      SET status = 'error', error = ?, completed_at = ?, updated_at = ?
      WHERE turn_id = ? AND status = 'active'`);
    const updateNode = prepareCached(`
      UPDATE nodes SET status = 'error' WHERE id = ? AND status = 'streaming'
    `);
    for (const turn of interrupted) {
      updateTurn.run(BACKEND_RESTARTED_ERROR, now, now, turn.turn_id);
      updateNode.run(turn.node_id);
    }
    return interrupted.length;
  });
}
