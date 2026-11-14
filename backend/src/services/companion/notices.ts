/**
 * What Michi itself has to tell the user, handed to the attention service
 * (services/attention/attentionService.ts proposeAgent), which alone decides
 * whether and where it is shown: in the windows, and from Electron main
 * while none is open (DESIGN P4, D12). Three kinds of fact:
 *
 * - Needs you: an item of Today that interrupts (rated now, open, of a
 *   source in sight, of a subtype the user's feedback did not demote), once
 *   per item version, as `agent:item:<itemId>` (reason `needs_you`); and the
 *   one reminder of a conversation that has waited on the user for 30
 *   minutes (its version `…:escalated`). Its record goes once the item is no
 *   longer open at that version (processItems). A Michi conversation the
 *   user has on screen, or viewed since the item changed, is handled.
 * - Michi's posts in its conversation (a check-in's reply: the brief, an
 *   alert, a worker report), as `agent:chat` (reason `update`), the newest
 *   replacing the last. Never the text, only the titles of the items the run
 *   was about. Not while the agent's panel is focused, and a check-in about
 *   items just notified, or about to be, says nothing of its own.
 * - A conversation Michi delegated that finished, as `agent:node:<nodeId>`.
 *
 * Nothing here holds a notice back by the clock or counts them: quiet hours,
 * workdays and the daily and half-hour caps are gone (DESIGN Q7, D5); quiet
 * comes from presence, the system's Do Not Disturb, Pause, and the user's
 * one notification level, which the attention service's readers apply.
 * While Michi is paused or the first welcome has not happened, nothing is
 * proposed, and an item's version is marked notified so that resuming sends
 * nothing old. How much of it reaches the user is their one level
 * (Settings › Notifications): Needs you at "Only when something needs me",
 * posts and the brief at All.
 *
 * The coordinator makes one CompanionNotices and calls it as it called the
 * notice gate it replaces. The attention service is the process's one, set
 * by server.ts (setCompanionAttention); without it nothing is proposed, but
 * item versions are still marked.
 */

import {
  isOpenCompanionItem,
  type AttentionKind,
  type CompanionItemDto,
  type CompanionSettings,
  type CompanionTarget,
} from 'michi-shared';
import type { AgentAttentionProposal } from '../attention/attentionService';
import { getDb } from '../db';
import { panePresenceRegistry } from '../panePresence';
import {
  COMPANION_ESCALATED_SUFFIX,
  companionHiddenItemTest,
  getItem,
  isCompanionItemHidden,
  isCompanionWelcomeDone,
  isSubtypeDemoted,
  listUnescalatedItems,
  listUnnotifiedNowItems,
  markItemsNotified,
  notifiedVersionOf,
} from './repository';
import { getCompanionSettings } from './settings';
import type { CompanionClock, CompanionMessageNotifier, CompanionTurnKind } from './types';

/** Where Michi's facts go: the attention service, with the agent's workspace and owner filled in (server.ts). */
export interface CompanionAttention {
  propose(proposal: AgentAttentionProposal): void;
  /** The active records whose keys start with `prefix`. */
  active(prefix: string): Array<{ key: string; fact: string }>;
  resolve(key: string): void;
}

let attention: CompanionAttention | null = null;

/** The process's attention service, for every CompanionNotices (server.ts sets it at boot; null detaches it). */
export function setCompanionAttention(next: CompanionAttention | null): void {
  attention = next;
}

const MINUTE_MS = 60_000;
/** A michi_waiting conversation unanswered this long gets its one reminder. */
export const COMPANION_ESCALATE_AFTER_MS = 30 * MINUTE_MS;
/** A check-in reply about items notified this recently needs no notice of its own (DESIGN §7.6). */
export const COMPANION_WAKE_RENOTIFY_MS = 10 * MINUTE_MS;
const ITEM_BODY_MAX = 200;
/** A check-in reply's notice names at most this many items, then how many more. */
const REPLY_NOTICE_TITLES = 3;
const REPLY_NOTICE_TITLE_MAX = 60;
const SPOKEN_RUNS_KEPT = 200;
const CHAT: CompanionTarget = Object.freeze({ kind: 'companion', tab: 'chat' }) as CompanionTarget;
/** Turns whose reply may notify (DESIGN §7.6): never the welcome, which the user just asked for, or a catch-up. */
const NOTIFYING_TURNS: ReadonlySet<CompanionTurnKind> = new Set<CompanionTurnKind>(['heartbeat', 'wake', 'worker_report', 'brief']);

