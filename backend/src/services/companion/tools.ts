/**
 * The agent's own tools (DESIGN §7.2 as amended by R2.1, R2.8, R2.9, R2.12;
 * DESIGN-v2 §2.3-§2.8, §3.4, §3.5). They exist only in the catalogs of the
 * user's conversation with the agent (V, purpose main: MAIN_TOOL_NAMES) and
 * of its check-ins (S, purpose checkin: CHECKIN_TOOL_NAMES), which their MCP
 * slot and Pi session serve, and run without any approval prompt in every
 * permission mode, so each one enforces its own rules here:
 *
 * - they work only on V and S (companionToolPurpose): an assistant node,
 *   whose purpose is checkin for a check-in node (the `n-cmph-` id alone
 *   decides, §2.2) and main otherwise;
 * - who started the turn is read from server-side turn attribution, never
 *   from tool arguments: the turn the runtime is sending (chatHub hands it
 *   the turn id and assistant message id) checked against its durable row,
 *   whose assistant message id starts with `self-` for a turn Michi started
 *   (a check-in, or a hidden turn on V) and `a-` for one the user started.
 *   A turn Michi cannot attribute is treated as unknown and the user-only
 *   tools refuse it;
 * - when Michi could not read the user's rules for the turn (the route
 *   marked the user message `companionTurn.rulesUnavailable`, or they cannot
 *   be read now) the action tools refuse (§1.3);
 * - companion_set_name, companion_set_notifications and mute change things
 *   only in a turn the user started, also one that read untrusted material
 *   (D19);
 *   companion_update_item and companion_edit_goal also in a check-in,
 *   which may snooze, dismiss or restore (never an item the user muted) at
 *   most ten items and change at most three goals, each with a reason,
 *   recorded for its post and its Undo (§2.6.5, §2.6.7, D5: repository
 *   recordRunChange, checkinWrites.ts);
 * - notes and goals a turn writes carry who wrote them (§2.8 T1): `user`
 *   only in a user turn on V that read no check-in or collector material,
 *   `checkin` otherwise;
 * - nothing_to_do is refused in a turn the user started ("a person is
 *   waiting; answer them"), in the first welcome, and once the check-in
 *   changed the user's content (§3.4: it must say so);
 * - companion_read (V only) returns what check-ins wrote, which
 *   [COMPANION CONTEXT] leaves out (§3.5), and like companion_items and
 *   companion_item marks the turn untrusted (§2.8 T5: `checkin` or
 *   `collector`), failing closed: material it cannot record as read is
 *   never returned;
 * - a source off in settings is said to be off, never answered for as if it
 *   had nothing (conv-3); times take a local `YYYY-MM-DD HH:MM` or `+90m`
 *   (conv-2);
 * - cards are only proposed (cards.ts), at most two a turn, and a rule, a
 *   reminder, a watch or a conversation only in a turn the user started
 *   (R2.15); applying and dismissing stay the user's REST;
 * - follow-ups into a conversation the agent started and still follows
 *   (DESIGN-v2 §4, sessionSend.ts): companion_session_send only in a turn
 *   the user started, at most three a turn, each after the user approved
 *   its exact text, unless they chose "Send, and stop asking" for that
 *   conversation; a turn that read check-in or collector material always
 *   asks (D3: no runtime prompt comes for this tool), and "stop asking"
 *   holds only while the conversation runs no wider than when it was chosen
 *   (D22). A check-in proposes a session.send card instead, at most one
 *   follow-up a check-in, and (Q1, D15) sends it itself only into a
 *   conversation that runs in exactly Ask on a runtime whose approval gate
 *   Michi holds, its turn recorded as check-in material; after that
 *   nothing_to_do is refused, and its post or Michi's receipt lists the send
 *   (D21): the user must hear of it;
 * - a check-in's brief, and a follow-up it sends itself, go out only while
 *   what its Michi Memory pack showed when it started holds
 *   (checkinNode.ts checkinMemoryHolds, D5): otherwise they are refused as
 *   withdrawn, and so is every later result of that check-in;
 * - an item out of sight (its source is off, B15) reads as an unknown id in
 *   every tool that takes one, and its events stay out of check results;
 * - companion_check_now waits up to 50 s, then answers with the sources that
 *   finished, what changed so far and what is still being checked (H#2);
 * - deep reads go through the injected CompanionDeepReads (the whitelisted
 *   MCP pool, sources/deepReads.ts) and answer "not available" until the
 *   server wires them; at most three a turn (H#3), each holding off while
 *   the turn's own check still waits, since they share its servers (H#2);
 *   outside text comes back as one untrusted block,
 *   scrubbed by the scrubber every other piece of material goes through
 *   (sources/common.ts inertText), and the turn is recorded as having read
 *   untrusted content (turnTrust.ts).
 *
 * The conversation layer (conversation.ts) registers each hidden turn it
 * starts (beginCompanionHiddenTurn), so a tool knows which kind of note it
 * runs in, and learns at its end whether nothing_to_do ended it (it is then
 * quiet, whatever else the model wrote) and what note it left for the
 * Activity log.
 */

import {
  CHAT_NOTIFICATION_LEVELS,
  COMPANION_BUCKETS,
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_LIMITS,
  COMPANION_SOURCE_KINDS,
  DEFAULT_COMPANION_NAME,
  companionCardButtonLabel,
  companionCheckinTurnRunId,
  isCheckinNodeId,
  parseCompanionPostMetadata,
  parseCompanionTurnMetadata,
  type ChatNotificationLevel,
  type CompanionCardKind,
  type CompanionConfigurableSource,
  type CompanionItemAction,
  type CompanionItemDto,
  type CompanionPostChangeAction,
  type CompanionSourceStatus,
  type CompanionStatusDto,
  type CompanionTaintDetail,
  type CompanionTextOrigin,
} from 'michi-shared';
import type { ParamField, ParamSpec } from '../../agents/builtinTools';
import type { AssistantPurpose, CompanionOwnToolName } from '../../assistant/policy';
import type { AssistantTool, AssistantToolContext, AssistantToolResult } from '../../assistant/tools';
import { assistantPurposeOf, isAssistantNode } from '../../assistant/identity';
import { changeUserNotificationLevel } from '../attention/notificationLevel';
import { getDb } from '../db';
import { log } from '../logger';
import { activeTurnTrust, recordCompanionTaint, turnTaintOf } from '../turnTrust';
import { turnHoldsOutsideContent } from '../turnGuard';
import { COMPANION_CARD_KINDS, COMPANION_MAX_PENDING_CARDS, proposePublicCompanionCard as proposeCompanionCard } from './cards';
import { CHECKIN_WITHDRAWN_MESSAGE, checkinMemoryHolds } from './checkinNode';
import { checkinWritesOf, noteCheckinWrite } from './checkinWrites';
import { COMPANION_TIME_FORMS, localDateKey, localTimeEchoText, parseCompanionTime, systemCompanionClock } from './clock';
import { companionEvents, type CompanionChangeReason, type CompanionEventBus } from './delivery';
import { CompanionError, notFound } from './errors';
import {
  checkinKindText,
  collectorData,
  companionChangesText,
  eventLine,
  fill,
  itemLine,
  materialBlock,
  materialLine,
  offSourcesText,
  plural,
  stampText,
} from './prompts';
import {
  COMPANION_GOAL_PROGRESS_MAX_CHARS,
  COMPANION_MAX_SNOOZE_MS,
  applyItemAction,
  briefForDate,
  cardDto,
  companionTransaction,
  editGoal,
  getCompanionNotesState,
  getGoal,
  getItem,
  insertBrief,
  isCompanionItemHidden,
  latestEventSeq,
  listEventsAfter,
  listGoals,
  listItemEvents,
  listOpenItems,
  listPendingCards,
  readCompanionRules,
  recordGoalProgress,
  recordRunChange,
  setBriefCurate,
  setDelegationAutoSend,
  setNotesByCompanion,
} from './repository';
import {
  COMPANION_SEND_CARD_INSTEAD,
  CompanionSendRefusal,
  checkCompanionSend,
  companionAutoSendAskReason,
  companionCheckinSendsDirectly,
  companionSendTarget,
  companionTargetPermissionLine,
  deliverCompanionMessage,
  type CompanionSendResult,
} from './sessionSend';
import { COMPANION_NAME_MAX_CHARS, companionSourcesOff, getCompanionSettings, patchCompanionSettings } from './settings';
import type { CompanionClock, CompanionDeepReads, CompanionEventRecord, CompanionTurnKind } from './types';


/** Cards one turn may propose (DESIGN §7.2). */
export const COMPANION_MAX_CARDS_PER_TURN = 2;
/**
 * How long companion_check_now waits for the check (DESIGN §7.2): every
 * source's poll fits in it (H#2: at 20 s the tool gave up 1.5 s before the
 * polls finished), and it stays under a runtime's minute-long tool timeout.
 */
export const COMPANION_CHECK_NOW_WAIT_MS = 50_000;
/**
 * Today items one check-in may change (D5: snooze, dismiss or restore); a
 * call about another item past it is refused. Undo all still reverses them.
 */
export const COMPANION_CHECKIN_MAX_ITEM_CHANGES = 10;
/**
 * Cards only the user's own message may lead to (R2.15, rule 9): material
 * never makes the Companion propose a rule, a reminder, a watch or a
 * conversation, so a hidden turn (a note from Michi) cannot propose them.
 */
