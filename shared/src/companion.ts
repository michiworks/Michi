import type { MichiAssistantInfo } from './assistant';
import { isChatPermissionChoice, type ChatPermissionChoice } from './chatPermissions';
import { DEFAULT_COMPANION_NAME } from './companionConstants';
import type { CompanionCheckinKind, CompanionPostChange, CompanionPostChangeAction, CompanionRunKind } from './companionMessageMetadata';
import type { CompanionStatusLine } from './companionStatus';
import type { RuntimeReasoning } from './reasoning';

// CompanionTurnRef and its parser moved to metaAgentChat.ts, beside the
// metaAgentContext parser that reads `refs` (W0 review #2); they are still
// exported from here.
export { COMPANION_TURN_REF_LIMITS, parseCompanionTurnRefs, type CompanionTurnRef } from './metaAgentChat';

// W0b recheck A-2: the default name and the limits (companionConstants.ts),
// the message metadata companionPost, companionSend and companionTurn with
// the types and parsers they need (companionMessageMetadata.ts), and the
// follow-ups' text check and format, formerly in threadMessage.ts
// (companionThreadMessage.ts), live in modules that import nothing from this
// one. chatStreamEvents.ts imports the metadata, and the runtime package
// vendors it with every module it imports, so none of them may load this
// module (or assistant, metaAgentChat, pages). They are still exported from here.
export { COMPANION_LIMITS, DEFAULT_COMPANION_NAME } from './companionConstants';
export {
  COMPANION_CHECKIN_KINDS,
  COMPANION_GOAL_CHANGE_ACTIONS,
  COMPANION_ITEM_CHANGE_ACTIONS,
  COMPANION_POST_CHANGE_KINDS,
  COMPANION_SEND_VIAS,
  COMPANION_TAINT_DETAILS,
  companionChangeActionsFor,
  parseCompanionPostMetadata,
  parseCompanionSendSource,
  parseCompanionTurnMetadata,
  type CompanionCheckinKind,
  type CompanionPostChange,
  type CompanionPostChangeAction,
  type CompanionPostChangeKind,
  type CompanionPostMetadata,
  type CompanionRunKind,
  type CompanionSendSource,
  type CompanionSendVia,
  type CompanionTaintDetail,
  type CompanionTurnMetadata,
} from './companionMessageMetadata';
export {
  checkCompanionSendText,
  companionCheckinMaySendDirectly,
  companionMessageBody,
  formatCompanionThreadMessage,
  parseCompanionThreadMessage,
  type CompanionSendTextCheck,
  type CompanionSendTextProblem,
} from './companionThreadMessage';

/**
 * Companion: Michi's global, proactive agent.
 *
 * Two layers share these contracts:
 * - a deterministic signal layer in the backend polls local Michi activity,
 *   diffs what it sees and keeps one feed item per watched object;
 *   external source contracts remain for persisted data and injected sources,
 *   but this build bundles no external collectors;
 * - an LLM layer speaks in the Companion's own pinned conversation only when
 *   there is new material (heartbeat, morning brief, catch-up, worker report),
 *   and ends quietly with `nothing_to_do` otherwise.
 *
 * The Companion exists only in the local desktop app (never in cloud mode).
 *
 * v2 merges it with the ⌘J
 * assistant: one panel and one visible conversation V (the user's own turns,
 * with the user's runtime tools and permissions), while every hidden turn is
 * a check-in that runs in a throwaway node S (CHECKIN_NODE_PREFIX) with a
 * fresh, closed session and posts into V only what it said or changed
 * (CompanionPostMetadata). The v2 contracts below were added in wave W0 and
 * were additive; the W2 merge removed the MVP ones they replaced (the
 * 'meta-agent' actor, quietMessageIds).
 */

/** Where a feed item came from. `system` = the Companion's own health (Auth, a broken source). */
export type CompanionSourceKind = 'michi' | 'cr' | 'pipeline' | 'email' | 'calendar' | 'system';

export const COMPANION_SOURCE_KINDS: readonly CompanionSourceKind[] = Object.freeze([
  'michi', 'cr', 'pipeline', 'email', 'calendar', 'system',
]);

/** Sources the user can switch on and off (`system` is always on). */
export type CompanionConfigurableSource = Exclude<CompanionSourceKind, 'system'>;

export const COMPANION_CONFIGURABLE_SOURCES: readonly CompanionConfigurableSource[] = Object.freeze([
  'michi', 'cr', 'pipeline', 'email', 'calendar',
]);

/**
 * What the item is. One stable object (a CR, a pipeline, an email thread, a
 * Michi conversation) has one item; its subtype moves as the object changes.
 */
export type CompanionItemSubtype =
  // Michi itself
  | 'michi_waiting'        // a conversation waits on the user (approval / input / question)
  | 'michi_stalled'        // a conversation has waited on the user for days
  | 'michi_done'           // an agent finished since the user last looked
  | 'michi_scheduled_failed'
  // CRs the user authored
  | 'cr_needs_attention'   // new comments / revision requested / analyzer failure
  | 'cr_approved'          // approved and not merged yet
  | 'cr_merged'
  | 'cr_stale'             // no reviewer activity for a while
  | 'cr_unpublished'       // a PENDING (unpublished) revision sitting for hours
  // CRs waiting on the user's review
  | 'cr_review_requested'
  | 'cr_review_stale'
  // Pipelines
  | 'pipeline_blocked'
  | 'pipeline_recovered'
  // Email / calendar
  | 'email_unread'
  | 'meeting_soon'
  | 'calendar_conflict'
  // Companion health
  | 'system_auth'
  | 'system_source_error'
  // Reminders and watches the user asked for
  | 'reminder_due';

/** How the feed groups an item. */
export type CompanionBucket = 'needs_you' | 'update' | 'stalled' | 'fyi';

export const COMPANION_BUCKETS: readonly CompanionBucket[] = Object.freeze(['needs_you', 'update', 'stalled', 'fyi']);

/**
 * now    = interrupt: a Needs you notification (services/companion/notices.ts) and an early Companion wake.
 * digest = next heartbeat / morning brief.
 * silent = feed only.
 */
