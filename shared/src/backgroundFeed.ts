/**
 * A background feed cursor (POST /chats/background/subscribe) names the last
 * turn a window applied for a chat: `{ turnId, seq }`.
 *
 * A window also sends this cursor for every chat it knows without an applied
 * turn. Without it the server could not tell such a chat's first turn, which
 * may have started, ended and left the in-memory replay ring while the window
 * was away, from a chat that never ran: with it, the server answers with a
 * replay gap whenever SQLite holds a turn for that chat.
 */
export const NO_APPLIED_TURN_CURSOR: Readonly<{ turnId: string; seq: number }> = Object.freeze({ turnId: '', seq: -1 });

export function isNoAppliedTurnCursor(cursor: { turnId: unknown; seq: unknown }): boolean {
  return cursor.turnId === NO_APPLIED_TURN_CURSOR.turnId && cursor.seq === NO_APPLIED_TURN_CURSOR.seq;
}
