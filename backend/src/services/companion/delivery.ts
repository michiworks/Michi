/**
 * How Companion changes leave the backend, and what the tray shows.
 *
 * - CompanionEventBus: in-process fan-out. emitChanged(reason) bumps the
 *   snapshot revision and tells every `GET /companion/events` stream (the
 *   windows) and Electron main's desktop feed (routes/attention.ts), whose
 *   tray fetches its menu again (DESIGN-v2 §5.1).
 * - companionTrayDto: what the tray menu shows (`GET /companion/tray`).
 *
 * Notices are not sent from here any more: what Michi has to tell the user
 * goes to the attention service (notices.ts), the one notification path
 * (DESIGN P4). The notice gate, its quiet hours, workdays and caps, and the
 * notice outbox with its replay, fold and wake are gone.
 */

import {
  companionBadgeCount,
  companionStatusLine,
  isOpenCompanionItem,
  type CompanionChangedEvent,
  type CompanionSnapshotDto,
  type CompanionTrayDto,
  type CompanionTrayItem,
} from 'michi-shared';
import { companionItemTarget } from './notices';
import { bumpRevision, currentRevision } from './repository';

/** SSE event name of the Companion's change stream. */
export const COMPANION_CHANGED_SSE_EVENT = 'companion_changed';

export type CompanionChangeReason = CompanionChangedEvent['reason'];

export function encodeCompanionChangedEvent(event: CompanionChangedEvent): string {
  return `event: ${COMPANION_CHANGED_SSE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`;
}

export interface CompanionEventSubscriber {
  /** Snapshot changes (renderer feeds, and the desktop feed's tray). */
  changed(event: CompanionChangedEvent): void;
}

/** Where the bus keeps the revision; the repository's `meta` counter by default. */
export interface CompanionRevisionStore {
  current(): number;
  bump(): number;
}

const storedRevision: CompanionRevisionStore = { current: currentRevision, bump: bumpRevision };

export class CompanionEventBus {
  private readonly subscribers = new Set<CompanionEventSubscriber>();

  constructor(private readonly revision: CompanionRevisionStore = storedRevision) {}

  subscribe(subscriber: CompanionEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  currentRevision(): number {
    return this.revision.current();
  }

  /** Bumps the revision and tells every subscriber. Call after the change is written. */
  emitChanged(reason: CompanionChangeReason): CompanionChangedEvent {
    const event: CompanionChangedEvent = { type: 'companion_changed', revision: this.revision.bump(), reason };
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.changed(event);
      } catch {
        // One broken stream must not stop the others.
      }
    }
    return event;
  }
}

/** The process's Companion bus (routes and the coordinator share it). */
export const companionEvents = new CompanionEventBus();

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
      id: item.id, title: item.title, isNew: item.status === 'new', target: companionItemTarget(item),
    })),
    needsYouTotal: Math.max(snapshot.counts.needsYou, needsYou.length),
    briefReady: snapshot.brief !== null && snapshot.brief.createdAt > (input.lastViewedAt ?? 0),
    revision: snapshot.revision,
  };
}
