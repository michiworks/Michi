/**
 * Turns that stopped before they finished for a reason outside the task:
 * Michi restarted (an update, a crash, the host going away) or the agent's
 * credentials expired (a Auth session lapsing). Such a turn is carried on
 * with Resume, a continuation prompt over its kept partial output, rather
 * than run again: its tool calls may already have taken effect.
 *
 * Backend routes (mounted under /api):
 *   GET  /interrupted-turns                  -> InterruptedTurnsDto
 *   POST /interrupted-turns/:turnId/dismiss  -> { dismissed: true }
 */

import { BACKEND_RESTARTED_ERROR } from './turnErrors';

export type TurnInterruptionCause = 'restart' | 'credentials';

/**
 * Failures that mean the agent's credentials expired or were refused, as the
 * runtimes word them: Claude's authentication_failed retry, Kiro's SSO token
 * exceptions, and the AWS SDK's (Bedrock through Codex or Pi) refused or
 * unloadable credentials.
 */
const CREDENTIAL_FAILURE = new RegExp([
  'authentication failed',
  'expiredtoken',
  'invalidgrantexception',
  'unauthorizedclientexception',
  'security token included in the request is (?:expired|invalid)',
  'failed to load aws credentials',
  'credential export command',
  '\\b403 forbidden\\b[^\\n]*assumed-role',
  'credentials? (?:have|has)? ?expired',
  'not (?:logged|signed) in',
].join('|'), 'i');

/**
 * Why a failed turn counts as interrupted, from its stored error (the
 * `turns.error` marker or message) and, on the live stream, its error code;
 * null for an ordinary failure.
 */
export function turnInterruptionCause(error: string | null | undefined, code?: string | null): TurnInterruptionCause | null {
  if (error === BACKEND_RESTARTED_ERROR || code === BACKEND_RESTARTED_ERROR) return 'restart';
  if (code === 'auth') return 'credentials';
  return error && CREDENTIAL_FAILURE.test(error) ? 'credentials' : null;
}

export interface InterruptedTurnV1 {
  turnId: string;
  nodeId: string;
  workspaceId: string;
  workspaceName: string;
  /** The thread title, or its first request when it has none. */
  title: string;
  /** When the turn stopped. */
  interruptedAt: number;
}

export interface InterruptedTurnsDto {
  items: InterruptedTurnV1[];
}

/** How far back a reminder reaches, and how many it lists. */
export const INTERRUPTED_TURN_LIMITS = { maxAgeMs: 7 * 24 * 60 * 60_000, items: 50 } as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseItem(raw: unknown): InterruptedTurnV1 | null {
  if (!isObject(raw)) return null;
  const { turnId, nodeId, workspaceId, workspaceName, title, interruptedAt } = raw;
  if (typeof turnId !== 'string' || !turnId || typeof nodeId !== 'string' || !nodeId
    || typeof workspaceId !== 'string' || !workspaceId) return null;
  if (typeof interruptedAt !== 'number' || !Number.isFinite(interruptedAt)) return null;
  return {
    turnId, nodeId, workspaceId, interruptedAt,
    workspaceName: typeof workspaceName === 'string' ? workspaceName : '',
    title: typeof title === 'string' ? title : '',
  };
}

/** Reads a GET /interrupted-turns body; malformed items are left out. */
export function parseInterruptedTurns(raw: unknown): InterruptedTurnsDto {
  const items = isObject(raw) && Array.isArray(raw.items) ? raw.items : [];
  return { items: items.map(parseItem).filter((item): item is InterruptedTurnV1 => item !== null) };
}
