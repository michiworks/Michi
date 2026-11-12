/**
 * The one policy every attention notification goes through: an agent needs
 * input, finished, or failed. Callers describe what happened (an intent);
 * this module decides whether, when and how the user hears about it.
 *
 * - Quiet only while the user can see the target: it is visible in this
 *   window (the intent says), the window is focused and its document visible.
 * - One notification per target key. A newer intent replaces a pending or
 *   shown one, even when the newer one ends up not being shown.
 * - Presented after a short delay, then revalidated: dropped if no longer
 *   current (answered, a new turn started) or now in view.
 * - Gated by prefs.notifications: needs_input for 'all' and 'approval-only',
 *   finished and failed for 'all' only, nothing for 'off'.
 * - A toast per notification (at most MAX_SHOWN), an OS notification while
 *   the window is unfocused or hidden (its click returns to this window), and
 *   a tone per kind when prefs.notificationSounds is on; the OS notification
 *   is silent unless the window cannot play the tone. Re-presenting the same
 *   kind for a target whose toast is still up refreshes it quietly.
 */
import type { AttentionKind } from 'michi-shared';
import { backendEntityId } from '../../config/backendIdentity';
import { showOsNotification } from './desktop';
import { playAttentionSound } from './sound';
import { dismissNotificationCard, showNotificationCard } from './toast';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../config/backendConnections';

export type AttentionTarget =
  | { type: 'node'; nodeId: string; workspaceId?: string; backendConnectionId?: string }
  | { type: 'agent_run'; runId: string; workspaceId?: string; backendConnectionId?: string };

export interface AttentionIntent {
  /** Stable per target, normally attentionTargetKey(target). */
  key: string;
  kind: AttentionKind;
  title: string;
  body?: string;
  /** What the notification is about. */
  target: AttentionTarget;
  /** 'server': decided by the backend's notification feed. Default 'local'. */
  source?: 'local' | 'server';
  /** Whether this window shows the target right now. Absent: never. */
  isTargetVisible?: () => boolean;
  /** Re-checked once the delay is over; false drops the notification. Absent: always current. */
  isStillCurrent?: () => boolean;
  /** Clicking the toast or the OS notification: reveal the target. */
  onOpen?: () => void;
  /** 'never': no OS notification from this window (another window claimed it). Default 'auto'. */
  osNotification?: 'auto' | 'never';
}

export interface AttentionPreferences {
  /** prefs.notifications */
  level: 'all' | 'approval-only' | 'off';
  /** prefs.notificationSounds */
  sounds: boolean;
}

/** Long enough for an auto-approval, a queued follow-up or a glance to make it moot. */
const DELAY_MS = 1000;
/** Needs-input waits on the user; a failure says more than a success. */
const DURATION_MS: Record<AttentionKind, number> = { needs_input: 8000, failed: 6000, finished: 5000 };
const MAX_SHOWN = 4;
const MAX_PENDING = 16;
/** A burst of notifications (several runs ending together) chimes once. */
const SOUND_GAP_MS = 750;

interface Pending {
  intent: AttentionIntent;
  timer: ReturnType<typeof setTimeout>;
}

interface Shown {
  toastId: string;
  kind: AttentionKind;
  /** An OS notification went out for this toast (or the one it refreshed). */
  osSent: boolean;
}

const DEFAULT_PREFERENCES: AttentionPreferences = { level: 'all', sounds: true };

let preferences = DEFAULT_PREFERENCES;
const pending = new Map<string, Pending>();
// Map order is presentation order, oldest first.
const shown = new Map<string, Shown>();
let toastSequence = 0;
let lastSoundAt = Number.NEGATIVE_INFINITY;

/** Kept in sync with the user's prefs by PrefsProvider. */
export function setAttentionPreferences(next: AttentionPreferences): void {
  preferences = next;
}

/**
 * The key for a target. Node ids are normalized to this window's ids (remote
 * nodes are connection-scoped), so a server-decided intent naming the
 * server's node id meets the local intent for the same node.
 */
export function attentionTargetKey(target: AttentionTarget): string {
  const connectionId = target.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID;
  if (target.type === 'agent_run') return `agent_run:${JSON.stringify([connectionId, target.runId])}`;
  let nodeId = target.nodeId;
  try {
    nodeId = backendEntityId(connectionId, target.nodeId);
  } catch {
    // Already scoped to another connection: keep the id as given.
  }
  return `node:${nodeId}`;
}

/**
 * The user's Notifications setting lets this kind through. Notices that do not
 * go through presentAttention (the Meta agent's and Memory's) check it too.
 */
export function attentionAllowed(kind: AttentionKind): boolean {
  if (preferences.level === 'off') return false;
  return preferences.level === 'all' || kind === 'needs_input';
}

