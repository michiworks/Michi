/**
 * Which approval rules hold for a chat's running turn (design D19, Q26,
 * lane D 2026-11-12). Michi asks by consequence (agents/callConsequence.ts):
 * this module says which turns the consequence rules apply to.
 *
 * - michiDriven: Michi, not the user, sent the turn's message: a follow-up
 *   (`companionSend`), a message relayed from another conversation
 *   (`threadMessage`), or the first message of a conversation Michi started
 *   (start_conversation notes it before the turn starts, and a followed
 *   delegation the user has not written in says so durably). These are the
 *   "work conversations": local, undoable work runs without asking whatever
 *   the chat's mode; whatever leaves the machine asks, even in Trust or YOLO.
 * - outsideContent: the turn holds Companion material (turnTrust
 *   activeCompanionTaint: its own reads, or what its live session took in
 *   earlier), or read web pages, another MCP server's results or content
 *   passed in from another conversation. Its own shell output does not count:
 *   turn trust records every command's output as outside content, and the
 *   rule would then hold for nearly every turn. In such a turn whatever
 *   leaves the machine asks, even in Trust or YOLO; everything else follows
 *   the chat's mode.
 * - outsideSourced: a Michi-driven conversation that started from content
 *   someone else wrote (Companion material, or content passed in with a
 *   message from a turn that held outside content): network reads and
 *   credential reads ask too. Sticky for the conversation.
 * - background: a check-in's own turn (a check-in node, however the
 *   scheduler's lane or the coordinator started it: check-ins and the work
 *   heartbeat). Nobody is there to answer, so whatever leaves the machine,
 *   or Michi cannot read, or reads credentials is refused rather than asked
 *   (permissionPolicy.backgroundRefusal); its closed toolset holds no such
 *   tool, and its name and settings tools refuse a turn that is not the
 *   user's (companion/tools.ts requireUserTurn).
 *
 * Never throws: a read that fails counts as guarded (fail closed).
 */

import type { DatabaseSync } from 'node:sqlite';
import { activeCompanionTaint, activeTurnTrust, getTurnTrust, recordUntrustedSource, turnTaintOf, type TrustSource, type TurnRef } from './turnTrust';
import { openDbOrNull } from './db';
import { assistantPurposeOf } from '../assistant/identity';
import { log } from './logger';

export interface TurnGuard {
  michiDriven: boolean;
  outsideContent: boolean;
  outsideSourced: boolean;
  background: boolean;
}

/** No consequence rule holds: the chat's mode decides everything, as before. */
export const UNGUARDED: TurnGuard = Object.freeze({ michiDriven: false, outsideContent: false, outsideSourced: false, background: false });
const FAIL_CLOSED: TurnGuard = Object.freeze({ michiDriven: true, outsideContent: true, outsideSourced: true, background: false });
/** A check-in's own turn: Michi's, from collector material, with nobody to ask. */
const BACKGROUND: TurnGuard = Object.freeze({ michiDriven: true, outsideContent: true, outsideSourced: true, background: true });

/** Whether any consequence rule holds for the turn. */
export function isGuarded(guard: TurnGuard): boolean {
  return guard.michiDriven || guard.outsideContent || guard.outsideSourced || guard.background;
}

/** A check-in node, by its id prefix or recorded purpose; one that cannot be read counts as one (fail closed). */
function checkinNode(nodeId: string): boolean {
  try {
    return assistantPurposeOf(nodeId) === 'checkin';
  } catch {
    return true;
  }
}

/** Tools whose output turn trust records as outside content but which only ran a command here. */
const SHELL_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  'bash', 'Bash', 'BashOutput', 'TaskOutput', 'KillShell', 'PowerShell', 'REPL', 'Monitor', 'shell', 'execute_bash', 'run_command', 'execute',
]);

/**
 * The source a message records on the turn it starts when the sending turn
 * held outside content (turnHoldsOutsideContent): the conversation then
 * started, or continued, from content someone else wrote. Beside the
 * untrusted source thread messages already record (threadMessageWakes.ts),
 * which any command output of the sender's sets too.
 */
export const PASSED_OUTSIDE_TOOL = 'passed_outside';

const outsideSource = (source: TrustSource): boolean => !SHELL_SOURCE_TOOLS.has(source.tool);

/**
 * Whether a turn holds outside content (see outsideContent above): Companion
 * material, its own or (as its chat's running turn) carried from an earlier
 * turn, or web pages, another MCP server's results or passed-in content.
 * Fails closed: true when it cannot be read.
 */
export function turnHoldsOutsideContent(ref: TurnRef): boolean {
  try {
    const taint = turnTaintOf(ref);
    if (taint === 'checkin' || taint === 'collector') return true;
    return getTurnTrust(ref).sources.some(outsideSource);
  } catch {
    return true;
  }
}

/**
 * Records on the turn a message starts (`to`) that it came from a turn that
 * held outside content (`fromNodeId`'s). Throws when the write fails: the
 * caller sends nothing then.
 */
export function recordPassedOutsideContent(to: TurnRef, fromNodeId: string, runtimeId: string): void {
  recordUntrustedSource(to, { tool: PASSED_OUTSIDE_TOOL, runtimeId, detail: `from:${fromNodeId}` });
}

// ---------------------------------------------------------------------------
// Turns Michi started (before their first message is on record)
// ---------------------------------------------------------------------------