export type CompanionSeverity = 'now' | 'digest' | 'silent';

/**
 * new       = changed since the user last saw it (counts toward the badge).
 * seen      = the user has seen this version.
 * snoozed   = hidden until `snoozedUntil`, then back to `new`.
 * dismissed = the user is done with this version; a newer meaningful change brings it back.
 * muted     = never resurface this object.
 * resolved  = the condition went away by itself (CR merged, email read, conversation answered).
 */
export type CompanionItemStatus = 'new' | 'seen' | 'snoozed' | 'dismissed' | 'muted' | 'resolved';

export type CompanionFeedback = 'up' | 'down';

/** Why the user gave a thumbs-down (Dot/Pulse-style steering). */
export type CompanionFeedbackReason = 'not_relevant' | 'already_handled' | 'too_early' | 'too_late' | 'too_noisy';

/** Where "Open" takes the user. */
export type CompanionTarget =
  | { kind: 'node'; workspaceId: string; nodeId: string }
  | { kind: 'url'; url: string }
  /** itemId (Today only): the item to scroll to and highlight, e.g. the one a notice is about. */
  | { kind: 'companion'; tab: CompanionTab; itemId?: string }
  | { kind: 'settings' };

export interface CompanionItemDto {
  id: string;
  source: CompanionSourceKind;
  subtype: CompanionItemSubtype;
  bucket: CompanionBucket;
  severity: CompanionSeverity;
  /** Stable object key, e.g. `cr:CR-123456:mine`, `pipeline:MyService`, `michi:node:<id>`. */
  itemKey: string;
  /** Fingerprint of the state that produced this version. */
  version: string;
  title: string;
  /** One or two plain sentences: what happened and why it matters. */
  summary: string | null;
  target: CompanionTarget | null;
  /** Small structured facts (ids, counts, states) - never message bodies. */
  facts: Record<string, string | number | boolean | null>;
  status: CompanionItemStatus;
  snoozedUntil: number | null;
  feedback: CompanionFeedback | null;
  feedbackReason: CompanionFeedbackReason | null;
  /** When Michi first saw the object. */
  firstSeenAt: number;
  /** When the object last changed meaningfully (the current version began). */
  changedAt: number;
  /** When a collector last confirmed the object. */
  observedAt: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export type CompanionItemAction =
  | { action: 'seen' }
  | { action: 'snooze'; until: number }
  | { action: 'dismiss' }
  | { action: 'mute' }
  | { action: 'restore' }
  | { action: 'feedback'; feedback: CompanionFeedback | null; reason?: CompanionFeedbackReason | null };

export type CompanionTab = 'chat' | 'today';

export type CompanionHeartbeatMinutes = 30 | 60 | 120 | 240;
export const COMPANION_HEARTBEAT_MINUTES: readonly CompanionHeartbeatMinutes[] = Object.freeze([30, 60, 120, 240]);

export interface CompanionSourceSettings {
  enabled: boolean;
}

/**
 * A timed Pause Michi (PATCH /companion/settings `{pauseFor}`): an hour from
 * now, or until tomorrow at MICHI_PAUSE_MORNING_HOUR. `{paused: true}` pauses
 * until the user resumes.
 */
export type MichiPauseFor = 'hour' | 'tomorrow';
export const MICHI_PAUSE_FOR: readonly MichiPauseFor[] = Object.freeze(['hour', 'tomorrow']);
/** The local hour "Until tomorrow" ends at. */
export const MICHI_PAUSE_MORNING_HOUR = 8;

/** When a timed pause starting at `now` ends, in the local time of whoever computes it (the backend). */
export function michiPauseEnd(pauseFor: MichiPauseFor, now: number): number {
  if (pauseFor === 'hour') return now + 60 * 60_000;
  const end = new Date(now);
  end.setDate(end.getDate() + 1);
  end.setHours(MICHI_PAUSE_MORNING_HOUR, 0, 0, 0);
  return end.getTime();
}

export interface CompanionSettings {
  /**
   * Always true: whether Michi works is Pause Michi alone (`paused`). Kept so
   * readers from before the one pause still read "on"; the stored value is
   * only read once, when it becomes Pause Michi.
   */
  enabled: boolean;
  /**
   * Pause Michi, as it is now: check-ins, Pages upkeep and automatic polling
   * stop; Check now, Run now and memory go on. Derived from the owner's
   * pause (backend services/michiPause.ts), not stored with these settings.
   */
  paused: boolean;
  /** When a timed pause ends by itself; null while paused until resumed, or not paused. */
  pausedUntil: number | null;
  /** What the Companion is called. The user can rename it; the Companion may rename itself when asked. */
  displayName: string;
  sources: {
    michi: CompanionSourceSettings;
    cr: CompanionSourceSettings & {
      /** reviews.example.com alias; null = the local account name. */
      alias: string | null;
      /** Watch CRs waiting on the user's review. */
      includeReviews: boolean;
    };
    pipeline: CompanionSourceSettings & {
      /** Pipeline names to watch in addition to favorites. */
      watch: string[];
      /** Watch the user's favorite pipelines from GetPipelinesRelevantToUser. */
      includeFavorites: boolean;
    };
    email: CompanionSourceSettings;
    calendar: CompanionSourceSettings;
  };
  /** The old Check every: no longer read; the polls run every COMPANION_POLL_MINUTES. Stays readable for a version. */
  pollMinutes: number;
  heartbeat: { enabled: boolean; intervalMinutes: CompanionHeartbeatMinutes };
  /** Pulse-style morning brief at a local time `HH:MM`, on its own local weekdays (0 = Sunday; default Monday to Friday). */
  brief: { enabled: boolean; time: string; days: number[] };
  /** Local `HH:MM` window with no notifications and no Companion turns. Wraps midnight when start > end. */
  quietHours: { enabled: boolean; start: string; end: string };
  /**
   * The old workdays (0 = Sunday). Read once as brief.days when none is
   * stored (backend settings.ts), and by the notice gate until it goes; no
   * longer written by Settings.
   */
  workdays: number[];
  /**
   * The reasoning check-ins always use, and new conversations with the agent
   * start with (DESIGN-v2 §6); null means the default: the lower of the
   * global reasoning and `high`. The composer chip still overrides it for one
   * conversation, never for check-ins. A level the model does not support is
   * dropped by the binding.
   *
   * Optional until W2: stored settings and backends from before v2 have none,
   * which reads as null. W2-G1b validates it in PATCH /companion/settings,
   * W2-E applies it in the assistant binding, W2-G1a in the check-in session,
   * W2-F2 shows it under Settings › <name> › Model.
   */
  reasoning?: RuntimeReasoning | null;
}

// DEFAULT_COMPANION_NAME and COMPANION_LIMITS live in companionConstants.ts
// (re-exported at the top of this file).

/**
 * The MVP's default name. MVP stored the whole settings object on every
 * PATCH, so an install that changed any setting holds `displayName:
 * 'Companion'` without the user ever naming it. The v2 migration (DESIGN-v2
 * §8.1, step 5 of migrateAssistantV2) turns a stored one into
 * DEFAULT_COMPANION_NAME; any other stored name stays. Not a reserved name:
 * after the migration a user may pick it like any other.
 */
export const LEGACY_DEFAULT_COMPANION_NAME = 'Companion';

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = Object.freeze({
  enabled: true,
  // Off until the user turns it on (2026-11-12): paused until resumed, as michiPause.ts reads an owner without a row.
  paused: true,
  pausedUntil: null,
  displayName: DEFAULT_COMPANION_NAME,
  sources: {
    michi: { enabled: true },
    cr: { enabled: false, alias: null, includeReviews: true },
    pipeline: { enabled: false, watch: [], includeFavorites: true },
    email: { enabled: false },
    calendar: { enabled: false },
  },
  pollMinutes: 5,
  heartbeat: { enabled: true, intervalMinutes: 60 },
  brief: { enabled: true, time: '09:00', days: [1, 2, 3, 4, 5] },
  quietHours: { enabled: true, start: '20:00', end: '08:00' },
  workdays: [1, 2, 3, 4, 5],
  reasoning: null,
}) as CompanionSettings;

export type CompanionSourceState = 'ok' | 'disabled' | 'unavailable' | 'error' | 'pending';

export interface CompanionSourceStatus {
  kind: CompanionConfigurableSource;
  state: CompanionSourceState;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  /** Short, user-safe reason when not ok (e.g. "Auth session expired - refresh your credentials"). */
  detail: string | null;
}

export type CompanionState = 'off' | 'paused' | 'quiet_hours' | 'ok' | 'degraded';

export interface CompanionStatusDto {
  state: CompanionState;
  auth: { valid: boolean | null; expiresAt: number | null; checkedAt: number | null };
  sources: CompanionSourceStatus[];
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  nextHeartbeatAt: number | null;
  nextBriefAt: number | null;
  turnsToday: number;
  /** True while a Companion model turn runs. */
  working: boolean;
  /**
   * True while the agent takes its first look, before the welcome's run
   * starts (DESIGN-v2 §1.5, §3.8): the welcome waits for the Pages upkeep's
   * first run to finish narrating into the conversation ("<name> · first
   * look"), then looks at every source (welcomeFirstLookWaitMs at most for
   * one still on its first poll). `working` is true then too.
   * companionStatusLine (companionStatus.ts) shows "Taking a first look…",
   * so the panel and the tray say the same. W2-G1a fills it (coordinator);
   * absent from older backends, which read as before ("Working…").
   */
  firstLook?: boolean;
}

export interface CompanionBriefCard {
  title: string;
  body: string;
  itemIds: string[];
  /** Optional one-click follow-up: puts `prompt` into the Companion chat. */
  action: { label: string; prompt: string } | null;
}

export interface CompanionBriefDto {
  id: string;
  /** Local date `YYYY-MM-DD`. */
  date: string;
  headline: string;
  cards: CompanionBriefCard[];
  /** Pulse-style ending, e.g. "That's all for today." */
  closing: string;
  /** llm = written by the Companion; fallback = assembled by Michi when no model turn ran. */
  origin: 'llm' | 'fallback';
  createdAt: number;
  cardFeedback: Record<number, CompanionFeedback>;
}

export type CompanionCardKind =
  | 'goal.add'
  | 'goal.update'
  | 'goal.remove'
  | 'source.update'
  | 'pipeline.watch'
  /** Delegate work: Apply starts a normal Michi conversation (the click is the approval). */
  | 'conversation.start'
  | 'reminder.add'
  | 'watch.add'
  /** Replace the user's rules text; only ever applied by the user. */
  | 'rules.update'
  /**
   * Send a follow-up into a conversation the agent started and still follows
   * (DESIGN-v2 §4); payload CompanionSessionSendPayload as proposed, stored as
   * CompanionSessionSendCardPayload. Apply is the user's approval of the
   * exact text, and re-checks the target first (still followed, not taken
   * over, idle, not waiting on the user, latest reply still
   * `afterMessageId`, permission choice no wider than `permissionWhenProposed`).
   * Check-ins and worker reports propose it (see COMPANION_LIMITS
   * maxSessionSendsPerCheckin, maxPendingSessionSendCards, sessionSendCardTtlMs).
   * W3-G2 validates and delivers it; W3-F3 previews it.
   */
  | 'session.send';

/**
 * The words on a card's Apply button, which the card face shows
 * (frontend companionCards.ts) and companion_propose's answer names, so the
 * agent tells the user the button that is there (W4 failure 4): Send for a
 * follow-up, Start conversation for a conversation, Apply for the rest.
 */
export function companionCardButtonLabel(kind: CompanionCardKind): string {
  return kind === 'session.send' ? 'Send' : kind === 'conversation.start' ? 'Start conversation' : 'Apply';
}

/** The payload of a `session.send` card (DESIGN-v2 §4), as companion_propose gives it. */
export interface CompanionSessionSendPayload {
  /** The delegated conversation's node: one the agent started that it still follows. */
  nodeId: string;
  /** The exact message, at most COMPANION_LIMITS.maxSendChars; the header is added on delivery (formatCompanionThreadMessage). */
  text: string;
  /** The target's latest assistant message when proposed (null: none yet); Apply fails once the conversation has moved on. */
  afterMessageId: string | null;
}

/**
 * What W3-G2 stores as a `session.send` card's CompanionCardDto.payload
 * (DESIGN-v2 §4): the proposal with `text` as delivered
 * (checkCompanionSendText(text).body, companionThreadMessage.ts), plus what Michi read
 * about the target when the card was proposed. The card face (W3-F3) shows
 * all of it: the target's title and workspace, "Runs in <choice>: …" from
 * `permissionWhenProposed`, and the full text. Apply re-reads the target and
 * fails the card when its choice is now wider (isWiderChatPermission, ask <
 * approve < trust < yolo), besides the other §4 checks.
 */
export interface CompanionSessionSendCardPayload extends CompanionSessionSendPayload {
  /** The target's workspace. */
  workspaceId: string;
  /** The target's title when proposed, one line (sanitizeThreadTitle). */
  title: string;
  /** The target's effective permission choice when proposed (chatPermissionChoice of its mode and Approve for me). */
  permissionWhenProposed: ChatPermissionChoice;
}

/** Reads a stored `session.send` card payload; undefined for any other shape (the card face then shows no preview). */
export function parseCompanionSessionSendCardPayload(value: unknown): CompanionSessionSendCardPayload | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (field: unknown): field is string => typeof field === 'string' && field.length > 0;
  if (!text(raw.nodeId) || !text(raw.text) || !text(raw.workspaceId) || typeof raw.title !== 'string'
    || (raw.afterMessageId !== null && !text(raw.afterMessageId)) || !isChatPermissionChoice(raw.permissionWhenProposed)) return undefined;
  return {
    nodeId: raw.nodeId,
    text: raw.text,
    afterMessageId: raw.afterMessageId as string | null,
    workspaceId: raw.workspaceId,
    title: raw.title,
    permissionWhenProposed: raw.permissionWhenProposed,
  };
}

