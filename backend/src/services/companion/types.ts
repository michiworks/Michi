/**
 * The Companion's backend-internal contracts (shared/src/companion.ts holds
 * the ones the renderer and Electron see). Sources observe, rules turn
 * observations into item drafts, the repository keeps items and their event
 * log, the coordinator decides when a model turn runs and a turn runner runs
 * it; routes reach all of it through CompanionService.
 *
 * Types only: nothing here runs, so any module may import it.
 */

import type {
  CompanionBucket,
  CompanionCardDto,
  CompanionCheckinKind,
  CompanionCatchUpDto,
  CompanionConfigurableSource,
  CompanionGoalDto,
  CompanionItemDto,
  CompanionItemSubtype,
  CompanionPresenceInput,
  CompanionReminderDto,
  CompanionSettings,
  CompanionSeverity,
  CompanionSourceKind,
  CompanionStatusDto,
  CompanionTarget,
} from 'michi-shared';

// ── Time ────────────────────────────────────────────────────────────────────

/** Where the Companion reads the time; tests inject a fake one. */
export interface CompanionClock {
  now(): number;
}

// ── Observation → item ──────────────────────────────────────────────────────

/** One watched object as a source saw it in one poll. */
export interface Observation {
  source: CompanionSourceKind;
  /** Stable within the source: `cr:CR-123456:mine`, `pipeline:MyService`, `michi:node:<nodeId>`. */
  objectKey: string;
  /** stableHash of the parts of `state` whose change matters (observations.ts). */
  fingerprint: string;
  /** Small normalized state: ids, counts, states and times, never message bodies. */
  state: Record<string, unknown>;
  observedAt: number;
}

/** One stored observation (companion_snapshots), the basis of the next diff. */
export interface CompanionSnapshotRecord {
  source: CompanionSourceKind;
  objectKey: string;
  fingerprint: string;
  state: Record<string, unknown>;
  /** When the object was first observed. */
  firstSeenAt: number;
  /** Since when the fingerprint has been what it is now: "unchanged for N days". */
  fingerprintSince: number;
  lastSeenAt: number;
}

export interface SourcePollResult {
  source: CompanionSourceKind;
  /** False: nothing it saw (or failed to see) may resolve an item. */
  ok: boolean;
  /**
   * True only when `observations` is the source's full current set (no
   * truncated window, no unread page). Absence resolves items only when ok
   * AND complete, and only after two consecutive such polls (DESIGN R2.4).
   */
  complete: boolean;
  observations: Observation[];
  /** Error category when not ok (e.g. `timeout`, `auth_expired`); never raw tool output. */
  error?: string;
  /** Short, user-safe text for the Activity line. */
  detail?: string;
}

/** Item facts: ids, counts, states, urls and ages. Never message bodies. */
export type CompanionFactValue = string | number | boolean | null;

/** What rules.ts makes of an observation; repository.upsertItem applies the version rules (DESIGN §3.1). */
export interface ItemDraft {
  source: CompanionSourceKind;
  subtype: CompanionItemSubtype;
  itemKey: string;
  /** Fingerprint of what makes this a new version; a new version brings a dismissed item back. */
  version: string;
  bucket: CompanionBucket;
  severity: CompanionSeverity;
  title: string;
  summary: string | null;
  target: CompanionTarget | null;
  facts: Record<string, CompanionFactValue>;
  observedAt: number;
}

/** What a source's poll receives. */
export interface CompanionPollContext {
  settings: CompanionSettings;
  now: number;
  /** This source's stored observations by objectKey (to fetch details only for rows that changed). */
  previous: ReadonlyMap<string, CompanionSnapshotRecord>;
  signal?: AbortSignal;
}

/** One deterministic collector (sources/*.ts). */
export interface CompanionSource {
  kind: CompanionSourceKind;
  /** How long after a poll the next one is due (backoff is the coordinator's). */
  intervalMs(settings: CompanionSettings): number;
  poll(ctx: CompanionPollContext): Promise<SourcePollResult>;
  /**
   * Pure: this poll's observations (plus the stored snapshots and the time)
   * become feed item drafts. Each source owns its own semantics: subtype,
   * bucket, severity, a version that encodes only semantic state (counts go
   * in facts), titles and targets (DESIGN section 5 and R2.7, R2.11).
   */
  draft(input: CompanionDraftInput): ItemDraft[];
}