export const COMPANION_USER_ONLY_CARD_KINDS: ReadonlySet<CompanionCardKind> = new Set<CompanionCardKind>([
  'rules.update', 'reminder.add', 'watch.add', 'conversation.start',
]);
const ITEMS_LIMIT_DEFAULT = 20;
const ITEMS_LIMIT_MAX = 50;
const QUIET_NOTE_MAX_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Posts companion_read returns at most, newest first. */
const READ_POSTS_LIMIT = 10;
const READ_POST_CHARS = 2000;

// ── What the server wires ───────────────────────────────────────────────────

export interface CompanionToolDeps {
  /**
   * Polls these sources now (every enabled one when omitted) and resolves
   * once they finished; rejects with a CompanionError (not_owner) in a
   * process that does not run the Companion. The coordinator's, wired by
   * the server; absent: companion_check_now answers "not available".
   */
  checkNow?(sources: readonly CompanionConfigurableSource[] | undefined): Promise<void>;
  /** The live status, for the sources a check could not reach. */
  status?(): CompanionStatusDto;
  /** The read-only deep reads (sources/deepReads.ts); absent: those tools answer "not available". */
  deepReads?: CompanionDeepReads | null;
  clock?: CompanionClock;
  /** Change events after a write (default: the process's companionEvents). */
  events?: Pick<CompanionEventBus, 'emitChanged'>;
  /** How long companion_check_now waits (default COMPANION_CHECK_NOW_WAIT_MS). */
  checkWaitMs?: number;
  /** How long a deep read holds off for its turn's check (default COMPANION_DEEP_READ_HOLD_MS). */
  deepReadHoldMs?: number;
}

let toolDeps: CompanionToolDeps = {};

/** The server sets these once (server.ts); tests set fakes. Replaces what was set. */
export function setCompanionToolDeps(deps: CompanionToolDeps): void {
  toolDeps = { ...deps };
}

// ── Hidden turns ────────────────────────────────────────────────────────────

interface HiddenTurn {
  kind: CompanionTurnKind;
  runId: string;
  quietNote: string | null;
  /** nothing_to_do was accepted: the turn ends quiet, whatever stray text the model wrote around the call. */
  quietEnd: boolean;
  /** companion_headline's last line, or the headline of the brief it published: Michi's latest line once the turn ran (Q45). */
  headline: string | null;
  briefHeadline: string | null;
}

/** Turns this process keeps in its small per-turn maps. */
const MAX_TRACKED_TURNS = 256;
const hiddenTurns = new Map<string, HiddenTurn>();
const proposalsByTurn = new Map<string, number>();
const goalEditsByTurn = new Map<string, number>();
/** The Today items each check-in changed so far (D5). */
const itemChangesByTurn = new Map<string, ReadonlySet<string>>();
/** Each turn's companion_check_now still waiting: settles when the tool answers (finished or out of wait), never rejects. */
const checksByTurn = new Map<string, Promise<void>>();
/** companion_session_send calls each user turn made that reached the user's approval or the send (§4). */
const sessionSendsByTurn = new Map<string, number>();
/** Each check-in's follow-ups (a session.send card or, Q1, one it sent itself, §4). */
const checkinSendsByTurn = new Map<string, number>();
/** The conversations each check-in sent a follow-up into itself: it must say so (nothing_to_do refuses). */
const checkinSentByTurn = new Map<string, readonly string[]>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_TRACKED_TURNS) map.delete(map.keys().next().value as string);
}

/** conversation.ts: a hidden turn of this kind is about to start under this chat turn id. */
export function beginCompanionHiddenTurn(turnId: string, info: { kind: CompanionTurnKind; runId: string }): void {
  remember(hiddenTurns, turnId, { kind: info.kind, runId: info.runId, quietNote: null, quietEnd: false, headline: null, briefHeadline: null });
}

/**
 * conversation.ts: the hidden turn is over. quietEnd: it ended with an
 * accepted nothing_to_do, so it is quiet even when the model also wrote
 * something; quietNote: what that call noted for the Activity log;
 * headline: the line it wrote for Home (its own, else its brief's).
 */
export function endCompanionHiddenTurn(turnId: string): { quietNote: string | null; quietEnd: boolean; headline: string | null } {
  const turn = hiddenTurns.get(turnId);
  hiddenTurns.delete(turnId);
  proposalsByTurn.delete(turnId);
  goalEditsByTurn.delete(turnId);
  itemChangesByTurn.delete(turnId);
  checksByTurn.delete(turnId);
  sessionSendsByTurn.delete(turnId);
  checkinSendsByTurn.delete(turnId);
  checkinSentByTurn.delete(turnId);
  return { quietNote: turn?.quietNote ?? null, quietEnd: turn?.quietEnd ?? false, headline: turn?.headline ?? turn?.briefHeadline ?? null };
}

// ── Who started the turn ────────────────────────────────────────────────────

/** hidden = Michi started it (a note); user = the user's own message; unknown = Michi cannot tell. */
export type CompanionTurnOrigin = 'hidden' | 'user' | 'unknown';

export interface CompanionToolTurn {
  origin: CompanionTurnOrigin;
  turnId: string | null;
  /** The note's kind, for a hidden turn conversation.ts started. */
  kind: CompanionTurnKind | null;
}

const UNKNOWN_TURN: CompanionToolTurn = Object.freeze({ origin: 'unknown', turnId: null, kind: null });

interface DurableTurnRow {
  turn_id: string;
  node_id: string;
  assistant_message_id: string;
}

/** chatHub names a turn Michi requested `self-…` and one the user sent `a-…`. */
function originOf(assistantId: string, turnId: string): CompanionToolTurn {
  if (assistantId.startsWith('self-')) return { origin: 'hidden', turnId, kind: hiddenTurns.get(turnId)?.kind ?? null };
  if (assistantId.startsWith('a-')) return { origin: 'user', turnId, kind: null };
  return UNKNOWN_TURN;
}

/**
 * The turn a tool call belongs to, from server-side attribution only: the
 * turn the runtime is sending (set by chatHub, never by the model) checked
 * against its durable row, else the node's active durable turn. A mismatch
 * between the two, or neither, is unknown.
 */
