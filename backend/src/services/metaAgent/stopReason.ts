/**
 * Why a Meta agent maintenance run failed, in plain words. A run's error
 * reaches the scheduler only as text (the turn row keeps the message, not the
 * error class or the stream frame's code), so the reason is read from the
 * messages the runtimes and Michi's own maintenance reader already produce.
 * Anything not recognized is `other` with the error's first line.
 */

import type { MetaAgentStopReason } from 'michi-shared';
import { classifyAcpError } from 'michi-runtime/internal/adapters/kiro/acpErrors';
import { KIRO_QUOTA_MARKERS } from 'michi-runtime/internal/adapters/kiro/kiroErrorMarkers';

const LABELS: Readonly<Record<string, string>> = { claude: 'Claude', pi: 'Pi', codex: 'Codex', kiro: 'Kiro', crew: 'Crew' };

export const runtimeLabel = (runtimeId: string): string => LABELS[runtimeId] ?? runtimeId;

/** The suffix the scheduler adds when it stops a job after repeated failures. */
const AUTO_PAUSE_SUFFIX = /\.? Paused after \d+ failed runs in a row\.$/;

// Codex and Claude binary lookups, Kiro's install probe, a spawn of a missing
// executable, the Crew adapter placeholder.
const MISSING = [/\bbinary not found\b/, /\bkiro-cli not found\b/, /\bspawn \S+ enoent\b/, /\bcommand not found\b/, /\bacp adapter not found\b/];

// Claude and Codex auth pre-flights, Pi's provider key check, the CLIs' own
// login prompts and HTTP 401s. Kiro's SSO markers come from classifyAcpError.
const SIGNED_OUT = [
  /\bno (claude|codex) auth found\b/, /\bnot (logged|signed) in\b/, /\bplease (run )?\/?login\b/, /\brun `?(claude|codex) \/?login/,
  /\binvalid api key\b/, /\bapi key not (configured|set)\b/, /\bauthentication_error\b/, /\boauth token (has )?expired\b/,
  /\bunauthori[sz]ed\b/, /\b401\b/,
];

// Signed in, but the provider rejected the credentials: Claude's own
// authentication failure (claudeAuthRetry.ts), Bedrock's expired or invalid
// security token.
const REJECTED = [/\bauthentication failed\b/, /\bsecurity token\b.*\b(expired|invalid)\b/, /\bexpiredtoken/];

// Claude's usage-limit message, Codex's usageLimitExceeded, Kiro's
// throttling, generic HTTP 429s; Kiro's request counters are its quota markers.
// A run that still fails throttled has met a rate limit, though classifyAcpError
// retries throttling as transient.
const QUOTA = [
  /\busage limit\b/, /\busagelimitexceeded\b/, /\brate.?limit/, /\bquota\b/, /\btoo many requests\b/, /\b429\b/, /\bthrottl/,
];

// The maintenance reader's own errors for a batch it cannot read.
const UNREADABLE = [/\bno longer readable\b/, /\btoo large or unavailable\b/];

const MAX_LINE = 200;

/** The first non-empty line of an error, without the scheduler's auto-pause suffix. */
export function errorFirstLine(error: string): string {
  const line = error.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  const trimmed = line.replace(AUTO_PAUSE_SUFFIX, '').trim();
  return trimmed.length > MAX_LINE ? `${trimmed.slice(0, MAX_LINE - 1)}…` : trimmed;
}

const matches = (text: string, patterns: readonly RegExp[]) => patterns.some((pattern) => pattern.test(text));

/** The runtime an install or sign-in error names, when it names one. */
function runtimeIn(text: string): string | null {
  const named = /\b(codex|claude) (binary not found|auth found)\b/.exec(text);
  if (named) return named[1];
  if (text.includes('kiro-cli')) return 'kiro';
  if (text.includes('kiro crew acp adapter')) return 'crew';
  return null;
}

export interface ClassifiedRunError {
  reason: Exclude<MetaAgentStopReason, 'runtime-unsupported' | 'restriction-check'>;
  message: string;
  firstLine: string;
}

/**
 * `runtimeId` is the runtime the Meta agent resolves now; an error that names
 * another runtime (it failed before the setting changed) is reported with that one.
 */
export function classifyMetaAgentRunError(error: string, input: { runtimeId: string; workspaceName: string }): ClassifiedRunError {
  const firstLine = errorFirstLine(error) || 'The run stopped without an error message';
  const text = error.toLowerCase();
  const label = runtimeLabel(runtimeIn(text) ?? input.runtimeId);
  if (matches(text, MISSING)) return { reason: 'runtime-missing', message: `${label} is not installed on this computer`, firstLine };
  if (matches(text, SIGNED_OUT) || classifyAcpError(error) === 'auth') {
    const message = /\bapi key not (configured|set)\b/.test(text) ? `${label} has no API key set up` : `${label} is not signed in`;
    return { reason: 'signed-out', message, firstLine };
  }
  if (matches(text, REJECTED)) return { reason: 'signed-out', message: `${label}'s credentials were rejected`, firstLine };
  if (matches(text, QUOTA) || KIRO_QUOTA_MARKERS.some((marker) => text.includes(marker))) return { reason: 'quota', message: `${label} reached its usage or rate limit`, firstLine };
  if (matches(text, UNREADABLE)) return { reason: 'needs-attention', message: `A conversation in ${input.workspaceName} could not be read`, firstLine };
  return { reason: 'other', message: firstLine, firstLine };
}

/**
 * Whether a run failed on sign-in or credentials (`signed-out` above). That
 * clears up outside Michi, by a refreshed credential or a new login, so a
 * maintenance execution stopped by it is tried again (maintenanceCoordinator.ts).
 */
export function isSignInFailure(error: string | null | undefined): boolean {
  return !!error && classifyMetaAgentRunError(error, { runtimeId: '', workspaceName: '' }).reason === 'signed-out';
}
