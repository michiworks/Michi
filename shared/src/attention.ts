import type { CompanionTarget } from './companion';

/**
 * Server attention: the backend decides, once, which events deserve the
 * user's attention, keeps them as durable records, and delivers them to every
 * window of the owner on the background feed (POST /chats/background/subscribe)
 * and, in the desktop app, to Electron main (ATTENTION_DESKTOP_STREAM_PATH),
 * which shows them while no window is open. It is the one notification path:
 * conversations, Agent Runs, Scheduled Jobs and Michi itself (its posts and
 * its Today's Needs you) all propose their facts to it.
 * Windows present the records; they do not decide them.
 *
 * Wire contract (all frames are owner-scoped):
 *   attention_snapshot      sent first on every subscription: the owner's active records
 *   attention_notification  a new active record (it may supersede the key's previous one)
 *   attention_resolved      a record that is no longer active; every window dismisses it
 *
 * A record names its target (a chat node or an Agent Run) and has a stable
 * `key` per target: at most one record per key is active, and a newer fact for
 * the key resolves the older one as `superseded`.
 *
 * Claim: POST /api/attention/notifications/:id/claim { windowId }. The first
 * window to claim a record is the only one that shows the OS-level
 * notification; see frontend/src/services/serverAttention.ts for the
 * in-app presentation rule of the other windows.
 *
 * Capability: GET /persistence/capabilities advertises `attention: 'v1'`.
 */

export const ATTENTION_PROTOCOL = 'v1';

export const ATTENTION_EVENTS = {
  snapshot: 'attention_snapshot',
  notification: 'attention_notification',
  resolved: 'attention_resolved',
} as const;

export type AttentionEventName = typeof ATTENTION_EVENTS[keyof typeof ATTENTION_EVENTS];

export type AttentionKind = 'needs_input' | 'finished' | 'failed';

/** Why a record exists. needs_input: approval | question | needs_you (an
 *  item in Michi's Today); finished: completed | run_completed | update (a
 *  post of Michi's: the brief, a check-in, a delegated conversation that
 *  finished); failed: error | run_failed. run_*: an Agent Run's or a Scheduled
 *  Job run's outcome. */
export type AttentionReason =
  | 'approval'
  | 'question'
  | 'completed'
  | 'error'
  | 'run_completed'
  | 'run_failed'
  | 'needs_you'
  | 'update';

export type AttentionStatus = 'active' | 'resolved' | 'expired';

/**
 * answered: the approval or question was answered. seen: a focused window had
 * the target on screen. stale: the fact stopped being true (the turn ended,
 * the node went away, a new turn started). superseded: a newer record took the
 * key. expired: older than the retention window.
 */
export type AttentionResolveReason = 'answered' | 'seen' | 'stale' | 'superseded' | 'expired';

/**
 * What a record is about. `agent`: Michi itself, in its own (system)
 * workspace: `ref` names the slot (`chat`, `item:<id>`, `node:<id>`) and
 * `open` is where a click takes the user, as a Today row or the panel does
 * (CompanionTarget). `scheduled_run`: one run of a Scheduled Job; its thread
 * (`nodeId`, none when it failed before it started) may show on the
 * Scheduled page only, so a click opens the run, not a conversation.
 */
export type AttentionTargetV1 =
  | { type: 'node'; nodeId: string; workspaceId: string }
  | { type: 'agent_run'; runId: string; workspaceId: string }
  | { type: 'agent'; ref: string; open: CompanionTarget; workspaceId: string }
  | { type: 'scheduled_run'; runId: string; jobId: string; nodeId: string | null; workspaceId: string };

export type AttentionTargetType = AttentionTargetV1['type'];

export interface AttentionNotificationV1 {
  id: string;
  key: string;
  kind: AttentionKind;
  reason: AttentionReason;
  title: string;
  body: string;
  target: AttentionTargetV1;
  createdAt: number;
  /** The window that won the claim, or null while nobody has claimed it. */
  claimedByWindowId: string | null;
  claimedAt: number | null;
}

export interface AttentionResolvedV1 {
  id: string;
  key: string;
  target: AttentionTargetV1;
  reason: AttentionResolveReason;
  resolvedAt: number;
}

export interface AttentionSnapshotV1 {
  protocol: typeof ATTENTION_PROTOCOL;
  notifications: AttentionNotificationV1[];
}

/** `claimed` is true for the winning window, also when it claims again. */
export interface AttentionClaimResultV1 {
  claimed: boolean;
  claimedByWindowId: string | null;
  status: AttentionStatus;
}