const MAX_NOTED = 512;
/** nodeId → turnId of a turn Michi is starting there (start_conversation). */
const notedStarts = new Map<string, string>();

/** start_conversation: the conversation's first turn is Michi's, before the delegation that says so is recorded. */
export function noteMichiStartedTurn(nodeId: string, turnId: string): void {
  if (!nodeId || !turnId) return;
  notedStarts.delete(nodeId);
  notedStarts.set(nodeId, turnId);
  while (notedStarts.size > MAX_NOTED) notedStarts.delete(notedStarts.keys().next().value!);
}

/** @testonly */
export function __resetTurnGuard(): void {
  notedStarts.clear();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface TurnRow { turn_id: string; user_message_id: string | null }

function runningTurn(db: DatabaseSync, nodeId: string): TurnRow | null {
  const row = db.prepare("SELECT turn_id, user_message_id FROM turns WHERE node_id = ? AND status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1")
    .get(nodeId) as unknown as TurnRow | undefined;
  return row ?? null;
}

function messageMetadata(db: DatabaseSync, nodeId: string, messageId: string | null): Record<string, unknown> | null {
  if (!messageId) return null;
  const row = db.prepare('SELECT metadata FROM messages WHERE id = ? AND node_id = ?').get(messageId, nodeId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return null;
  try {
    const parsed = JSON.parse(row.metadata) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** A user message Michi sent: a follow-up, or one relayed from another conversation. */
function sentByMichi(metadata: Record<string, unknown> | null): boolean {
  return !!metadata && (metadata.companionSend !== undefined || metadata.threadMessage !== undefined);
}

/**
 * A conversation Michi started and still follows, which the user has not
 * written in (its first message is Michi's; a second one without Michi's
 * metadata is the user's).
 */
function followedWorkConversation(db: DatabaseSync, nodeId: string): boolean {
  const followed = db.prepare("SELECT 1 FROM companion_delegations WHERE node_id = ? AND state = 'following' LIMIT 1").get(nodeId);
  if (!followed) return false;
  const human = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE node_id = ? AND role = 'user'
      AND (metadata IS NULL OR NOT json_valid(metadata)
        OR (json_extract(metadata, '$.companionSend') IS NULL AND json_extract(metadata, '$.threadMessage') IS NULL))`)
    .get(nodeId) as { n: number } | undefined;
  return Number(human?.n ?? 0) <= 1;
}

function michiDriven(db: DatabaseSync, nodeId: string, turn: TurnRow | null): boolean {
  if (turn && notedStarts.get(nodeId) === turn.turn_id) return true;
  if (turn && sentByMichi(messageMetadata(db, nodeId, turn.user_message_id))) return true;
  return followedWorkConversation(db, nodeId);
}

/** Any turn of this conversation took in content passed in with a message from a turn that held outside content. */
function passedInContent(db: DatabaseSync, nodeId: string): boolean {
  return !!db.prepare('SELECT 1 FROM turn_trust WHERE node_id = ? AND tool = ? LIMIT 1').get(nodeId, PASSED_OUTSIDE_TOOL);
}

/**
 * Whether the chat's running turn is one the user sent themselves (the rule
 * that a conversation the user asks for in their own turn starts without a
 * card, 2026-11-12): chatHub names a turn the user sent `a-…` and one Michi
 * requested `self-…` (a note, a worker report, a thread reply, a wake), and
 * no message metadata says Michi sent it (michiDriven). Whatever the turn
 * read does not matter. False when there is no running turn, or it cannot be
 * read (fail closed: the start asks).
 */
export function userSentRunningTurn(nodeId: string | null | undefined): boolean {
  if (typeof nodeId !== 'string' || !nodeId) return false;
  const db = openDbOrNull();
  if (!db) return false;
  try {
    const row = db.prepare("SELECT assistant_message_id FROM turns WHERE node_id = ? AND status = 'active' ORDER BY started_at DESC, rowid DESC LIMIT 1")
      .get(nodeId) as { assistant_message_id?: unknown } | undefined;
    if (typeof row?.assistant_message_id !== 'string' || !row.assistant_message_id.startsWith('a-')) return false;
    return !turnGuard(nodeId).michiDriven;
  } catch {
    return false;
  }
}

/**
 * The rules that hold for the chat's running turn (or, between turns, its
 * last state: a workflow asking after the turn ended). UNGUARDED when no
 * database is open or the node is not a chat.
 */
export function turnGuard(nodeId: string | null | undefined): TurnGuard {
  if (typeof nodeId !== 'string' || !nodeId) return UNGUARDED;
  const db = openDbOrNull();
  if (!db) return UNGUARDED;
  if (checkinNode(nodeId)) return BACKGROUND;
  try {
    const turn = runningTurn(db, nodeId);
    const companion = activeCompanionTaint(nodeId) !== null;
    const trust = activeTurnTrust(nodeId);
    const readOutside = companion || (trust?.sources ?? []).some(outsideSource);
    const driven = michiDriven(db, nodeId, turn);
    const sourced = driven && (companion || passedInContent(db, nodeId));
    return driven || readOutside ? { michiDriven: driven, outsideContent: readOutside, outsideSourced: sourced, background: false } : UNGUARDED;
  } catch (err) {
    log.warn('chat', 'turn guard read failed; the turn asks before anything leaves the machine', {
      nodeId, error: err instanceof Error ? err.message : String(err),
    });
    return FAIL_CLOSED;
  }
}