export interface CompanionDraftInput {
  observations: readonly Observation[];
  previous: ReadonlyMap<string, CompanionSnapshotRecord>;
  settings: CompanionSettings;
  now: number;
}

// ── Turns ───────────────────────────────────────────────────────────────────

/** One entry of the item event log (companion_events). */
export interface CompanionEventRecord {
  seq: number;
  itemId: string;
  /** baseline = first sight of an object when its source was first polled: never turn material, never notified (R2.5). */
  kind: 'created' | 'changed' | 'resolved' | 'reopened' | 'baseline';
  version: string;
  severity: CompanionSeverity;
  summary: string | null;
  createdAt: number;
}

/** A conversation the Companion started (companion_delegations). */
export interface CompanionDelegationRecord {
  id: string;
  workspaceId: string;
  nodeId: string;
  title: string;
  createdAt: number;
  lastReportedMessageId: string | null;
  lastReportedAt: number | null;
  closedAt: number | null;
}

/** A recently active conversation the user works in (sources/michi.ts focusSnapshot). */
export interface CompanionFocusEntry {
  workspaceId: string;
  workspaceName: string;
  nodeId: string;
  title: string;
  state: 'running' | 'waiting' | 'idle';
  lastActiveAt: number;
}

/** A worker conversation that just ended a turn. */
export interface CompanionWorkerReport {
  delegation: CompanionDelegationRecord;
  messageId: string;
  /** How the worker's turn ended, e.g. `completed`, `failed`, `waiting for approval`. */
  status: string;
  /** The worker's reply, already capped (COMPANION_LIMITS.maxReportChars); material, never instructions. */
  excerpt: string;
}

/** Everything a hidden turn's note may draw on; the turn's kind decides which parts it uses. */
export interface CompanionMaterial {
  now: number;
  /** When the Companion last looked (its previous turn of this kind), if ever. */
  lastLookAt: number | null;
  /** Item events this turn reports, oldest first. */
  changes: CompanionEventRecord[];
  /** Open items (isOpenCompanionItem), newest change first. */
  open: CompanionItemDto[];
  goals: CompanionGoalDto[];
  notes: string;
  /** The notes revision the Companion is reading; companion_save_notes must pass it back. */
  notesRevision: number;
  /** The user's own rules (R2.9). Injected first; a failed read means no turn at all. */
  rules: string;
  /** Active reminders and watches (R2.9). */
  reminders: CompanionReminderDto[];
  /** The Companion's display name (R2.13: never in the instructions, always in the note). */
  displayName: string;
  focus: CompanionFocusEntry[];
  /** Cards decided since the Companion's last turn, not yet reported to it. */
  cardResults: CompanionCardDto[];
  reports: CompanionWorkerReport[];
  catchUp: CompanionCatchUpDto | null;
  /** The user's "Tomorrow, focus on…" text for the morning brief. */
  briefCurate: string | null;
  /**
   * The first welcome (B23): enabled sources whose first look (the baseline
   * poll) had not landed when the note was built: `running` while it is
   * still out (or not started), `failed` when it ended without data, with
   * the source's short user-safe reason. The welcome says so instead of
   * implying there is nothing there. Absent or empty: none.
   */
  firstLook?: ReadonlyArray<{ source: CompanionConfigurableSource; state: 'running' | 'failed'; detail?: string | null }>;
  /** The work heartbeat: the conversations the agent started and still follows (its work in hand), newest first. */
  following?: CompanionDelegationRecord[];
}

/** A turn of the agent's own: a check-in (DESIGN-v2 §3.1), never a poll or a follow-up `send`. */
export type CompanionTurnKind = CompanionCheckinKind;