export function companionToolTurn(ctx: Pick<AssistantToolContext, 'nodeId' | 'getActivePageTurnAttribution'>): CompanionToolTurn {
  const nodeId = ctx.nodeId;
  if (!nodeId) return UNKNOWN_TURN;
  let attribution: { turnId: string; assistantId: string } | null = null;
  try {
    attribution = ctx.getActivePageTurnAttribution?.() ?? null;
  } catch {
    attribution = null;
  }
  const db = getDb();
  const row = (attribution?.turnId
    ? db.prepare('SELECT turn_id, node_id, assistant_message_id FROM turns WHERE turn_id = ?').get(attribution.turnId)
    : db.prepare(`SELECT turn_id, node_id, assistant_message_id FROM turns WHERE node_id = ? AND status = 'active'
        ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(nodeId)) as DurableTurnRow | undefined;
  if (row) {
    if (row.node_id !== nodeId) return UNKNOWN_TURN;
    if (attribution?.assistantId && attribution.assistantId !== row.assistant_message_id) return UNKNOWN_TURN;
    return originOf(row.assistant_message_id, row.turn_id);
  }
  // The runtime is sending a turn whose row this connection cannot see yet: chatHub's own ids still say who started it.
  if (attribution?.turnId && attribution.assistantId) return originOf(attribution.assistantId, attribution.turnId);
  return UNKNOWN_TURN;
}

// ── Plumbing ────────────────────────────────────────────────────────────────

/** A refusal or bad input: the tool answers it as an error result. */
class CompanionToolRefusal extends Error {}

const refuse = (message: string): never => { throw new CompanionToolRefusal(message); };

function result(value: string, isError = false): AssistantToolResult {
  return isError ? { content: [{ type: 'text', text: value }], isError: true } : { content: [{ type: 'text', text: value }] };
}

const f = (type: ParamSpec, opts: Omit<ParamField, 'type'> = {}): ParamField => ({ type, ...opts });

// ── Arguments ───────────────────────────────────────────────────────────────
// The runtimes check a call against `parameters` before it arrives; these
// small parsers check it again with its bounds (lengths, ranges, list sizes),
// trim ids, drop unknown fields, and name the first field that is wrong.

/** Parses one argument value, or throws the problem with it. */
type Arg<T> = (value: unknown) => T;

class ArgumentIssue extends Error {
  readonly path: (string | number)[] = [];
}

const badArgument = (message: string): never => { throw new ArgumentIssue(message); };

/** Parses `value` as the field `key` of its parent, so a problem names its path. */
function field<T>(key: string | number, parseValue: Arg<T>, value: unknown): T {
  try {
    return parseValue(value);
  } catch (error) {
    if (error instanceof ArgumentIssue) error.path.unshift(key);
    throw error;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const arg = {
  string: (bounds: { trim?: boolean; min?: number; max?: number } = {}): Arg<string> => (value) => {
    if (value === undefined) return badArgument('is required');
    if (typeof value !== 'string') return badArgument('must be text');
    const text = bounds.trim ? value.trim() : value;
    if (bounds.min !== undefined && text.length < bounds.min) badArgument(bounds.min === 1 ? 'must not be empty' : `must have at least ${bounds.min} characters`);
    if (bounds.max !== undefined && text.length > bounds.max) badArgument(`must have at most ${bounds.max} characters`);
    return text;
  },
  int: (bounds: { min?: number; max?: number } = {}): Arg<number> => (value) => {
    if (value === undefined) return badArgument('is required');
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return badArgument('must be a whole number');
    if (bounds.min !== undefined && value < bounds.min) badArgument(`must be at least ${bounds.min}`);
    if (bounds.max !== undefined && value > bounds.max) badArgument(`must be at most ${bounds.max}`);
    return value;
  },
  oneOf: <T extends string>(values: readonly T[]): Arg<T> => (value) => {
    if (value === undefined) return badArgument('is required');
    return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : badArgument(`must be one of: ${values.join(', ')}`);
  },
  list: <T>(item: Arg<T>, bounds: { max?: number } = {}): Arg<T[]> => (value) => {
    if (value === undefined) return badArgument('is required');
    if (!Array.isArray(value)) return badArgument('must be a list');
    if (bounds.max !== undefined && value.length > bounds.max) badArgument(`must have at most ${bounds.max} entries`);
    return value.map((entry, index) => field(index, item, entry));
  },
  object: <S extends Record<string, Arg<unknown>>>(shape: S): Arg<{ [K in keyof S]: ReturnType<S[K]> }> => (value) => {
    if (value === undefined) return badArgument('is required');
    if (!isPlainObject(value)) return badArgument('must be an object');
    const parsed: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const entry = field(key, shape[key]!, value[key]);
      if (entry !== undefined) parsed[key] = entry;
    }
    return parsed as { [K in keyof S]: ReturnType<S[K]> };
  },
  optional: <T>(parseValue: Arg<T>): Arg<T | undefined> => (value) => (value === undefined ? undefined : parseValue(value)),
  nullable: <T>(parseValue: Arg<T>): Arg<T | null> => (value) => (value === null ? null : parseValue(value)),
  /** Any value; its own checks (cards.ts) come later. */
  any: (): Arg<unknown> => (value) => value,
};

/** A call's arguments (none counts as `{}`); a wrong one is refused as INVALID_ARGUMENT naming its field. */
function parse<T>(schema: Arg<T>, args: unknown): T {
  try {
    return schema(args ?? {});
  } catch (error) {
    if (!(error instanceof ArgumentIssue)) throw error;
    return refuse(`INVALID_ARGUMENT: ${error.path.join('.') || 'arguments'}: ${error.message}`);
  }
}

function now(): number {
  return (toolDeps.clock ?? systemCompanionClock).now();
}

function emit(reason: CompanionChangeReason): void {
  try {
    (toolDeps.events ?? companionEvents).emitChanged(reason);
  } catch (error) {
    log.warn('chat', 'companion change event failed', { reason, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The turns a read of check-in or collector material taints (§2.8 T5): the
 * turn Michi attributed the call to, and the conversation's running turn,
 * which the permission policy reads (turnTrust.activeCompanionTaint), when
 * that is another or Michi could not attribute the call. Empty when there is
 * neither: nothing could be tainted.
 */
function taintTargets(nodeId: string | null, turn: CompanionToolTurn): string[] {
  if (!nodeId) return [];
  const turnIds = new Set<string>(turn.turnId ? [turn.turnId] : []);
  try {
    const active = activeTurnTrust(nodeId)?.turnId;
    if (active) turnIds.add(active);
  } catch (error) {
    log.warn('chat', 'companion running turn not read for taint', { nodeId, error: error instanceof Error ? error.message : String(error) });
  }
  return [...turnIds];
}

/**
 * Records that the turn read untrusted material through one of the agent's
 * tools (DESIGN-v2 §2.8 T5): `collector` for what a source brought in,
 * `checkin` for what a check-in wrote. Memory work does not follow it, and
 * on V the rest of the turn's tools ask first (assistant/permission policy).
 * Fails closed (G1b-review #3): with no turn to taint, or a record that
 * fails, the tool refuses and its material never reaches the model.
 */
function markUntrusted(ctx: AssistantToolContext, turn: CompanionToolTurn, tool: CompanionOwnToolName, detail: CompanionTaintDetail): void {
  const turnIds = taintTargets(ctx.nodeId, turn);
  if (turnIds.length === 0) refuse(fill('result.taintUnrecorded', { tool }));
  try {
    for (const turnId of turnIds) recordCompanionTaint({ nodeId: ctx.nodeId!, turnId }, tool, detail);
  } catch (error) {
    log.warn('chat', 'companion turn trust record failed', { tool, error: error instanceof Error ? error.message : String(error) });
    refuse(fill('result.taintUnrecorded', { tool }));
  }
}

/** The user-only tools: a change the user just asked for, in a turn they started. */
function requireUserTurn(turn: CompanionToolTurn, tool: CompanionOwnToolName): void {
  if (turn.origin === 'hidden') refuse(fill('result.hiddenTurn', { tool }));
  if (turn.origin !== 'user') refuse(fill('result.unknownTurn', { tool }));
}

/**
 * What the conversation a tool runs in is for (DESIGN-v2 §2.2, §2.5): an
 * assistant conversation's purpose (identity.ts assistantPurposeOf: `checkin`
 * for a check-in node, whose `n-cmph-` id alone decides, and for the MVP's
 * closed Companion conversation; `main` for V and the archived ⌘J and
 * Scheduled conversations); null outside the assistant's workspace, where
 * these tools do nothing.
 */
export function companionToolPurpose(nodeId: string | null | undefined): AssistantPurpose | null {
  if (!nodeId) return null;
  if (isCheckinNodeId(nodeId)) return isAssistantNode(nodeId) ? 'checkin' : null;
  return isAssistantNode(nodeId) ? assistantPurposeOf(nodeId) : null;
}

interface ToolCall {
  ctx: AssistantToolContext;
  args: unknown;
  now: number;
  /** V (`main`) or a check-in (`checkin`). */
  purpose: AssistantPurpose;
  /** Who started this turn (read once per call, lazily). */
  turn(): CompanionToolTurn;
}

interface ToolSpec {
  name: CompanionOwnToolName;
  /** What a tool row shows (Pi); a function for one that names the agent, read when it is shown. */
  label: string | (() => string);
  description: string;
  parameters: AssistantTool['parameters'];
  sequential?: boolean;
  /** An action tool (§1.3): refused in a turn whose user's rules Michi could not read. */
  acts?: true;
  run(call: ToolCall): Promise<string> | string;
}

interface UserMessageRow { metadata: string | null }

/**
 * Michi could not read the user's rules for this turn (§1.3): they cannot be
 * read now, or the route marked the turn's user message
 * (`companionTurn.rulesUnavailable`) when it sent it without [COMPANION CONTEXT].
 */
function rulesUnavailable(call: ToolCall): boolean {
  if (!readCompanionRules().ok) return true;
  const turnId = call.turn().turnId;
  if (!turnId) return false;
  const row = getDb().prepare(`SELECT m.metadata FROM turns t JOIN messages m ON m.id = t.user_message_id
    WHERE t.turn_id = ? AND t.node_id = ?`).get(turnId, call.ctx.nodeId) as UserMessageRow | undefined;
  if (!row?.metadata) return false;
  try {
    const metadata = JSON.parse(row.metadata) as { companionTurn?: unknown } | null;
    return parseCompanionTurnMetadata(metadata?.companionTurn)?.rulesUnavailable === true;
  } catch {
    return false;
  }
}

/**
 * One of the agent's tools: refused outside V and its check-ins; an action
 * tool refused when the turn's rules could not be read; a refusal, bad input
 * or a CompanionError (a limit, a conflict, a missing item) answers as an
 * error result; anything else is a bug and throws.
 */
function companionTool(spec: ToolSpec): AssistantTool {
  const label = spec.label;
  return {
    name: spec.name,
    get label() { return typeof label === 'function' ? label() : label; },
    description: spec.description,
    parameters: spec.parameters,
    ...(spec.sequential ? { sequential: true } : {}),
    execute: async (ctx, args) => {
      const purpose = companionToolPurpose(ctx.nodeId);
      if (!purpose) return result(fill('result.notCompanion'), true);
      let turn: CompanionToolTurn | null = null;
      try {
        const call: ToolCall = { ctx, args, now: now(), purpose, turn: () => (turn ??= companionToolTurn(ctx)) };
        if (spec.acts && rulesUnavailable(call)) refuse(fill('result.rulesUnavailable', { tool: spec.name }));
        return result(await spec.run(call));
      } catch (error) {
        if (error instanceof CompanionToolRefusal) return result(error.message, true);
        if (error instanceof CompanionError) return result(`${error.code.toUpperCase()}: ${error.message}`, true);
        throw error;
      }
    },
  };
}

const unavailable = (what: string) => refuse(fill('result.unavailable', { what }));

/**
 * The agent's name as the user sees it (§1.5: every visible place uses the
 * name, the product has no "Companion" persona): its display name, else the
 * default before settings can be read.
 */
function agentName(): string {
  try {
    return getCompanionSettings().displayName || DEFAULT_COMPANION_NAME;
  } catch {
    return DEFAULT_COMPANION_NAME;
  }
}

const quotedTitle = (title: string) => `"${materialLine(title, 120)}"`;

/**
 * The turn read untrusted material (any source recorded on it: §2.8 T4, T5),
 * or, as the conversation's running turn, starts tainted because its session
 * read check-in material in an earlier turn (D1, D17): turnTrust.turnTaintOf
 * answers both, and fails closed (a trust read that fails counts as tainted).
 */
function turnTainted(nodeId: string, turnId: string): boolean {
  return turnTaintOf({ nodeId, turnId }) !== null;
}

/**
 * Who wrote the text a turn saves (DESIGN-v2 §2.8 T1): `user` only in a turn
 * the user started on V that read no untrusted material; a check-in, a hidden
 * or unattributed turn, and a tainted one write `checkin`.
 */
function writeOrigin(call: ToolCall): CompanionTextOrigin {
  if (call.purpose !== 'main' || !call.ctx.nodeId) return 'checkin';
  const turn = call.turn();
  if (turn.origin !== 'user' || !turn.turnId) return 'checkin';
  return turnTainted(call.ctx.nodeId, turn.turnId) ? 'checkin' : 'user';
}

/** A check-in's own turn on its node, with its run; null for anything else. */
function checkinTurnOf(call: ToolCall): { turnId: string; runId: string } | null {
  if (call.purpose !== 'checkin') return null;
  const turn = call.turn();
  if (turn.origin !== 'hidden' || !turn.turnId) return null;
  const runId = companionCheckinTurnRunId(turn.turnId) ?? hiddenTurns.get(turn.turnId)?.runId ?? null;
  return runId ? { turnId: turn.turnId, runId } : null;
}

/** A check-in's reason for a change (§2.6.5, §2.7): one line, 1 to maxChangeReasonChars UTF-16 units (as the shared parser counts). */
function changeReason(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/[\p{Cc}\s]+/gu, ' ').trim() : '';
  if (!text || text.length > COMPANION_LIMITS.maxChangeReasonChars) refuse(fill('result.reasonNeeded', { max: COMPANION_LIMITS.maxChangeReasonChars }));
  return text;
}

// ── The feed ────────────────────────────────────────────────────────────────

/** An item, goal or card id as the tools take it. */
const ID_ARG = arg.string({ trim: true, min: 1, max: 160 });

/**
 * One item by id as the tools may see it: null when there is none, and when
 * it is out of sight (its source is off: repository isCompanionItemHidden,
 * B15), so a tool that reads one item answers for it as for an unknown id.
 */
function visibleItem(id: string): CompanionItemDto | null {
  const item = getItem(id);
  return item && !isCompanionItemHidden(item) ? item : null;
}

const itemsTool = companionTool({
  name: 'companion_items',
  label: () => `${agentName()}'s Today items`,
  description: fill('tool.companion_items', { maxLimit: ITEMS_LIMIT_MAX }),
  parameters: { object: {
    source: f('string', { optional: true, enum: COMPANION_SOURCE_KINDS, description: 'Only items from this source.' }),
    bucket: f('string', { optional: true, enum: COMPANION_BUCKETS, description: 'Only items in this bucket.' }),
    limit: f('integer', { optional: true, description: `1-${ITEMS_LIMIT_MAX}, default ${ITEMS_LIMIT_DEFAULT}.` }),
  } },
  run: ({ ctx, args, now: at, turn }) => {
    const input = parse(arg.object({
      source: arg.optional(arg.oneOf(COMPANION_SOURCE_KINDS)),
      bucket: arg.optional(arg.oneOf(COMPANION_BUCKETS)),
      limit: arg.optional(arg.int({ min: 1, max: ITEMS_LIMIT_MAX })),
    }), args);
    // A source off in settings is not watched: say so, never "0 open" (conv-3).
    const off = companionSourcesOff(getCompanionSettings());
    if (input.source && (off as readonly string[]).includes(input.source)) {
      return fill('result.sourceOffItems', { source: offSourcesText([input.source as CompanionConfigurableSource]) });
    }
    const open = listOpenItems(at, {
      ...(input.source ? { source: input.source } : {}),
      ...(input.bucket ? { bucket: input.bucket } : {}),
      limit: 500,
    });
    const limit = input.limit ?? ITEMS_LIMIT_DEFAULT;
    const lines = open.slice(0, limit).map((item) => itemLine(item, at));
    if (open.length > limit) lines.push(fill('section.more', { count: open.length - limit }));
    markUntrusted(ctx, turn(), 'companion_items', 'collector');
    return collectorData([fill('section.items', { count: open.length }), ...(lines.length > 0 ? lines : [fill('section.nothing')]),
      ...(!input.source && off.length > 0 ? [fill('section.sourcesOff', { sources: offSourcesText(off) })] : [])]);
  },
});

const itemTool = companionTool({
  name: 'companion_item',
  label: () => `${agentName()}'s Today item`,
  description: fill('tool.companion_item'),
  parameters: { object: { itemId: f('string', { description: 'From companion_items or a note from Michi.' }) } },
  run: ({ ctx, args, now: at, turn }) => {
    const { itemId } = parse(arg.object({ itemId: ID_ARG }), args);
    const item = visibleItem(itemId);
    if (!item) refuse(`NOT_FOUND: no item ${materialLine(itemId, 160)}; get ids from companion_items.`);
    const events = listItemEvents(item!.id, 10);
    markUntrusted(ctx, turn(), 'companion_item', 'collector');
    return collectorData([
      fill('section.item'), itemLine(item!, at),
      fill('section.history'), ...(events.length > 0 ? events.map((event) => eventLine(event, item!, at)) : [fill('section.nothing')]),
    ]);
  },
});

// ── What the check-ins wrote (DESIGN-v2 §3.5) ─────────────────────────────

const READ_WHATS = ['posts', 'notes', 'goals', 'brief', 'cards'] as const;
type ReadWhat = typeof READ_WHATS[number];

interface PostRow {
  id: string;
  content: string | null;
  metadata: string | null;
  created_at: number;
}

const WRITERS: Record<CompanionTextOrigin, string> = { user: 'the user', checkin: 'a check-in' };

/** The check-ins' posts in this conversation, newest first: time, kind, what changed and why, then the text. */
function readPosts(nodeId: string, since: number | null, now: number): string[] {
  const rows = getDb().prepare(`SELECT id, content, metadata, created_at FROM messages
    WHERE node_id = ? AND role = 'assistant' AND id LIKE 'cmp-post-%' AND created_at >= ? ORDER BY seq DESC LIMIT ?`)
    .all(nodeId, since ?? 0, READ_POSTS_LIMIT) as unknown as PostRow[];
  const entries = rows.map((row) => {
    let metadata: unknown = null;
    try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { metadata = null; }
    const post = parseCompanionPostMetadata((metadata as { companionPost?: unknown } | null)?.companionPost);
    const changes = post ? companionChangesText(post.changes) : '';
    const reasons = (post?.changes ?? []).filter((change) => change.reason)
      .map((change) => `  - ${change.kind} ${change.id}${change.action ? ` ${change.action}` : ''}: ${materialLine(change.reason, 300)}`);
    return [
      `- ${stampText(now, row.created_at)} ${post ? checkinKindText(post.kind) : 'check-in'}: ${changes || 'changed nothing'}`,
      ...reasons,
      materialBlock(row.content, READ_POST_CHARS) || '(no text)',
    ].join('\n');
  });
  return [fill('read.posts'), ...(entries.length > 0 ? entries : [fill('section.nothing')])];
}

function readNotes(): string[] {
  const state = getCompanionNotesState();
  return [
    fill('read.notes', { revision: state.notesRevision, writer: `written last by ${WRITERS[state.origin]}` }),
    materialBlock(state.notes, COMPANION_LIMITS.maxNotesChars + 100) || fill('section.nothing'),
  ];
}

function readGoals(now: number): string[] {
  const lines = listGoals().map((goal) => {
    // No recorded origin reads as a check-in's, as [COMPANION CONTEXT] reads it (prompts.ts goalFact): never claimed for the user.
    const writer = WRITERS[goal.textOrigin ?? 'checkin'];
    const reading = goal.progress ? ` — latest reading: "${materialLine(goal.progress, 200)}"${goal.progressAt ? ` (${stampText(now, goal.progressAt)})` : ''}` : '';
    return `- ${goal.id} (worded by ${writer}): "${materialLine(goal.text, COMPANION_LIMITS.maxGoalChars)}"${reading}`;
  });
  return [fill('read.goals'), ...(lines.length > 0 ? lines : [fill('section.nothing')])];
}

function readBrief(now: number): string[] {
  const brief = briefForDate(localDateKey(now));
  if (!brief) return [fill('read.brief', { published: 'not published yet' })];
  return [
    fill('read.brief', { published: `published at ${stampText(now, brief.createdAt)}` }),
    `headline: "${materialLine(brief.headline, 200)}"`,
    ...brief.cards.map((card) => `- "${materialLine(card.title, 120)}": ${materialLine(card.body, 600)}${card.itemIds.length > 0 ? ` (items ${card.itemIds.join(', ')})` : ''}`),
    `closing: "${materialLine(brief.closing, 200)}"`,
  ];
}

function readCards(since: number | null, now: number): string[] {
  const lines = listPendingCards(now).map(cardDto).filter((card) => since === null || card.createdAt >= since).map((card) => [
    `- ${card.id} ${card.kind}, proposed ${stampText(now, card.createdAt)}: ${materialLine(card.summary, 400)}`,
    ...(card.reason ? [`  reason: ${materialLine(card.reason, 300)}`] : []),
  ].join('\n'));
  return [fill('read.cards'), ...(lines.length > 0 ? lines : [fill('section.nothing')])];
}

const readTool = companionTool({
  name: 'companion_read',
  label: 'Read check-in material',
  description: fill('tool.companion_read'),
  parameters: { object: {
    what: f('string', { enum: READ_WHATS }),
    since: f('string', { optional: true, description: 'posts and cards only: a local time "YYYY-MM-DD HH:MM" or a time before now such as "-3h".' }),
  } },
  run: (call) => {
    // A check-in's note carries what it needs; this read is for the user's conversation (§2.3).
    if (call.purpose === 'checkin') refuse(fill('result.readInCheckin'));
    const input = parse(arg.object({ what: arg.oneOf(READ_WHATS), since: arg.optional(arg.string({ trim: true, min: 1, max: 40 })) }), call.args);
    let since: number | null = null;
    if (input.since !== undefined) {
      if (input.what !== 'posts' && input.what !== 'cards') refuse('INVALID_ARGUMENT: since: only posts and cards take since');
      const parsed = parseCompanionTime(input.since, call.now);
      if (!parsed.ok) return refuse(`INVALID_ARGUMENT: since: ${parsed.problem}`);
      since = parsed.at;
    }
    const sections: Record<ReadWhat, () => string[]> = {
      posts: () => readPosts(call.ctx.nodeId!, since, call.now),
      notes: readNotes,
      goals: () => readGoals(call.now),
      brief: () => readBrief(call.now),
      cards: () => readCards(since, call.now),
    };
    const lines = sections[input.what]();
    // What a check-in wrote is check-in material (§2.8 T5): the rest of this turn asks before acting.
    markUntrusted(call.ctx, call.turn(), 'companion_read', 'checkin');
    return fill('block.checkinMaterial', { data: lines.join('\n') });
  },
});

/** Waits for `promise` at most `ms`; 'timeout' when it did not settle. */
async function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then((value) => ({ value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** An item event a check reports, with its item when that still exists. */
interface CheckedEvent {
  event: CompanionEventRecord;
  item: CompanionItemDto | undefined;
}

/**
 * The item events since `seq` a check may report: never a baseline (what was
 * already there is not news, R2.5), never one of an item out of sight (B15).
 */
function checkEvents(seq: number): CheckedEvent[] {
  const events: CheckedEvent[] = [];
  for (const event of listEventsAfter(seq, 100)) {
    if (event.kind === 'baseline') continue;
    const item = getItem(event.itemId);
    if (item && isCompanionItemHidden(item)) continue;
    events.push({ event, item: item ?? undefined });
  }
  return events;
}

/** The live status's sources; null when this Michi has none to read. */
function statusSources(): CompanionSourceStatus[] | null {
  try {
    return toolDeps.status?.().sources ?? null;
  } catch {
    return null;
  }
}

const sourceFailed = (source: CompanionSourceStatus) => source.state === 'error' || source.state === 'unavailable';

/** One source of a check when the tool answers: finished (ok or failed), off, or still being checked. */
interface CheckedSource {
  status: CompanionSourceStatus;
  state: 'ok' | 'failed' | 'off' | 'running';
}

/**
 * The sources a check covers (those asked for, else every enabled one) as
 * they stand: a source is done once its last poll ended at or after the call
 * began (H#2), off when it is turned off, else still being checked. Null
 * without a live status.
 */
function checkedSources(kinds: readonly CompanionConfigurableSource[] | undefined, startedAt: number): CheckedSource[] | null {
  const sources = statusSources();
  if (!sources) return null;
  return sources.filter((source) => (kinds ? kinds.includes(source.kind) : source.state !== 'disabled')).map((status): CheckedSource => {
    if (status.state === 'disabled') return { status, state: 'off' };
    if (status.lastPolledAt === null || status.lastPolledAt < startedAt) return { status, state: 'running' };
    return { status, state: sourceFailed(status) ? 'failed' : 'ok' };
  });
}

const CHECKED_WORDS: Record<Exclude<CheckedSource['state'], 'running'>, string> = { ok: 'ok', failed: 'failed', off: 'off in settings' };

/** What a check answers: its line, then what changed, the sources that failed and those off in settings, fenced as collector data. */
function checkAnswer(summary: string, events: readonly CheckedEvent[], failing: readonly CompanionSourceStatus[], at: number,
  off: readonly CompanionConfigurableSource[] = []): string {
  const lines = events.map(({ event, item }) => eventLine(event, item, at));
  return [
    summary,
    collectorData([
      fill('section.checked'), ...(lines.length > 0 ? lines : [fill('section.nothing')]),
      ...(failing.length > 0 ? [fill('section.sources'), ...failing.map((source) =>
        `- ${source.kind}: ${source.state}${source.detail ? ` — ${materialLine(source.detail, 200)}` : ''}`)] : []),
      ...(off.length > 0 ? [fill('section.sourcesOff', { sources: offSourcesText(off) })] : []),
    ]),
  ].join('\n\n');
}

const checkNowTool = companionTool({
  name: 'companion_check_now',
  label: 'Check sources now',
  description: fill('tool.companion_check_now', { waitSeconds: Math.round(COMPANION_CHECK_NOW_WAIT_MS / 1000) }),
  parameters: { object: {
    sources: f({ array: 'string' }, { optional: true, description: 'Local Michi activity only: use michi or omit this field. External collectors are not included.' }),
  } },
  run: async ({ ctx, args, now: startedAt, turn }) => {
    const input = parse(arg.object({
      sources: arg.optional(arg.list(arg.oneOf(COMPANION_CONFIGURABLE_SOURCES), { max: COMPANION_CONFIGURABLE_SOURCES.length })),
    }), args);
    const current = turn();
    if (current.origin === 'hidden') refuse(fill('result.checkInHiddenTurn'));
    const asked = input.sources && input.sources.length > 0 ? [...new Set(input.sources)] : undefined;
    // A source off in settings is not polled: say so at once instead of "checked: nothing changed" (conv-3).
    const offInSettings = companionSourcesOff(getCompanionSettings());
    const off = asked ? asked.filter((kind) => offInSettings.includes(kind)) : offInSettings;
    const kinds = asked ? asked.filter((kind) => !offInSettings.includes(kind)) : undefined;
    if ((kinds && kinds.length === 0) || (!kinds && off.length === COMPANION_CONFIGURABLE_SOURCES.length)) {
      return fill('result.sourcesOff', { sources: offSourcesText(off) });
    }
    const check = toolDeps.checkNow;
    if (!check) return unavailable('Checking sources on demand');
    const before = latestEventSeq();
    const running = check(kinds);
    running.catch(() => {});
    const waitMs = toolDeps.checkWaitMs ?? COMPANION_CHECK_NOW_WAIT_MS;
    const waiting = within(running, waitMs);
    // This turn's deep reads hold off until the check answers: its polls go first on the servers they share (H#2).
    const answered = waiting.then(() => {}, () => {});
    if (current.turnId) remember(checksByTurn, current.turnId, answered);
    let outcome: Awaited<typeof waiting>;
    try {
      outcome = await waiting;
    } finally {
      if (current.turnId && checksByTurn.get(current.turnId) === answered) checksByTurn.delete(current.turnId);
    }
    const at = now();
    const events = checkEvents(before);
    const changed = new Set(events.map(({ event }) => event.itemId)).size;
    const changes = changed > 0 ? `${plural(changed, 'item')} changed` : 'nothing changed';
    markUntrusted(ctx, current, 'companion_check_now', 'collector');
    if (outcome === 'timeout') {
      const waited = plural(Math.max(1, Math.round(waitMs / 1000)), 'second');
      const sources = checkedSources(kinds, startedAt);
      if (!sources) return checkAnswer(fill('result.checkPending', { waited, changes }), events, [], at, off);
      const still = sources.filter((source) => source.state === 'running');
      // With every source it covers finished (only the rest of the tick was still going), it answers as a finished check.
      if (still.length > 0) {
        const done = sources.filter((source) => source.state !== 'running');
        return checkAnswer(fill('result.checkPartial', {
          running: still.map((source) => source.status.kind).join(', '),
          waited,
          done: done.length > 0
            ? done.map((source) => `${source.status.kind} (${CHECKED_WORDS[source.state as Exclude<CheckedSource['state'], 'running'>]})`).join(', ')
            : 'none yet',
          changes,
        }), events, done.filter((source) => source.state === 'failed').map((source) => source.status), at, off);
      }
    }
    const failing = (statusSources() ?? []).filter((source) => (!kinds || kinds.includes(source.kind)) && sourceFailed(source));
    return checkAnswer(fill('result.checkFinished', { sources: kinds ? kinds.join(', ') : 'every enabled source', changes }), events, failing, at, off);
  },
});

// ── The user's direct requests, and a check-in's tidying ───────────────────

const UPDATE_ACTIONS = ['snooze', 'dismiss', 'mute', 'restore'] as const;

/** What an item's state is, for the record of a check-in's change (its Undo restores it). */
const itemState = (item: Pick<CompanionItemDto, 'status' | 'snoozedUntil'>) => ({ status: item.status, snoozedUntil: item.snoozedUntil });

const updateItemTool = companionTool({
  name: 'companion_update_item',
  label: () => `Update ${agentName()}'s Today item`,
  description: fill('tool.companion_update_item', {
    timeForms: COMPANION_TIME_FORMS, maxSnoozeDays: Math.round(COMPANION_MAX_SNOOZE_MS / DAY_MS), maxItems: COMPANION_CHECKIN_MAX_ITEM_CHANGES,
  }),
  parameters: { object: {
    itemId: f('string', { description: 'From companion_items or a note from Michi.' }),
    action: f('string', { enum: UPDATE_ACTIONS }),
    until: f('string', { optional: true, description: `snooze only: until when, ${COMPANION_TIME_FORMS}.` }),
    reason: f('string', { optional: true, description: 'In a check-in (required): one line the user sees beside the change.' }),
  } },
  sequential: true,
  acts: true,
  run: (call) => {
    const { args, now: at } = call;
    const checkin = call.purpose === 'checkin';
    if (!checkin) requireUserTurn(call.turn(), 'companion_update_item');
    const own = checkin ? checkinTurnOf(call) : null;
    if (checkin && !own) refuse(fill('result.unknownTurn', { tool: 'companion_update_item' }));
    const input = parse(arg.object({
      itemId: ID_ARG,
      action: arg.oneOf(UPDATE_ACTIONS),
      until: arg.optional(arg.any()),
      reason: arg.optional(arg.string()),
    }), args);
    // A check-in tidies Today; muting an object for good stays the user's (§2.3).
    if (checkin && input.action === 'mute') refuse(fill('result.checkinItemAction'));
    if (input.action === 'snooze' && input.until === undefined) refuse(`INVALID_ARGUMENT: until: snooze needs until (${COMPANION_TIME_FORMS})`);
    if (input.action !== 'snooze' && input.until !== undefined) refuse('INVALID_ARGUMENT: until: only snooze takes until');
    let until: number | undefined;
    if (input.action === 'snooze') {
      const parsed = parseCompanionTime(input.until, at);
      if (!parsed.ok) return refuse(`INVALID_ARGUMENT: until: ${parsed.problem}`);
      until = parsed.at;
    }
    const reason = checkin ? changeReason(input.reason) : null;
    // An item out of sight answers as an unknown one, as applyItemAction words it (its answer would name the item).
    const existing = getItem(input.itemId);
    if (existing && isCompanionItemHidden(existing)) throw notFound('Companion item not found');
    // Undoing the user's "never show this again" is the same decision as muting: theirs alone (§2.3, G1b-review #4).
    if (own && input.action === 'restore' && existing?.status === 'muted') refuse(fill('result.checkinUnmute'));
    // At most COMPANION_CHECKIN_MAX_ITEM_CHANGES items per check-in; one it already changed may change again (D5).
    const changedItems = own ? itemChangesByTurn.get(own.turnId) ?? new Set<string>() : null;
    if (changedItems && existing && !changedItems.has(existing.id) && changedItems.size >= COMPANION_CHECKIN_MAX_ITEM_CHANGES) {
      refuse(fill('result.itemChangeLimit', { max: COMPANION_CHECKIN_MAX_ITEM_CHANGES }));
    }
    const action: CompanionItemAction = input.action === 'snooze' ? { action: 'snooze', until: until! } : { action: input.action };
    let changed = false;
    const item = companionTransaction(() => {
      const updated = applyItemAction(input.itemId, action, at);
      changed = !existing || existing.status !== updated.status || existing.snoozedUntil !== updated.snoozedUntil;
      if (changed && own) {
        recordRunChange({
          runId: own.runId, targetKind: 'item', targetId: updated.id, before: itemState(existing!), after: itemState(updated),
          reason, action: input.action as CompanionPostChangeAction, now: at,
        });
      }
      return updated;
    });
    if (!changed) return fill('result.itemUnchanged', { what: `${quotedTitle(item.title)} is already ${item.status}` });
    if (own) {
      remember(itemChangesByTurn, own.turnId, new Set([...changedItems!, item.id]));
      noteCheckinWrite(own.turnId, { kind: 'item', id: item.id, applied: 1, proposed: 0, action: input.action as CompanionPostChangeAction, reason });
    }
    emit('items');
    const what = input.action === 'snooze' ? `snoozed ${quotedTitle(item.title)} until ${localTimeEchoText(until!)}`
      : `${quotedTitle(item.title)} is now ${item.status}`;
    return fill('result.itemUpdated', { what });
  },
});

const GOAL_ACTIONS = ['add', 'reword', 'remove'] as const;

const editGoalTool = companionTool({
  name: 'companion_edit_goal',
  label: 'Edit goal',
  description: fill('tool.companion_edit_goal', {
    maxChars: COMPANION_LIMITS.maxGoalChars, maxGoals: COMPANION_LIMITS.maxGoals, maxPerCheckin: COMPANION_LIMITS.checkinMaxGoalEdits,
  }),
  parameters: { object: {
    action: f('string', { enum: GOAL_ACTIONS }),
    goalId: f('string', { optional: true, description: 'reword and remove: from [YOUR GOALS].' }),
    text: f('string', { optional: true, description: 'add and reword: the goal, one line.' }),
    reason: f('string', { optional: true, description: 'In a check-in (required): one line the user sees beside the change.' }),
  } },
  sequential: true,
  acts: true,
  run: (call) => {
    const checkin = call.purpose === 'checkin';
    if (!checkin) requireUserTurn(call.turn(), 'companion_edit_goal');
    const own = checkin ? checkinTurnOf(call) : null;
    if (checkin && !own) refuse(fill('result.unknownTurn', { tool: 'companion_edit_goal' }));
    const input = parse(arg.object({
      action: arg.oneOf(GOAL_ACTIONS),
      goalId: arg.optional(ID_ARG),
      text: arg.optional(arg.string({ max: 2000 })),
      reason: arg.optional(arg.string()),
    }), call.args);
    if (input.action === 'add' && input.goalId !== undefined) refuse('INVALID_ARGUMENT: goalId: add makes a new goal; leave goalId out');
    if (input.action !== 'add' && input.goalId === undefined) refuse(`INVALID_ARGUMENT: goalId: ${input.action} needs the goal's id from [YOUR GOALS]`);
    if (input.action !== 'remove' && input.text === undefined) refuse(`INVALID_ARGUMENT: text: ${input.action} needs the goal's text`);
    if (input.action === 'remove' && input.text !== undefined) refuse('INVALID_ARGUMENT: text: remove takes no text');
    const reason = checkin ? changeReason(input.reason) : null;
    const used = own ? goalEditsByTurn.get(own.turnId) ?? 0 : 0;
    if (own && used >= COMPANION_LIMITS.checkinMaxGoalEdits) refuse(fill('result.goalEditLimit', { max: COMPANION_LIMITS.checkinMaxGoalEdits }));
    const before = input.goalId !== undefined ? getGoal(input.goalId) : null;
    if (input.goalId !== undefined && !before) throw notFound('Goal not found');
    const origin = writeOrigin(call);
    const goal = companionTransaction(() => {
      const edited = editGoal({
        action: input.action, ...(input.goalId !== undefined ? { id: input.goalId } : {}), ...(input.text !== undefined ? { text: input.text } : {}), origin,
      }, call.now);
      if (own) {
        recordRunChange({
          runId: own.runId, targetKind: 'goal', targetId: edited.id,
          before: before ? { text: before.text, textOrigin: before.textOrigin ?? 'user' } : null,
          after: input.action === 'remove' ? null : { text: edited.text, textOrigin: origin },
          reason, action: input.action, now: call.now,
        });
      }
      return edited;
    });
    if (own) {
      remember(goalEditsByTurn, own.turnId, used + 1);
      noteCheckinWrite(own.turnId, { kind: 'goal', id: goal.id, applied: 1, proposed: 0, action: input.action, reason });
    }
    emit('goals');
    const what = input.action === 'add' ? `added the goal ${quotedTitle(goal.text)}`
      : input.action === 'reword' ? `reworded the goal ${goal.id} to ${quotedTitle(goal.text)}`
        : `removed the goal ${quotedTitle(before!.text)}`;
    return fill('result.goalEdited', { what });
  },
});

const setNameTool = companionTool({
  name: 'companion_set_name',
  label: () => `Rename ${agentName()}`,
  description: fill('tool.companion_set_name', { maxChars: COMPANION_NAME_MAX_CHARS }),
  parameters: { object: { name: f('string', { description: 'The name the user asked for.' }) } },
  sequential: true,
  run: ({ args, now: at, turn }) => {
    requireUserTurn(turn(), 'companion_set_name');
    const { name } = parse(arg.object({ name: arg.string({ max: 200 }) }), args);
    const previous = getCompanionSettings().displayName;
    const settings = patchCompanionSettings({ displayName: name }, at);
    emit('settings');
    return fill('result.nameSet', { name: settings.displayName, previous });
  },
});

/** Each level as Settings › Notifications shows it (NotificationsPane.tsx NOTIFICATION_OPTIONS). */
const NOTIFICATION_LEVEL_LABELS: Readonly<Record<ChatNotificationLevel, string>> = Object.freeze({
  all: 'All', 'approval-only': 'Only when something needs me', off: 'Off',
});

/** The user's one level (Settings › Notifications), for every window and the desktop notifier. */
const setNotificationsTool = companionTool({
  name: 'companion_set_notifications',
  label: () => 'Change notifications',
  description: fill('tool.companion_set_notifications'),
  parameters: { object: { level: f('string', { enum: CHAT_NOTIFICATION_LEVELS }) } },
  sequential: true,
  run: ({ args, turn }) => {
    requireUserTurn(turn(), 'companion_set_notifications');
    const { level } = parse(arg.object({ level: arg.oneOf(CHAT_NOTIFICATION_LEVELS) }), args);
    const previous = changeUserNotificationLevel(level);
    emit('notifications');
    return fill('result.notificationsSet', { level: NOTIFICATION_LEVEL_LABELS[level], previous: NOTIFICATION_LEVEL_LABELS[previous] });
  },
});

// ── The Companion's own state ───────────────────────────────────────────────

const saveNotesTool = companionTool({
  name: 'companion_save_notes',
  label: () => `Save ${agentName()}'s notes`,
  description: fill('tool.companion_save_notes', { maxChars: COMPANION_LIMITS.maxNotesChars }),
  parameters: { object: {
    notes: f('string', { description: 'The whole new notes; empty clears them.' }),
    expectedRevision: f('integer', { description: 'The revision of the notes you read.' }),
  } },
  sequential: true,
  acts: true,
  run: (call) => {
    const input = parse(arg.object({ notes: arg.string(), expectedRevision: arg.int({ min: 0 }) }), call.args);
    try {
      // Who wrote them (§2.8 T1): only an untainted user turn's notes go back into [COMPANION CONTEXT].
      const saved = setNotesByCompanion(input.notes, input.expectedRevision, writeOrigin(call));
      emit('notes');
      return fill('result.notesSaved', { revision: saved.notesRevision });
    } catch (error) {
      if (!(error instanceof CompanionError) || error.code !== 'notes_conflict') throw error;
      const current = getCompanionNotesState();
      return refuse(fill('result.notesConflict', {
        revision: current.notesRevision,
        notes: materialBlock(current.notes, COMPANION_LIMITS.maxNotesChars + 100) || '(empty)',
      }));
    }
  },
});

const goalProgressTool = companionTool({
  name: 'companion_goal_progress',
  label: 'Record goal progress',
  description: fill('tool.companion_goal_progress', { maxChars: COMPANION_GOAL_PROGRESS_MAX_CHARS }),
  parameters: { object: {
    goalId: f('string', { description: 'From [YOUR GOALS].' }),
    progress: f('string', { description: `The reading, at most ${COMPANION_GOAL_PROGRESS_MAX_CHARS} characters.` }),
  } },
  sequential: true,
  acts: true,
  run: ({ args, now: at }) => {
    const input = parse(arg.object({ goalId: ID_ARG, progress: arg.string() }), args);
    const goal = recordGoalProgress(input.goalId, input.progress, at);
    emit('goals');
    return fill('result.progressSaved', { goal: quotedTitle(goal.text) });
  },
});

const proposeTool = companionTool({
  name: 'companion_propose',
  label: 'Propose a change',
  description: fill('tool.companion_propose', {
    maxPerTurn: COMPANION_MAX_CARDS_PER_TURN,
    maxPending: COMPANION_MAX_PENDING_CARDS,
    timeForms: COMPANION_TIME_FORMS,
    maxSendChars: COMPANION_LIMITS.maxSendChars,
  }),
  parameters: { object: {
    kind: f('string', { enum: COMPANION_CARD_KINDS }),
    payload: f({ object: {}, additionalProperties: true }, { description: 'The kind\'s payload, as listed above.' }),
    reason: f('string', { optional: true, description: 'One sentence for the card: why you propose it.' }),
  } },
  sequential: true,
  acts: true,
  run: async (call) => {
    const { args, now: at, turn, purpose } = call;
    const input = parse(arg.object({ kind: arg.oneOf(COMPANION_CARD_KINDS), payload: arg.any(), reason: arg.optional(arg.string()) }), args);
    const current = turn();
    if (!current.turnId) refuse(fill('result.unknownTurn', { tool: 'companion_propose' }));
    // Only the user's own words lead to a rule, a reminder, a watch or a conversation (R2.15, rule 9).
    if (current.origin === 'hidden' && COMPANION_USER_ONLY_CARD_KINDS.has(input.kind)) refuse(fill('result.cardInHiddenTurn', { kind: input.kind }));
    const followUps = input.kind === 'session.send' && current.origin === 'hidden' ? checkinSendsByTurn.get(current.turnId!) ?? 0 : null;
    if (followUps !== null && followUps >= COMPANION_LIMITS.maxSessionSendsPerCheckin) {
      refuse(fill('result.checkinSendLimit', { max: COMPANION_LIMITS.maxSessionSendsPerCheckin }));
    }
    // Q1, D15: a check-in sends a follow-up itself into a conversation that runs in exactly Ask on a runtime
    // whose gate Michi holds; any other gets the card.
    const own = followUps !== null && purpose === 'checkin' ? checkinTurnOf(call) : null;
    if (own) {
      const sent = await checkinSendsItself(input.payload, at, own.runId);
      if (sent) {
        remember(checkinSendsByTurn, current.turnId!, followUps! + 1);
        remember(checkinSentByTurn, current.turnId!, [...(checkinSentByTurn.get(current.turnId!) ?? []), sent.title]);
        // D21: the user always hears of it: the check-in's reply or Michi's receipt lists it, superseded or not.
        noteCheckinWrite(own.turnId, { kind: 'send', id: sent.nodeId, title: sent.title, applied: 1, proposed: 0 });
        emit('activity');
        return fill('result.checkinSent', { title: quotedTitle(sent.title), link: `michi://node/${sent.nodeId}` });
      }
    }
    const proposed = proposalsByTurn.get(current.turnId!) ?? 0;
    if (proposed >= COMPANION_MAX_CARDS_PER_TURN) refuse(fill('result.cardLimit', { max: COMPANION_MAX_CARDS_PER_TURN }));
    // A reminder or watch about an item out of sight answers as one about an unknown item (B15).
    const itemId = isPlainObject(input.payload) ? input.payload.itemId : undefined;
    const item = typeof itemId === 'string' ? getItem(itemId) : null;
    if (item && isCompanionItemHidden(item)) throw notFound('That item does not exist');
    const card = proposeCompanionCard({ kind: input.kind, payload: input.payload, reason: input.reason }, at);
    remember(proposalsByTurn, current.turnId!, proposed + 1);
    if (followUps !== null) remember(checkinSendsByTurn, current.turnId!, followUps + 1);
    emit('cards');
    return fill('result.cardShown', { summary: card.summary, button: companionCardButtonLabel(card.kind) });
  },
});

/**
 * A check-in's follow-up when its target runs in exactly Ask on a runtime
 * whose approval gate Michi holds for a tainted turn (DESIGN-v2 Q1, w3-fix
 * D15): sent at once (via `checkin`, re-checked right before it goes out,
 * its turn recorded as check-in material), and the result names where it
 * went. Null when the target runs in any other mode or on another runtime,
 * or when its turn could not be recorded as check-in material: the caller
 * proposes the session.send card instead (which checks the payload itself).
 * A target that cannot take it now (gone, busy, waiting on the user, its
 * day's follow-ups used) refuses the call.
 */
async function checkinSendsItself(payload: unknown, at: number, checkinRunId: string): Promise<CompanionSendResult | null> {
  if (!isPlainObject(payload) || typeof payload.nodeId !== 'string' || typeof payload.text !== 'string') return null;
  const nodeId = payload.nodeId.trim();
  try {
    const target = companionSendTarget(nodeId, at);
    if (!companionCheckinSendsDirectly(target)) return null;
    if (payload.afterMessageId !== undefined && payload.afterMessageId !== target.latestReplyId) {
      refuse(fill('result.sendMovedOn'));
    }
    return await deliverCompanionMessage({ nodeId, text: payload.text, via: 'checkin', now: at, afterMessageId: target.latestReplyId, checkinRunId });
  } catch (error) {
    if (error instanceof CompanionSendRefusal) {
      if (COMPANION_SEND_CARD_INSTEAD.has(error.code)) return null;
      return refuse(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

// ── Follow-ups (DESIGN-v2 §4) ───────────────────────────────────────────────

const sessionSendTool = companionTool({
  name: 'companion_session_send',
  label: 'Send a follow-up',
  description: fill('tool.companion_session_send', {
    maxChars: COMPANION_LIMITS.maxSendChars,
    maxPerTurn: COMPANION_LIMITS.maxSessionSendsPerTurn,
    maxDaily: COMPANION_LIMITS.maxDailySendsPerDelegation,
  }),
  parameters: { object: {
    conversation: f('string', { description: 'The node id of a conversation you started: from start_conversation, a worker report or its michi://node/ link.' }),
    text: f('string', { description: `The exact message, at most ${COMPANION_LIMITS.maxSendChars} characters. The user approves it as written.` }),
  } },
  sequential: true,
  acts: true,
  run: async ({ ctx, args, turn }) => {
    const current = turn();
    requireUserTurn(current, 'companion_session_send');
    const input = parse(arg.object({ conversation: arg.string({ trim: true, min: 1, max: 160 }), text: arg.string() }), args);
    const used = sessionSendsByTurn.get(current.turnId!) ?? 0;
    if (used >= COMPANION_LIMITS.maxSessionSendsPerTurn) refuse(fill('result.sendLimit', { max: COMPANION_LIMITS.maxSessionSendsPerTurn }));
    const caller = { ownerUserId: ctx.ownerUserId, workspaceId: ctx.workspaceId ?? '', nodeId: ctx.nodeId! };
    const sendInput = () => ({ nodeId: input.conversation, text: input.text, via: 'user' as const, now: now(), caller });
    const asRefusal = <T>(work: () => T): T => {
      try {
        return work();
      } catch (error) {
        if (error instanceof CompanionSendRefusal) return refuse(`${error.code}: ${error.message}`);
        throw error;
      }
    };
    const { target, body } = asRefusal(() => checkCompanionSend(sendInput()));
    remember(sessionSendsByTurn, current.turnId!, used + 1);
    // D22: "stop asking" holds only while the conversation runs no wider than when the user chose it, and never when Michi cannot read how it runs.
    const widened = target.delegation.autoSend ? companionAutoSendAskReason(target.delegation.autoSendChoice, target.permission) : null;
    // D19 (replaces D3): a turn that read outside content no longer asks for that alone; a message it sends unasked
    // carries that content to the conversation, whose network and credential reads then ask (services/turnGuard.ts).
    const asks = !target.delegation.autoSend || widened !== null;
    const passedOutside = !asks && turnHoldsOutsideContent({ nodeId: ctx.nodeId!, turnId: current.turnId! });
    if (asks) {
      const askReason = target.delegation.autoSend ? widened : null;
      const approval = await ctx.approveThreadMessage({
        targetNodeId: target.node.id,
        targetTitle: target.title,
        targetWorkspaceName: target.workspaceName,
        text: body,
        exact: true,
        permissionNote: companionTargetPermissionLine(target.permission),
        ...(askReason ? { askReason } : {}),
        offerStopAsking: true,
      });
      if (!approval.approved) {
        if (approval.reason === 'unavailable') refuse(fill('result.sendApprovalUnavailable'));
        return fill(approval.reason === 'no_answer' ? 'result.sendNoAnswer' : 'result.sendDeclined', {
          title: quotedTitle(target.title),
          note: approval.note ? ` The user wrote: ${materialLine(approval.note, 500)}` : '',
        });
      }
      // Stored with the choice the question named; one Michi could not read is never one it stops asking under.
      if (approval.stopAsking && target.permission !== null) setDelegationAutoSend(target.delegation.id, target.permission);
    }
    let sent: CompanionSendResult;
    try {
      // What the user approved: the conversation as it was asked about, in a mode no wider than the question named.
      sent = await deliverCompanionMessage({
        ...sendInput(),
        ...(passedOutside ? { passedOutside } : {}),
        afterMessageId: target.latestReplyId,
        ...(target.permission ? { notWiderThan: target.permission } : {}),
      });
    } catch (error) {
      if (error instanceof CompanionSendRefusal) return refuse(`${error.code}: ${error.message}`);
      throw error;
    }
    emit('activity');
    return fill('result.sendSent', { title: quotedTitle(sent.title), link: `michi://node/${sent.nodeId}` });
  },
});

const publishBriefTool = companionTool({
  name: 'companion_publish_brief',
  label: 'Publish brief',
  description: fill('tool.companion_publish_brief', { maxCards: COMPANION_LIMITS.maxBriefCards }),
  parameters: { object: {
    headline: f('string', { description: 'One line: what today is about.' }),
    cards: f({ array: { object: {
      title: f('string'),
      body: f('string', { description: 'What it is and why it matters today.' }),
      itemIds: f({ array: 'string' }, { optional: true, description: 'Ids of the items the card is about.' }),
      action: f({ object: { label: f('string'), prompt: f('string') } }, { optional: true, description: 'A button that puts prompt into this chat.' }),
    } } }, { description: `At most ${COMPANION_LIMITS.maxBriefCards}, most important first.` }),
    closing: f('string', { description: 'One sentence that ends the brief.' }),
  } },
  sequential: true,
  acts: true,
  run: (call) => {
    const { args, now: at, turn } = call;
    const input = parse(arg.object({
      headline: arg.string(),
      cards: arg.list(arg.object({
        title: arg.string(),
        body: arg.string(),
        itemIds: arg.optional(arg.list(ID_ARG, { max: 10 })),
        action: arg.optional(arg.nullable(arg.object({ label: arg.string(), prompt: arg.string() }))),
      }), { max: COMPANION_LIMITS.maxBriefCards }),
      closing: arg.string(),
    }), args);
    const unknown = [...new Set(input.cards.flatMap((card) => card.itemIds ?? []))].filter((id) => !visibleItem(id));
    if (unknown.length > 0) {
      refuse(`INVALID_ARGUMENT: cards: unknown item ${unknown.slice(0, 5).map((id) => materialLine(id, 160)).join(', ')}; use item ids from Michi's data`);
    }
    if (call.purpose === 'checkin') {
      // D5: a check-in's brief goes out only while what its memory pack showed holds.
      const own = checkinTurnOf(call);
      if (!own) refuse(fill('result.unknownTurn', { tool: 'companion_publish_brief' }));
      if (!checkinMemoryHolds(own!.runId)) refuse(`WITHDRAWN: ${CHECKIN_WITHDRAWN_MESSAGE}`);
    }
    const own = call.purpose === 'checkin' ? checkinTurnOf(call) : null;
    const brief = insertBrief({
      date: localDateKey(at),
      headline: input.headline,
      cards: input.cards.map((card) => ({ title: card.title, body: card.body, itemIds: card.itemIds ?? [], action: card.action ?? null })),
      closing: input.closing,
      origin: 'llm',
      now: at,
    });
    if (!brief) refuse(fill('result.briefExists'));
    const hidden = own ? hiddenTurns.get(own.turnId) : undefined;
    if (hidden) hidden.briefHeadline = materialLine(input.headline, COMPANION_LIMITS.maxHeadlineChars) || null;
    // The user's "Tomorrow, focus on…" was for this brief.
    if (turn().kind === 'brief') setBriefCurate('');
    emit('brief');
    return fill('result.briefPublished', { cards: plural(brief!.cards.length, 'card') });
  },
});

// ── Michi's line for Home ───────────────────────────────────────────────────

const headlineTool = companionTool({
  name: 'companion_headline',
  label: 'Headline',
  description: fill('tool.companion_headline', { max: COMPANION_LIMITS.maxHeadlineChars }),
  parameters: { object: {
    text: f('string', { description: `One line, at most ${COMPANION_LIMITS.maxHeadlineChars} characters.` }),
  } },
  run: ({ args, turn }) => {
    const { text } = parse(arg.object({ text: arg.string() }), args);
    const current = turn();
    // Only a check-in writes it: V's turns answer the user, who reads them there.
    const hidden = current.origin === 'hidden' && current.turnId ? hiddenTurns.get(current.turnId) : undefined;
    if (!hidden) refuse(fill('result.unknownTurn', { tool: 'companion_headline' }));
    const line = materialLine(text, COMPANION_LIMITS.maxHeadlineChars);
    if (!line) refuse('INVALID_ARGUMENT: text: one line');
    hidden!.headline = line;
    return fill('result.headline');
  },
});

// ── The quiet end ───────────────────────────────────────────────────────────

const nothingToDoTool = companionTool({
  name: 'nothing_to_do',
  label: 'Nothing to do',
  description: fill('tool.nothing_to_do'),
  parameters: { object: {
    note: f('string', { optional: true, description: 'One line for the activity log, e.g. "no change worth a message".' }),
  } },
  run: ({ args, turn }) => {
    const { note } = parse(arg.object({ note: arg.optional(arg.string()) }), args);
    const current = turn();
    // A person is waiting on a turn they started; a turn Michi cannot attribute is not proof of one.
    if (current.origin === 'user') refuse(fill('result.userTurn'));
    if (current.kind === 'welcome') refuse(fill('result.welcomeTurn'));
    // A follow-up it sent itself is news the user has not seen (§4, Q1): said first, as it is the most specific.
    const sent = current.origin === 'hidden' && current.turnId ? checkinSentByTurn.get(current.turnId) ?? [] : [];
    if (sent.length > 0) refuse(fill('result.sentSoSpeak', { conversations: sent.map(quotedTitle).join(', ') }));
    // A check-in that changed the user's content must say so (§3.4).
    const changes = current.origin === 'hidden' && current.turnId ? checkinWritesOf(current.turnId) : [];
    if (changes.length > 0) refuse(fill('result.changedSoSpeak', { changes: companionChangesText(changes) }));
    // Only a hidden turn conversation.ts registered ends quiet: it hides the turn's message and sends no notice.
    const hidden = current.origin === 'hidden' && current.turnId ? hiddenTurns.get(current.turnId) : undefined;
    if (hidden) {
      hidden.quietEnd = true;
      if (note && materialLine(note, QUIET_NOTE_MAX_CHARS)) hidden.quietNote = materialLine(note, QUIET_NOTE_MAX_CHARS);
    }
    return fill('result.quiet');
  },
});

/**
 * The agent's own tools, in COMPANION_OWN_TOOL_NAMES order (assistant/policy.ts);
 * assistant/tools.ts serves each in the catalogs that list it
 * (MAIN_TOOL_NAMES, CHECKIN_TOOL_NAMES).
 */
export const COMPANION_OWN_TOOLS: readonly AssistantTool[] = Object.freeze([
  itemsTool,
  itemTool,
  checkNowTool,
  updateItemTool,
  saveNotesTool,
  goalProgressTool,
  editGoalTool,
  proposeTool,
  publishBriefTool,
  setNameTool,
  setNotificationsTool,
  readTool,
  sessionSendTool,
  headlineTool,
  nothingToDoTool,
]);