const KINDS: ReadonlySet<string> = new Set<AttentionKind>(['needs_input', 'finished', 'failed']);
const REASONS: ReadonlySet<string> = new Set<AttentionReason>([
  'approval', 'question', 'completed', 'error', 'run_completed', 'run_failed', 'needs_you', 'update',
]);
const RESOLVE_REASONS: ReadonlySet<string> = new Set<AttentionResolveReason>([
  'answered', 'seen', 'stale', 'superseded', 'expired',
]);
const STATUSES: ReadonlySet<string> = new Set<AttentionStatus>(['active', 'resolved', 'expired']);

export function isAttentionEventName(name: string): name is AttentionEventName {
  return name === ATTENTION_EVENTS.snapshot
    || name === ATTENTION_EVENTS.notification
    || name === ATTENTION_EVENTS.resolved;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const OPEN_ID_MAX = 160;
const OPEN_URL_MAX = 2048;

function openId(value: unknown): value is string {
  return nonEmpty(value) && value.length <= OPEN_ID_MAX;
}

/**
 * Where an `agent` record opens, rebuilt from its known fields; null for
 * anything else. Electron main mirrors it (electron/attentionNotifications.ts
 * parseOpenTarget, preload.ts companionTargetFrom).
 */
export function parseAttentionOpenTarget(value: unknown): CompanionTarget | null {
  const raw = record(value);
  if (!raw) return null;
  switch (raw.kind) {
    case 'node':
      return openId(raw.workspaceId) && openId(raw.nodeId) ? { kind: 'node', workspaceId: raw.workspaceId, nodeId: raw.nodeId } : null;
    case 'url':
      return typeof raw.url === 'string' && raw.url.length <= OPEN_URL_MAX && /^https?:\/\/\S/i.test(raw.url) ? { kind: 'url', url: raw.url } : null;
    case 'companion':
      if (raw.tab !== 'chat' && raw.tab !== 'today') return null;
      return raw.tab === 'today' && openId(raw.itemId) ? { kind: 'companion', tab: 'today', itemId: raw.itemId } : { kind: 'companion', tab: raw.tab };
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
}

export function parseAttentionTarget(value: unknown): AttentionTargetV1 | null {
  const raw = record(value);
  if (!raw || !nonEmpty(raw.workspaceId)) return null;
  if (raw.type === 'node' && nonEmpty(raw.nodeId)) {
    return { type: 'node', nodeId: raw.nodeId, workspaceId: raw.workspaceId };
  }
  if (raw.type === 'agent_run' && nonEmpty(raw.runId)) {
    return { type: 'agent_run', runId: raw.runId, workspaceId: raw.workspaceId };
  }
  if (raw.type === 'agent' && nonEmpty(raw.ref)) {
    const open = parseAttentionOpenTarget(raw.open);
    return open ? { type: 'agent', ref: raw.ref, open, workspaceId: raw.workspaceId } : null;
  }
  if (raw.type === 'scheduled_run' && nonEmpty(raw.runId) && nonEmpty(raw.jobId) && (raw.nodeId === null || nonEmpty(raw.nodeId))) {
    return { type: 'scheduled_run', runId: raw.runId, jobId: raw.jobId, nodeId: raw.nodeId, workspaceId: raw.workspaceId };
  }
  return null;
}

/** Null for anything that is not a well-formed record; frames that fail are ignored. */
export function parseAttentionNotification(value: unknown): AttentionNotificationV1 | null {
  const raw = record(value);
  if (!raw) return null;
  const target = parseAttentionTarget(raw.target);
  if (!target || !nonEmpty(raw.id) || !nonEmpty(raw.key)) return null;
  if (typeof raw.kind !== 'string' || !KINDS.has(raw.kind)) return null;
  if (typeof raw.reason !== 'string' || !REASONS.has(raw.reason)) return null;
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || !finite(raw.createdAt)) return null;
  const claimedByWindowId = raw.claimedByWindowId === null || raw.claimedByWindowId === undefined
    ? null : nonEmpty(raw.claimedByWindowId) ? raw.claimedByWindowId : undefined;
  const claimedAt = raw.claimedAt === null || raw.claimedAt === undefined
    ? null : finite(raw.claimedAt) ? raw.claimedAt : undefined;
  if (claimedByWindowId === undefined || claimedAt === undefined) return null;
  return {
    id: raw.id,
    key: raw.key,
    kind: raw.kind as AttentionKind,
    reason: raw.reason as AttentionReason,
    title: raw.title,
    body: raw.body,
    target,
    createdAt: raw.createdAt,
    claimedByWindowId,
    claimedAt,
  };
}

export function parseAttentionResolved(value: unknown): AttentionResolvedV1 | null {
  const raw = record(value);
  if (!raw) return null;
  const target = parseAttentionTarget(raw.target);
  if (!target || !nonEmpty(raw.id) || !nonEmpty(raw.key) || !finite(raw.resolvedAt)) return null;
  if (typeof raw.reason !== 'string' || !RESOLVE_REASONS.has(raw.reason)) return null;
  return { id: raw.id, key: raw.key, target, reason: raw.reason as AttentionResolveReason, resolvedAt: raw.resolvedAt };
}

/** A snapshot of another protocol version is rejected rather than half-read. */
export function parseAttentionSnapshot(value: unknown): AttentionSnapshotV1 | null {
  const raw = record(value);
  if (!raw || raw.protocol !== ATTENTION_PROTOCOL || !Array.isArray(raw.notifications)) return null;
  const notifications: AttentionNotificationV1[] = [];
  for (const item of raw.notifications) {
    const parsed = parseAttentionNotification(item);
    if (parsed) notifications.push(parsed);
  }
  return { protocol: ATTENTION_PROTOCOL, notifications };
}

export function parseAttentionClaimResult(value: unknown): AttentionClaimResultV1 | null {
  const raw = record(value);
  if (!raw || typeof raw.claimed !== 'boolean') return null;
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) return null;
  if (raw.claimedByWindowId !== null && !nonEmpty(raw.claimedByWindowId)) return null;
  return { claimed: raw.claimed, claimedByWindowId: raw.claimedByWindowId, status: raw.status as AttentionStatus };
}

