/**
 * How Companion changes and notices leave the backend.
 *
 * - CompanionEventBus: in-process fan-out. emitChanged(reason) bumps the
 *   snapshot revision and tells every `GET /companion/events` stream and the
 *   notifier (whose tray fetches its menu again, DESIGN-v2 §5.1); notices go
 *   to the `GET /companion/notifications/stream` notifiers (Electron main).
 *   It counts its subscribers by kind, a window or a notifier (DESIGN-v2
 *   §5.2): chatNotices.ts notifies only while no window is open, and a notice
 *   wakes the quit app only while no notifier is (§5.1).
 * - The notice outbox: a notice is stored before it is published and
 *   replayed to every notifier that connects until one acknowledges it, as
 *   long as it has not expired and one of its items is still open at the
 *   version it was about (R2.7). A backlog of more than one of the
 *   Companion's own is folded into a single "While you were away: N updates"
 *   (replayCompanionNotices); a conversation's (`chat`) ones are replayed one
 *   by one. A notice the outbox stores while no notifier has been connected
 *   for NOTIFIER_GRACE_MS wakes the app through the backend's one launcher.
 *
 * - The delivery POLICY (CompanionNoticeGate, below): which items and which
 *   Companion replies deserve a desktop notice. Every notice of the agent's
 *   own passes the one gate of R2.7, the running coordinator's (coordinator.ts
 *   makes it and hands it to the turn runner); the outbox functions above it
 *   are its plumbing and nothing else may call them to send a notice, except
 *   chatNotices.ts for the `chat` channel, which the user's chat notification
 *   level governs instead (DESIGN-v2 §5.2).
 * - companionTrayDto: what the tray menu shows (`GET /companion/tray`).
 */

import {
  COMPANION_LIMITS,
  companionBadgeCount,
  companionStatusLine,
  isOpenCompanionItem,
  type CompanionChangedEvent,
  type CompanionItemDto,
  type CompanionNotice,
  type CompanionNoticeChannel,
  type CompanionSettings,
  type CompanionSnapshotDto,
  type CompanionTarget,
  type CompanionTrayDto,
  type CompanionTrayItem,
} from 'michi-shared';
import { getDb } from '../db';
import { panePresenceRegistry } from '../panePresence';
import { NOTIFIER_GRACE_MS, type AppLauncher } from '../scheduledJobs/appLauncher';
import { isCompanionWorkday, isInQuietHours, localDayStart } from './clock';
import {
  COMPANION_ESCALATED_SUFFIX,
  COMPANION_OWNER,
  ackNotice,
  bumpRevision,
  companionHiddenItemTest,
  companionTransaction,
  countNoticesSince,
  currentRevision,
  getItem,
  insertNotice,
  isCompanionItemHidden,
  isCompanionWelcomeDone,
  isSubtypeDemoted,
  listUnescalatedItems,
  listUnnotifiedNowItems,
  markItemsNotified,
  markNoticesDelivered,
  notifiedVersionOf,
  pendingNotices,
} from './repository';
import { getCompanionSettings } from './settings';
import type { CompanionClock, CompanionMessageNotifier, CompanionTurnKind } from './types';

/** SSE event names of the two Companion streams. */
export const COMPANION_CHANGED_SSE_EVENT = 'companion_changed';
export const COMPANION_NOTICE_SSE_EVENT = 'companion_notice';

export type CompanionChangeReason = CompanionChangedEvent['reason'];