export type CompanionCardStatus = 'pending' | 'applied' | 'dismissed' | 'expired' | 'failed';

/**
 * A change the Companion proposes; nothing changes until the user presses
 * Apply. Outcomes reach the Companion at the start
 * of its next turn.
 */
export interface CompanionCardDto {
  id: string;
  kind: CompanionCardKind;
  /** Kind-specific payload, validated server-side on create and on apply. */
  payload: Record<string, unknown>;
  /** Plain-language summary of the change, written by Michi from the payload. */
  summary: string;
  /** The Companion's reason, <= 500 chars. */
  reason: string | null;
  status: CompanionCardStatus;
  error: string | null;
  createdAt: number;
  decidedAt: number | null;
  expiresAt: number;
}

/**
 * Who last wrote a goal's text or the notes (DESIGN-v2 §2.6.7, §2.8 T1):
 * `user` = the user (Settings), or the agent in a user turn that had read no
 * check-in or collector material; `checkin` = a check-in, or a turn that had
 * read some (any tainted turn), and the notes MVP left behind. Only `user`
 * text goes into the conversation's [COMPANION CONTEXT]. The user editing
 * it, or saving it unchanged (the "Keep" that confirms it: PATCH
 * /companion/goals/:id with the same text, PUT /companion/notes), makes it
 * `user` again. W2-G1a stores it (companion_goals.text_origin, meta
 * companion:notes_origin) and fills CompanionGoalDto.textOrigin and
 * snapshot.notesOrigin; W2-G1b passes it on every write; W2-F2 shows
 * "Written by <name>" with Keep beside `checkin` text.
 */
