/**
 * Machine-readable turn error codes: the `code` of a refused send or replay,
 * of a stream `error` frame, and a node's errorKind. Whether a code means the
 * turn never began decides whether Retry may run the prompt again.
 */
export const TURN_ERROR_CODES = {
  /** 409 on send: another turn owns the chat and this one never began; resend the same request. */
  active: 'turn_active',
  /** The send was refused before its turn began. */
  beginFailed: 'turn_begin_failed',
  /** The turn ID already has a receipt: the turn began, so it is not run again. */
  alreadyBegan: 'turn_already_began',
  persistenceFailed: 'turn_persistence_failed',
  replayUnavailable: 'turn_replay_unavailable',
  /** `turns.error` too: a Michi restart cut the turn short. */
  backendRestarted: 'backend_restarted',
  /** Client-only: the renderer could not confirm whether the turn ran. */
  outcomeUnknown: 'turn_outcome_unknown',
} as const;

export type TurnErrorCode = typeof TURN_ERROR_CODES[keyof typeof TURN_ERROR_CODES];

/** `turns.error` and the stream error `code` of a turn a Michi restart cut short. */
export const BACKEND_RESTARTED_ERROR = TURN_ERROR_CODES.backendRestarted;

/** The one sentence shown for a turn a restart cut short, live or after a reload. */
export const BACKEND_RESTARTED_MESSAGE =
  'Michi restarted while this task was running. Review the partial output above, then resume.';
