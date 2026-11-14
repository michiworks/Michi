import { COMPANION_LIMITS } from './companionConstants';

/**
 * The Companion's fields of DurableMessageMetadata (chatStreamEvents.ts):
 * `companionPost` (a check-in's post), `companionSend` (a follow-up the agent
 * sent) and `companionTurn` (what the route decided about a user message to
 * the agent), with their parsers and the types they name. chatStreamEvents.ts
 * imports them, and the runtime package vendors it with every module it
 * imports, so this module imports only companionConstants.ts, never
 * companion.ts (W0b recheck A-2). companion.ts re-exports all of it.
 */

// ── The runs a post names (DESIGN-v2 §3.1, §4) ──────────────────────────────

export type CompanionRunKind =
  | 'poll'
  | 'heartbeat'
  | 'brief'
  | 'welcome'
  | 'catch_up'
  | 'worker_report'
  | 'wake'
  /**
   * One follow-up delivered into a delegated conversation, from
   * companion_session_send, an applied `session.send` card or (Q1) a
   * check-in's direct send to a target whose permission choice is exactly
   * `ask` (DESIGN-v2 §4). Not a model turn of the agent's own; its turn in
   * the target is `cms-<runId>`
   * (companionSendTurnId). W3-G2 records it; Activity (W2-F2) lists it.
   */
  | 'send';

/**
 * The runs that are turns of the agent's own, each a check-in in a fresh
 * throwaway node and session (DESIGN-v2 §3.1): every run kind but polls and
 * sends (catch-ups are deterministic now, but stay a turn kind as before).
 * CompanionPostMetadata.kind names one. Backend services/companion/types.ts
 * CompanionTurnKind is `Exclude<CompanionRunKind, 'poll'>`, which now also
 * takes 'send'; W2-G1a can narrow it to this type.
 */
export type CompanionCheckinKind = Exclude<CompanionRunKind, 'poll' | 'send'>;

export const COMPANION_CHECKIN_KINDS: readonly CompanionCheckinKind[] = Object.freeze([
  'heartbeat', 'brief', 'welcome', 'catch_up', 'worker_report', 'wake',
]);

// ── companionPost: posted check-ins (DESIGN-v2 §3.3, §3.4) ──────────────────

/**
 * The kinds of target a posted check-in reports changing, or (`send`) a
 * conversation it sent a follow-up into itself (DESIGN-v2 Q1, w3-fix D21:
 * always reported, by its reply or Michi's receipt, superseded or not).
 */
export type CompanionPostChangeKind = 'page' | 'database' | 'item' | 'goal' | 'send';

export const COMPANION_POST_CHANGE_KINDS: readonly CompanionPostChangeKind[] = Object.freeze(['page', 'database', 'item', 'goal', 'send']);

/**
 * What a check-in did to a Today item (snooze, dismiss, restore: the
 * companion_update_item actions it may use) or a goal (add, reword, remove:
 * companion_edit_goal), so a receipt can say "snoozed 1 item and reworded 1
 * goal" (DESIGN-v2 §3.4). Pages and databases have none: their counts say it.
 */
export type CompanionPostChangeAction = 'snooze' | 'dismiss' | 'restore' | 'add' | 'reword' | 'remove';

export const COMPANION_ITEM_CHANGE_ACTIONS: readonly CompanionPostChangeAction[] = Object.freeze(['snooze', 'dismiss', 'restore']);
export const COMPANION_GOAL_CHANGE_ACTIONS: readonly CompanionPostChangeAction[] = Object.freeze(['add', 'reword', 'remove']);

/** The actions a check-in can take on a target of this kind (none for pages, databases and sends). */
export function companionChangeActionsFor(kind: CompanionPostChangeKind): readonly CompanionPostChangeAction[] {
  return kind === 'item' ? COMPANION_ITEM_CHANGE_ACTIONS : kind === 'goal' ? COMPANION_GOAL_CHANGE_ACTIONS : [];
}

/**
 * One target a check-in changed, as its posted message lists it: the receipt
 * under the message and its "Undo all" (POST /companion/runs/:runId/undo)
 * read these (DESIGN-v2 §3.3, §3.4). A `send` is a follow-up the check-in
 * sent itself into a conversation the agent follows (Q1, D21): it went out,
 * so "Undo all" cannot take it back.
 */
