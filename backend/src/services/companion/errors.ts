/**
 * A refusal the Companion's storage or validation gives a caller: routes
 * answer `{ error, code }` with `status`; tools turn it into a tool error.
 * Anything else thrown is a bug and answers 500.
 */

export type CompanionErrorCode =
  | 'invalid_request'
  | 'invalid_settings'
  | 'not_found'
  | 'limit_reached'
  | 'card_not_pending'
  | 'card_expired'
  | 'companion_busy'
  /** This process does not hold the scheduler lease, so it does not run the Companion (R2.14). */
  | 'not_owner'
  /** companion_save_notes passed a notes revision that is no longer current (R2.9). */
  | 'notes_conflict'
  /** A fired or cancelled reminder cannot be paused or resumed. */
  | 'reminder_closed'
  /** Get started's workspace homes need scheduled jobs, which are off in this backend (MICHI_SCHEDULED_JOBS=0). */
  | 'scheduler_off';

export class CompanionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: CompanionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompanionError';
  }
}

export const invalidRequest = (message: string) => new CompanionError(400, 'invalid_request', message);
export const notFound = (message: string) => new CompanionError(404, 'not_found', message);
export const limitReached = (message: string) => new CompanionError(409, 'limit_reached', message);

/**
 * What CompanionService.checkNow throws in a process that does not hold the
 * scheduler lease (another Michi process runs the Companion): the route
 * answers 409 `not_owner`.
 */
export const notOwner = () => new CompanionError(409, 'not_owner', 'Another Michi process runs the Companion on this computer; check from there');

export const notesConflict = () => new CompanionError(409, 'notes_conflict', 'notes changed; read them again');