/** One SSE frame. `data` is JSON on a single line, as every background-feed frame is. */
export function encodeAttentionFrame(
  event: AttentionEventName,
  data: AttentionSnapshotV1 | AttentionNotificationV1 | AttentionResolvedV1,
): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The user's notification level (Settings › Notifications; prefs.notifications,
 * mirrored to the backend for Electron main as ChatNotificationLevel).
 * `approval-only` is the stored name of "Only when something needs me".
 */
export type AttentionLevel = 'all' | 'approval-only' | 'off';

/**
 * Whether the level lets a record through, wherever it is shown (a window's
 * policy, Electron main's banners). Off: nothing. "Only when something needs
 * me": what waits on the user (approvals, questions, Needs you) and a task of
 * theirs that failed (an Agent Run or a Scheduled Job run). All: everything,
 * finished conversations, Michi's posts and scheduled runs with Notify on too.
 */
export function attentionLevelAllows(level: AttentionLevel, kind: AttentionKind, reason?: AttentionReason): boolean {
  if (level === 'off') return false;
  if (level === 'all') return true;
  return kind === 'needs_input' || reason === 'run_failed';
}

/**
 * The desktop notifier's feed (Electron main, loopback only): the attention_*
 * frames the level lets through, and `companion_changed` for the tray. While
 * it is connected the backend does not wake the app to notify.
 */
export const ATTENTION_DESKTOP_STREAM_PATH = '/attention/desktop/stream';

/** POST: Electron main claims a record before it shows its banner (the claim is the acknowledgement). */
export function attentionDesktopClaimPath(id: string): string {
  return `/attention/desktop/notifications/${encodeURIComponent(id)}/claim`;
}

/** What a turn's end raises: nothing when it was cancelled, a failure when it stopped on an error, else a completion. */
export function turnEndAttentionKind(stopReason: string | null | undefined): 'finished' | 'failed' | null {
  if (stopReason === 'cancel' || stopReason === 'cancelled') return null;
  return stopReason === 'error' ? 'failed' : 'finished';
}

export interface AttentionCopy {
  title: string;
  body: string;
}

export function approvalAttentionCopy(toolTitle: string | null | undefined): AttentionCopy {
  return { title: 'Tool approval needed', body: toolTitle || 'A tool is waiting for your approval' };
}

export function questionAttentionCopy(question: string | null | undefined): AttentionCopy {
  return { title: 'Agent needs your input', body: question || 'Please answer' };
}

export function completionAttentionCopy(threadTitle: string | null | undefined): AttentionCopy {
  return { title: threadTitle || 'Branch complete', body: 'Streaming finished' };
}

export function failureAttentionCopy(threadTitle: string | null | undefined, message: string | null | undefined): AttentionCopy {
  return { title: threadTitle || 'Conversation', body: message ? `Failed: ${message}` : 'The turn failed' };
}