export type CompanionTextOrigin = 'user' | 'checkin';

export interface CompanionGoalDto {
  id: string;
  text: string;
  /** Latest short progress note the Companion recorded (goal progress). */
  progress: string | null;
  progressAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Who wrote `text` (CompanionTextOrigin); absent from older backends, which read as `user`. */
  textOrigin?: CompanionTextOrigin;
}

// CompanionRunKind, CompanionCheckinKind and COMPANION_CHECKIN_KINDS live in
// companionMessageMetadata.ts (re-exported at the top of this file).

/**
 * How a run ended. `superseded` (DESIGN-v2 §3.3): a check-in whose reply was
 * not posted because the user wrote in the conversation after it began;
 * Activity keeps that fact and the reply's length, never its text (a
 * deterministic receipt is still posted when it changed something). Written
 * by W2-G1a; shown by W2-F2.
 */
export type CompanionRunOutcome = 'running' | 'ok' | 'spoke' | 'quiet' | 'skipped' | 'error' | 'preempted' | 'superseded';

/** One line of the Activity log: every poll and every Companion turn, so nothing runs unseen. */
export interface CompanionRunDto {
  id: string;
  kind: CompanionRunKind;
  trigger: string;
  outcome: CompanionRunOutcome;
  detail: string | null;
  startedAt: number;
  finishedAt: number | null;
  /**
   * The message this run posted into the conversation, `cmp-post-<runId>`
   * (DESIGN-v2 §3.3); null or absent when it posted nothing. Activity links
   * the run to it (W2-F2); W2-G1a fills it from companion_runs.posted_message_id.
   */
  postedMessageId?: string | null;
  /**
   * What a check-in changed in the user's Pages, databases, Today and goals,
   * the same list its post's receipt shows (CompanionPostMetadata.changes);
   * absent or empty when it changed nothing. Activity's "Changed 3 blocks on
   * Tasks · Undo all" reads it (W2-F2, DESIGN-v2 §2.7). W2-G1a fills it.
   */
  changes?: CompanionPostChange[];
  /**
   * When "Undo all" (POST companionRunUndoPath(runId)) last reverted
   * everything the run had changed; null while anything stays (never undone,
   * or the undo stopped at a conflict, which a second Undo all may clear).
   * Activity and the receipt show "Undone" for it. W2-G1a fills it.
   */
  undoneAt?: number | null;
}

