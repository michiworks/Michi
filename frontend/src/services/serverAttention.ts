import {
  parseAttentionClaimResult,
  type AttentionClaimResultV1,
  type AttentionKind,
  type AttentionNotificationV1,
  type AttentionReason,
  type CompanionTarget,
} from 'michi-shared';
import { WINDOW_ID } from '../config/windowIdentity';
import { backendApiBase } from '../config/backendConnections';
import { backendFetch } from './api/backendRequest';
import {
  activeServerAttentionRecord,
  onServerAttentionFrame,
  type ServerAttentionFrame,
} from './serverAttentionStore';

export { isServerAttentionActive, noteServerAttentionCapabilities, supportsServerAttention } from './serverAttentionStore';

/**
 * Presents the notifications the backend decided (services/attention on the
 * server; frames parsed by serverAttentionStore.ts). Windows do not decide
 * whether something deserves attention; they decide how to show it:
 *
 * - The OS-level notification belongs to the one window that wins the claim
 *   (POST /attention/notifications/:id/claim). A focused window claims at
 *   once; an unfocused one waits `unfocusedClaimDelayMs` first, so a window
 *   the user is in front of wins and nobody else rings.
 * - In-app toasts: the claimant shows one; another window shows one only
 *   while it is focused (the user is looking at that window). An unfocused
 *   window that lost the claim shows nothing.
 * - A focused window whose target is already in front of the user
 *   (`isTargetInView`, e.g. the ⌘J panel, which presence does not report)
 *   claims and shows nothing.
 * - A snapshot (feed reconnect) presents only unclaimed records younger than
 *   `replayWindowMs`; older ones stay visible as unread marks, not alerts.
 * - A claim the backend could not answer counts as won (better a duplicate
 *   than a missed alert) and is retried in the background, so the server
 *   learns who showed it. This window also remembers for its session what it
 *   presented (sessionStorage), so a reload meanwhile does not show it again.
 * - A resolved record calls the dismiss function its presenter returned.
 *
 * The presenter receives intents (chatStore's shows them through the attention
 * policy). Local triggers should stay off for a connection while
 * isServerAttentionActive() holds.
 */

export type AttentionIntentTarget =
  | { type: 'node'; nodeId: string; workspaceId: string; backendConnectionId: string }
  | { type: 'agent_run'; runId: string; workspaceId: string; backendConnectionId: string }
  | { type: 'agent'; ref: string; open: CompanionTarget; workspaceId: string; backendConnectionId: string }
  | { type: 'scheduled_run'; runId: string; jobId: string; nodeId: string | null; workspaceId: string; backendConnectionId: string };

export interface AttentionIntent {
  /** Stable for the target across windows and reloads: `server:<connection>:<record key>`. */
  key: string;
  kind: AttentionKind;
  /** Why the backend raised it: a question, an approval, a completion… */
  reason: AttentionReason;
  title: string;
  body: string;
  target: AttentionIntentTarget;
  /** The record's id on its backend. */
  serverId: string;
}

export interface ServerAttentionPresentation {
  /** This window holds the claim: it alone may show the OS-level notification. */
  claimed: boolean;
  /** This window was focused and visible when it presented. */
  windowFocused: boolean;
  /** Delivered by a feed (re)connect snapshot rather than live. */
  replay: boolean;
}

/** Shows an intent. May return a function that dismisses what it showed. */
export type ServerAttentionPresenter = (
  intent: AttentionIntent,
  presentation: ServerAttentionPresentation,
) => void | (() => void);

export interface SubscribeServerAttentionOptions {
  windowId?: string;
  windowFocused?: () => boolean;
  isTargetInView?: (intent: AttentionIntent) => boolean;
  claim?: (connectionId: string, id: string, windowId: string) => Promise<AttentionClaimResultV1 | null>;
  unfocusedClaimDelayMs?: number;
  replayWindowMs?: number;
  /** Waits before each retry of a claim the backend could not answer. */
  claimRetryDelaysMs?: readonly number[];
  now?: () => number;
}

export const UNFOCUSED_CLAIM_DELAY_MS = 400;
export const ATTENTION_REPLAY_WINDOW_MS = 2 * 60_000;
export const ATTENTION_CLAIM_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 30_000];

/** The records this window presented, for its session: one whose claim failed is still
 *  unclaimed on the server, so the snapshot after a reload would present it again. */
const SHOWN_KEY = 'michi:attention:shown:v1';
const SHOWN_LIMIT = 100;

function shownRecords(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(SHOWN_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function rememberShown(slotId: string): void {
  try {
    const shown = shownRecords().filter((entry) => entry !== slotId);
    shown.push(slotId);
    window.sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shown.slice(-SHOWN_LIMIT)));
  } catch {
    // No session storage: a reload may present it once more.
  }
}