export interface CompanionPostChange {
  kind: CompanionPostChangeKind;
  /** The page, database, Today item or goal; for a `send`, the conversation's node id. */
  id: string;
  /**
   * The page's or database's title, only when it existed before the check-in
   * (§2.8 T1: a title the check-in wrote is check-in material). Absent for
   * Today items, goals and whatever the check-in created. A `send`: the
   * conversation's title as Michi read it when it sent (one line).
   */
  title?: string;
  /** Changes applied directly (a `send`: 1, the follow-up that went out). */
  applied: number;
  /** Changes left as proposals for the user to review. */
  proposed: number;
  /** Items and goals: what the check-in did (companionChangeActionsFor(kind)). */
  action?: CompanionPostChangeAction;
  /**
   * Items and goals: the check-in's reason, at most
   * COMPANION_LIMITS.maxChangeReasonChars ("Dismissed by <name> — <reason>",
   * §2.7). Check-in material: shown to the user, never put in the agent's
   * context, nor in a rebuilt session's one-line stub of the post (§2.8 T1, T2).
   */
  reason?: string;
}

/**
 * `DurableMessageMetadata.companionPost`: the assistant message is one a
 * check-in posted into the conversation (chatHub.postSelfMessage, DESIGN-v2
 * §3.3), not a reply to the user; its id is `cmp-post-<runId>` and its turn
 * has no user message. Its text is check-in material: the turn that posts it
 * is marked untrusted, a rebuilt session replays it as a one-line fact, never
 * its text (§2.8 T2), and its follow-up chips only fill the composer (T3).
 * Rendered as "<name> · check-in" ("morning brief", "worker update" by kind)
 * with a receipt of `changes` and no tool rows. W2-G1a writes it
 * (services/companion/posts.ts); W1-B replays it; W2-F1a renders it.
 */
