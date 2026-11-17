import { BACKEND_RESTARTED_ERROR, buildContinuationPrompt, turnInterruptionCause, type TurnEndMark, type TurnInterruptionCause } from 'michi-shared';
import { assistantAnswerVisibleText } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';

/** The stream error code and `turns.error` marker of a turn a Michi restart cut short. */
export const BACKEND_RESTARTED_KIND = BACKEND_RESTARTED_ERROR;

/**
 * The error kind of a turn the agent's credentials expiring cut short (an
 * expired Auth session, say), classified from its message: the stored
 * receipt keeps only the text, and runtimes word it their own way.
 */
export const CREDENTIALS_EXPIRED_KIND = 'credentials_expired';

/** A turn's error kind, with a credentials failure the stream sent no code for named as one. */
export function classifiedErrorKind(code: string | undefined, message: string): string | undefined {
  if (code) return code;
  return turnInterruptionCause(message) === 'credentials' ? CREDENTIALS_EXPIRED_KIND : undefined;
}

/** Why the node's last turn was interrupted, from its error kind; null when it was not. */
export function interruptionCauseOfKind(errorKind: string | undefined): TurnInterruptionCause | null {
  if (errorKind === BACKEND_RESTARTED_KIND) return 'restart';
  return errorKind === CREDENTIALS_EXPIRED_KIND || errorKind === 'auth' ? 'credentials' : null;
}

export { BACKEND_RESTARTED_MESSAGE } from 'michi-shared';

/** The user rows a Resume and a Continue land as; the wire text is the continuation prompt. */
const RESUME_DISPLAY_TEXT = 'Resume the interrupted turn';
const CONTINUE_DISPLAY_TEXT = 'Continue';

/**
 * The prompt a Resume sends after a restart (or expired credentials) cut the
 * last turn short, and a Continue after a turn the user stopped or that hit a
 * limit (its message's turnEnd mark). The shared builder restores what the
 * agent session may be missing and asks for a continuation: never re-run
 * finished steps, never assume progress. Returns null when the transcript
 * holds no request to carry on with.
 */
export function buildResumePrompt(
  messages: ChatMessage[],
  cause: TurnInterruptionCause | TurnEndMark = 'restart',
): { text: string; displayText: string } | null {
  const interrupted = cause === 'restart' || cause === 'credentials';
  const text = buildContinuationPrompt(messages.map((m) => ({
    role: m.role,
    text: m.role === 'user' ? m.text : assistantAnswerVisibleText(m),
    steered: m.steered,
    autoContinue: m.autoContinue !== undefined,
    toolCalls: m.toolCalls,
  })), cause, interrupted ? 'resume' : 'continue');
  return text === null ? null : { text, displayText: interrupted ? RESUME_DISPLAY_TEXT : CONTINUE_DISPLAY_TEXT };
}