/**
 * `POST /api/companion/runs/:runId/undo` (DESIGN-v2 §2.7): "Undo all" on a
 * check-in's receipt or Activity row → CompanionRunUndoResult. Only for runs
 * that had a check-in node, scoped to the local owner. W2-G1a builds it;
 * W2-F1a (receipt) and W2-F2 (Activity) call it.
 */
export function companionRunUndoPath(runId: string): string {
  return `/companion/runs/${encodeURIComponent(runId)}/undo`;
}

/**
 * What "Undo all" did, in the shape of the pages' batch revert: the run's
 * applied page and database changes, newest first, stopping at the first
 * conflict (its pending proposals dismissed), then its Today and goal
 * changes from companion_run_changes. Calling it again skips what is already
 * undone, so it is safe to repeat.
 */
export interface CompanionRunUndoResult {
  /** What was undone: page_changes ids, then companion_run_changes ids. */
  reverted: string[];
  /** What could not be undone because it changed since, with a message for the user. */
  conflicts: Array<{ changeId: string; message: string }>;
}

/** Whether the agent still follows a conversation it started (DESIGN-v2 §4). Delegations from before v2 are all `closed`. */
export type CompanionDelegationState = 'following' | 'closed';

/** How the conversation was started: an applied `conversation.start` card, or start_conversation in the user's own turn. */
export type CompanionDelegationOrigin = 'card' | 'start_conversation';

/**
 * Why a delegation stopped being followed (DESIGN-v2 §4): the user wrote in
 * it themselves (`took_over`), the conversation was deleted or cancelled
 * (`gone`), nothing was sent or reported for COMPANION_LIMITS.delegationIdleMs
 * (`idle`), or it outlived delegationMaxAgeMs (`age`).
 */
export type CompanionDelegationClosedReason = 'took_over' | 'gone' | 'idle' | 'age';

/**
 * A conversation the agent started (companion_delegations): the only kind of
 * conversation session_send may write into, and only while `following`
 * (DESIGN-v2 §4). W3-G2 owns the lifecycle; Settings › <name> › Activity
 * (W2-F2) lists the followed ones with their "Ask before sending" switch,
 * which turns autoSend off through PATCH companionDelegationPath(id)
 * (CompanionDelegationPatch, built by W2-G1a).
 */
export interface CompanionDelegationDto {
  id: string;
  workspaceId: string;
  nodeId: string;
  title: string;
  state: CompanionDelegationState;
  /** null for delegations from before v2. */
  origin: CompanionDelegationOrigin | null;
  /**
   * The user answered a follow-up's approval with "Send, and stop asking for
   * this conversation" (auto_send = 1): later follow-ups from the user's own
   * turns go without asking (still asking in a turn tainted by check-in or
   * collector material). The Activity row's switch turns it off. Never set
   * for check-ins, which propose cards (or send directly to a target whose
   * permission choice is exactly `ask`, Q1).
   */
  autoSend: boolean;
  createdAt: number;
  lastSentAt: number | null;
  lastReportedAt: number | null;
  closedAt: number | null;
  /** null while following, and for delegations closed before v2. */
  closedReason: CompanionDelegationClosedReason | null;
}

export interface CompanionConversationDto {
  workspaceId: string;
  nodeId: string;
  /** What an embedded TPane needs as its assistantSource (runtime/model chips, currentAssistant). */
  assistant: MichiAssistantInfo;
}

/**
 * A reminder or watch the user asked for (Dot "commitments"): kept by Michi,
 * not by the model's memory. Firing creates a `reminder_due` item.
 */
export interface CompanionReminderDto {
  id: string;
  /** time = at a moment or daily at a local time; watch = when an item reaches a state. */
  kind: 'time' | 'watch';
  text: string;
  /** Epoch ms for a one-off time reminder. */
  at: number | null;
  /** Local `HH:MM` for a daily reminder (workdays only). */
  dailyAt: string | null;
  /** The item a watch (or a time reminder) is about. */
  itemId: string | null;
  until: 'approved' | 'merged' | 'recovered' | 'read' | 'answered' | null;
  status: 'active' | 'paused' | 'fired' | 'cancelled';
  createdAt: number;
  firedAt: number | null;
}

/** Deterministic "since you left" summary, shown without spending a model turn. */
export interface CompanionCatchUpDto {
  awaySince: number;
  returnedAt: number;
  changedItemIds: string[];
  /** e.g. "Nothing new since 08:12." or "3 updates, 1 needs you." */
  line: string;
}

/**
 * Michi's latest line (Q45): one line a check-in wrote about what it is doing
 * or what changed, for Home's greeting. Never how many things need the user:
 * Today lists those (Q12). Kept until a later check-in writes another.
 */
export interface CompanionHeadlineDto {
  /** One line of plain text, at most COMPANION_LIMITS.maxHeadlineChars. */
  text: string;
  /** When the check-in that wrote it ended. */
  at: number;
  /** Which check-in wrote it. */
  kind: CompanionCheckinKind;
}