/** This window is in front of the user: focused, and its document not hidden. */
function windowAttended(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState !== 'hidden' && document.hasFocus();
}

/** A caller's predicate; one that throws counts as `fallback`. */
function check(predicate: (() => boolean) | undefined, fallback: boolean): boolean {
  if (!predicate) return fallback;
  try {
    return predicate();
  } catch {
    return fallback;
  }
}

function inView(intent: AttentionIntent): boolean {
  return windowAttended() && check(intent.isTargetVisible, false);
}

function closeShown(key: string, toastId?: string): void {
  const entry = shown.get(key);
  if (!entry || (toastId !== undefined && entry.toastId !== toastId)) return;
  shown.delete(key);
  dismissNotificationCard(entry.toastId);
}

/** The toast went away by itself, or was clicked. */
function forget(key: string, toastId: string): void {
  if (shown.get(key)?.toastId === toastId) shown.delete(key);
}

/**
 * The tone for a notification shown now: 'heard'; 'blocked' while sounds are
 * on but this window cannot play one (no Web Audio, or the browser's autoplay
 * rules); 'quiet' when sounds are off or a tone just sounded for the burst.
 */
function chime(kind: AttentionKind): 'heard' | 'blocked' | 'quiet' {
  if (!preferences.sounds) return 'quiet';
  const now = Date.now();
  if (now - lastSoundAt < SOUND_GAP_MS) return 'quiet';
  lastSoundAt = now;
  return playAttentionSound(kind) ? 'heard' : 'blocked';
}

/** Raise a notification about `intent.target`; the policy decides the rest. */
export function presentAttention(intent: AttentionIntent): void {
  const previous = pending.get(intent.key);
  if (previous) {
    clearTimeout(previous.timer);
    pending.delete(intent.key);
  }
  if (!attentionAllowed(intent.kind) || inView(intent)) {
    // Still the newest word on this target: what it replaces is moot.
    closeShown(intent.key);
    return;
  }
  let next = intent;
  if (previous && previous.intent.kind === intent.kind && previous.intent.osNotification === 'never'
    && (previous.intent.source ?? 'local') !== (intent.source ?? 'local')) {
    // The same event from this window and from the server: keep the server's
    // word that another window shows the OS notification.
    next = { ...intent, osNotification: 'never' };
  }
  for (const [key, entry] of pending) {
    if (pending.size < MAX_PENDING) break;
    clearTimeout(entry.timer);
    pending.delete(key);
  }
  pending.set(intent.key, { intent: next, timer: setTimeout(() => deliver(intent.key), DELAY_MS) });
}

function deliver(key: string): void {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  const { intent } = entry;
  if (!attentionAllowed(intent.kind) || !check(intent.isStillCurrent, true) || inView(intent)) {
    closeShown(key);
    return;
  }
  const previous = shown.get(key);
  const repeat = previous?.kind === intent.kind;
  const alreadySent = repeat && previous.osSent;
  closeShown(key);
  for (const oldest of shown.keys()) {
    if (shown.size < MAX_SHOWN) break;
    closeShown(oldest);
  }
  const toastId = `attention:${++toastSequence}`;
  const sendOs = intent.osNotification !== 'never' && !windowAttended() && !alreadySent;
  shown.set(key, { toastId, kind: intent.kind, osSent: sendOs || alreadySent });
  const open = intent.onOpen;
  showNotificationCard({
    id: toastId,
    title: intent.title,
    body: intent.body,
    kind: intent.kind,
    duration: DURATION_MS[intent.kind],
    onClick: open ? () => { forget(key, toastId); open(); } : undefined,
    onClose: () => forget(key, toastId),
  });
  const tone = !repeat || sendOs ? chime(intent.kind) : 'quiet';
  if (sendOs) {
    showOsNotification({
      key,
      title: intent.title,
      body: intent.body,
      // The tone above is the sound, or the user turned sounds off. Where this
      // window cannot play it, the OS notification makes its own.
      silent: tone !== 'blocked',
      onOpen: open ? () => { closeShown(key, toastId); open(); } : undefined,
    });
  }
}

/**
 * Withdraw the notification for `key`, pending or shown. With `kind`, only
 * when it is of that kind: an answered approval must not take a later
 * "finished" for the same target with it.
 */
export function dismissAttention(key: string, kind?: AttentionKind): void {
  const waiting = pending.get(key);
  if (waiting && (!kind || waiting.intent.kind === kind)) {
    clearTimeout(waiting.timer);
    pending.delete(key);
  }
  const entry = shown.get(key);
  if (entry && (!kind || entry.kind === kind)) closeShown(key);
}

/** @testonly */
export function resetAttentionForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  shown.clear();
  preferences = DEFAULT_PREFERENCES;
  toastSequence = 0;
  lastSoundAt = Number.NEGATIVE_INFINITY;
}