export function encodeCompanionChangedEvent(event: CompanionChangedEvent): string {
  return `event: ${COMPANION_CHANGED_SSE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function encodeCompanionNotice(notice: CompanionNotice): string {
  return `event: ${COMPANION_NOTICE_SSE_EVENT}\ndata: ${JSON.stringify(notice)}\n\n`;
}

/**
 * What a subscriber is (DESIGN-v2 §5.2). `window`: a renderer's
 * `/companion/events` feed, one per Michi window (a remote browser's
 * included). `notifier`: the Electron main process's notification feed,
 * which shows OS notifications and refreshes the tray.
 */
export type CompanionSubscriberClient = 'window' | 'notifier';

export interface CompanionEventSubscriber {
  /** Snapshot changes (renderer feeds, and the notifier's tray). */
  changed?(event: CompanionChangedEvent): void;
  /** New notices (desktop notifiers; renderer feeds show them in a plain browser). */
  notice?(notice: CompanionNotice): void;
  /** What it is, for windowCount() and hasNotifier(); in-process listeners leave it out and count as neither. */
  client?: CompanionSubscriberClient;
  /** The same as `client: 'notifier'`. */
  notifier?: boolean;
}

/** Where the bus keeps the revision; the repository's `meta` counter by default. */
export interface CompanionRevisionStore {
  current(): number;
  bump(): number;
}

const storedRevision: CompanionRevisionStore = { current: currentRevision, bump: bumpRevision };

export interface CompanionEventBusOptions {
  /** For the absence times (default Date.now). */
  clock?: () => number;
}

/** How a notice wakes the quit app (DESIGN-v2 §5.1, state C: the macOS background service runs the backend). */
export interface CompanionWakeConfig {
  /** The backend's one launcher: the scheduler wakes the app through it too, so they share its throttle. */
  launcher: AppLauncher;
  /** How long no notifier must have been connected (default NOTIFIER_GRACE_MS). */
  graceMs?: number;
  /** A notice still waits for a notifier (default: the outbox has one, pendingNotices). */
  hasPendingNotice?: (now: number) => boolean;
  /** Runs `callback` after `delayMs`; the returned function cancels it (default: an unref'd setTimeout). */
  setTimer?: (callback: () => void, delayMs: number) => () => void;
}

interface WakeState {
  launcher: AppLauncher;
  graceMs: number;
  hasPendingNotice: (now: number) => boolean;
  setTimer: (callback: () => void, delayMs: number) => () => void;
}

/** A timer that does not keep the process alive. */
export function unrefTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function clientOf(subscriber: CompanionEventSubscriber): CompanionSubscriberClient | null {
  return subscriber.client ?? (subscriber.notifier ? 'notifier' : null);
}

export class CompanionEventBus {
  private readonly subscribers = new Set<CompanionEventSubscriber>();
  private readonly clock: () => number;
  /**
   * When a window, and a notifier, was last connected. Boot counts as just
   * now, so a window or a notifier reconnecting after a backend restart is
   * not taken for one that is gone (as ScheduledJobEventBus does).
   */
  private readonly lastSeenAt: Record<CompanionSubscriberClient, number>;
  private wake: WakeState | null = null;
  /** The one look again once the notifier's grace is up (wakeForNotice); null while none is armed. */
  private cancelWakeCheck: (() => void) | null = null;

  constructor(private readonly revision: CompanionRevisionStore = storedRevision, options: CompanionEventBusOptions = {}) {
    this.clock = options.clock ?? Date.now;
    const now = this.clock();
    this.lastSeenAt = { window: now, notifier: now };
  }

  subscribe(subscriber: CompanionEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    const client = clientOf(subscriber);
    if (client) this.lastSeenAt[client] = this.clock();
    return () => {
      if (!this.subscribers.delete(subscriber)) return;
      if (client) this.lastSeenAt[client] = this.clock();
    };
  }

  private count(client: CompanionSubscriberClient): number {
    let count = 0;
    for (const subscriber of this.subscribers) if (clientOf(subscriber) === client) count += 1;
    return count;
  }

  /** Open Michi windows (their `/companion/events` feeds). */
  windowCount(): number {
    return this.count('window');
  }

  /** Milliseconds since a window was last connected (0 while one is). */
  windowAbsentForMs(): number {
    return this.windowCount() > 0 ? 0 : Math.max(0, this.clock() - this.lastSeenAt.window);
  }

  /** Milliseconds since a notifier was last connected (0 while one is). */
  notifierAbsentForMs(): number {
    return this.hasNotifier() ? 0 : Math.max(0, this.clock() - this.lastSeenAt.notifier);
  }

  /** Where notices wake the app; null: they never do (the default, and every backend but the macOS service's). */
  configureWake(config: CompanionWakeConfig | null): void {
    this.cancelWakeCheck?.();
    this.cancelWakeCheck = null;
    this.wake = config ? {
      launcher: config.launcher,
      graceMs: config.graceMs ?? NOTIFIER_GRACE_MS,
      hasPendingNotice: config.hasPendingNotice ?? ((now) => pendingNotices(now, 1).length > 0),
      setTimer: config.setTimer ?? unrefTimer,
    } : null;
  }

  /**
   * A notice was just stored and published (enqueueCompanionNotice): when no
   * notifier has been connected for the grace, the launcher starts the app
   * hidden, and its notifier gets the notice from the replay (DESIGN-v2
   * §5.1). Only a notice that went out calls this: one the gate held or
   * dropped, and the replay's fold, never do. True when it asked.
   *
   * Within the grace the notifier may only be reconnecting (a feed's
   * backoff, a backend restart, the first 30 s after boot), so nothing wakes
   * yet; but the notice must not be left there (H-review #2: the user quit
   * Michi and V asked for approval ten seconds later). One look again is set
   * for when the grace is up: if no notifier has come back by then and a
   * notice still waits in the outbox, the app is woken.
   */
  wakeForNotice(): boolean {
    const wake = this.wake;
    if (!wake || this.hasNotifier()) return false;
    const absentFor = this.notifierAbsentForMs();
    if (absentFor < wake.graceMs) {
      this.lookAgainForWake(wake, wake.graceMs - absentFor);
      return false;
    }
    return this.launch(wake);
  }

  private lookAgainForWake(wake: WakeState, delayMs: number): void {
    if (this.cancelWakeCheck) return;
    this.cancelWakeCheck = wake.setTimer(() => {
      this.cancelWakeCheck = null;
      if (this.wake !== wake || this.hasNotifier()) return;
      const absentFor = this.notifierAbsentForMs();
      // A notifier came and went meanwhile: its grace starts over.
      if (absentFor < wake.graceMs) {
        this.lookAgainForWake(wake, wake.graceMs - absentFor);
        return;
      }
      let waiting = false;
      try {
        waiting = wake.hasPendingNotice(this.clock());
      } catch {
        waiting = false;
      }
      if (waiting) this.launch(wake);
    }, Math.max(1, delayMs));
  }

  private launch(wake: WakeState): boolean {
    try {
      return wake.launcher.wake();
    } catch {
      return false;
    }
  }

  currentRevision(): number {
    return this.revision.current();
  }

  /** Bumps the revision and tells every renderer stream. Call after the change is written. */
  emitChanged(reason: CompanionChangeReason): CompanionChangedEvent {
    const event: CompanionChangedEvent = { type: 'companion_changed', revision: this.revision.bump(), reason };
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.changed?.(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
    return event;
  }

  publishNotice(notice: CompanionNotice): void {
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.notice?.(notice);
      } catch {
        // One broken stream must not stop the others.
      }
    }
  }

  hasNotifier(): boolean {
    for (const subscriber of this.subscribers) if (clientOf(subscriber) === 'notifier') return true;
    return false;
  }
}

/** The process's Companion bus (routes and the coordinator share it). */
export const companionEvents = new CompanionEventBus();

// ── Notice outbox ───────────────────────────────────────────────────────────

/** A notification someone wants shown. */
export interface CompanionNoticeDraft {
  title: string;
  body: string;
  target: CompanionTarget;
  /** The feed items it is about (none for a Companion reply); the notice goes stale when none of them is open at this version any more. */
  itemIds: readonly string[];
  /** When it goes stale; default COMPANION_LIMITS.noticeTtlMs from now (a meeting's notice: the meeting's start). */
  expiresAt?: number;
  /**
   * The gate it came through: `chat` for a conversation's approval request,
   * question or reply that chatNotices.ts sends while no window is open
   * (DESIGN-v2 §5.2); absent for the Companion's own. Stored with it
   * (companion_notices.channel), so the replay says it too.
   */
  channel?: CompanionNoticeChannel;
  /**
   * A `chat` notice's kind, stored with it (companion_notices.chat_kind): an
   * approval or a question no longer waits once the backend restarted, so
   * withdrawChatRequestNotices takes those back and leaves the replies.
   */
  chatKind?: ChatNoticeKind;
}

/** What a conversation's (`chat`) notice is about. */
export type ChatNoticeKind = 'approval' | 'question' | 'reply';

/**
 * A last word on a draft at the outbox: whether it is stored and published.
 * The decision whether something deserves a notice at all is the gate's
 * (CompanionNoticeGate); it admits what it has decided on.
 */
export interface CompanionDeliveryPolicy {
  admit(draft: CompanionNoticeDraft, now: number): boolean;
}

/** Every draft offered is stored (the gate has already decided). */
export const DELIVER_EVERY_NOTICE: CompanionDeliveryPolicy = Object.freeze({ admit: () => true });

/**
 * The outbox write: stores a notice the policy admits and publishes it to
 * the connected notifiers. Null when the policy holds it back. Only the gate
 * sends notices through it.
 */
export function enqueueCompanionNotice(
  draft: CompanionNoticeDraft,
  now: number,
  options: { bus?: CompanionEventBus; policy?: CompanionDeliveryPolicy } = {},
): CompanionNotice | null {
  if (!(options.policy ?? DELIVER_EVERY_NOTICE).admit(draft, now)) return null;
  const bus = options.bus ?? companionEvents;
  const { channel, chatKind, ...insert } = draft;
  const notice = companionTransaction((): CompanionNotice => {
    const stored = insertNotice({ ...insert, now });
    if (channel !== 'chat') return stored;
    getDb().prepare("UPDATE companion_notices SET channel = 'chat', chat_kind = ? WHERE owner_user_id = ? AND id = ?")
      .run(chatKind ?? null, COMPANION_OWNER, stored.id);
    return { ...stored, channel: 'chat' };
  });
  bus.publishNotice(notice);
  bus.wakeForNotice();
  return notice;
}

/** The ids among these that are `chat` notices (companion_notices.channel). */
function chatNoticeIds(ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = getDb().prepare(`SELECT id FROM companion_notices WHERE owner_user_id = ? AND channel = 'chat'
      AND id IN (${ids.map(() => '?').join(', ')})`).all(COMPANION_OWNER, ...ids) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/**
 * The Companion's own notices created since `since`: what its caps count.
 * A conversation's (`chat`) notices are the user's chat notification level's
 * and never use them up (DESIGN-v2 §5.2).
 */
export function countCompanionNoticesSince(since: number): number {
  const chats = getDb().prepare(`SELECT COUNT(*) AS n FROM companion_notices WHERE owner_user_id = ? AND created_at >= ?
      AND channel = 'chat'`).get(COMPANION_OWNER, since) as { n: number };
  return countNoticesSince(since) - Number(chats.n);
}

/**
 * Notices that no longer need showing, before a notifier showed them (an
 * approval answered elsewhere, a turn that ended): they count as delivered,
 * so no replay brings them back. Returns how many there were.
 */
export function withdrawCompanionNotices(ids: readonly string[], now: number): number {
  return markNoticesDelivered(ids, now);
}

/**
 * Every conversation's approval and question notice not shown yet: nothing
 * waits on them any more once the backend that stored them has stopped (its
 * turns ended with it), so no notifier is told of a request that no longer
 * exists (H-review #6). chatNotices.ts calls it as it starts, before any
 * notifier can connect. Replies stay: the reply is still there to read.
 * Returns how many there were.
 */
export function withdrawChatRequestNotices(now: number): number {
  const rows = getDb().prepare(`SELECT id FROM companion_notices WHERE owner_user_id = ? AND delivered_at IS NULL AND channel = 'chat'
      AND chat_kind IN ('approval', 'question')`).all(COMPANION_OWNER) as Array<{ id: string }>;
  return markNoticesDelivered(rows.map((row) => row.id), now);
}

/** The body of the one notice a backlog folds into. */
export function companionBacklogBody(count: number): string {
  return `While you were away: ${count} updates`;
}

/**
 * A notifier that connects gets at most this many of the conversations'
 * (`chat`) notices it missed, the newest, one by one: each opens its own
 * conversation. The older ones count as delivered.
 */
export const CHAT_NOTICE_REPLAY_MAX = 3;

/**
 * What a notifier that connects is sent (R2.7): the undelivered notices
 * still worth showing. When there is more than one of the Companion's own, a
 * single new notice in their place ("While you were away: N updates", to the
 * Today tab, about all their items, until the latest of them would have
 * expired); the folded ones count as delivered. The fold is stored, so it is
 * replayed until acknowledged like any other notice. A conversation's
 * (`chat`) notices are not folded (Today does not show them): the newest
 * CHAT_NOTICE_REPLAY_MAX follow, each as it is, channel included.
 */
export function replayCompanionNotices(now: number): CompanionNotice[] {
  return companionTransaction(() => {
    const pending = pendingNotices(now);
    const chatIds = chatNoticeIds(pending.map((notice) => notice.id));
    const own = pending.filter((notice) => !chatIds.has(notice.id));
    const chats = pending.filter((notice) => chatIds.has(notice.id)).map((notice): CompanionNotice => ({ ...notice, channel: 'chat' }));
    const kept = chats.slice(-CHAT_NOTICE_REPLAY_MAX);
    markNoticesDelivered(chats.slice(0, chats.length - kept.length).map((notice) => notice.id), now);
    if (own.length <= 1) return [...own, ...kept];
    const fold = insertNotice({
      title: getCompanionSettings().displayName,
      body: companionBacklogBody(own.length),
      target: { kind: 'companion', tab: 'today' },
      itemIds: [...new Set(own.flatMap((notice) => notice.itemIds))],
      now,
      expiresAt: Math.max(...own.map((notice) => notice.expiresAt)),
    });
    markNoticesDelivered(own.map((notice) => notice.id), now);
    return [fold, ...kept];
  });
}

/** A notifier showed the notice; it is not replayed again. */
export function acknowledgeCompanionNotice(id: string, now: number): 'acked' | 'already' | 'missing' {
  return ackNotice(id, now);
}

// ── The delivery policy: one gate for every notice (R2.7) ──────────────────

const MINUTE_MS = 60_000;
/** Notices about items that became due within this window go out as one. */
export const COMPANION_COALESCE_MS = 30_000;
/** A michi_waiting conversation unanswered this long gets its one reminder (R2.7). */
export const COMPANION_ESCALATE_AFTER_MS = 30 * MINUTE_MS;
/** A wake reply about items notified this recently needs no notice of its own (DESIGN §7.6). */
export const COMPANION_WAKE_RENOTIFY_MS = 10 * MINUTE_MS;
const HALF_HOUR_MS = 30 * MINUTE_MS;
const ITEM_BODY_MAX = 200;
const MESSAGE_BODY_MAX = 140;
/** A check-in reply's notice names at most this many items, then how many more. */
const REPLY_NOTICE_TITLES = 3;
const REPLY_NOTICE_TITLE_MAX = 60;
const SPOKEN_RUNS_KEPT = 200;
const TODAY: CompanionTarget = Object.freeze({ kind: 'companion', tab: 'today' }) as CompanionTarget;
const CHAT: CompanionTarget = Object.freeze({ kind: 'companion', tab: 'chat' }) as CompanionTarget;
/** Turns whose reply may notify (DESIGN §7.6): never the welcome, which the user just asked for, or a catch-up. */
const NOTIFYING_TURNS: ReadonlySet<CompanionTurnKind> = new Set<CompanionTurnKind>(['heartbeat', 'wake', 'worker_report', 'brief']);

export type CompanionNoticeRequest =
  /** A feed item's current version (an interrupting item), or the one 30-minute reminder of a michi_waiting conversation. */
  | { kind: 'item'; itemId: string; escalation?: boolean }
  /** The Companion said something in a hidden turn (CompanionMessageNotifier.companionSpoke). */
  | { kind: 'message'; runId: string; runKind: CompanionTurnKind; itemIds: readonly string[] }
  /** A conversation the Companion delegated finished while the day's turn budget is used up (R2.8). */
  | { kind: 'worker_finished'; workspaceId: string; nodeId: string; title: string };

/**
 * sent     = a notice went out;
 * queued   = it waits in the 30-second batch (the next flush sends it);
 * deferred = something only the clock made due (a reminder the user set,
 *            R2.9; a calendar conflict about to start, engine F2) came due
 *            in quiet hours or on an off day: nothing goes out now, and it is
 *            not marked notified, so the first tick once the window opens
 *            sends it;
 * held     = it is not sent and counts as handled: the Companion is off,
 *            paused or not welcomed yet, notifications are off, quiet hours or
 *            an off day, the user already handled it, a cap is reached, or the
 *            item does not interrupt. Its version is marked notified so it
 *            never bursts out later; the brief and Today cover it;
 * dropped  = nothing to send (not open, already notified, a duplicate, a
 *            reply the gate does not notify).
 */
export type CompanionNotifyResult = 'sent' | 'queued' | 'deferred' | 'held' | 'dropped';

export interface CompanionNoticeGateDeps {
  clock?: CompanionClock;
  bus?: CompanionEventBus;
  /** The Companion panel is open and focused (presence.ts): it needs no desktop notice for what it shows. */
  isPanelFocused?: (now: number) => boolean;
  /** A Michi conversation is on screen in some window (default: panePresence). */
  isPaneVisible?: (nodeId: string) => boolean;
  /** When the user last had a conversation on screen (default: nodes.viewed_at). */
  nodeViewedAt?: (nodeId: string) => number | null;
  coalesceMs?: number;
}

interface BatchEntry {
  itemId: string;
  /** The version the notice is about: the item's, or `<version>:escalated` for the 30-minute reminder. */
  version: string;
  escalation: boolean;
}

function clipText(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}


/** The longest single word that counts as a lead-in by itself. */
const LEAD_IN_WORD_MAX = 12;

/**
 * A conversation reply's opening as plain notification text (chatNotices.ts;
 * a check-in's reply never shows its text: companionReplyNoticeBody):
 * markdown marks, code fences and sentinels left out. Its first paragraph,
 * and while that reads as a lead-in (it ends with a colon, "It printed:", or
 * is one word, "Done.") the paragraphs after it too, up to `max` (W4
 * failure 7).
 */
export function noticeExcerpt(text: string, max = MESSAGE_BODY_MAX): string {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)
    .map((paragraph) => paragraph.split('\n').filter((line) => !/^\s*\[(?:FOLLOW-UPS?|TITLE|BRANCH-OVERVIEW)\s*:/i.test(line) && !/^\s*(?:```|~~~)/.test(line)).join(' '))
    .map((paragraph) => paragraph.replace(/^\s*(?:#{1,6}\s+|[-*>]\s+)/, '').replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'))
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let excerpt = paragraphs[0] ?? '';
  // One short word ("Done.", "好的。") leads in; a sentence without spaces (Chinese, Japanese) does not.
  const leadsIn = (line: string) => /[:：]$/.test(line) || (!/\s/.test(line) && line.length <= LEAD_IN_WORD_MAX);
  for (let next = 1; next < paragraphs.length && excerpt.length < max && leadsIn(excerpt); next += 1) {
    excerpt = `${excerpt} ${paragraphs[next]}`;
  }
  return clipText(excerpt, max);
}

/**
 * A check-in reply's notice text: never the reply (model text stays off the
 * lock screen), only the agent's name and the titles of the items its run
 * was about, at most REPLY_NOTICE_TITLES and then how many more, e.g.
 * `Nova: CR-1 needs attention · AuthService is blocked +2`; with none,
 * `Nova has an update`.
 */
function companionReplyNoticeBody(displayName: string, titles: readonly string[]): string {
  const named = titles.map((title) => clipText(title, REPLY_NOTICE_TITLE_MAX)).filter(Boolean);
  if (named.length === 0) return `${displayName} has an update`;
  const more = named.length - REPLY_NOTICE_TITLES;
  return `${displayName}: ${named.slice(0, REPLY_NOTICE_TITLES).join(' · ')}${more > 0 ? ` +${more}` : ''}`;
}

const defaultPaneVisible = (nodeId: string) => panePresenceRegistry.getPresence({ kind: 'node', nodeId }).views.some((view) => view.visible);
const defaultViewedAt = (nodeId: string) => {
  const row = getDb().prepare('SELECT viewed_at FROM nodes WHERE id = ?').get(nodeId) as { viewed_at: number | null } | undefined;
  return row?.viewed_at ?? null;
};

/**
 * The single notification gate (R2.7). Every Companion notice passes it, in
 * this order:
 *   1. the Companion is on, not paused, and the first welcome happened;
 *   2. the notification level (off: nothing; important: no brief reply, and
 *      a wake or heartbeat reply only about an interrupting item);
 *   3. not in quiet hours, on a workday;
 *   4. the item is still open (not resolved, dismissed, muted or snoozed)
 *      and in sight: an item of a source the user turned off counts as gone
 *      (repository isCompanionItemHidden, B15), unmarked, so it is neither
 *      sent nor used up;
 *   5. the user has not handled it already (a Michi conversation on screen,
 *      or viewed since it changed; an email that was read resolved its item);
 *   6. at most COMPANION_LIMITS.maxDailyNotices a day and
 *      maxNoticesPer30Min in any half hour (more wait for the brief);
 *   7. one notice per item key and version (and per Companion reply);
 *   8. items due within 30 s go out together as one notice.
 * Items that do not interrupt (digest, silent, or a subtype the user's
 * feedback demoted) never notify, except the one 30-minute reminder of a
 * conversation that waits on the user. A reminder the user set, and a
 * calendar conflict whose overlap has not started yet (its two-hour `:soon`
 * version, engine F2), that come due in quiet hours or on an off day wait
 * for the window to open instead of being held; a conflict's notice goes
 * stale when its overlap starts (R2.7's meeting rule). The caps count only
 * the Companion's own notices, never a conversation's (`chat`, DESIGN-v2
 * §5.2). A Companion reply never notifies while the Companion panel
 * is focused, nor a wake or heartbeat reply about items notified in the last
 * ten minutes or about to be (in the batch). At the level `important`
 * ("only what needs you now") a wake or heartbeat reply notifies only when
 * it is about at least one item that interrupts (B19): a reply about
 * conversations waiting on the user, review requests or other digest items
 * waits in the chat; at `all` every such reply notifies. A reply's notice
 * never carries its text, only the titles of the items its run was about
 * (companionReplyNoticeBody).
 */
export class CompanionNoticeGate implements CompanionMessageNotifier {
  private readonly clock: CompanionClock;
  private readonly bus: CompanionEventBus;
  private readonly panelFocused: (now: number) => boolean;
  private readonly paneVisible: (nodeId: string) => boolean;
  private readonly viewedAt: (nodeId: string) => number | null;
  private readonly coalesceMs: number;
  private batch: { since: number; entries: Map<string, BatchEntry> } | null = null;
  /** When a notice about each item last went out (the wake rule). */
  private readonly notifiedAt = new Map<string, number>();
  private readonly spokenRuns = new Set<string>();
  /** The items each running turn's material was about (expectReply), for a reply reported without them. */
  private readonly runItems = new Map<string, readonly string[]>();

  constructor(deps: CompanionNoticeGateDeps = {}) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.bus = deps.bus ?? companionEvents;
    this.panelFocused = deps.isPanelFocused ?? (() => false);
    this.paneVisible = deps.isPaneVisible ?? defaultPaneVisible;
    this.viewedAt = deps.nodeViewedAt ?? defaultViewedAt;
    this.coalesceMs = deps.coalesceMs ?? COMPANION_COALESCE_MS;
  }

  /** The gate: whether (and when) this deserves a notice. */
  notify(request: CompanionNoticeRequest, now: number = this.clock.now()): CompanionNotifyResult {
    switch (request.kind) {
      case 'item': return this.notifyItem(request.itemId, request.escalation === true, now);
      case 'message': return this.notifyMessage(request, now);
      case 'worker_finished': return this.notifyWorker(request, now);
      default: return 'dropped';
    }
  }

  /** A turn starts: the items its material is about, so its reply is judged by them however it is reported. */
  expectReply(runId: string, itemIds: readonly string[]): void {
    this.runItems.set(runId, [...itemIds]);
    if (this.runItems.size > SPOKEN_RUNS_KEPT) this.runItems.delete(this.runItems.keys().next().value as string);
  }

  /** CompanionMessageNotifier: the conversation layer reports a reply (the coordinator does too; the second report is a duplicate). */
  companionSpoke(input: { runId: string; runKind: CompanionTurnKind; itemIds: readonly string[] }): void {
    try {
      this.notify({ kind: 'message', runId: input.runId, runKind: input.runKind, itemIds: input.itemIds });
    } catch {
      // A notice is never worth failing a turn over.
    }
  }

  /**
   * The tick's item notices: every open item whose interrupting version was
   * not notified yet, every conversation unanswered for 30 minutes, then the
   * batch when its 30 seconds are up. Returns the notice sent, if any.
   */
  processItems(now: number = this.clock.now()): CompanionNotice | null {
    for (const item of listUnnotifiedNowItems(now)) this.notify({ kind: 'item', itemId: item.id }, now);
    for (const item of listUnescalatedItems('michi_waiting', now - COMPANION_ESCALATE_AFTER_MS, now)) {
      this.notify({ kind: 'item', itemId: item.id, escalation: true }, now);
    }
    return this.flush(now);
  }

  /**
   * Sends the batch once it has waited COMPANION_COALESCE_MS (at once with
   * `force`), re-checking the gate first. An item that is gone meanwhile
   * (resolved, a new version, out of sight because its source was turned
   * off) leaves the batch unmarked.
   */
  flush(now: number = this.clock.now(), options: { force?: boolean } = {}): CompanionNotice | null {
    const batch = this.batch;
    if (!batch || (!options.force && now - batch.since < this.coalesceMs)) return null;
    this.batch = null;
    const hidden = companionHiddenItemTest();
    const entries = [...batch.entries.values()].flatMap((entry) => {
      const item = getItem(entry.itemId);
      if (!item || !isOpenCompanionItem(item, now) || hidden(item) || this.versionOf(item, entry.escalation) !== entry.version) return [];
      if (notifiedVersionOf(item.id) === entry.version) return [];
      return [{ ...entry, item }];
    });
    if (entries.length === 0) return null;
    const settings = getCompanionSettings();
    if (this.closed(settings, now)) {
      // What only the clock holds back stays unmarked: a tick once the window opens queues it again.
      this.hold(entries.filter((entry) => !this.waitsForWindow(entry.item, entry.escalation, settings, now)));
      return null;
    }
    const handled = entries.filter((entry) => this.handled(entry.item));
    this.hold(handled);
    const live = entries.filter((entry) => !handled.includes(entry));
    if (live.length === 0) return null;
    if (!this.withinCaps(now)) {
      this.hold(live);
      return null;
    }
    const notice = this.send(itemNoticeDraft(live, settings.displayName, now), now);
    markItemsNotified(live.map((entry) => ({ id: entry.itemId, version: entry.version })));
    for (const entry of live) this.notifiedAt.set(entry.itemId, now);
    return notice;
  }

  /** Item ids waiting in the batch. */
  pendingItemIds(): string[] {
    return this.batch ? [...this.batch.entries.keys()] : [];
  }

  /** A notice about this item went out within `windowMs`. */
  recentlyNotified(itemId: string, now: number, windowMs: number): boolean {
    const at = this.notifiedAt.get(itemId);
    return at !== undefined && now - at <= windowMs;
  }

  private versionOf(item: CompanionItemDto, escalation: boolean): string {
    return escalation ? `${item.version}${COMPANION_ESCALATED_SUFFIX}` : item.version;
  }

  /** Steps 1-3: nothing goes out at all. */
  private closed(settings: CompanionSettings, now: number): boolean {
    return !settings.enabled || settings.paused || settings.notifications === 'off' || !isCompanionWelcomeDone()
      || this.outsideWindow(settings, now);
  }

  /** Step 3: quiet hours or an off day. */
  private outsideWindow(settings: CompanionSettings, now: number): boolean {
    return isInQuietHours(settings, now) || !isCompanionWorkday(settings, now);
  }

  /**
   * Something only the clock made due (dueByTheClock) that only the clock
   * holds back (quiet hours, an off day): it waits for the window instead of
   * being held. Off, paused, notifications off or before the welcome, it is
   * held like any item, so turning notices back on sends nothing old.
   */
  private waitsForWindow(item: CompanionItemDto, escalation: boolean, settings: CompanionSettings, now: number): boolean {
    if (escalation || !dueByTheClock(item, now) || !this.outsideWindow(settings, now)) return false;
    return settings.enabled && !settings.paused && settings.notifications !== 'off' && isCompanionWelcomeDone();
  }

  /** Step 5: the user has already handled it. */
  private handled(item: CompanionItemDto): boolean {
    if (item.source !== 'michi' || item.target?.kind !== 'node') return false;
    const { nodeId } = item.target;
    if (this.paneVisible(nodeId)) return true;
    const viewedAt = this.viewedAt(nodeId);
    return viewedAt !== null && viewedAt >= item.changedAt;
  }

  /** Step 6. */
  private withinCaps(now: number): boolean {
    return countCompanionNoticesSince(localDayStart(now)) < COMPANION_LIMITS.maxDailyNotices
      && countCompanionNoticesSince(now - HALF_HOUR_MS) < COMPANION_LIMITS.maxNoticesPer30Min;
  }

  private hold(entries: ReadonlyArray<{ itemId: string; version: string }>): void {
    if (entries.length > 0) markItemsNotified(entries.map((entry) => ({ id: entry.itemId, version: entry.version })));
  }

  private send(draft: CompanionNoticeDraft, now: number): CompanionNotice {
    return enqueueCompanionNotice(draft, now, { bus: this.bus })!;
  }

  private notifyItem(itemId: string, escalation: boolean, now: number): CompanionNotifyResult {
    const item = getItem(itemId);
    if (!item) return 'dropped';
    const version = this.versionOf(item, escalation);
    if (notifiedVersionOf(item.id) === version) return 'dropped';
    if (this.batch?.entries.get(item.id)?.version === version) return 'queued';
    if (!isOpenCompanionItem(item, now) || isCompanionItemHidden(item)) return 'dropped';
    // Only an interrupting item notifies; a digest or silent one never does (and keeps its version unmarked).
    if (escalation ? item.subtype !== 'michi_waiting' || now - item.changedAt < COMPANION_ESCALATE_AFTER_MS : item.severity !== 'now') return 'dropped';
    const entry: BatchEntry = { itemId: item.id, version, escalation };
    const settings = getCompanionSettings();
    // A subtype the user's feedback demoted is digest now: held, so undoing the demotion later sends nothing old.
    if (!escalation && isSubtypeDemoted(item.subtype)) {
      this.hold([entry]);
      return 'held';
    }
    if (this.waitsForWindow(item, escalation, settings, now)) return 'deferred';
    if (this.closed(settings, now) || this.handled(item)) {
      this.hold([entry]);
      return 'held';
    }
    if (!this.batch) this.batch = { since: now, entries: new Map() };
    this.batch.entries.set(item.id, entry);
    return 'queued';
  }

  private notifyMessage(request: Extract<CompanionNoticeRequest, { kind: 'message' }>, now: number): CompanionNotifyResult {
    if (this.spokenRuns.has(request.runId)) return 'dropped';
    this.spokenRuns.add(request.runId);
    if (this.spokenRuns.size > SPOKEN_RUNS_KEPT) this.spokenRuns.delete(this.spokenRuns.values().next().value as string);
    const settings = getCompanionSettings();
    if (!NOTIFYING_TURNS.has(request.runKind)) return 'dropped';
    if (request.runKind === 'brief' && settings.notifications !== 'all') return 'dropped';
    if (this.closed(settings, now) || this.panelFocused(now)) return 'dropped';
    const itemIds = request.itemIds.length > 0 ? request.itemIds : this.runItems.get(request.runId) ?? [];
    this.runItems.delete(request.runId);
    const checkIn = request.runKind === 'wake' || request.runKind === 'heartbeat';
    // A wake or heartbeat reply only about items a notice just covered, or is about to (they wait in the batch),
    // needs no notice of its own: one item, one notice.
    if (checkIn && itemIds.length > 0
      && itemIds.every((id) => this.recentlyNotified(id, now, COMPANION_WAKE_RENOTIFY_MS) || this.batch?.entries.has(id) === true)) return 'dropped';
    // "Important" is only what needs the user now (B19): a check-in about digest items alone (a review request, a
    // conversation waiting on them, a stalled draft), or about no item at all (a goal), stays in the chat.
    if (checkIn && settings.notifications === 'important' && !this.aboutInterruptingItem(itemIds, now)) return 'dropped';
    if (!this.withinCaps(now)) return 'dropped';
    this.send({ title: settings.displayName, body: companionReplyNoticeBody(settings.displayName, this.noticeTitles(itemIds)), target: CHAT, itemIds: [] }, now);
    return 'sent';
  }

  /**
   * The titles of these items a notice may name: not muted by the user and
   * not of a source they turned off; those rated now first, then the rest,
   * each in the run's order. A resolved one stays: the reply may be about it.
   */
  private noticeTitles(itemIds: readonly string[]): string[] {
    const hidden = companionHiddenItemTest();
    const items = [...new Set(itemIds)].map((id) => getItem(id))
      .filter((item): item is CompanionItemDto => !!item && item.status !== 'muted' && !hidden(item));
    return [...items.filter((item) => item.severity === 'now'), ...items.filter((item) => item.severity !== 'now')].map((item) => item.title);
  }

  /** At least one of these items interrupts: open and in sight, rated now, of a subtype the user's feedback did not demote. */
  private aboutInterruptingItem(itemIds: readonly string[], now: number): boolean {
    const hidden = companionHiddenItemTest();
    return itemIds.some((id) => {
      const item = getItem(id);
      return !!item && item.severity === 'now' && isOpenCompanionItem(item, now) && !hidden(item) && !isSubtypeDemoted(item.subtype);
    });
  }

  /** Held: the gate is closed, the conversation is on screen, or a cap is reached (the caller leaves it to Today and the brief). */
  private notifyWorker(request: Extract<CompanionNoticeRequest, { kind: 'worker_finished' }>, now: number): CompanionNotifyResult {
    const settings = getCompanionSettings();
    if (this.closed(settings, now) || this.paneVisible(request.nodeId) || !this.withinCaps(now)) return 'held';
    this.send({
      title: settings.displayName,
      body: clipText(`Worker finished: ${request.title}`, ITEM_BODY_MAX),
      target: { kind: 'node', workspaceId: request.workspaceId, nodeId: request.nodeId },
      itemIds: [],
    }, now);
    return 'sent';
  }
}

/**
 * What news from outside does not cover but the clock does, so quiet hours
 * must not swallow it: a reminder the user set (R2.9), and a calendar
 * conflict whose overlap has not started yet (its `:soon` version comes two
 * hours ahead, often in the morning's quiet hours; engine F2). Once the
 * overlap has started, a conflict is held like any item.
 */
function dueByTheClock(item: CompanionItemDto, now: number): boolean {
  if (item.subtype === 'reminder_due') return true;
  if (item.subtype !== 'calendar_conflict') return false;
  const start = item.facts.overlapStart;
  return typeof start === 'number' && start > now;
}

/** A calendar conflict's notice goes stale when its overlap starts (R2.7's meeting rule); null: the default TTL. */
function itemNoticeExpiry(item: CompanionItemDto, now: number): number | null {
  if (item.subtype !== 'calendar_conflict') return null;
  const start = item.facts.overlapStart;
  return typeof start === 'number' && start > now ? Math.min(start, now + COMPANION_LIMITS.noticeTtlMs) : null;
}

/**
 * One notice for a batch: the item itself when alone, else a count to the
 * Today tab. A lone Michi conversation opens that conversation; any other lone
 * item opens Today at the item (A10), so a click from the toast, the banner
 * or a window it opens lands on the same row. It expires with its items:
 * when all of them are conflicts, when the last of their overlaps starts;
 * otherwise after the default TTL.
 */
function itemNoticeDraft(entries: ReadonlyArray<BatchEntry & { item: CompanionItemDto }>, displayName: string, now: number): CompanionNoticeDraft {
  const expiries = entries.map((entry) => itemNoticeExpiry(entry.item, now));
  const expiresAt = expiries.every((expiry): expiry is number => expiry !== null) ? { expiresAt: Math.max(...expiries) } : {};
  if (entries.length === 1) {
    const { item, escalation } = entries[0]!;
    const body = escalation
      ? `${item.title} has been waiting 30 min${item.summary ? ` — ${item.summary}` : ''}`
      : item.summary ? `${item.title} — ${item.summary}` : item.title;
    return {
      title: displayName,
      body: clipText(body, ITEM_BODY_MAX),
      target: itemTarget(item),
      itemIds: [item.id],
      ...expiresAt,
    };
  }
  return {
    title: displayName,
    body: clipText(`${entries.length} updates: ${entries.map((entry) => entry.item.title).join(' · ')}`, ITEM_BODY_MAX),
    target: TODAY,
    itemIds: entries.map((entry) => entry.item.id),
    ...expiresAt,
  };
}

/** Where an item's notice or tray row opens: a Michi conversation itself, anything else Today at its row (A10). */
function itemTarget(item: CompanionItemDto): CompanionTarget {
  return item.target?.kind === 'node' ? item.target : { kind: 'companion', tab: 'today', itemId: item.id };
}

// ── The tray menu (DESIGN-v2 §5.1) ──────────────────────────────────────────

/** The tray menu lists at most this many "Needs you" rows. */
export const TRAY_NEEDS_YOU_MAX = 5;

export interface CompanionTrayInput {
  now: number;
  /** The conversation V waits on the user: an approval or a question in its running turn. */
  conversationWaiting: boolean;
  /** When the user last viewed the panel (`companion:last_viewed_at`): a brief made after it is "ready". */
  lastViewedAt: number | null;
}

/**
 * What the tray menu shows, from the snapshot the panel reads (so it says
 * what the panel says): the panel's status line (companionStatusLine, with
 * the activity) and badge (companionBadgeCount), its welcome rule
 * (snapshot.welcome.wanted), and up to TRAY_NEEDS_YOU_MAX open Needs you
 * items, newest change first, each with its title only (never a summary or
 * a fact) and where it opens. Items of a source the user turned off are not
 * in the snapshot, so not here either.
 */
export function companionTrayDto(snapshot: CompanionSnapshotDto, input: CompanionTrayInput): CompanionTrayDto {
  const { settings } = snapshot;
  const needsYou = snapshot.items.filter((item) => item.bucket === 'needs_you' && isOpenCompanionItem(item, input.now));
  return {
    displayName: settings.displayName,
    enabled: settings.enabled,
    paused: settings.paused,
    welcomeWanted: snapshot.welcome?.wanted === true,
    conversationWaiting: input.conversationWaiting,
    statusLine: companionStatusLine(snapshot, input.now),
    badge: companionBadgeCount(snapshot),
    needsYou: needsYou.slice(0, TRAY_NEEDS_YOU_MAX).map((item): CompanionTrayItem => ({
      id: item.id, title: item.title, isNew: item.status === 'new', target: itemTarget(item),
    })),
    needsYouTotal: Math.max(snapshot.counts.needsYou, needsYou.length),
    briefReady: snapshot.brief !== null && snapshot.brief.createdAt > (input.lastViewedAt ?? 0),
    revision: snapshot.revision,
  };
}