export interface CompanionSnapshotDto {
  settings: CompanionSettings;
  status: CompanionStatusDto;
  conversation: CompanionConversationDto | null;
  /** Open items (not resolved / dismissed / muted), newest change first. */
  items: CompanionItemDto[];
  brief: CompanionBriefDto | null;
  cards: CompanionCardDto[];
  goals: CompanionGoalDto[];
  notes: string;
  /** Bumps on every notes write; the Companion's companion_save_notes must pass the revision it read. */
  notesRevision: number;
  /** The user's own rules for the Companion (only the user writes them). */
  rules: string;
  reminders: CompanionReminderDto[];
  /** Subtypes the user's feedback demoted to digest (undo in Settings). */
  demotedSubtypes: CompanionItemSubtype[];
  catchUp: CompanionCatchUpDto | null;
  activity: CompanionRunDto[];
  /** needsYou = open needs_you items; newItems = status 'new'; unreadMessages = Companion messages since the user last viewed the panel. */
  counts: { needsYou: number; newItems: number; unreadMessages: number };
  /** Monotonic; bumps on every change (SSE `companion_changed`). */
  revision: number;
  /** Michi's latest line (Q45): null when none was written yet; absent from older backends. */
  headline?: CompanionHeadlineDto | null;
  /**
   * Whether the panel should ask for the welcome (DESIGN-v2 §3.8): it has not
   * happened yet (`welcome_done` unset) and the user has written nothing in
   * the conversation since the v2 merge (`assistant:v2_merged_at`; narration
   * and posted check-ins do not count). The Chat tab asks for it when it shows
   * while this is true. W2-G1a fills it; W2-F1a reads it. Optional until
   * every backend sends it: absent means unknown, not false.
   */
  welcome?: { wanted: boolean };
  /**
   * The conversations the agent started and still follows, newest first
   * (DESIGN-v2 §4), for Settings › <name> › Activity and its "Ask before
   * sending" switches (W2-F2). W2-G1a fills it from companion_delegations
   * (state 'following'; none follow until W3-G2 starts following them).
   */
  delegations?: CompanionDelegationDto[];
  /**
   * Who last wrote `notes` (CompanionTextOrigin, meta companion:notes_origin):
   * Settings › <name> › Notes shows "Written by <name>" and Keep for
   * `checkin` (W2-F2). W2-G1a fills it; absent from older backends.
   */
  notesOrigin?: CompanionTextOrigin;
  /**
   * The check-ins' changes to Today items and goals (companion_run_changes),
   * newest first, at most COMPANION_LIMITS.maxSnapshotCheckinChanges, undone
   * ones included: Today's "by <name>" and "Dismissed by <name> — <reason> ·
   * Undo" read it, also for items no longer in `items` (W3-F3, DESIGN-v2
   * §2.7), and so do the receipts' per-target lines (W2-F1a). W2-G1a fills it.
   */
  checkinChanges?: CompanionCheckinChangeDto[];
  /**
   * The Get started card in V (unification design D17): null when there is
   * none, for someone who met Michi before it existed. Absent from older
   * backends, which welcome with a model turn instead.
   */
  getStarted?: CompanionGetStartedDto | null;
  /**
   * When this owner was told once that Michi is off and where to turn it on
   * (Q29: no button or ⌘J while off), or found it on: null until then.
   * POST /companion/off-notice sets it. Absent from older backends.
   */
  offNoticeAt?: number | null;
}

/**
 * The Get started card (D17): the first time the panel opens, V shows a
 * model-free introduction and this card, and nothing starts until Start.
 * `offer`: not answered yet; `later`: Not now, so it can still be started;
 * `started`: Start was pressed in the conversation `nodeId` (another
 * conversation shows no card).
 */
export interface CompanionGetStartedDto {
  state: 'offer' | 'later' | 'started';
  /** When Start or Not now was pressed; null while offered. */
  at: number | null;
  nodeId: string | null;
  /** What Start chose for workspace homes, and for watching the outside sources (null: left as they were); null before Start. */
  homes: boolean | null;
  watch: boolean | null;
  /** The card's first line now: whether workspace homes are kept up to date, and how many days back the first read goes. */
  homesOn: boolean;
  firstRunDays: number;
}

/** POST /companion/get-started: the card's choices. `watch` left out leaves the outside sources as they are. */
export interface CompanionGetStartedInput {
  homes: boolean;
  watch?: boolean;
}

/** Renderer activity beacon: the backend uses it for catch-up and to keep turns out of the user's way. */
export interface CompanionPresenceInput {
  /** The Michi window is focused and the user acted recently. */
  active: boolean;
  /** The Companion window is open and focused. */
  companionFocused: boolean;
  /** Epoch ms of the last keyboard/pointer input the renderer saw. */
  lastInputAt: number | null;
  /** The user is typing in (or just focused) the Companion composer: Michi stops any hidden turn so the user goes first. */
  composing: boolean;
  /** The window that sent it (its WINDOW_ID): every window, a remote one included, is heard on its own. Absent: one unnamed window. */
  windowId?: string;
  /**
   * Set only on Electron main's system beacon: how long the computer has had
   * no keyboard or mouse input (powerMonitor.getSystemIdleTime), so working in
   * another app counts as here. Such a beacon says nothing about any window.
   */
  systemIdleSeconds?: number;
}

/** SSE stream `GET /api/companion/events`. */
export const COMPANION_EVENTS_PATH = '/companion/events';

export interface CompanionChangedEvent {
  type: 'companion_changed';
  revision: number;
  /** `notifications`: the user's notification level changed (Michi's companion_set_notifications); windows read their prefs again. */
  reason: 'items' | 'brief' | 'cards' | 'goals' | 'notes' | 'settings' | 'status' | 'activity' | 'catch_up' | 'conversation' | 'reminders' | 'rules'
    | 'notifications';
}

/**
 * The user's one notification level (Settings › Notifications), what
 * attentionLevelAllows reads: `all`; `approval-only`, shown as "Only when
 * something needs me" (approvals, questions, Needs you, a task that failed);
 * `off`. The same values as the renderer's pref (frontend state/prefs.tsx
 * `notifications`), where it lives; the renderer PUTs it to
 * COMPANION_CHAT_NOTIFICATION_LEVEL_PATH at start and on every change so
 * Electron main's banners follow it while no window is open (DESIGN P4).
 */
export type ChatNotificationLevel = 'all' | 'approval-only' | 'off';

export const CHAT_NOTIFICATION_LEVELS: readonly ChatNotificationLevel[] = Object.freeze(['all', 'approval-only', 'off']);

/** The renderer's default level, which the backend uses until a renderer has written one. */
export const DEFAULT_CHAT_NOTIFICATION_LEVEL: ChatNotificationLevel = 'all';