const ITEM_KEY_PREFIX = 'agent:item:';
const CHAT_KEY = 'agent:chat';

export type CompanionNoticeRequest =
  /** A feed item's current version (an interrupting item), or the one 30-minute reminder of a michi_waiting conversation. */
  | { kind: 'item'; itemId: string; escalation?: boolean }
  /** The Companion said something in a hidden turn (CompanionMessageNotifier.companionSpoke). */
  | { kind: 'message'; runId: string; runKind: CompanionTurnKind; itemIds: readonly string[] }
  /** A conversation the Companion delegated finished (its report is the notice). */
  | { kind: 'worker_finished'; workspaceId: string; nodeId: string; title: string };

/**
 * sent     = handed to the attention service;
 * held     = not sent and counts as handled: Michi is paused or it was
 *            not welcomed yet, the user already handled it, or its subtype
 *            was demoted. An item's
 *            version is marked notified, so it never bursts out later; Today
 *            and the brief cover it;
 * dropped  = nothing to send (not open, already notified, a duplicate, a
 *            reply that does not notify).
 */
export type CompanionNotifyResult = 'sent' | 'held' | 'dropped';

export interface CompanionNoticesDeps {
  clock?: CompanionClock;
  /** Kept for the coordinator's call; the notices no longer go through the Companion's bus. */
  bus?: unknown;
  /** The Companion panel is open and focused (presence.ts): a reply it shows needs no notice. */
  isPanelFocused?: (now: number) => boolean;
  /** A Michi conversation is on screen in some window (default: panePresence). */
  isPaneVisible?: (nodeId: string) => boolean;
  /** When the user last had a conversation on screen (default: nodes.viewed_at). */
  nodeViewedAt?: (nodeId: string) => number | null;
}

function clipText(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A check-in reply's notice text: never the reply (model text stays off the
 * lock screen), only the agent's name and the titles of the items its run
 * was about, at most REPLY_NOTICE_TITLES and then how many more, e.g.
 * `Nova: CR-1 needs attention · AuthService is blocked +2`; with none,
 * `Nova has an update`.
 */
export function companionReplyNoticeBody(displayName: string, titles: readonly string[]): string {
  const named = titles.map((title) => clipText(title, REPLY_NOTICE_TITLE_MAX)).filter(Boolean);
  if (named.length === 0) return `${displayName} has an update`;
  const more = named.length - REPLY_NOTICE_TITLES;
  return `${displayName}: ${named.slice(0, REPLY_NOTICE_TITLES).join(' · ')}${more > 0 ? ` +${more}` : ''}`;
}

/** Where an item's record opens: a Michi conversation itself, anything else Today at its row (A10). */
export function companionItemTarget(item: Pick<CompanionItemDto, 'id' | 'target'>): CompanionTarget {
  return item.target?.kind === 'node' ? item.target : { kind: 'companion', tab: 'today', itemId: item.id };
}

function itemFact(version: string): string {
  return `item:${version}`;
}

const defaultPaneVisible = (nodeId: string) => panePresenceRegistry.getPresence({ kind: 'node', nodeId }).views.some((view) => view.visible);
const defaultViewedAt = (nodeId: string) => {
  const row = getDb().prepare('SELECT viewed_at FROM nodes WHERE id = ?').get(nodeId) as { viewed_at: number | null } | undefined;
  return row?.viewed_at ?? null;
};