/** POST /attention/notifications/:id/claim; null when the backend does not know the record. */
export async function claimServerAttention(connectionId: string, id: string, windowId: string): Promise<AttentionClaimResultV1 | null> {
  const res = await backendFetch(`${backendApiBase(connectionId)}/attention/notifications/${encodeURIComponent(id)}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`claim failed: ${res.status}`);
  const result = parseAttentionClaimResult(await res.json());
  if (!result) throw new Error('claim failed: malformed answer');
  return result;
}

export function attentionIntentOf(connectionId: string, record: AttentionNotificationV1): AttentionIntent {
  const target: AttentionIntentTarget = { ...record.target, backendConnectionId: connectionId };
  return {
    key: `server:${connectionId}:${record.key}`,
    kind: record.kind,
    reason: record.reason,
    title: record.title,
    body: record.body,
    target,
    serverId: record.id,
  };
}

function windowIsFocused(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Presents every attention record this window's background feeds deliver,
 * by the rules above. Returns the unsubscribe function.
 */
export function subscribeServerAttention(
  presenter: ServerAttentionPresenter,
  options: SubscribeServerAttentionOptions = {},
): () => void {
  const windowId = options.windowId ?? WINDOW_ID;
  const focused = options.windowFocused ?? windowIsFocused;
  const claim = options.claim ?? claimServerAttention;
  const delayMs = options.unfocusedClaimDelayMs ?? UNFOCUSED_CLAIM_DELAY_MS;
  const replayWindowMs = options.replayWindowMs ?? ATTENTION_REPLAY_WINDOW_MS;
  const retryDelaysMs = options.claimRetryDelaysMs ?? ATTENTION_CLAIM_RETRY_DELAYS_MS;
  const now = options.now ?? Date.now;
  /** connection + record id → what this window showed (or decided not to show). */
  const handled = new Map<string, { dismiss?: () => void }>();
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const retrying = new Set<ReturnType<typeof setTimeout>>();
  /** What this window presented this session, before a reload too. */
  const presentedBefore = new Set(shownRecords());
  let stopped = false;
  const slot = (connectionId: string, id: string) => `${connectionId}\u0000${id}`;

  const present = (connectionId: string, record: AttentionNotificationV1, presentation: ServerAttentionPresentation) => {
    const id = slot(connectionId, record.id);
    if (stopped || !activeServerAttentionRecord(connectionId, record.id)) return;
    let dismiss: void | (() => void);
    try {
      dismiss = presenter(attentionIntentOf(connectionId, record), presentation);
    } catch {
      return;
    }
    handled.set(id, typeof dismiss === 'function' ? { dismiss } : {});
    presentedBefore.add(id);
    rememberShown(id);
  };

  /** Tells the server, once it answers, that this window showed the record. */
  const retryClaim = (connectionId: string, recordId: string, attempt = 0) => {
    const delay = retryDelaysMs[attempt];
    if (delay === undefined || stopped) return;
    const timer = setTimeout(() => {
      retrying.delete(timer);
      if (stopped || !activeServerAttentionRecord(connectionId, recordId)) return;
      claim(connectionId, recordId, windowId).catch(() => retryClaim(connectionId, recordId, attempt + 1));
    }, delay);
    retrying.add(timer);
  };

  const claimThenPresent = async (connectionId: string, record: AttentionNotificationV1, replay: boolean) => {
    let claimed: boolean;
    try {
      claimed = (await claim(connectionId, record.id, windowId))?.claimed ?? false;
    } catch {
      // The backend could not be asked: better a duplicate than a missed alert.
      claimed = true;
      retryClaim(connectionId, record.id);
    }
    const windowFocused = focused();
    if (claimed || windowFocused) present(connectionId, record, { claimed, windowFocused, replay });
  };

  const consider = (connectionId: string, record: AttentionNotificationV1, replay: boolean) => {
    const id = slot(connectionId, record.id);
    if (handled.has(id) || waiting.has(id)) return;
    // This window already showed it (before a reload): nothing to repeat. The
    // server knows from the claim; this session's memory covers a failed one.
    if (record.claimedByWindowId === windowId || presentedBefore.has(id)) { handled.set(id, {}); return; }
    if (replay && (record.claimedByWindowId !== null || now() - record.createdAt > replayWindowMs)) {
      handled.set(id, {});
      return;
    }
    if (focused()) {
      handled.set(id, {});
      if (options.isTargetInView?.(attentionIntentOf(connectionId, record))) {
        void claim(connectionId, record.id, windowId).catch(() => {});
        return;
      }
      void claimThenPresent(connectionId, record, replay);
      return;
    }
    waiting.set(id, setTimeout(() => {
      waiting.delete(id);
      if (stopped || !activeServerAttentionRecord(connectionId, record.id)) return;
      handled.set(id, {});
      void claimThenPresent(connectionId, record, replay);
    }, delayMs));
  };

  const forget = (connectionId: string, recordId: string) => {
    const id = slot(connectionId, recordId);
    const timer = waiting.get(id);
    if (timer) { clearTimeout(timer); waiting.delete(id); }
    const shown = handled.get(id);
    handled.delete(id);
    try { shown?.dismiss?.(); } catch { /* Dismissal is best-effort. */ }
  };

  const unsubscribe = onServerAttentionFrame((frame: ServerAttentionFrame) => {
    if (frame.type === 'resolved') {
      forget(frame.connectionId, frame.resolved.id);
      return;
    }
    if (frame.type === 'notification') {
      consider(frame.connectionId, frame.notification, false);
      return;
    }
    // A snapshot replaces the connection's records: what is missing resolved while away.
    const stillActive = new Set(frame.notifications.map((record) => slot(frame.connectionId, record.id)));
    const prefix = `${frame.connectionId}\u0000`;
    for (const id of [...handled.keys(), ...waiting.keys()]) {
      if (id.startsWith(prefix) && !stillActive.has(id)) forget(frame.connectionId, id.slice(prefix.length));
    }
    for (const record of frame.notifications) consider(frame.connectionId, record, true);
  });

  return () => {
    stopped = true;
    unsubscribe();
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
    for (const timer of retrying) clearTimeout(timer);
    retrying.clear();
    handled.clear();
  };
}