export function isChatNotificationLevel(value: unknown): value is ChatNotificationLevel {
  return typeof value === 'string' && (CHAT_NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

/** `PUT /api/companion/chat-notification-level` with a CompanionChatNotificationLevelInput body (W3: F3 → H). */
export const COMPANION_CHAT_NOTIFICATION_LEVEL_PATH = '/companion/chat-notification-level';

/** The body of PUT COMPANION_CHAT_NOTIFICATION_LEVEL_PATH. */
export interface CompanionChatNotificationLevelInput {
  level: ChatNotificationLevel;
}

export function isCompanionChangedEvent(value: unknown): value is CompanionChangedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<CompanionChangedEvent>;
  return event.type === 'companion_changed' && typeof event.revision === 'number' && typeof event.reason === 'string';
}

/** `HH:MM` 24h. */
export function isCompanionClock(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Items that are still in front of the user (not resolved, dismissed, muted, or snoozed into the future). */
export function isOpenCompanionItem(item: Pick<CompanionItemDto, 'status' | 'snoozedUntil'>, now: number): boolean {
  if (item.status === 'resolved' || item.status === 'dismissed' || item.status === 'muted') return false;
  if (item.status === 'snoozed') return item.snoozedUntil !== null && item.snoozedUntil <= now;
  return true;
}

// ── v2: check-in nodes and the ids derived from a run (DESIGN-v2 §2.2, §3) ──

/**
 * Every check-in's throwaway node id starts with this: `n-cmph-<runId>`
 * (DESIGN-v2 §2.2). The prefix alone makes a node a check-in, with the closed
 * profile, whatever its meta row says or whether its row still exists (fail
 * closed: the node is purged after the run, §3.1). Clients can never create
 * such an id (the save and restore routes refuse it, §2.5); only the
 * backend's createCheckinNode does. Read by W1-B (chatManager refuses it
 * before any open binding; chatHub turn guards), W1-C (attribution and
 * source resolution), W2-E (assistantPurposeOf, route guards), W2-G1a
 * (createCheckinNode, purge, boot cleanup).
 */
export const CHECKIN_NODE_PREFIX = 'n-cmph-';

/** True for a check-in node's id (CHECKIN_NODE_PREFIX). */
export function isCheckinNodeId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(CHECKIN_NODE_PREFIX);
}

/** The node id of the check-in run `runId` (W2-G1a createCheckinNode). */
export function checkinNodeId(runId: string): string {
  return `${CHECKIN_NODE_PREFIX}${runId}`;
}

/** The run a check-in node belongs to, or null for any other id (W1-C resolves sources through it). */
export function checkinRunId(nodeId: string | null | undefined): string | null {
  if (typeof nodeId !== 'string' || !nodeId.startsWith(CHECKIN_NODE_PREFIX) || nodeId.length === CHECKIN_NODE_PREFIX.length) return null;
  return nodeId.slice(CHECKIN_NODE_PREFIX.length);
}

/**
 * The id of the message (and of its turn) that check-in run `runId` posts into
 * the conversation: `cmp-post-<runId>` (DESIGN-v2 §3.3). It carries no
 * conversation id, so a page change's check-in source finds its message from
 * the run alone (§2.7). Note it also starts with `cmp-`, the prefix of a
 * check-in's own turn in its node (`cmp-<runId>`).
 */
export const COMPANION_POST_ID_PREFIX = 'cmp-post-';

export function companionPostId(runId: string): string {
  return `${COMPANION_POST_ID_PREFIX}${runId}`;
}

/** The run a posted message (or its turn) belongs to, or null for any other id. */
export function companionPostRunId(id: string | null | undefined): string | null {
  return typeof id === 'string' && id.startsWith(COMPANION_POST_ID_PREFIX) && id.length > COMPANION_POST_ID_PREFIX.length
    ? id.slice(COMPANION_POST_ID_PREFIX.length) : null;
}

/**
 * A check-in's own turn in its node: `cmp-<runId>` (DESIGN-v2 §3.1, as the
 * MVP's hidden turns). A post's id (`cmp-post-<runId>`) starts the same way,
 * so read one with companionCheckinTurnRunId, which tells them apart. W1-B's
 * guard: a requested self turn with such an id runs only on a check-in node
 * (§2.5); W2-G1a starts it.
 */
export const COMPANION_CHECKIN_TURN_PREFIX = 'cmp-';

export function companionCheckinTurnId(runId: string): string {
  return `${COMPANION_CHECKIN_TURN_PREFIX}${runId}`;
}

/** The run of a check-in's own turn, or null for any other id, a post's included. */
export function companionCheckinTurnRunId(turnId: string | null | undefined): string | null {
  if (typeof turnId !== 'string' || !turnId.startsWith(COMPANION_CHECKIN_TURN_PREFIX) || turnId.startsWith(COMPANION_POST_ID_PREFIX)) return null;
  return turnId.length > COMPANION_CHECKIN_TURN_PREFIX.length ? turnId.slice(COMPANION_CHECKIN_TURN_PREFIX.length) : null;
}

/**
 * A follow-up's turn in the delegated conversation: `cms-<runId>`, the `send`
 * run that delivered it (DESIGN-v2 §4). W1-B's guard: such a turn runs only
 * on a node outside the assistant workspace (§2.5); W3-G2 starts it and
 * records the run.
 */
export const COMPANION_SEND_TURN_PREFIX = 'cms-';

export function companionSendTurnId(runId: string): string {
  return `${COMPANION_SEND_TURN_PREFIX}${runId}`;
}

/** The `send` run of a follow-up's turn, or null for any other id. */
export function companionSendTurnRunId(turnId: string | null | undefined): string | null {
  return typeof turnId === 'string' && turnId.startsWith(COMPANION_SEND_TURN_PREFIX) && turnId.length > COMPANION_SEND_TURN_PREFIX.length
    ? turnId.slice(COMPANION_SEND_TURN_PREFIX.length) : null;
}

/**
 * Whether a block's (or a page change's) source is a check-in (DESIGN-v2
 * §2.6.2, §2.7). W1-C's read-time resolution rewrites a check-in source to
 * the conversation and the post and marks it `checkin: true`
 * (BlockSource.checkin), so its node id no longer tells; a source it left
 * alone still names the check-in node. W2-F1b's renderer keys "Load images"
 * on this, never on the node id alone. The argument is BlockSource's two
 * fields, typed here so this module imports nothing from pages/.
 */
export function isCheckinBlockSource(source: { nodeId: string; checkin?: true }): boolean {
  return source.checkin === true || isCheckinNodeId(source.nodeId);
}

// ── v2: posted check-ins (DESIGN-v2 §3.3, §3.4) ─────────────────────────────

// CompanionPostChange, CompanionPostMetadata, their kinds and actions and
// parseCompanionPostMetadata live in companionMessageMetadata.ts
// (re-exported at the top of this file).

/**
 * One change a check-in made to a Today item or a goal: a row of
 * companion_run_changes (DESIGN-v2 §2.6.5, §2.7), as
 * CompanionSnapshotDto.checkinChanges lists it.
 */
export interface CompanionCheckinChangeDto {
  /** The companion_run_changes row. */
  id: string;
  /** The check-in run that made it (its receipt is `cmp-post-<runId>` when it posted). */
  runId: string;
  targetKind: 'item' | 'goal';
  /** The Today item's or the goal's id. */
  targetId: string;
  action: CompanionPostChangeAction;
  /** The check-in's reason (required for Today changes); check-in material, as CompanionPostChange.reason. */
  reason: string | null;
  /**
   * What it touched, for a row that shows it after it left Today (a
   * dismissed item is not in snapshot.items): the item's title, or the
   * goal's text after the change (before it, for a removed goal). Display
   * only: collector or check-in material, never put in the agent's context.
   */
  title: string | null;
  /** When the check-in made the change. */
  at: number;
  /** When an undo restored the target (the run's Undo all); null while it was not undone. */
  undoneAt: number | null;
  /**
   * The change still holds, by the check Undo all makes (W3-F3-review #1):
   * not undone, and its target is as the change left it (an item's status
   * and snooze end, a goal's text and whether it is live). False once the
   * user, its source or a later run moved the target on (a snooze that ran
   * out, an item the user dismissed again after a restore, a CR that
   * resolved) or the target is gone. Today credits the check-in ("by
   * <name>", with Undo) only for standing changes.
   */
  standing: boolean;
  /** A snooze's end, as the change set it (Today lists a standing snooze until then); null for every other action. */
  snoozedUntil: number | null;
}

// ── v2: the menu-bar / tray menu (DESIGN-v2 §5.1) ──────────────────────────

/** `GET /api/companion/tray` → CompanionTrayDto (W3-H serves it; W1-D mocks it, W3-D2 reads it). */
export const COMPANION_TRAY_PATH = '/companion/tray';

/** One "Needs you" row of the tray menu: a title only, never a summary. */
export interface CompanionTrayItem {
  id: string;
  title: string;
  /** status `new` (● in the menu); seen ones show ○. */
  isNew: boolean;
  /** Where clicking it goes: the item's own target, or Today at its row. */
  target: CompanionTarget;
}

/**
 * What the tray menu shows, computed by the backend because Electron main
 * loads no workspace package at runtime (DESIGN-v2 §5.1; electron-tray-map
 * §2.5, plus `conversationWaiting`). Items of sources the user turned off are
 * left out. Electron main fetches it after each `companion_changed` frame on
 * the notifier feed (debounced) and pops the menu up from its cached copy.
 */
export interface CompanionTrayDto {
  /** settings.displayName: "Chat with <name>". */
  displayName: string;
  enabled: boolean;
  paused: boolean;
  /**
   * The panel's rule, snapshot.welcome.wanted (no welcome yet, and no user
   * message since the v2 merge): while true the status row says "Say hello
   * to <name>". W3-H computes it with the panel's function, so the tray never
   * asks for a welcome the panel would not. (The `welcomeDone` W0 kept for
   * W1-D's mock is gone since W3: the tray reads only this.)
   */
  welcomeWanted: boolean;
  /** The conversation waits on the user (an approval or a question): "<name> is waiting for you". */
  conversationWaiting: boolean;
  /**
   * companionStatusLine (companionStatus.ts) of the snapshot with its
   * activity: the line and tone the panel shows, "Checking in…", "Saying
   * hello…" and "Taking a first look…" included (its `stoppable` is the
   * panel's; the tray shows no Stop).
   */
  statusLine: CompanionStatusLine;
  /** companionBadgeCount: the same count as the Topbar button. */
  badge: number;
  /** Open needs_you items, newest change first, at most 5. */
  needsYou: CompanionTrayItem[];
  /** All open needs_you items ("View all in Today"). */
  needsYouTotal: number;
  /** Today's brief exists and the user has not looked at it. */
  briefReady: boolean;
  /** The snapshot revision it was computed from. */
  revision: number;
}

// ── v2: what a message to the agent refers to (DESIGN-v2 §1.3, §2.8 T4) ────
// CompanionTurnRef, COMPANION_TURN_REF_LIMITS and parseCompanionTurnRefs live
// in metaAgentChat.ts (re-exported at the top of this file).

// CompanionTaintDetail, COMPANION_TAINT_DETAILS, CompanionTurnMetadata and
// parseCompanionTurnMetadata live in companionMessageMetadata.ts
// (re-exported at the top of this file).

// ── v2: the agent's follow-up delegations (DESIGN-v2 §4) ───────────────────

/** `PATCH /api/companion/delegations/:id` (companionDelegationPath) with a CompanionDelegationPatch body → the CompanionDelegationDto. */
export const COMPANION_DELEGATIONS_PATH = '/companion/delegations';

export function companionDelegationPath(delegationId: string): string {
  return `${COMPANION_DELEGATIONS_PATH}/${encodeURIComponent(delegationId)}`;
}

/**
 * The body of PATCH companionDelegationPath(id): Settings › <name> › Activity
 * turns "Send, and stop asking for this conversation" back off for one
 * delegation, so follow-ups from the user's turns ask again (DESIGN-v2 §4).
 * Only off: auto_send is set only by the user answering an approval. W2-G1a
 * builds the route (404 for an unknown delegation) and lists the followed
 * ones in snapshot.delegations; W2-F1a adds the client call; W2-F2 shows the
 * switch; W3-G2 owns everything else in a delegation's life (DESIGN-v2 §8.1).
 */
export interface CompanionDelegationPatch {
  autoSend: false;
}

export function isCompanionDelegationPatch(value: unknown): value is CompanionDelegationPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'autoSend' && (value as Record<string, unknown>).autoSend === false;
}