export class CompanionNotices implements CompanionMessageNotifier {
  private readonly clock: CompanionClock;
  private readonly panelFocused: (now: number) => boolean;
  private readonly paneVisible: (nodeId: string) => boolean;
  private readonly viewedAt: (nodeId: string) => number | null;
  /** When a notice about each item last went out (the check-in rule). */
  private readonly notifiedAt = new Map<string, number>();
  private readonly spokenRuns = new Set<string>();
  /** The items each running turn's material was about (expectReply), for a reply reported without them. */
  private readonly runItems = new Map<string, readonly string[]>();

  constructor(deps: CompanionNoticesDeps = {}) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.panelFocused = deps.isPanelFocused ?? (() => false);
    this.paneVisible = deps.isPaneVisible ?? defaultPaneVisible;
    this.viewedAt = deps.nodeViewedAt ?? defaultViewedAt;
  }

  notify(request: CompanionNoticeRequest, now: number = this.clock.now()): CompanionNotifyResult {
    switch (request.kind) {
      case 'item': return this.notifyItem(request.itemId, request.escalation === true, now);
      case 'message': return this.notifyMessage(request, now);
      case 'worker_finished': return this.notifyWorker(request);
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
   * The tick's notices: first the records of items no longer open at the
   * version they were about go, then every open item whose interrupting
   * version was not notified yet, and every conversation unanswered for 30
   * minutes, is proposed. Returns how many were sent.
   */
  processItems(now: number = this.clock.now()): number {
    this.settleItemRecords(now);
    let sent = 0;
    for (const item of listUnnotifiedNowItems(now)) if (this.notify({ kind: 'item', itemId: item.id }, now) === 'sent') sent += 1;
    for (const item of listUnescalatedItems('michi_waiting', now - COMPANION_ESCALATE_AFTER_MS, now)) {
      if (this.notify({ kind: 'item', itemId: item.id, escalation: true }, now) === 'sent') sent += 1;
    }
    return sent;
  }

  /** A notice about this item went out within `windowMs`. */
  recentlyNotified(itemId: string, now: number, windowMs: number): boolean {
    const at = this.notifiedAt.get(itemId);
    return at !== undefined && now - at <= windowMs;
  }

  private versionOf(item: CompanionItemDto, escalation: boolean): string {
    return escalation ? `${item.version}${COMPANION_ESCALATED_SUFFIX}` : item.version;
  }

  /** Nothing goes out at all: Michi is off or paused, or it has not met the user yet. */
  private closed(settings: CompanionSettings): boolean {
    return !settings.enabled || settings.paused || !isCompanionWelcomeDone();
  }

  /** The user has already handled it: its Michi conversation is on screen, or was viewed since the item changed. */
  private handled(item: CompanionItemDto): boolean {
    if (item.source !== 'michi' || item.target?.kind !== 'node') return false;
    const { nodeId } = item.target;
    if (this.paneVisible(nodeId)) return true;
    const viewedAt = this.viewedAt(nodeId);
    return viewedAt !== null && viewedAt >= item.changedAt;
  }

  /** The item is still open, in sight and at the version the record is about. */
  private stillAbout(itemId: string, version: string, now: number): boolean {
    const item = getItem(itemId);
    if (!item || !isOpenCompanionItem(item, now) || isCompanionItemHidden(item)) return false;
    return item.version === version || `${item.version}${COMPANION_ESCALATED_SUFFIX}` === version;
  }

  /** Records of items that were resolved, dismissed, muted, snoozed, put out of sight or changed go. */
  private settleItemRecords(now: number): void {
    if (!attention) return;
    for (const record of attention.active(ITEM_KEY_PREFIX)) {
      const itemId = record.key.slice(ITEM_KEY_PREFIX.length);
      const version = record.fact.startsWith('item:') ? record.fact.slice('item:'.length) : '';
      if (!this.stillAbout(itemId, version, now)) attention.resolve(record.key);
    }
  }

  private hold(entries: ReadonlyArray<{ id: string; version: string }>): void {
    if (entries.length > 0) markItemsNotified(entries);
  }

  private propose(proposal: AgentAttentionProposal): void {
    attention?.propose(proposal);
  }

  private notifyItem(itemId: string, escalation: boolean, now: number): CompanionNotifyResult {
    const item = getItem(itemId);
    if (!item) return 'dropped';
    const version = this.versionOf(item, escalation);
    if (notifiedVersionOf(item.id) === version) return 'dropped';
    if (!isOpenCompanionItem(item, now) || isCompanionItemHidden(item)) return 'dropped';
    // Only an interrupting item notifies; a digest or silent one never does (and keeps its version unmarked).
    if (escalation ? item.subtype !== 'michi_waiting' || now - item.changedAt < COMPANION_ESCALATE_AFTER_MS : item.severity !== 'now') return 'dropped';
    const entry = { id: item.id, version };
    const settings = getCompanionSettings();
    // A subtype the user's feedback demoted is digest now: held, so undoing the demotion later sends nothing old.
    if (!escalation && isSubtypeDemoted(item.subtype)) {
      this.hold([entry]);
      return 'held';
    }
    if (this.closed(settings) || this.handled(item)) {
      this.hold([entry]);
      return 'held';
    }
    markItemsNotified([entry]);
    this.notifiedAt.set(item.id, now);
    const body = escalation
      ? `${item.title} has been waiting 30 min${item.summary ? ` — ${item.summary}` : ''}`
      : item.summary ? `${item.title} — ${item.summary}` : item.title;
    this.propose({
      key: `${ITEM_KEY_PREFIX}${item.id}`,
      fact: itemFact(version),
      kind: 'needs_input',
      reason: 'needs_you',
      title: settings.displayName,
      body: clipText(body, ITEM_BODY_MAX),
      ref: `item:${item.id}`,
      open: companionItemTarget(item),
      isCurrent: () => this.stillAbout(item.id, version, this.clock.now()) && !this.closed(getCompanionSettings()) && !this.handled(getItem(item.id) ?? item),
    });
    return 'sent';
  }

  private notifyMessage(request: Extract<CompanionNoticeRequest, { kind: 'message' }>, now: number): CompanionNotifyResult {
    if (this.spokenRuns.has(request.runId)) return 'dropped';
    this.spokenRuns.add(request.runId);
    if (this.spokenRuns.size > SPOKEN_RUNS_KEPT) this.spokenRuns.delete(this.spokenRuns.values().next().value as string);
    const settings = getCompanionSettings();
    if (!NOTIFYING_TURNS.has(request.runKind)) return 'dropped';
    if (this.closed(settings) || this.panelFocused(now)) return 'dropped';
    const itemIds = request.itemIds.length > 0 ? request.itemIds : this.runItems.get(request.runId) ?? [];
    this.runItems.delete(request.runId);
    const checkIn = request.runKind === 'wake' || request.runKind === 'heartbeat';
    // A check-in only about items a notice just covered says nothing of its own: one item, one notice.
    if (checkIn && itemIds.length > 0 && itemIds.every((id) => this.recentlyNotified(id, now, COMPANION_WAKE_RENOTIFY_MS))) return 'dropped';
    this.propose({
      key: CHAT_KEY,
      fact: `post:${request.runId}`,
      kind: 'finished' satisfies AttentionKind,
      reason: 'update',
      title: settings.displayName,
      body: companionReplyNoticeBody(settings.displayName, this.noticeTitles(itemIds)),
      ref: 'chat',
      open: CHAT,
      isCurrent: () => !this.closed(getCompanionSettings()),
    });
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

  /** Held: Michi is off or paused, or the conversation is on screen (the caller leaves it to Today and the brief). */
  private notifyWorker(request: Extract<CompanionNoticeRequest, { kind: 'worker_finished' }>): CompanionNotifyResult {
    const settings = getCompanionSettings();
    if (this.closed(settings) || this.paneVisible(request.nodeId)) return 'held';
    this.propose({
      key: `agent:node:${request.nodeId}`,
      fact: `finished:${this.clock.now()}`,
      kind: 'finished',
      reason: 'update',
      title: settings.displayName,
      body: clipText(`${request.title} finished`, ITEM_BODY_MAX),
      ref: `node:${request.nodeId}`,
      open: { kind: 'node', workspaceId: request.workspaceId, nodeId: request.nodeId },
    });
    return 'sent';
  }
}
