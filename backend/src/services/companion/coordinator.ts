/**
 * The Companion's engine (DESIGN §6 as amended by R2.3, R2.5-R2.10, R2.14).
 * It ticks every 30 s, and does work only in the process that holds the
 * scheduler lease (a dev backend and the app may share one data directory).
 *
 * A tick:
 *  1. the daily retention pass (cleanup.ts), whether or not the Companion is on;
 *  2. off: nothing more. On: snoozes that ran out come back, cards past their
 *     TTL expire, runs a restart left behind are settled;
 *  3. paused: only the polls the user asked for (Check now). Otherwise
 *     every source that is due (§5 intervals, backoff after failures, the
 *     outside sources behind the Auth check with the system_auth item).
 *     Sources sharing an MCP server (CR and pipelines; email and calendar)
 *     poll one after another, the servers and Michi at the same time (H#2).
 *     An outside poll writes a run row, but of the scheduled ones that were
 *     ok and changed nothing only each source's latest stays (H#5). A
 *     source's first successful poll is its baseline
 *     (repository.applySourcePoll, R2.5); absence resolves an item only after
 *     two ok and complete polls (R2.4);
 *  4. reminders and watches fire (remindersEngine.ts);
 *  5. item notices pass the single gate (delivery.ts CompanionNoticeGate);
 *  6. at most one model turn starts.
 * The first tick with the lease also settles what a stopped Michi left
 * behind, before anything else: its check-ins (cleanup.ts cleanUpCheckins:
 * post what is still due, discard their native records, purge their nodes,
 * DESIGN-v2 §3.7), runs it left running, and conversation.start cards it
 * left starting.
 *
 * Every model turn is a check-in (DESIGN-v2 §3.1, conversation.ts): its own
 * throwaway node and session, posting into the one visible conversation V
 * only what it said or changed. "The conversation" below is V, the
 * assistant's current one, where the user also talks to the agent.
 *
 * Model turns (R2.6, R2.8): none before the first welcome (POST
 * /companion/welcome; it polls everything first, up to 20 s, and up to 90 s
 * for a source still on its first look, so the welcome can name what it
 * finds; a source whose last poll was ok and complete less than two minutes
 * ago is not polled again unless its first look is still open, H#4). While
 * the Pages upkeep's first run still narrates into V, the welcome waits for
 * it (status.firstLook, "Taking a first look…", DESIGN-v2 §3.8). The
 * welcome is what the user opened the chat for: a composing
 * beacon neither holds it back nor stops it. One that did not speak
 * (stopped, failed, cut short by a restart) is not the welcome: unless the
 * user has written to the Companion meanwhile, it is tried again the next
 * time the user opens the Companion, at most three tries in all. No model
 * turn while paused, in quiet hours, while the Companion's conversation is
 * busy or the user types to it; one at a time, each stopped after the
 * hidden-turn timeout and preempted by a composing beacon (outcome
 * `preempted`: its material waits for the next turn). By priority:
 *   worker_report  a conversation the Companion delegated ended a turn with a
 *                  reply the user has not seen (after its brief or the last
 *                  follow-up the agent sent). It does not count against the
 *                  daily budget, but once the budget is used up it becomes a
 *                  deterministic "Worker finished" notice. A delegation stays
 *                  followed after its report (DESIGN-v2 §4) and closes when
 *                  the user writes in it themselves, when it goes or is
 *                  stopped, after a day with no follow-up or report, or three
 *                  days after it started;
 *   wake           interrupting items appeared: after a minute of batching and
 *                  at least ten minutes after the last wake, on workdays, not
 *                  in away mode. What came in while a wake could not run is
 *                  left to the brief and the heartbeat;
 *   brief          once a workday at its time (not before the welcome's day
 *                  is over, not away: then when the user is back; the rule
 *                  is briefSchedule.ts', which status.nextBriefAt follows
 *                  too). Michi's fallback when the budget is used up, the
 *                  turn fails or it publishes nothing;
 *   heartbeat      every interval, after the day's brief, with material only
 *                  (B19): an interrupting or needs-you event (a due reminder
 *                  is both), a card the user decided that the Companion has
 *                  not heard of, or goals every four hours. A look with only
 *                  digest changes (items entering stalled) leaves them to the
 *                  brief; without material, a skipped run and no model. Not
 *                  while a wake is batching or waiting: interrupting items
 *                  are the wake's first.
 * The material of every turn leaves out the items of a source the user turned
 * off, and their events (B15): they are not resolved, they are out of sight.
 * Each turn's companion_runs row comes first and its chat turn id is
 * `cmp-<runId>` (R2.3); what a turn covers is tracked by cursors, dates and
 * runs, never by reusing turn ids. A turn another process left running is
 * waited for while its chat turn runs, at most as long as a turn can run.
 * The rules failing to read stops every model turn (fail closed). Logs carry
 * counts only, never titles or text.
 */