export interface CompanionPostMetadata {
  runId: string;
  /** The run's kind: which label the speaker line takes. */
  kind: CompanionCheckinKind;
  /** What the run changed in the user's Pages, databases, Today and goals; empty when it only spoke. */
  changes: CompanionPostChange[];
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Reads `companionPost` from stored or streamed metadata: undefined unless it
 * names a run and a check-in kind. A change entry of another shape is
 * dropped, so one bad entry does not hide the rest of the receipt; within an
 * entry, an action its kind cannot take, and a reason without a valid action
 * or empty or too long, are dropped the same way.
 */
export function parseCompanionPostMetadata(value: unknown): CompanionPostMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || !raw.runId) return undefined;
  if (!(COMPANION_CHECKIN_KINDS as readonly unknown[]).includes(raw.kind)) return undefined;
  const changes: CompanionPostChange[] = [];
  for (const entry of Array.isArray(raw.changes) ? raw.changes : []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const change = entry as Record<string, unknown>;
    if (!(COMPANION_POST_CHANGE_KINDS as readonly unknown[]).includes(change.kind) || typeof change.id !== 'string' || !change.id
      || !isCount(change.applied) || !isCount(change.proposed)) continue;
    const kind = change.kind as CompanionPostChangeKind;
    const action = (companionChangeActionsFor(kind) as readonly unknown[]).includes(change.action) ? change.action as CompanionPostChangeAction : undefined;
    const reason = action && typeof change.reason === 'string' && change.reason.trim() && change.reason.length <= COMPANION_LIMITS.maxChangeReasonChars
      ? change.reason : undefined;
    changes.push({
      kind,
      id: change.id,
      ...(typeof change.title === 'string' && change.title ? { title: change.title } : {}),
      applied: change.applied,
      proposed: change.proposed,
      ...(action ? { action } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return { runId: raw.runId, kind: raw.kind as CompanionCheckinKind, changes };
}

// ── companionSend: the agent's follow-ups into conversations it started (DESIGN-v2 §4) ──
// The text they carry is formatted and checked in companionThreadMessage.ts.

/**
 * Why a follow-up went out: `user` = companion_session_send in the user's own
 * turn (after the user approved its exact text, or with "stop asking" on for
 * that conversation); `card` = the user applied a `session.send` card, i.e.
 * approved this exact text; `checkin` = a check-in sent it on its own, which
 * it may do only to a conversation whose permission choice is exactly `ask`
 * (DESIGN-v2 Q1, companionCheckinMaySendDirectly), so the user has not seen
 * it. The header says which, so the worker never takes more backing from it
 * than the user gave.
 */
export type CompanionSendVia = 'user' | 'card' | 'checkin';

export const COMPANION_SEND_VIAS: readonly CompanionSendVia[] = Object.freeze(['user', 'card', 'checkin']);

/**
 * `DurableMessageMetadata.companionSend`: this user message in a delegated
 * conversation is a follow-up the agent sent (DESIGN-v2 §4), stored beside
 * `threadMessage: {fromNodeId: <the agent's conversation>, fromTitle: <name>}`.
 * The run is the `send` run that delivered it (turn `cms-<runId>`). The
 * Michi source's "the user took over" rule ignores user messages that carry
 * it (W3-G2); the worker's message list shows "From <name>" (W3-F3).
 */
export interface CompanionSendSource {
  runId: string;
  via: CompanionSendVia;
}

/** Validates `companionSend` from persisted or streamed metadata. */
export function parseCompanionSendSource(value: unknown): CompanionSendSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.runId !== 'string' || !raw.runId) return undefined;
  if (!(COMPANION_SEND_VIAS as readonly unknown[]).includes(raw.via)) return undefined;
  return { runId: raw.runId, via: raw.via as CompanionSendVia };
}

// ── companionTurn: what a message to the agent started with (DESIGN-v2 §1.3, §2.8 T4) ──

/**
 * The kind of untrusted material a turn started with or read (DESIGN-v2 §2.8
 * T4, T5): `checkin` = text a check-in wrote (posts, notes, goal readings and
 * reworded goals, the brief, card summaries, blocks and rows it wrote);
 * `collector` = what a source brought in (item titles, mail, CR text). It is
 * the `detail` W2-E records with recordUntrustedSource, and what
 * CompanionTurnMetadata.startTaint names.
 */
export type CompanionTaintDetail = 'checkin' | 'collector';

export const COMPANION_TAINT_DETAILS: readonly CompanionTaintDetail[] = Object.freeze(['checkin', 'collector']);

/**
 * `DurableMessageMetadata.companionTurn`: what the route decided about a user
 * message to the agent before its turn started (DESIGN-v2 §1.3, §2.8 T4),
 * each shown as one line under the message by W2-F1a:
 * - `rulesUnavailable`: "<name> couldn't read your rules, so it won't act on
 *   its own this turn." The turn ran without [COMPANION CONTEXT] and the
 *   agent's action tools refused (§1.3).
 * - `startTaint`: "Anything that would leave this machine asks first: this
 *   turn includes check-in material." The message referred to check-in or
 *   collector material (metaAgentContext.refs, a reply to a post), so the
 *   turn is guarded (T4, D19): what leaves the machine asks whatever the
 *   mode; `checkin` when it referred to both.
 * - `carriedTaint`: "Anything that would leave this machine asks first: this
 *   conversation read check-in material earlier." An earlier turn on the same
 *   live session took such material in, so this one is guarded too (w2-fix
 *   D1). Set only when `startTaint` is not.
 * W2-E (routes/michi.ts) writes it on the user message it hands to
 * chatHub.startTurn, so turn_start.userMetadata carries it to every window
 * and the stored row keeps it; the route drops a client's own
 * `userMetadata.companionTurn`. The lines say what happened; the permission
 * change itself is the untrusted source the route records.
 */
export interface CompanionTurnMetadata {
  rulesUnavailable?: true;
  startTaint?: CompanionTaintDetail;
  carriedTaint?: CompanionTaintDetail;
}

/** Reads `companionTurn` from stored or streamed metadata: undefined unless it says something. */
export function parseCompanionTurnMetadata(value: unknown): CompanionTurnMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const taint = (field: unknown) => (COMPANION_TAINT_DETAILS as readonly unknown[]).includes(field) ? field as CompanionTaintDetail : undefined;
  const startTaint = taint(raw.startTaint);
  const carriedTaint = startTaint ? undefined : taint(raw.carriedTaint);
  if (raw.rulesUnavailable !== true && !startTaint && !carriedTaint) return undefined;
  return {
    ...(raw.rulesUnavailable === true ? { rulesUnavailable: true as const } : {}),
    ...(startTaint ? { startTaint } : {}),
    ...(carriedTaint ? { carriedTaint } : {}),
  };
}
