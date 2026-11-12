import { getDb } from '../db';

/**
 * The send_to_thread wake records (thread_message_wakes, migration 0065) as
 * the attention service reads them, to tell a hand-off in a wake chain from
 * its end (attentionService.ts). Read only, and only the table's columns:
 * services/threadMessageWakeStore.ts owns the records, agents/
 * threadMessageWakes.ts delivers them.
 *
 * A wake record is keyed by the target's turn for the message
 * (target_turn_id), names the sender's turn that asked for it
 * (caller_turn_id, when known) and the sender's reply turn it starts
 * (requested_turn_id). pending and delivering are open; delivered means the
 * reply turn began; undeliverable means it never will.
 */

/** Wakes come back at most THREAD_WAKE_MAX_HOPS hand-offs from a person; this bounds a corrupt chain. */
const MAX_CHAIN_STEPS = 16;

export class AttentionWakeFacts {
  /** The turn asked for a wake that is still open: its chain goes on with the reply turn. */
  registeredOpenWake(nodeId: string, turnId: string): boolean {
    // The open-wake partial index (idx_thread_message_wakes_open) bounds this to the open rows.
    return !!getDb().prepare(`SELECT 1 FROM thread_message_wakes
      WHERE state IN ('pending', 'delivering') AND caller_node_id = ? AND caller_turn_id = ? LIMIT 1`).get(nodeId, turnId);
  }

  /** The turn answers a message sent with wake, and its reply is on its way to the sender (or there). */
  answersWake(turnId: string): boolean {
    const row = getDb().prepare('SELECT state FROM thread_message_wakes WHERE target_turn_id = ?').get(turnId) as
      { state: string } | undefined;
    return row?.state === 'pending' || row?.state === 'delivering' || row?.state === 'delivered';
  }

  /**
   * For a woken reply turn, the turn that began its chain: the first sender's
   * turn, before any reply. Null for a turn that is no wake's reply, or when a
   * record in the chain could not name the turn that asked for it.
   */
  chainOrigin(turnId: string): string | null {
    const step = getDb().prepare('SELECT caller_turn_id FROM thread_message_wakes WHERE requested_turn_id = ?');
    let origin: string | null = null;
    let current = turnId;
    for (let steps = 0; steps < MAX_CHAIN_STEPS; steps += 1) {
      const row = step.get(current) as { caller_turn_id: string | null } | undefined;
      if (!row) return origin;
      if (!row.caller_turn_id) return null;
      origin = row.caller_turn_id;
      current = origin;
    }
    return null;
  }
}
