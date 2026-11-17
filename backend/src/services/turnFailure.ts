/**
 * What kind of failure ended a turn, from what the turn row and its error
 * frame keep (the message and the stream's code): one reading of the three
 * classifiers Michi already has, for code that decides whether trying again
 * by itself is worthwhile (services/autoContinue.ts).
 *
 * - restart: Michi restarted under the turn (BACKEND_RESTARTED_ERROR).
 * - credentials: signed out, or the credentials expired or were refused
 *   (turnInterruptionCause, the sign-in reasons of classifyMetaAgentRunError,
 *   Kiro's auth class). Only the user clears these up.
 * - quota: a usage or rate limit (classifyMetaAgentRunError).
 * - transient / connection: Kiro's retryable classes (classifyAcpError), or
 *   the stream's `connection` code.
 * - other: anything else, a missing runtime included.
 */

import { BACKEND_RESTARTED_ERROR, turnInterruptionCause } from 'michi-shared';
import { classifyAcpError } from 'michi-runtime/internal/adapters/kiro/acpErrors';
import { classifyMetaAgentRunError } from './metaAgent/stopReason';

export type TurnFailureKind = 'restart' | 'credentials' | 'quota' | 'transient' | 'connection' | 'other';

export function classifyTurnFailure(error: string | null | undefined, code?: string | null): TurnFailureKind {
  if (error === BACKEND_RESTARTED_ERROR || code === BACKEND_RESTARTED_ERROR) return 'restart';
  const text = error ?? '';
  if (turnInterruptionCause(text, code) === 'credentials') return 'credentials';
  const run = classifyMetaAgentRunError(text, { runtimeId: '', workspaceName: '' }).reason;
  if (run === 'signed-out') return 'credentials';
  if (run === 'runtime-missing') return 'other';
  if (run === 'quota') return 'quota';
  const acp = classifyAcpError(text);
  if (acp === 'auth') return 'credentials';
  if (acp === 'transient' || acp === 'connection') return acp;
  return code === 'connection' ? 'connection' : 'other';
}