import {
  COMPANION_CONFIGURABLE_SOURCES,
  COMPANION_LIMITS,
  companionCheckinTurnId,
  isOpenCompanionItem,
  type CompanionCatchUpDto,
  type CompanionConfigurableSource,
  type CompanionItemDto,
  type CompanionItemSubtype,
  type CompanionPresenceInput,
  type CompanionRunOutcome,
  type CompanionSettings,
  type CompanionSourceState,
  type CompanionSourceStatus,
  type CompanionStatusDto,
} from 'michi-shared';
import { currentAssistantNodeId } from '../../assistant/store';
import { log } from '../logger';
import { writeFallbackBrief } from './briefFallback';
import { isCompanionBriefPending } from './briefSchedule';
import { settleAbandonedStarts } from './cards';
import { runDailyCleanup, type CompanionCheckinCleanupResult } from './cleanup';
import { atLocalClock, isCompanionWorkday, isInQuietHours, localDateKey, localDayStart, systemCompanionClock } from './clock';
import { CompanionNoticeGate, companionEvents, type CompanionChangeReason, type CompanionEventBus } from './delivery';
import { notOwner } from './errors';
import { CompanionPresence } from './presence';
import { fireDueReminders } from './remindersEngine';
import {
  COMPANION_FIRST_LOOK_WINDOW_MS,
  applySourcePoll,
  briefForDate,
  cardDto,
  clearCompanionWelcomeDone,
  closeDelegation,
  companionHiddenItemTest,
  companionWelcomeDoneAt,
  countTurnsSince,
  defaultCompanionStatus,
  expireCards,
  failInterruptedRuns,
  finishRun,
  getBriefCurate,
  getCompanionMetaNumber,
  getCompanionNotesState,
  getItem,
  getItemByKey,
  getSnapshots,
  getSourceBaseline,
  isCompanionWelcomeDone,
  isSourceBaselined,
  isSubtypeDemoted,
  keepLatestQuietPoll,
  latestCatchUp,
  latestEventSeq,
  latestFinishedRun,
  latestRunWithOutcome,
  leaveDelegationReplyToToday,
  listEventsAfter,
  listGoals,
  listOpenDelegations,
  listOpenItems,
  listReminders,
  listRunningRuns,
  listUnreportedCards,
  markCardsReported,
  markCompanionWelcomeDone,
  markDelegationReported,
  readCompanionRules,
  recordRun,
  reminderDto,
  resolveItems,
  setBriefCurate,
  setCompanionMetaNumber,
  setRunTurnId,
  startRun,
  upsertItem,
  userWroteInConversation,
  wakeSnoozedItems,
  type CompanionMetaKey,
} from './repository';
import { getCompanionSettings } from './settings';
import { AUTH_EXPIRED_DETAIL } from './sources/common';
const COMPANION_SOURCE_SERVERS: Record<string, string> = { cr: 'code', pipeline: 'code', email: 'office', calendar: 'office' };
import { createMichiSource, type CompanionMichiSource, type CompanionWorkerState } from './sources/michi';
import type { CompanionAuthChecker, CompanionAuthStatus } from './sources/auth';
import type {
  CompanionClock,
  CompanionEventRecord,
  CompanionFocusEntry,
  CompanionMaterial,
  CompanionMessageNotifier,
  CompanionService,
  CompanionSource,
  CompanionTurnKind,
  CompanionTurnOutcome,
  CompanionTurnRunner,
  CompanionWorkerReport,
  SourcePollResult,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const COMPANION_TICK_MS = 30_000;
const FIRST_TICK_DELAY_MS = 3_000;
/** Interrupting items are batched this long before a wake (§6.6). */
export const COMPANION_WAKE_BATCH_MS = MINUTE_MS;
/** At least this long between two wakes (§6.6). */
export const COMPANION_WAKE_SPACING_MS = 10 * MINUTE_MS;
/** With goals, a heartbeat has material at least this often (R2.8). */
export const COMPANION_GOALS_HEARTBEAT_MS = 240 * MINUTE_MS;
/** A source that keeps failing waits at most this long between tries. */
const MAX_BACKOFF_MS = 60 * MINUTE_MS;
/** With Auth known to be expired, the outside sources look again this soon (the check itself is cached). */
const AUTH_RETRY_MS = MINUTE_MS;
/** A source failing this many polls in a row gets a system_source_error item. */
const SOURCE_ERROR_AFTER = 3;
/** After a turn of a kind failed, cut short or was refused, that kind waits this long. */
const ERROR_RETRY_MS = 10 * MINUTE_MS;
const PREEMPT_RETRY_MS = 2 * MINUTE_MS;
const SKIP_RETRY_MS = MINUTE_MS;
/** With the user's rules unreadable, each kind of turn records its refusal this often. */
const RULES_RETRY_MS = 30 * MINUTE_MS;
/** A brief turn cut short this many times gives way to the fallback. */
const BRIEF_MAX_ATTEMPTS = 3;
/** A worker report that failed this many times goes out as a "Worker finished" notice instead. */
const WORKER_REPORT_MAX_ERRORS = 2;
/** A delegation with nothing sent or reported for a day closes; so does any after three days (DESIGN-v2 §4). */
const DELEGATION_IDLE_CLOSE_MS = COMPANION_LIMITS.delegationIdleMs;
const DELEGATION_MAX_AGE_MS = COMPANION_LIMITS.delegationMaxAgeMs;
/** Events one look reads at most (the newest ones after its cursor). */
const EVENT_WINDOW = 200;
const WAKE_REPORTED_KEPT = 500;
const PREEMPT_WAIT_MS = 5_000;
/** How long the first welcome waits for its polls, and for a source still on its first look (default 20 s and 90 s). */
const WELCOME_POLL_WAIT_MS = 20_000;
const WELCOME_FIRST_LOOK_WAIT_MS = 90_000;
/** A source whose last poll was ok and complete this recently is not polled again for the welcome (H#4). */
const WELCOME_FRESH_POLL_MS = 2 * MINUTE_MS;
/** Welcome turns that did not speak before the welcome counts as done anyway (a broken runtime must not keep the Companion silent). */
const COMPANION_WELCOME_MAX_TRIES = 3;
/** A turn another process left running is given up this long after it could at most have run (its guard). */
const ORPHAN_SETTLE_MS = 2 * MINUTE_MS;
const AUTH_ITEM_KEY = 'system:auth';
const UNKNOWN_AUTH: CompanionAuthStatus = Object.freeze({ valid: null, expiresAt: null, checkedAt: null });
/** Interrupting items that need no Companion turn: the notice says it all. */
const NO_WAKE: ReadonlySet<CompanionItemSubtype> = new Set<CompanionItemSubtype>(['system_auth', 'system_source_error']);
const SOURCE_LABELS: Record<CompanionConfigurableSource, string> = {
  michi: 'Michi conversations', cr: 'CRs', pipeline: 'pipelines', email: 'email', calendar: 'calendar',
};

/** Which sources poll one after another: those of one MCP server (it runs one call at a time); Michi reads the database. */
function pollLaneOf(kind: CompanionConfigurableSource): string {
  return kind === 'michi' ? 'michi' : COMPANION_SOURCE_SERVERS[kind] ?? kind;
}

// ── Dependencies and handle ─────────────────────────────────────────────────

export interface CompanionCoordinatorDeps {
  clock?: CompanionClock;
  /** The outside sources (sources/index.ts createExternalSources): cr, pipeline, email, calendar. */
  sources?: readonly CompanionSource[];
  /** Michi's own source; default createMichiSource(); null runs without it. */
  michiSource?: CompanionMichiSource | null;
  /** The Auth check the outside sources sit behind; without it Auth is unknown and blocks nothing. */
  auth?: Pick<CompanionAuthChecker, 'check' | 'last'> | null;
  /** Runs check-ins (conversation.ts), or makes the runner from the gate it reports posts to. */
  turnRunner?: CompanionTurnRunner | ((notifier: CompanionMessageNotifier) => CompanionTurnRunner) | null;
  /** This process holds the scheduler lease and so runs the Companion (R2.14; scheduledJobScheduler.status().active). Default: always. */
  isLeaseHolder?: () => boolean;
  /** The conversation V answers or its runtime cleans up (chatHub.isActive || isOwnerTurnActive || hasPendingSelfTurn). */
  conversationBusy?: (nodeId: string) => boolean;
  /** The conversation V's node (default: assistant/store currentAssistantNodeId). */
  conversationNodeId?: () => string | null;
  /**
   * What a stopped Michi left of its check-ins (cleanup.ts cleanUpCheckins
   * with this process's chatHub and chatManager, boot.ts): run once, before
   * the first tick does anything else, leaving alone the runs `skip` names
   * (turns another process may still be running).
   */
  cleanUpCheckins?: (skip: (runId: string) => boolean) => Promise<CompanionCheckinCleanupResult>;
  /** The Pages upkeep's first run still narrates into V: the welcome waits for it (default: never). */
  firstRunPending?: () => boolean;
  /** A chat turn still runs: after a restart, a run whose turn still runs is re-attached instead of failed (R2.3). */
  turnActive?: (turnId: string) => boolean;
  events?: CompanionEventBus;
  /** The gate's readers (defaults: panePresence and nodes.viewed_at). */
  isPaneVisible?: (nodeId: string) => boolean;
  nodeViewedAt?: (nodeId: string) => number | null;
  tickMs?: number;
  /** false: no timers at all, the caller drives tick() (tests). */
  autoTick?: boolean;
  /** How long the first welcome waits for its polls (default 20 s). */
  welcomePollWaitMs?: number;
  /** How long it waits for a source still on its first look, so it can name what that source finds (default 90 s). */
  welcomeFirstLookWaitMs?: number;
  /** A poll still running after this fails as a timeout (default 3 min). */
  pollTimeoutMs?: number;
  /** A hidden turn still running after this is stopped (default: the hidden-turn timeout and a minute). */
  turnGuardMs?: number;
}

export interface CompanionCoordinator {
  /** The real CompanionService the routes use (routes/companion.ts CompanionRouterDeps.service). */
  service: CompanionService;
  /** The single notification gate; the conversation layer reports replies to it (CompanionMessageNotifier). */
  notifier: CompanionNoticeGate;
  /** One tick now (what the timer runs). */
  tick(): Promise<void>;
  /** Resolves once no tick, poll or model turn is in flight (tests). */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

// ── Internal state ──────────────────────────────────────────────────────────

interface SourceRuntime {
  state: CompanionSourceState | null;
  detail: string | null;
  lastPolledAt: number | null;
  /** When a poll last came back ok and complete, and was stored. */
  lastCompleteAt: number | null;
  nextPollAt: number | null;
  failures: number;
  /** Check now asked for it. */
  forced: boolean;
  inflight: Promise<void> | null;
}

type TurnPlan =
  | { kind: 'welcome' }
  | { kind: 'worker_report'; reports: CompanionWorkerReport[] }
  | { kind: 'wake'; changes: CompanionEventRecord[]; cursor: number }
  | { kind: 'brief'; changes: CompanionEventRecord[]; cursor: number; date: string }
  | { kind: 'heartbeat'; changes: CompanionEventRecord[]; cursor: number };

interface ActiveTurn {
  runId: string;
  plan: TurnPlan;
  material: CompanionMaterial;
  promise: Promise<void>;
  guard: NodeJS.Timeout | null;
  finished: boolean;
  preempting: boolean;
}

/** A turn a previous process left running whose chat turn still ran when this one started (R2.3). */
interface OrphanTurn {
  turnId: string;
  kind: CompanionTurnKind;
  /** When to stop waiting: no live process lets a hidden turn run this long, so its chat turn is a dead process's leftover. */
  giveUpAt: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** Resolves when `promise` settles or `ms` have passed, whichever comes first. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  await Promise.race([
    promise.then(() => {}, () => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function planItemIds(plan: TurnPlan): string[] {
  return 'changes' in plan ? [...new Set(plan.changes.map((event) => event.itemId))] : [];
}

function workerStatus(worker: CompanionWorkerState): string {
  if (worker.turnStatus === 'error') return worker.error === 'backend_restarted' ? 'interrupted: Michi stopped while it ran' : 'failed';
  if (worker.stopReason === 'max_tokens' || worker.stopReason === 'max_turn_requests') return 'stopped early';
  if (worker.stopReason === 'refusal') return 'declined to continue';
  return /[?？]\s*$/.test(worker.reply) ? 'completed, waiting for your answer' : 'completed';
}

const TURN_OUTCOMES: readonly CompanionTurnOutcome['outcome'][] = ['spoke', 'quiet', 'error', 'skipped', 'preempted', 'superseded'];

class Coordinator implements CompanionCoordinator {
  readonly service: CompanionService;
  readonly notifier: CompanionNoticeGate;
  private readonly clock: CompanionClock;
  private readonly events: CompanionEventBus;
  private readonly sources: CompanionSource[];
  private readonly michi: CompanionMichiSource | null;
  private readonly auth: Pick<CompanionAuthChecker, 'check' | 'last'> | null;
  private readonly runner: CompanionTurnRunner | null;
  private readonly presence: CompanionPresence;
  private readonly runtimes = new Map<CompanionConfigurableSource, SourceRuntime>();
  private readonly retryAfter = new Map<CompanionTurnKind, number>();
  private readonly briefAttempts = new Map<string, number>();
  private readonly workerErrors = new Map<string, number>();
  /** Item versions a wake turn reported: the heartbeat does not bring them up again. */
  private readonly wakeReported = new Map<string, string>();
  private readonly orphans = new Map<string, OrphanTurn>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private interval: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  /** Aborted by stop(): polls still out end at once, so shutdown never waits for a slow source. */
  private readonly stopSignal = new AbortController();
  private startedUp = false;
  private welcoming = false;
  /** A welcome asked for while the Pages upkeep's first run still narrates: the tick starts it once that is over. */
  private welcomeQueued = false;
  /** A welcome the tick asked for again (maybeRetryWelcome), until it settles. */
  private welcomeRetry: Promise<void> | null = null;
  private activeTurn: ActiveTurn | null = null;
  private wakePendingSince: number | null = null;
  private statusSignature: string | null = null;

  constructor(private readonly deps: CompanionCoordinatorDeps) {
    this.clock = deps.clock ?? systemCompanionClock;
    this.events = deps.events ?? companionEvents;
    this.michi = deps.michiSource === undefined ? createMichiSource() : deps.michiSource;
    const seen = new Set<string>();
    this.sources = [...(this.michi ? [this.michi] : []), ...(deps.sources ?? [])].filter((source) => {
      if (!(COMPANION_CONFIGURABLE_SOURCES as readonly string[]).includes(source.kind) || seen.has(source.kind)) return false;
      seen.add(source.kind);
      return true;
    });
    this.auth = deps.auth ?? null;
    this.presence = new CompanionPresence(this.clock.now());
    this.notifier = new CompanionNoticeGate({
      clock: this.clock,
      bus: this.events,
      isPanelFocused: (now) => this.presence.isPanelFocused(now),
      isPaneVisible: deps.isPaneVisible,
      nodeViewedAt: deps.nodeViewedAt,
    });
    const runner = deps.turnRunner ?? null;
    this.runner = typeof runner === 'function' ? runner(this.notifier) : runner;
    this.service = {
      checkNow: (kinds) => this.checkNow(kinds),
      onPresence: (input) => this.onPresence(input),
      requestWelcome: () => this.requestWelcome(),
      isBusy: () => this.isBusy(),
      status: () => this.status(),
      catchUp: () => this.catchUp(),
    };
    if (deps.autoTick !== false) {
      this.interval = setInterval(() => { void this.tick(); }, deps.tickMs ?? COMPANION_TICK_MS);
      this.interval.unref?.();
      this.later(() => { void this.tick(); }, FIRST_TICK_DELAY_MS);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) {
      this.rerun = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.rerun = false;
          try {
            await this.tickOnce();
          } catch (error) {
            // The timer fires the next tick; a database that went away must not become an unhandled rejection.
            log.warn('scheduler', 'companion tick failed', { err: errorText(error) });
          }
        } while (this.rerun && !this.stopped);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  async idle(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      const pending = [this.ticking, this.welcomeRetry, this.activeTurn?.promise ?? null, ...[...this.runtimes.values()].map((runtime) => runtime.inflight)]
        .filter((promise): promise is Promise<void> => promise !== null);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopSignal.abort();
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.activeTurn?.guard) clearTimeout(this.activeTurn.guard);
    // The tick and the polls still out (the welcome's too) settle before the caller closes the database.
    const pending = [this.ticking, this.welcomeRetry, ...[...this.runtimes.values()].map((runtime) => runtime.inflight)]
      .filter((promise): promise is Promise<void> => promise !== null);
    await Promise.allSettled(pending);
  }

  /** A one-shot timer that never keeps the process alive and dies with stop(). */
  private later(fn: () => void, ms: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  private scheduleTick(): void {
    if (this.stopped || this.deps.autoTick === false) return;
    this.later(() => { void this.tick(); }, 0);
  }

  private holdsLease(): boolean {
    try {
      return this.deps.isLeaseHolder ? this.deps.isLeaseHolder() : true;
    } catch {
      return false;
    }
  }

  private emit(reason: CompanionChangeReason): void {
    try {
      this.events.emitChanged(reason);
    } catch {
      // A broken subscriber never stops the engine.
    }
  }

  private step(name: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log.warn('scheduler', 'companion step failed', { step: name, err: errorText(error) });
    }
  }

  private async tickOnce(): Promise<void> {
    if (!this.holdsLease()) return;
    const now = this.clock.now();
    if (!this.startedUp) {
      try {
        await this.startUp(now);
      } catch (error) {
        log.warn('scheduler', 'companion step failed', { step: 'start', err: errorText(error) });
      }
    }
    this.step('cleanup', () => { runDailyCleanup(now); });
    const settings = getCompanionSettings();
    if (settings.enabled) {
      this.step('housekeeping', () => this.housekeeping(now));
      try {
        await this.settleOrphans(now);
      } catch (error) {
        log.warn('scheduler', 'companion step failed', { step: 'restarted turns', err: errorText(error) });
      }
      this.step('welcome', () => this.noticeUserMet(now));
      try {
        await this.runPolls(settings.paused);
      } catch (error) {
        log.warn('scheduler', 'companion polls failed', { err: errorText(error) });
      }
      if (!settings.paused && !this.stopped) this.step('reminders', () => this.fireReminders(this.clock.now()));
      // Paused too: the gate holds what comes in, so resuming sends nothing old (§6.5).
      if (!this.stopped) this.step('notices', () => { this.notifier.processItems(this.clock.now()); });
      if (!settings.paused && !this.stopped) this.step('welcome after the first run', () => this.maybeStartQueuedWelcome());
      if (!settings.paused && !this.stopped) this.step('welcome again', () => this.maybeRetryWelcome(this.clock.now()));
      if (!settings.paused && !this.stopped) this.step('turns', () => this.maybeStartTurn(this.clock.now()));
    }
    this.step('status', () => this.emitStatusIfChanged());
  }

  /** The longest a hidden turn runs before its guard stops it. */
  private turnGuardMs(): number {
    return this.deps.turnGuardMs ?? COMPANION_LIMITS.hiddenTurnTimeoutMs + MINUTE_MS;
  }

  /**
   * The first tick with the lease, before anything else: what a stopped
   * Michi left of its check-ins is cleaned up (cleanUpCheckins: due posts,
   * native records, nodes, §3.7), except turns whose chat turn still runs,
   * which are re-attached until they end or could not run any longer (R2.3).
   * Every other run left running ends as interrupted; a welcome among them
   * that did not speak is asked for again. And a conversation.start card a
   * stopped Michi left starting ends failed now (cards.ts
   * settleAbandonedStarts, B7), so the user sees it and the Companion hears
   * of it, even when no check-in comes soon.
   */
  private async startUp(now: number): Promise<void> {
    if (this.startedUp) return;
    this.startedUp = true;
    const turnActive = this.deps.turnActive ?? (() => false);
    const running = listRunningRuns();
    const alive = running.filter((run) => run.kind !== 'poll' && run.turnId !== null && turnActive(run.turnId)
      && now < run.startedAt + this.turnGuardMs() + ORPHAN_SETTLE_MS);
    for (const run of alive) {
      this.orphans.set(run.id, { turnId: run.turnId!, kind: run.kind as CompanionTurnKind, giveUpAt: run.startedAt + this.turnGuardMs() + ORPHAN_SETTLE_MS });
    }
    const handled = await this.cleanUpCheckins();
    // Only what a stopped Michi left: a poll or a welcome this process started while cleanup ran is its own (G1a-review #4).
    const failed = failInterruptedRuns(this.clock.now(), { only: running.map((run) => run.id), except: alive.map((run) => run.id) });
    if (running.some((run) => run.kind === 'welcome' && !alive.includes(run) && !handled.has(run.id))) this.welcomeDidNotSpeak();
    if (failed > 0) this.emit('activity');
    this.step('abandoned starts', () => {
      if (settleAbandonedStarts(now) > 0) this.emit('cards');
    });
  }

  /**
   * cleanUpCheckins, leaving alone the turns re-attached (orphans). Returns
   * the runs it ended. A welcome among them that posted met the user; one the
   * user's own message superseded did too, without a hello; any other did
   * not speak.
   */
  private async cleanUpCheckins(): Promise<Set<string>> {
    const handled = new Set<string>();
    if (!this.deps.cleanUpCheckins) return handled;
    try {
      const result = await this.deps.cleanUpCheckins((runId) => this.orphans.has(runId));
      for (const run of result.settled) {
        handled.add(run.runId);
        if (run.kind !== 'welcome') continue;
        if (run.outcome !== 'spoke' && run.outcome !== 'superseded') this.welcomeDidNotSpeak();
      }
      if (result.settled.length > 0 || result.purged > 0) this.emit('activity');
    } catch (error) {
      log.warn('scheduler', 'companion check-in cleanup failed', { err: errorText(error) });
    }
    return handled;
  }

  /**
   * Re-attached turns end with their chat turn. The durable turn row is what
   * says so, and a process that died mid-turn (another backend on this data
   * directory, R2.14) leaves it `active` for good: past the longest a turn
   * can run, cleanup takes it over anyway (it posts what is due, discards and
   * purges), so it never holds the Companion up.
   */
  private async settleOrphans(now: number): Promise<void> {
    const turnActive = this.deps.turnActive ?? (() => false);
    const over: Array<[string, OrphanTurn]> = [];
    for (const [runId, orphan] of this.orphans) {
      if (now < orphan.giveUpAt && turnActive(orphan.turnId)) continue;
      this.orphans.delete(runId);
      over.push([runId, orphan]);
    }
    if (over.length === 0) return;
    const handled = await this.cleanUpCheckins();
    for (const [runId, orphan] of over) {
      if (handled.has(runId)) continue;
      const settled = finishRun(runId, {
        outcome: 'error',
        finishedAt: this.clock.now(),
        detail: now >= orphan.giveUpAt ? 'Michi restarted while this turn ran; it never finished' : 'Michi restarted while this turn ran',
      });
      // Null: the process that ran it recorded how it went (and settled its welcome) itself.
      if (settled && orphan.kind === 'welcome') this.welcomeDidNotSpeak();
    }
    this.emit('activity');
  }

  private housekeeping(now: number): void {
    if (wakeSnoozedItems(now).length > 0) this.emit('items');
    if (expireCards(now).length > 0) this.emit('cards');
  }

  // ── Polls ─────────────────────────────────────────────────────────────────

  private runtime(kind: CompanionConfigurableSource): SourceRuntime {
    let runtime = this.runtimes.get(kind);
    if (!runtime) {
      runtime = { state: null, detail: null, lastPolledAt: null, lastCompleteAt: null, nextPollAt: null, failures: 0, forced: false, inflight: null };
      this.runtimes.set(kind, runtime);
    }
    return runtime;
  }

  /**
   * Every due source; while paused only what Check now asked for. Resolves
   * once they all finished (companion_check_now waits for this). Each MCP
   * server runs one call at a time (sources/mcpPool.ts), so the sources of
   * one server poll one after another, each in its own time, and the servers
   * (and Michi, which reads the database) at the same time (H#2): CR deep
   * reads queued on a source no longer hold up the calendar.
   */
  private async runPolls(onlyForced: boolean): Promise<void> {
    const lanes = new Map<string, CompanionSource[]>();
    for (const source of this.sources) {
      const lane = pollLaneOf(source.kind as CompanionConfigurableSource);
      lanes.set(lane, [...(lanes.get(lane) ?? []), source]);
    }
    const lanesDone = await Promise.allSettled([...lanes.values()].map((sources) => this.pollLane(sources, onlyForced)));
    for (const lane of lanesDone) {
      if (lane.status === 'rejected') log.warn('scheduler', 'companion polls failed', { err: errorText(lane.reason) });
    }
  }

  /** The due sources of one lane, one after another. */
  private async pollLane(sources: readonly CompanionSource[], onlyForced: boolean): Promise<void> {
    for (const source of sources) {
      if (this.stopped) return;
      const kind = source.kind as CompanionConfigurableSource;
      const runtime = this.runtime(kind);
      if (!getCompanionSettings().sources[kind].enabled) {
        runtime.forced = false;
        continue;
      }
      const now = this.clock.now();
      const due = runtime.forced || (!onlyForced && (runtime.nextPollAt === null || runtime.nextPollAt <= now));
      if (!due) continue;
      await this.pollGated(source, runtime.forced ? 'check_now' : 'schedule');
    }
  }

  /**
   * Everything enabled at once (the first welcome), shared with a poll
   * already out. The welcome waits for these at most welcomePollWaitMs, and
   * for a source still on its first look (no baseline yet) at most
   * welcomeFirstLookWaitMs: what was already there is what the welcome is
   * about, and it is never news later (R2.5), so a welcome that ran before it
   * landed would never bring it up. A source checked ok and complete in the
   * last two minutes is not checked again (H#4: the schedule had just looked),
   * unless its first look is still open (what a look that grew may still
   * bring in is the welcome's).
   */
  private async pollEverything(): Promise<void> {
    const settings = getCompanionSettings();
    const now = this.clock.now();
    const firstLooks: Promise<void>[] = [];
    const refreshes: Promise<void>[] = [];
    for (const source of this.sources) {
      const kind = source.kind as CompanionConfigurableSource;
      if (!settings.sources[kind].enabled) continue;
      const firstLook = !isSourceBaselined(kind);
      if (!firstLook && this.justChecked(kind, now)) continue;
      (firstLook ? firstLooks : refreshes).push(this.pollGated(source, 'welcome').catch(() => {}));
    }
    await Promise.all([
      waitAtMost(Promise.all(refreshes), this.deps.welcomePollWaitMs ?? WELCOME_POLL_WAIT_MS),
      waitAtMost(Promise.all(firstLooks), this.deps.welcomeFirstLookWaitMs ?? WELCOME_FIRST_LOOK_WAIT_MS),
    ]);
  }

  /** The source's last poll was ok and complete less than WELCOME_FRESH_POLL_MS ago, and its first look is closed. */
  private justChecked(kind: CompanionConfigurableSource, now: number): boolean {
    const { lastCompleteAt } = this.runtime(kind);
    if (lastCompleteAt === null || now - lastCompleteAt >= WELCOME_FRESH_POLL_MS) return false;
    const baseline = getSourceBaseline(kind);
    return baseline !== null && !(baseline.open && now - baseline.at < COMPANION_FIRST_LOOK_WINDOW_MS);
  }

  /** An enabled source's first poll is still out: a welcome waits for what it finds. */
  private firstLookPending(): boolean {
    const settings = getCompanionSettings();
    return this.sources.some((source) => {
      const kind = source.kind as CompanionConfigurableSource;
      return settings.sources[kind].enabled && this.runtime(kind).inflight !== null && !isSourceBaselined(kind);
    });
  }

  /** An outside source runs only while Auth is not known to be expired. */
  private async pollGated(source: CompanionSource, trigger: string): Promise<void> {
    const kind = source.kind as CompanionConfigurableSource;
    if (kind !== 'michi') {
      const status = await this.checkAuth();
      if (status.valid === false) {
        const runtime = this.runtime(kind);
        runtime.state = 'unavailable';
        runtime.detail = AUTH_EXPIRED_DETAIL;
        runtime.nextPollAt = this.clock.now() + AUTH_RETRY_MS;
        runtime.forced = false;
        return;
      }
    }
    await this.pollSource(source, trigger);
  }

  private async checkAuth(): Promise<CompanionAuthStatus> {
    if (!this.auth) return UNKNOWN_AUTH;
    let status: CompanionAuthStatus;
    try {
      status = await this.auth.check();
    } catch {
      return UNKNOWN_AUTH;
    }
    const now = this.clock.now();
    if (status.valid === false) this.raiseAuth(status.expiresAt, now);
    else if (status.valid === true) this.clearAuth(now);
    return status;
  }

  private raiseAuth(expiresAt: number | null, now: number): void {
    const { change } = upsertItem({
      source: 'system',
      subtype: 'system_auth',
      itemKey: AUTH_ITEM_KEY,
      version: expiresAt === null ? 'expired' : `expired:${expiresAt}`,
      bucket: 'needs_you',
      severity: 'now',
      title: 'Auth session expired',
      summary: 'Refresh your credentials so the Companion can check your CRs, pipelines, email and calendar again.',
      target: { kind: 'settings' },
      facts: { expiresAt },
      observedAt: now,
    }, now);
    if (change !== 'unchanged') this.emit('items');
  }

  private clearAuth(now: number): void {
    const item = getItemByKey(AUTH_ITEM_KEY);
    if (item && item.status !== 'resolved' && item.status !== 'muted' && resolveItems([item.id], now).length > 0) this.emit('items');
  }

  /** One poll of one source, shared by whoever asks while it runs. */
  private pollSource(source: CompanionSource, trigger: string): Promise<void> {
    const kind = source.kind as CompanionConfigurableSource;
    const runtime = this.runtime(kind);
    if (runtime.inflight) return runtime.inflight;
    runtime.forced = false;
    const work = this.runPoll(source, kind, runtime, trigger)
      .catch((error) => { log.warn('scheduler', 'companion poll failed', { source: kind, err: errorText(error) }); })
      .finally(() => { runtime.inflight = null; });
    runtime.inflight = work;
    return work;
  }

  private async callPoll(source: CompanionSource, settings: CompanionSettings, now: number, previous: ReturnType<typeof getSnapshots>): Promise<SourcePollResult> {
    const failed = (error: string, detail: string): SourcePollResult => ({ source: source.kind, ok: false, complete: false, observations: [], error, detail });
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = null;
    let onStop: (() => void) | null = null;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(() => source.poll({ settings, now, previous, signal: controller.signal }))
          .catch(() => failed('tool_error', 'The check failed')),
        new Promise<SourcePollResult>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(failed('timeout', 'The check took too long'));
          }, this.deps.pollTimeoutMs ?? 3 * MINUTE_MS);
          timer.unref?.();
        }),
        new Promise<SourcePollResult>((resolve) => {
          onStop = () => {
            controller.abort();
            resolve(failed('stopped', 'Michi stopped before the check finished'));
          };
          if (this.stopSignal.signal.aborted) onStop();
          else this.stopSignal.signal.addEventListener('abort', onStop, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onStop) this.stopSignal.signal.removeEventListener('abort', onStop);
    }
  }

  private intervalOf(source: CompanionSource, settings: CompanionSettings): number {
    try {
      const interval = source.intervalMs(settings);
      return Number.isFinite(interval) && interval > 0 ? interval : settings.pollMinutes * MINUTE_MS;
    } catch {
      return settings.pollMinutes * MINUTE_MS;
    }
  }

  private async runPoll(source: CompanionSource, kind: CompanionConfigurableSource, runtime: SourceRuntime, trigger: string): Promise<void> {
    const settings = getCompanionSettings();
    const startedAt = this.clock.now();
    // Michi polls every minute: only polls that found something, or failed, get a row (the rest would drown the Activity list).
    const run = kind === 'michi' ? null : startRun({ kind: 'poll', trigger: kind, startedAt });
    const previous = getSnapshots(kind);
    const result = await this.callPoll(source, settings, startedAt, previous);
    const now = this.clock.now();
    if (this.stopped) {
      // Shutting down: what this poll saw, or did not, changes nothing; the next start polls again.
      if (run) finishRun(run.id, { outcome: 'skipped', finishedAt: now, detail: 'Michi stopped before the check finished' });
      return;
    }
    let failed = !result.ok;
    let detail = result.detail ?? null;
    let changed = false;
    let baseline = false;
    let observed = 0;
    if (result.ok) {
      try {
        const drafts = source.draft({ observations: result.observations, previous, settings, now });
        const write = applySourcePoll({ source: kind, result, drafts, now });
        if (write.outcome === 'applied') {
          baseline = write.baseline;
          observed = result.observations.length;
          changed = write.resolved.length > 0 || write.upserts.some((upsert) => upsert.change !== 'unchanged');
        } else {
          failed = true;
          detail = 'The answer had none of what it had before; not trusted this time';
        }
      } catch (error) {
        failed = true;
        detail = 'What it found could not be stored';
        log.warn('scheduler', 'companion poll not stored', { source: kind, err: errorText(error) });
      }
    }
    const interval = this.intervalOf(source, settings);
    let outcome: Exclude<CompanionRunOutcome, 'running'> = failed ? 'error' : 'ok';
    if (failed && result.error === 'auth_expired') {
      // Not the source's fault: no failure counted, no backoff.
      runtime.state = 'unavailable';
      runtime.detail = detail ?? AUTH_EXPIRED_DETAIL;
      runtime.nextPollAt = now + AUTH_RETRY_MS;
      this.raiseAuth(this.auth?.last().expiresAt ?? null, now);
    } else if (failed && result.error === 'disabled') {
      runtime.state = 'disabled';
      runtime.detail = null;
      runtime.nextPollAt = now + interval;
      outcome = 'skipped';
    } else if (failed) {
      runtime.failures += 1;
      runtime.state = result.error === 'unavailable' ? 'unavailable' : 'error';
      runtime.detail = detail ?? 'The check failed';
      runtime.nextPollAt = now + Math.max(interval, Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(runtime.failures, 10)));
      this.sourceTrouble(kind, runtime, result.error ?? 'error', now);
    } else {
      runtime.failures = 0;
      runtime.state = 'ok';
      runtime.detail = null;
      runtime.nextPollAt = now + interval;
      if (result.complete) runtime.lastCompleteAt = now;
      this.sourceTrouble(kind, runtime, null, now);
    }
    runtime.lastPolledAt = now;
    const parts = [
      trigger === 'check_now' ? 'Check now' : trigger === 'welcome' ? 'First look' : null,
      detail,
      !failed && baseline ? 'first poll: what is there now is not news' : null,
    ].filter((part): part is string => !!part);
    const runDetail = parts.join(' · ') || null;
    if (run) {
      finishRun(run.id, { outcome, finishedAt: now, detail: runDetail });
      // A scheduled look that was ok and changed nothing: only each source's latest keeps its row (H#5).
      if (outcome === 'ok' && !changed && !baseline && trigger === 'schedule') {
        try {
          keepLatestQuietPoll(kind, run.id);
        } catch (error) {
          log.warn('scheduler', 'companion poll rows not compacted', { source: kind, err: errorText(error) });
        }
      }
    } else if (failed || changed || baseline) recordRun({ kind: 'poll', trigger: kind, startedAt, outcome, finishedAt: now, detail: runDetail });
    if (failed) log.warn('scheduler', 'companion poll failed', { source: kind, error: result.error ?? 'stored', failures: runtime.failures });
    else if (baseline) log.info('scheduler', 'companion baseline poll', { source: kind, observations: observed });
    if (changed) this.emit('items');
    if (run || failed || changed || baseline) this.emit('activity');
  }

  /** system_source_error after three failed polls in a row; resolved by the next good one. */
  private sourceTrouble(kind: CompanionConfigurableSource, runtime: Pick<SourceRuntime, 'failures' | 'detail'>, category: string | null, now: number): void {
    const key = `system:source:${kind}`;
    if (runtime.failures >= SOURCE_ERROR_AFTER && category) {
      const { change } = upsertItem({
        source: 'system',
        subtype: 'system_source_error',
        itemKey: key,
        version: category,
        bucket: 'fyi',
        severity: 'silent',
        title: `Couldn't check your ${SOURCE_LABELS[kind]}`,
        summary: runtime.detail,
        target: { kind: 'settings' },
        facts: { source: kind, failures: runtime.failures, error: category },
        observedAt: now,
      }, now);
      if (change !== 'unchanged') this.emit('items');
    } else if (runtime.failures === 0) {
      const item = getItemByKey(key);
      if (item && item.status !== 'resolved' && item.status !== 'muted' && resolveItems([item.id], now).length > 0) this.emit('items');
    }
  }

  // ── Reminders ─────────────────────────────────────────────────────────────

  private fireReminders(now: number): void {
    const fired = fireDueReminders(getCompanionSettings(), now);
    if (fired.length === 0) return;
    this.emit('reminders');
    this.emit('items');
  }

  // ── The first welcome (R2.6) ──────────────────────────────────────────────

  /**
   * The welcome happened: from now on the cursors start here, so what was
   * there before is the welcome's, not news. A welcome asked for again moves
   * them up to it too: no turn ran in between (R2.6), and its look covers
   * what came in since the try that did not speak.
   */
  private markWelcome(now: number): void {
    markCompanionWelcomeDone(now);
    const seq = latestEventSeq();
    for (const key of ['companion:wake_cursor', 'companion:heartbeat_cursor', 'companion:brief_cursor'] as const) {
      if (getCompanionMetaNumber(key) === null) setCompanionMetaNumber(key, seq);
      else this.advance(key, seq);
    }
    setCompanionMetaNumber('companion:last_heartbeat_at', Math.floor(now));
  }

  /**
   * The user wrote in the conversation before any welcome spoke: they have
   * met the agent, without a hello (§3.8).
   */
  private noticeUserMet(now: number): void {
    if (isCompanionWelcomeDone() || this.welcoming || this.activeTurn) return;
    if (this.userHasWritten()) this.welcomeSkipped(now);
  }

  /** The welcome counts as done without having said hello (the user wrote first). */
  private welcomeSkipped(now: number): void {
    this.markWelcome(now);
    this.welcomeQueued = false;
  }

  /**
   * The user wrote in the conversation since the v2 merge. Only their own
   * messages count: posted check-ins and first-run narration are the
   * agent's, and no meeting (§3.8).
   */
  private userHasWritten(): boolean {
    try {
      return userWroteInConversation(this.conversationNodeId());
    } catch {
      return false;
    }
  }

  /**
   * A welcome check-in ended without a word for the user: stopped, failed,
   * cut short by a restart, or quiet. It was not the welcome, so it is asked
   * for again (maybeRetryWelcome), unless the user has written meanwhile
   * (they have met it, without a hello) or it had its last try
   * (COMPANION_WELCOME_MAX_TRIES: the Companion goes on without one rather
   * than stay silent).
   */
  private welcomeDidNotSpeak(): void {
    if (this.userHasWritten()) return;
    const tries = countTurnsSince(0, ['welcome']);
    if (tries >= COMPANION_WELCOME_MAX_TRIES) {
      log.warn('scheduler', 'companion welcome never spoke: going on without it', { tries });
      return;
    }
    clearCompanionWelcomeDone();
  }

  /**
   * A welcome that did not speak is asked for again here, once the user
   * opens the Companion after it (POST /companion/view), is around and not
   * typing to it, and the try's wait is over. The Chat tab may ask too
   * (requestWelcome), under the same wait. A first welcome is always the
   * user's to ask for (R2.6).
   */
  private maybeRetryWelcome(now: number): void {
    if (this.welcomeRetry || this.welcoming || this.welcomeBlocked() || !this.mayTry('welcome', now)) return;
    const last = latestFinishedRun('welcome');
    if (!last) return;
    const viewedAt = getCompanionMetaNumber('companion:last_viewed_at');
    if (viewedAt === null || viewedAt <= last.startedAt) return;
    if (this.presence.isAway(now) || this.presence.isUserTyping(now) || this.firstLookPending() || this.firstRunPending() || !this.conversationIdle()) return;
    this.startWelcomeInBackground('retry', false);
  }

  /** A welcome asked for while the first run narrated starts once it is over (§3.8). */
  private maybeStartQueuedWelcome(): void {
    if (!this.welcomeQueued) return;
    if (isCompanionWelcomeDone()) { this.welcomeQueued = false; return; }
    if (this.welcomeRetry || this.welcoming || this.welcomeBlocked() || this.firstRunPending()) return;
    this.welcomeQueued = false;
    this.startWelcomeInBackground('first-open', true);
  }

  private startWelcomeInBackground(trigger: string, look: boolean): void {
    const retry = this.welcome(trigger, look)
      .then(() => {}, (error: unknown) => { log.warn('scheduler', 'companion welcome failed', { trigger, err: errorText(error) }); })
      .finally(() => { if (this.welcomeRetry === retry) this.welcomeRetry = null; });
    this.welcomeRetry = retry;
  }

  /** The Pages upkeep's first run still narrates into the conversation. */
  private firstRunPending(): boolean {
    try {
      return this.deps.firstRunPending?.() === true;
    } catch {
      return false;
    }
  }

  private conversationNodeId(): string | null {
    try {
      return (this.deps.conversationNodeId ?? currentAssistantNodeId)();
    } catch {
      return null;
    }
  }

  private conversationIdle(): boolean {
    if (this.runner && !this.runner.isIdle()) return false;
    const nodeId = this.conversationNodeId();
    return !(nodeId && this.deps.conversationBusy?.(nodeId));
  }

  private welcomeBlocked(): boolean {
    if (this.stopped || !this.runner || !this.holdsLease() || this.activeTurn || this.orphans.size > 0) return true;
    const settings = getCompanionSettings();
    return !settings.enabled || settings.paused || isCompanionWelcomeDone();
  }

  /**
   * POST /companion/welcome: the Chat tab shows while the welcome is wanted.
   * A welcome that did not speak waits out its retry wait (mayTry) here too,
   * so the tab's own asking cannot use up the tries within minutes. While
   * the Pages upkeep's first run still narrates, the welcome waits for it:
   * queued (status.firstLook), started by the tick once that is over.
   */
  requestWelcome(): Promise<{ started: boolean }> {
    if (!this.mayTry('welcome', this.clock.now())) return Promise.resolve({ started: false });
    if (this.firstRunPending() && !this.welcomeBlocked()) {
      if (!this.welcomeQueued) {
        this.welcomeQueued = true;
        this.emit('status');
      }
      return Promise.resolve({ started: false });
    }
    return this.welcome('first-open', true);
  }

  /**
   * The welcome check-in: a look at every source first (`look`), then the
   * check-in, unless the user wrote before it could start (they have met the
   * agent). The Companion counts as working, and takes its first look, while
   * it looks.
   */
  private async welcome(trigger: string, look: boolean): Promise<{ started: boolean }> {
    if (this.welcoming || this.welcomeBlocked()) return { started: false };
    this.welcoming = true;
    this.emit('status');
    let started = false;
    try {
      if (this.userHasWritten()) {
        this.welcomeSkipped(this.clock.now());
        return { started };
      }
      if (look) await this.pollEverything();
      if (this.welcomeBlocked() || !this.conversationIdle()) return { started };
      const now = this.clock.now();
      if (this.userHasWritten()) {
        this.welcomeSkipped(now);
        return { started };
      }
      this.markWelcome(now);
      started = this.startTurn({ kind: 'welcome' }, trigger, now);
      if (!started) clearCompanionWelcomeDone();
      return { started };
    } finally {
      this.welcoming = false;
      // A turn that started said so itself.
      if (!started) this.emit('status');
    }
  }

  // ── Model turns ───────────────────────────────────────────────────────────

  private mayTry(kind: CompanionTurnKind, now: number): boolean {
    return (this.retryAfter.get(kind) ?? 0) <= now;
  }

  /**
   * Today's brief is still to come: on, a workday, none yet, and the welcome
   * was before its time (that day the welcome is the look). The one rule of
   * briefSchedule.ts, which status.nextBriefAt follows too (B24), so the
   * Today tab never promises a brief the engine will not write.
   */
  private briefPending(settings: CompanionSettings, now: number): boolean {
    return isCompanionBriefPending({ settings, now, welcomeAt: companionWelcomeDoneAt(), briefToday: briefForDate(localDateKey(now)) !== null });
  }

  private maybeStartTurn(now: number): void {
    if (this.stopped || !this.runner) return;
    if (!isCompanionWelcomeDone()) return;
    const settings = getCompanionSettings();
    if (!settings.enabled || settings.paused) return;
    const quiet = isInQuietHours(settings, now);
    const workday = isCompanionWorkday(settings, now);
    const away = this.presence.isAway(now);
    const budgetLeft = countTurnsSince(localDayStart(now)) < settings.dailyTurnBudget;

    // The wake's minute of batching starts when an interrupting item is first seen, whatever else holds the turn back.
    // What came in while no wake could run at all goes to the brief and the heartbeat instead.
    const wake = this.wakeMaterial(now);
    const wakeBlocked = quiet || !workday || away || !budgetLeft;
    if (wakeBlocked) {
      this.advance('companion:wake_cursor', wake.cursor);
      this.wakePendingSince = null;
    } else if (wake.changes.length === 0) {
      this.wakePendingSince = null;
    } else {
      this.wakePendingSince ??= now;
    }

    if (this.activeTurn || this.orphans.size > 0 || this.welcoming) return;
    if (!this.conversationIdle() || this.presence.isUserTyping(now)) return;

    // 1. Worker reports: not counted against the budget; once it is used up, a notice instead.
    if (!quiet) {
      const reports = this.collectWorkerReports(now);
      if (reports.length > 0) {
        if (!budgetLeft) this.reportWorkersByNotice(reports, now, 'Daily turn budget used');
        else if (this.mayTry('worker_report', now)) {
          if (this.startTurn({ kind: 'worker_report', reports }, 'delegation', now)) return;
        }
      }
    }

    // 2. Wake: interrupting items, batched a minute, ten minutes apart.
    if (!wakeBlocked && wake.changes.length > 0 && this.wakePendingSince !== null) {
      const lastWake = getCompanionMetaNumber('companion:last_wake_at');
      if (now - this.wakePendingSince >= COMPANION_WAKE_BATCH_MS && (lastWake === null || now - lastWake >= COMPANION_WAKE_SPACING_MS)
        && this.mayTry('wake', now)) {
        if (this.startTurn({ kind: 'wake', changes: wake.changes, cursor: wake.cursor }, 'now-items', now)) return;
      }
    }

    // 3. Brief: once a workday at its time; away, it waits for the user's return.
    const briefPending = this.briefPending(settings, now);
    if (briefPending && now >= atLocalClock(now, settings.brief.time) && !quiet && !away) {
      const changes = this.eventsAfter('companion:brief_cursor');
      if (!budgetLeft) {
        recordRun({ kind: 'brief', trigger: 'schedule', startedAt: now, outcome: 'skipped', finishedAt: now, detail: 'Daily turn budget used: Michi wrote the brief' });
        this.fallbackBrief(now, changes.cursor);
        this.emit('activity');
      } else if (this.mayTry('brief', now)) {
        const date = localDateKey(now);
        if (this.startTurn({ kind: 'brief', changes: this.briefChanges(changes.events), cursor: changes.cursor, date }, 'schedule', now)) return;
      }
    }

    // 4. Heartbeat: after the day's brief, every interval, with material only.
    if (!settings.heartbeat.enabled || quiet || !workday || away || briefPending) return;
    // Interrupting items are the wake's (its minute, its spacing or a retry): the heartbeat waits for it, and then
    // leaves out what the wake reported. Otherwise both would speak about one item, and both replies notify.
    if (this.wakePendingSince !== null) return;
    const last = getCompanionMetaNumber('companion:last_heartbeat_at');
    if (last !== null && now - last < settings.heartbeat.intervalMinutes * MINUTE_MS) return;
    if (!this.mayTry('heartbeat', now)) return;
    const material = this.heartbeatMaterial(now);
    if (!material.worthATurn) {
      // Digest changes alone (an item entering stalled) are for the brief and Today; the cursor moves past them.
      this.skipHeartbeat(now, material.cursor, material.changes.length > 0 ? 'only digest changes: they wait for the brief' : 'no new material');
      return;
    }
    if (!budgetLeft) {
      this.skipHeartbeat(now, material.cursor, 'Daily turn budget used');
      return;
    }
    this.startTurn({ kind: 'heartbeat', changes: material.changes, cursor: material.cursor }, 'schedule', now);
  }

  private skipHeartbeat(now: number, cursor: number, detail: string): void {
    recordRun({ kind: 'heartbeat', trigger: 'schedule', startedAt: now, outcome: 'skipped', finishedAt: now, detail });
    setCompanionMetaNumber('companion:last_heartbeat_at', Math.floor(now));
    this.advance('companion:heartbeat_cursor', cursor);
    this.emit('activity');
  }

  private advance(key: CompanionMetaKey, cursor: number): void {
    if (cursor > (getCompanionMetaNumber(key) ?? 0)) setCompanionMetaNumber(key, cursor);
  }

  /** The newest events after a cursor (at most EVENT_WINDOW), and the seq a look at them moves the cursor to. */
  private eventsAfter(key: CompanionMetaKey): { events: CompanionEventRecord[]; cursor: number } {
    const cursor = getCompanionMetaNumber(key) ?? 0;
    const latest = latestEventSeq();
    const events = latest > cursor ? listEventsAfter(Math.max(cursor, latest - EVENT_WINDOW), EVENT_WINDOW) : [];
    return { events, cursor: events.length > 0 ? events[events.length - 1]!.seq : cursor };
  }

  /**
   * Of these events, each item's latest one that still describes it (the
   * item is open at that version and in sight: not of a source the user
   * turned off, B15) and that `keep` accepts; never baseline sightings or
   * resolutions. Oldest first.
   */
  private currentEvents(events: readonly CompanionEventRecord[], now: number, keep: (event: CompanionEventRecord, item: CompanionItemDto) => boolean): CompanionEventRecord[] {
    const hidden = companionHiddenItemTest();
    const items = new Map<string, CompanionItemDto | null>();
    const latest = new Map<string, CompanionEventRecord>();
    for (const event of events) {
      if (event.kind === 'baseline' || event.kind === 'resolved') continue;
      if (!items.has(event.itemId)) items.set(event.itemId, getItem(event.itemId));
      const item = items.get(event.itemId);
      if (!item || item.version !== event.version || !isOpenCompanionItem(item, now) || hidden(item) || !keep(event, item)) continue;
      latest.set(item.id, event);
    }
    return [...latest.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * The brief's changes: every event since its cursor (what was done and
   * resolved too), but baseline sightings and the events of items out of
   * sight (B15: a source the user turned off; its items are not resolved, so
   * the brief must not hear of them as done either). Oldest first.
   */
  private briefChanges(events: readonly CompanionEventRecord[]): CompanionEventRecord[] {
    const hidden = companionHiddenItemTest();
    const items = new Map<string, CompanionItemDto | null>();
    return events.filter((event) => {
      if (event.kind === 'baseline') return false;
      if (!items.has(event.itemId)) items.set(event.itemId, getItem(event.itemId));
      const item = items.get(event.itemId);
      return !item || !hidden(item);
    });
  }

  private wakeMaterial(now: number): { changes: CompanionEventRecord[]; cursor: number } {
    const { events, cursor } = this.eventsAfter('companion:wake_cursor');
    const changes = this.currentEvents(events, now, (event, item) => event.severity === 'now' && item.severity === 'now'
      && !NO_WAKE.has(item.subtype) && !isSubtypeDemoted(item.subtype));
    return { changes, cursor };
  }

  /**
   * The heartbeat's changes (R2.8): needs-you or interrupting events (not a
   * version a wake already reported) and items entering stalled; goals every
   * four hours. Worth a model turn (B19) only with an interrupting or
   * needs-you event among them (a due reminder is both), due goals, or a card
   * the user decided that the Companion was not told of yet; worker reports
   * have their own turn, before this one. Digest changes alone wait for the
   * brief.
   */
  private heartbeatMaterial(now: number): { changes: CompanionEventRecord[]; cursor: number; goalsDue: boolean; worthATurn: boolean } {
    const { events, cursor } = this.eventsAfter('companion:heartbeat_cursor');
    let pressing = false;
    const changes = this.currentEvents(events, now, (event, item) => {
      if (this.wakeReported.get(item.id) === event.version) return false;
      const needsTheUser = item.bucket === 'needs_you' || (event.severity === 'now' && !isSubtypeDemoted(item.subtype));
      if (needsTheUser) pressing = true;
      return needsTheUser || item.bucket === 'stalled';
    });
    const lastTurn = latestRunWithOutcome('heartbeat', ['spoke', 'quiet'])?.startedAt ?? companionWelcomeDoneAt() ?? 0;
    const goalsDue = listGoals().length > 0 && now - lastTurn >= COMPANION_GOALS_HEARTBEAT_MS;
    const worthATurn = pressing || goalsDue || listUnreportedCards(1).length > 0;
    return { changes, cursor, goalsDue, worthATurn };
  }

  /**
   * Delegated conversations that ended a turn with a reply the user has not
   * seen: the turn that answered the brief or the agent's last follow-up
   * (the latest turn: a follow-up only goes into an idle conversation).
   * Closes what is over on the way (R2.8, DESIGN-v2 §4): the conversation
   * went or was stopped, the user wrote in it (the agent's own follow-ups do
   * not count), three days passed since it started, or a day passed since
   * the last follow-up or report with nothing new. A reply the user read
   * already counts as reported; the delegation stays followed.
   */
  private collectWorkerReports(now: number): CompanionWorkerReport[] {
    const open = listOpenDelegations();
    if (open.length === 0 || !this.michi) return [];
    const states = this.michi.workerStates(open.map((delegation) => delegation.nodeId));
    const reports: CompanionWorkerReport[] = [];
    for (const delegation of open) {
      const worker = states.get(delegation.nodeId);
      const age = now - delegation.createdAt;
      if (!worker || !worker.exists || worker.turnStatus === 'cancelled') {
        closeDelegation(delegation.nodeId, now, 'gone');
        continue;
      }
      if (worker.userTookOver) {
        closeDelegation(delegation.nodeId, now, 'took_over');
        continue;
      }
      if (age >= DELEGATION_MAX_AGE_MS) {
        closeDelegation(delegation.nodeId, now, 'age');
        continue;
      }
      const ended = worker.turnStatus === 'completed' || worker.turnStatus === 'error';
      // A reply a held-back notice left to Today (D18) is Today's now, not a report's.
      const fresh = ended && worker.messageId !== null && worker.messageId !== delegation.lastReportedMessageId
        && worker.messageId !== delegation.leftToTodayMessageId;
      if (fresh && worker.viewedAt !== null && worker.endedAt !== null && worker.viewedAt >= worker.endedAt) {
        // The user read the reply already: nothing to report; the agent keeps following.
        markDelegationReported(delegation.nodeId, worker.messageId!, now);
        continue;
      }
      if (!fresh) {
        const since = Math.max(delegation.createdAt, delegation.lastSentAt ?? 0, delegation.lastReportedAt ?? 0);
        if (now - since >= DELEGATION_IDLE_CLOSE_MS) closeDelegation(delegation.nodeId, now, 'idle');
        continue;
      }
      reports.push({
        delegation,
        messageId: worker.messageId!,
        status: workerStatus(worker),
        excerpt: worker.reply.slice(0, COMPANION_LIMITS.maxReportChars),
      });
    }
    return reports;
  }

  /**
   * Worker reports as deterministic "Worker finished" notices (the budget is
   * used up, or the report failed twice). One whose notice went out counts as
   * reported, and the agent keeps following it (DESIGN-v2 §4). One the gate
   * held back (an off day, quiet hours, notifications off, a cap, its pane
   * on screen) stays followed too, its reply left to Today (D18): worker
   * reports skip that reply, so nothing repeats on every tick, and the Michi
   * source shows it as a done item in Today and the next brief (R2.7: what a
   * notice cannot say goes to the brief), while a later reply, to a
   * follow-up, is reported as usual. It never closes for this.
   */
  private reportWorkersByNotice(reports: readonly CompanionWorkerReport[], now: number, why: string): void {
    let sent = 0;
    for (const report of reports) {
      const { delegation } = report;
      const result = this.notifier.notify({ kind: 'worker_finished', workspaceId: delegation.workspaceId, nodeId: delegation.nodeId, title: delegation.title }, now);
      if (result === 'sent') {
        markDelegationReported(delegation.nodeId, report.messageId, now);
        sent += 1;
      } else {
        leaveDelegationReplyToToday(delegation.nodeId, report.messageId);
      }
      this.workerErrors.delete(report.messageId);
    }
    const held = reports.length - sent;
    const parts = [
      sent > 0 ? (sent === 1 ? 'a "Worker finished" notice instead' : `${sent} "Worker finished" notices instead`) : null,
      held > 0 ? `${held === 1 ? 'one' : held} left to Today and the brief` : null,
    ].filter((part): part is string => part !== null);
    recordRun({ kind: 'worker_report', trigger: 'delegation', startedAt: now, outcome: 'skipped', finishedAt: now, detail: `${why}: ${parts.join(', ')}` });
    this.emit('activity');
  }

  private focus(settings: CompanionSettings, now: number): CompanionFocusEntry[] {
    if (!this.michi || !settings.sources.michi.enabled) return [];
    try {
      return this.michi.focusSnapshot(now);
    } catch {
      return [];
    }
  }

  private material(plan: TurnPlan, rules: string, settings: CompanionSettings, now: number): CompanionMaterial {
    const notes = getCompanionNotesState();
    return {
      now,
      lastLookAt: latestRunWithOutcome(plan.kind, ['spoke', 'quiet'])?.startedAt ?? null,
      changes: 'changes' in plan ? plan.changes : [],
      open: listOpenItems(now),
      goals: listGoals(),
      notes: notes.notes,
      notesRevision: notes.notesRevision,
      rules,
      reminders: listReminders().map(reminderDto),
      displayName: settings.displayName,
      focus: this.focus(settings, now),
      cardResults: listUnreportedCards().map(cardDto),
      reports: plan.kind === 'worker_report' ? plan.reports : [],
      catchUp: latestCatchUp(now),
      briefCurate: plan.kind === 'brief' ? getBriefCurate() || null : null,
      ...(plan.kind === 'welcome' ? { firstLook: this.firstLooks(settings) } : {}),
    };
  }

  /**
   * The welcome's NOT READ YET section (B23): enabled sources whose first
   * look has not landed, still running or failed, so the welcome does not
   * read their silence as "nothing there".
   */
  private firstLooks(settings: CompanionSettings): NonNullable<CompanionMaterial['firstLook']> {
    return this.sources.flatMap((source) => {
      const kind = source.kind as CompanionConfigurableSource;
      if (!settings.sources[kind].enabled || isSourceBaselined(kind)) return [];
      const runtime = this.runtime(kind);
      const failed = runtime.inflight === null && (runtime.state === 'error' || runtime.state === 'unavailable');
      return [{ source: kind, state: failed ? 'failed' as const : 'running' as const, detail: failed ? runtime.detail : null }];
    });
  }

  /** The user's rules could not be read: no model turn (fail closed), one error run per kind every half hour. */
  private failClosed(plan: TurnPlan, trigger: string, now: number): void {
    if (!this.mayTry(plan.kind, now)) return;
    this.retryAfter.set(plan.kind, now + RULES_RETRY_MS);
    recordRun({ kind: plan.kind, trigger, startedAt: now, outcome: 'error', finishedAt: now, detail: 'Your rules could not be read; the Companion stays quiet until they can' });
    log.warn('scheduler', 'companion rules unreadable: no model turn', { kind: plan.kind });
    if (plan.kind === 'brief') this.fallbackBrief(now, plan.cursor);
    this.emit('activity');
  }

  /** Starts a check-in: its run row first (its node `n-cmph-<runId>`, its turn `cmp-<runId>`), then the runner, in the background. False when it did not start. */
  private startTurn(plan: TurnPlan, trigger: string, now: number): boolean {
    const runner = this.runner;
    if (!runner) return false;
    const rules = readCompanionRules();
    if (!rules.ok) {
      this.failClosed(plan, trigger, now);
      return false;
    }
    const settings = getCompanionSettings();
    const material = this.material(plan, rules.rules, settings, now);
    const run = startRun({ kind: plan.kind, trigger, startedAt: now });
    setRunTurnId(run.id, companionCheckinTurnId(run.id));
    this.notifier.expectReply(run.id, planItemIds(plan));
    const turn: ActiveTurn = { runId: run.id, plan, material, promise: Promise.resolve(), guard: null, finished: false, preempting: false };
    this.activeTurn = turn;
    turn.guard = this.later(() => this.onGuard(turn), this.deps.turnGuardMs ?? COMPANION_LIMITS.hiddenTurnTimeoutMs + MINUTE_MS);
    turn.promise = (async () => {
      let outcome: CompanionTurnOutcome;
      try {
        outcome = await runner.run({ kind: plan.kind, trigger, material, runId: run.id });
      } catch (error) {
        log.warn('scheduler', 'companion turn failed to run', { kind: plan.kind, err: errorText(error) });
        outcome = { outcome: 'error', detail: 'The turn could not run' };
      }
      this.finishTurn(turn, outcome);
    })();
    this.emit('activity');
    this.emit('status');
    return true;
  }

  /** The runner did not end the turn in time: stop it and free the Companion. */
  private onGuard(turn: ActiveTurn): void {
    if (turn.finished) return;
    void this.preemptRunner();
    this.finishTurn(turn, { outcome: 'error', detail: 'The turn did not end in time; Michi stopped it' });
  }

  private async preemptRunner(): Promise<void> {
    if (!this.runner) return;
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.runner.preempt(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PREEMPT_WAIT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      // The turn ends on its own then; its run says so.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private finishTurn(turn: ActiveTurn, raw: CompanionTurnOutcome): void {
    if (turn.finished) return;
    turn.finished = true;
    if (turn.guard) {
      clearTimeout(turn.guard);
      this.timers.delete(turn.guard);
    }
    if (this.activeTurn === turn) this.activeTurn = null;
    const now = this.clock.now();
    const outcome = TURN_OUTCOMES.includes(raw.outcome) ? raw.outcome : 'error';
    try {
      finishRun(turn.runId, {
        outcome,
        finishedAt: now,
        detail: raw.detail ?? null,
        turnId: raw.turnId ?? null,
      });
      this.afterTurn(turn, outcome, now);
    } catch (error) {
      log.warn('scheduler', 'companion turn not settled', { kind: turn.plan.kind, err: errorText(error) });
    }
    this.emit('activity');
    this.emit('status');
    this.scheduleTick();
  }

  /**
   * What a finished check-in covered: cursors, delegations, the day's brief
   * and card outcomes. One the user's message superseded ran too (the model
   * saw its material; the user is in the conversation now), but a worker's
   * report it did not post is still owed. Its post went to the notice gate
   * already (posts.ts).
   */
  private afterTurn(turn: ActiveTurn, outcome: CompanionTurnOutcome['outcome'], now: number): void {
    const { plan } = turn;
    const ran = outcome === 'spoke' || outcome === 'quiet' || (outcome === 'superseded' && plan.kind !== 'worker_report');
    if (ran) {
      markCardsReported(turn.material.cardResults.map((card) => card.id), now);
      this.retryAfter.delete(plan.kind);
    } else {
      this.retryAfter.set(plan.kind, now + (outcome === 'preempted' || outcome === 'superseded' ? PREEMPT_RETRY_MS : outcome === 'skipped' ? SKIP_RETRY_MS : ERROR_RETRY_MS));
    }
    switch (plan.kind) {
      case 'welcome':
        // Superseded: the user wrote first, so they met the agent, without a hello (§3.8).
        if (outcome !== 'spoke' && outcome !== 'superseded') {
          // A welcome that posted nothing: the next try waits as after a failure.
          if (outcome === 'quiet') this.retryAfter.set('welcome', now + ERROR_RETRY_MS);
          this.welcomeDidNotSpeak();
        }
        break;
      case 'worker_report':
        if (ran) {
          // Reported, and still followed (DESIGN-v2 §4): its next reply comes back too.
          for (const report of plan.reports) {
            markDelegationReported(report.delegation.nodeId, report.messageId, now);
            this.workerErrors.delete(report.messageId);
          }
        } else if (outcome === 'error') {
          const given = plan.reports.filter((report) => {
            const errors = (this.workerErrors.get(report.messageId) ?? 0) + 1;
            this.workerErrors.set(report.messageId, errors);
            return errors >= WORKER_REPORT_MAX_ERRORS;
          });
          if (given.length > 0) this.reportWorkersByNotice(given, now, 'The report failed twice');
        }
        break;
      case 'wake':
        if (ran) {
          this.advance('companion:wake_cursor', plan.cursor);
          setCompanionMetaNumber('companion:last_wake_at', Math.floor(now));
          this.wakePendingSince = null;
          for (const event of plan.changes) this.wakeReported.set(event.itemId, event.version);
          while (this.wakeReported.size > WAKE_REPORTED_KEPT) this.wakeReported.delete(this.wakeReported.keys().next().value as string);
        }
        break;
      case 'heartbeat':
        if (ran) {
          this.advance('companion:heartbeat_cursor', plan.cursor);
          setCompanionMetaNumber('companion:last_heartbeat_at', Math.floor(now));
        }
        break;
      case 'brief': {
        const attempts = outcome === 'preempted' || outcome === 'skipped' ? (this.briefAttempts.get(plan.date) ?? 0) + 1 : 0;
        if (attempts > 0) this.briefAttempts.set(plan.date, attempts);
        const settled = ran || outcome === 'error' || attempts >= BRIEF_MAX_ATTEMPTS;
        if (!settled) break;
        if (briefForDate(plan.date)?.origin === 'llm') {
          // The user's "Tomorrow, focus on…" was for this brief.
          setBriefCurate('');
          this.briefWasTheLook(now, plan.cursor);
        } else {
          this.fallbackBrief(now, plan.cursor);
        }
        this.emit('brief');
        break;
      }
      default:
        break;
    }
  }

  /**
   * Michi's own brief for today (briefFallback.ts) when the Companion's
   * cannot be had. A brief, either kind, is also the day's look: the
   * heartbeat starts after it.
   */
  private fallbackBrief(now: number, cursor: number): void {
    const brief = writeFallbackBrief(now);
    this.briefWasTheLook(now, cursor);
    if (brief) this.emit('brief');
  }

  /** Today's brief covered everything up to `cursor`: the next brief and heartbeat start after it. */
  private briefWasTheLook(now: number, cursor: number): void {
    this.advance('companion:brief_cursor', cursor);
    this.advance('companion:heartbeat_cursor', cursor);
    setCompanionMetaNumber('companion:last_heartbeat_at', Math.floor(now));
  }

  // ── The service the routes use ────────────────────────────────────────────

  checkNow(kinds?: readonly CompanionConfigurableSource[]): void {
    if (!this.holdsLease()) throw notOwner();
    const wanted = new Set<string>(kinds ?? COMPANION_CONFIGURABLE_SOURCES);
    for (const source of this.sources) if (wanted.has(source.kind)) this.runtime(source.kind as CompanionConfigurableSource).forced = true;
    this.scheduleTick();
  }

  async onPresence(input: CompanionPresenceInput): Promise<void> {
    const now = this.clock.now();
    const update = this.presence.update(input, now);
    const turn = this.activeTurn;
    // The user goes first (R2.8): the hidden turn yields; its material waits for the next one. Not the welcome:
    // the user opened the chat for it and is about to read it, and a click into the composer (or its keepalive)
    // must not lose it. A message they send meanwhile waits for it to end.
    if (update.composing && (turn ? turn.plan.kind !== 'welcome' : this.orphans.size > 0)) {
      if (!turn || !turn.preempting) {
        if (turn) turn.preempting = true;
        await this.preemptRunner();
      }
    }
    // Back from away mode: a brief that waited for the user may go now.
    if (update.returned) this.scheduleTick();
  }

  /** A check-in runs (or one a previous process left), or a turn runs in the conversation (and its runtime's cleanup after it). */
  isBusy(): boolean {
    if (this.activeTurn || this.orphans.size > 0) return true;
    const nodeId = this.conversationNodeId();
    return !!(nodeId && this.deps.conversationBusy?.(nodeId));
  }

  /**
   * status.working: the Companion's own work only (a hidden turn, one a
   * previous process left running, the welcome getting ready). Never the
   * user's own turn: nothing tells the Companion when that one ends, so a
   * status read during it would keep showing "Working…" after the reply.
   * Every change of this one emits 'status' (startTurn, finishTurn, the
   * welcome, the tick when a turn left behind settles).
   */
  private working(): boolean {
    return this.activeTurn !== null || this.orphans.size > 0 || this.welcoming || this.firstLook();
  }

  /**
   * status.firstLook (§3.8, "Taking a first look…"): the welcome is on its
   * way but its check-in has not started: it waits for the first run's
   * narration, or looks at every source.
   */
  private firstLook(): boolean {
    if (this.activeTurn) return false;
    return this.welcoming || (this.welcomeQueued && !this.welcomeBlocked());
  }

  status(): CompanionStatusDto {
    const now = this.clock.now();
    const settings = getCompanionSettings();
    const leased = this.holdsLease();
    const known = new Set(this.sources.map((source) => source.kind));
    const sources: Partial<Record<CompanionConfigurableSource, Partial<Omit<CompanionSourceStatus, 'kind'>>>> = {};
    for (const kind of COMPANION_CONFIGURABLE_SOURCES) {
      if (!known.has(kind)) {
        sources[kind] = { state: 'unavailable', detail: 'Not available in this Michi' };
        continue;
      }
      if (!leased) {
        sources[kind] = { state: 'pending', detail: 'Another Michi process on this computer runs the Companion' };
        continue;
      }
      const runtime = this.runtime(kind);
      sources[kind] = {
        state: runtime.state ?? 'pending',
        lastPolledAt: runtime.lastPolledAt,
        nextPollAt: runtime.forced ? now : runtime.nextPollAt ?? now,
        detail: runtime.detail,
      };
    }
    let auth: CompanionStatusDto['auth'] = UNKNOWN_AUTH;
    try {
      if (this.auth) auth = this.auth.last();
    } catch {
      auth = UNKNOWN_AUTH;
    }
    const status = defaultCompanionStatus({ settings, now, working: this.working(), sources, auth });
    return this.firstLook() ? { ...status, firstLook: true } : status;
  }

  catchUp(): CompanionCatchUpDto | null {
    return latestCatchUp(this.clock.now());
  }

  private emitStatusIfChanged(): void {
    const status = this.status();
    const signature = JSON.stringify([status.state, status.working, status.firstLook === true, status.turnsToday, status.auth.valid,
      status.sources.map((source) => [source.kind, source.state, source.detail])]);
    if (signature === this.statusSignature) return;
    this.statusSignature = signature;
    this.emit('status');
  }
}

/**
 * Starts the Companion's engine. The returned service is what the routes
 * use; `notifier` is the single notification gate the conversation layer
 * reports replies to. server.ts starts it through boot.ts (not in cloud
 * mode, not with MICHI_DISABLE_COMPANION=1).
 */
export function startCompanion(deps: CompanionCoordinatorDeps = {}): CompanionCoordinator {
  return new Coordinator(deps);
}
