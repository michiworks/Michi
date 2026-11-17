/**
 * How a finished turn ended when it did not finish its answer: the user
 * stopped it, or it completed early (its output or step limit, or the agent
 * declining). The shared projection writes the mark on the turn's assistant
 * message (`DurableMessageMetadata.turnEnd`) when its `done` frame says so,
 * so a reload reads what the live stream showed.
 *
 * Also here: what Michi's automatic continuation of such a turn records on
 * the user message it sends (`DurableMessageMetadata.autoContinue`, backend
 * services/autoContinue.ts).
 */

export type TurnEndMark = 'stopped' | 'max_tokens' | 'max_turn_requests' | 'refusal';

const TURN_END_MARKS: readonly TurnEndMark[] = ['stopped', 'max_tokens', 'max_turn_requests', 'refusal'];

/** Turns that completed without finishing their work, as Michi words them everywhere it lists them. */
export const TURN_ENDED_EARLY: Readonly<Record<Exclude<TurnEndMark, 'stopped'>, string>> = Object.freeze({
  max_tokens: 'Stopped early: it reached its output limit',
  max_turn_requests: 'Stopped early: it reached its step limit',
  refusal: 'Stopped: the agent declined to continue',
});

/** The mark a `done` frame's stop reason leaves; undefined for a turn that finished. */
export function turnEndMarkOf(stopReason: string | null | undefined): TurnEndMark | undefined {
  if (stopReason === 'cancel' || stopReason === 'cancelled') return 'stopped';
  return stopReason === 'max_tokens' || stopReason === 'max_turn_requests' || stopReason === 'refusal' ? stopReason : undefined;
}

export function parseTurnEndMark(value: unknown): TurnEndMark | undefined {
  return (TURN_END_MARKS as readonly unknown[]).includes(value) ? value as TurnEndMark : undefined;
}

/** The line under an answer that carries a mark. */
export function turnEndNote(mark: TurnEndMark): string {
  return mark === 'stopped' ? 'Stopped' : TURN_ENDED_EARLY[mark];
}

/** Why Michi continued a turn by itself: an early stop, or a failure that clears up on its own. */
export type AutoContinueReason = 'max_tokens' | 'max_turn_requests' | 'transient' | 'connection' | 'quota';

const AUTO_CONTINUE_REASONS: readonly AutoContinueReason[] = ['max_tokens', 'max_turn_requests', 'transient', 'connection', 'quota'];

/** On a user message Michi sent to continue the turn before it: which continuation in a row it is, and why. */
export interface AutoContinueSource {
  /** 1 for the first continuation since the user last wrote. */
  n: number;
  /** The most there may be in a row. */
  of: number;
  reason: AutoContinueReason;
  /** The turn it continued. */
  fromTurnId: string;
}

export function parseAutoContinueSource(value: unknown): AutoContinueSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { n, of, reason, fromTurnId } = value as Record<string, unknown>;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || typeof of !== 'number' || !Number.isInteger(of) || of < n) return undefined;
  if (!(AUTO_CONTINUE_REASONS as readonly unknown[]).includes(reason) || typeof fromTurnId !== 'string' || !fromTurnId) return undefined;
  return { n, of, reason: reason as AutoContinueReason, fromTurnId };
}

/** The first line of an automatic continuation's message, e.g. `[auto-continue 1/3 · max_tokens]`. */
export function autoContinueLabel(source: Pick<AutoContinueSource, 'n' | 'of' | 'reason'>): string {
  return `[auto-continue ${source.n}/${source.of} · ${source.reason}]`;
}