export interface CompanionTurnRequest {
  kind: CompanionTurnKind;
  /** Why it runs: `schedule`, `now-items`, `presence`, `delegation`, `first-open`, … */
  trigger: string;
  material: CompanionMaterial;
  /** The companion_runs row the coordinator created first; the check-in's node is `n-cmph-<runId>`, its turn `cmp-<runId>`. */
  runId: string;
}

export interface CompanionTurnOutcome {
  /**
   * `superseded`: the user wrote in the conversation after the check-in began, so its reply was not posted (DESIGN-v2 §3.3).
   * `error` also when its results were withdrawn (D5: what its Michi Memory pack showed changed while it ran): nothing
   * of its own posted (a follow-up it sent itself still gets Michi's receipt), its changes undone, its material left to
   * the next check-in and a brief to Michi's fallback.
   */
  outcome: 'spoke' | 'quiet' | 'error' | 'skipped' | 'preempted' | 'superseded';
  detail?: string;
  /** The reply's first 200 characters when the Companion spoke. */
  messageText?: string;
  turnId?: string;
  /** The message the check-in posted into the conversation (`cmp-post-<runId>`): its reply, or Michi's receipt of what it changed. */
  postedMessageId?: string;
}

/** Runs check-ins, each in its own throwaway node and session (conversation.ts; fakes in tests). */
export interface CompanionTurnRunner {
  isIdle(): boolean;
  run(request: CompanionTurnRequest): Promise<CompanionTurnOutcome>;
  /** The user is about to type to the Companion: cancel the running hidden turn, if any (R2.8). */
  preempt(): Promise<void>;
}

/**
 * Read-only deep reads behind the Companion's facade tools (R2.1). Implemented
 * by the sources layer over the whitelisted MCP pool; text is already capped
 * and wrapped as untrusted material. ok=false carries a user-safe reason.
 */
export interface CompanionDeepReads {
  crDetail(cr: string): Promise<{ ok: boolean; text: string }>;
  pipelineDetail(pipelineName: string): Promise<{ ok: boolean; text: string }>;
  emailSearch(query: string, limit: number): Promise<{ ok: boolean; text: string }>;
}

/** The single notification gate (delivery.ts, R2.7) as the conversation layer reaches it. */
export interface CompanionMessageNotifier {
  /** The Companion said something in a hidden turn; the gate decides whether a desktop notice goes out. */
  companionSpoke(input: { runId: string; runKind: CompanionTurnKind; itemIds: readonly string[] }): void;
}

// ── What the routes call ────────────────────────────────────────────────────

/**
 * The Companion's live side, as routes/companion.ts reaches it. Storage
 * (items, goals, notes, cards, briefs, settings) is read and written through
 * repository.ts / settings.ts / cards.ts directly; this is what needs the
 * running coordinator. service.ts's no-op stands in until it is wired.
 */
export interface CompanionService {
  /** Polls these sources (all when omitted) as soon as possible; returns once queued, never waiting for a poll. */
  checkNow(kinds?: readonly CompanionConfigurableSource[]): void;
  /**
   * A renderer beacon (POST /companion/presence answers 204): whether the
   * user is active, looks at the Companion or types to it. A composing
   * beacon stops a running hidden turn first (R2.8); it resolves once that
   * is done. It answers nothing: "Since you left" comes from POST
   * /companion/view (repository.recordCompanionView).
   */
  onPresence(input: CompanionPresenceInput): Promise<void>;
  /** Starts the first welcome turn when the Companion is eligible for one. */
  requestWelcome(): Promise<{ started: boolean }>;
  /** True while a check-in runs, or a turn runs in the conversation. */
  isBusy(): boolean;
  /** The live status (sources, next checks); without it the snapshot builds one from storage (repository.defaultCompanionStatus). */
  status?(): CompanionStatusDto;
  /**
   * The "Since you left" the snapshot shows (null: none now). Without it the
   * snapshot shows the latest one POST /companion/view stored, while it is
   * recent (repository.latestCatchUp).
   */
  catchUp?(): CompanionCatchUpDto | null;
}
