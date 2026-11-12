import { toast } from 'sonner';
import { useEffect, useRef } from 'react';
import { oneLine, type MemoryChangedEvent, type MemoryRecord } from 'michi-shared';
import { deleteMemory, fetchMemorySettings, isMemoryNotFound, markMemoryNoticeSeen, subscribeMemoryChanges } from '../../services/api/memories';
import { createReconnectingFeed } from '../../services/api/sseFeed';
import { SseHttpError } from '../../services/api/sseParser';

/**
 * Michi Memory's notices: a quiet receipt when an agent saves a memory the
 * user asked for, and, once, word that memory learns from conversations.
 * Changes arrive on the backend's memory change feed (GET
 * /api/memories/changes/stream).
 *
 * An explicit save shows "Remembered: …" with Undo; an explicit correction
 * "Memory updated: …" with Review, which opens Settings › Memory. What
 * automatic memory saves (origin extracted) shows nothing, and neither does
 * what Settings itself just changed. Notices never move focus, open a pane
 * or switch the workspace or thread.
 */

/** How long after Settings changed a memory its own change events stay quiet. */
const SELF_WINDOW_MS = 10_000;
/** Longest a change waits for a Settings addition in flight to name its memory. */
const HOLD_MAX_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** A feed that stayed open this long starts its reconnect delay over. */
const STABLE_MS = 30_000;
const PREVIEW_CHARS = 120;
const NOTIFIED_LIMIT = 1_000;

const changeListeners = new Set<(event: MemoryChangedEvent) => void>();

// Mutations Settings made: memory id → until when its events stay quiet.
const selfIds = new Map<string, number>();
// Settings additions in flight; their ids are known only once they answer.
let creating = 0;
let held: MemoryChangedEvent[] = [];
let holdTimer: ReturnType<typeof setTimeout> | null = null;
// Memories a toast already announced (a feed reconnect can repeat nothing, but a mock or replay could).
const notified = new Set<string>();
let reviewHandler: (() => void) | null = null;

let feedUsers = 0;
let feed: { start(): void; stop(): void } | null = null;
// No feed on this backend (or no access to it): no notices until reload.
let feedUnavailable = false;

// ── changes Settings makes ─────────────────────────────────────────────────

function isSelf(memoryId: string): boolean {
  const until = selfIds.get(memoryId);
  if (until === undefined) return false;
  if (until >= Date.now()) return true;
  selfIds.delete(memoryId);
  return false;
}

function markSelf(memoryId: string): void {
  const now = Date.now();
  for (const [id, until] of selfIds) if (until < now) selfIds.delete(id);
  selfIds.set(memoryId, now + SELF_WINDOW_MS);
}

/** Run a change Settings makes to one memory; the change events it causes show no toast. */
export async function runSelfMutation<T>(memoryId: string, action: () => Promise<T>): Promise<T> {
  markSelf(memoryId);
  try {
    return await action();
  } finally {
    markSelf(memoryId);
  }
}

/**
 * Add a memory from Settings. Its id is unknown until the backend answers,
 * and the feed may announce it first, so new memories wait for the answer:
 * the one Settings added shows no toast, any other then shows as usual.
 */
export async function runSelfCreate(action: () => Promise<MemoryRecord>): Promise<MemoryRecord> {
  creating += 1;
  try {
    const record = await action();
    markSelf(record.id);
    return record;
  } finally {
    creating -= 1;
    if (creating === 0) flushHeld();
  }
}

function flushHeld(): void {
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  const events = held;
  held = [];
  for (const event of events) announce(event);
}

// ── toasts ─────────────────────────────────────────────────────────────────

function preview(body: string): string {
  return oneLine(body, PREVIEW_CHARS);
}

const rememberedToastId = (memoryId: string) => `memory:${memoryId}`;

function review(): void {
  reviewHandler?.();
}

function reviewAction() {
  return reviewHandler ? { action: { label: 'Review', onClick: review } } : {};
}

/** Undo from the "Remembered" toast: delete the memory the agent just saved. */
export async function undoRememberedMemory(memoryId: string): Promise<void> {
  try {
    await runSelfMutation(memoryId, () => deleteMemory(memoryId));
    toast.success('Memory removed');
  } catch (error) {
    if (isMemoryNotFound(error)) toast('That memory was already removed');
    else toast.error(`Couldn’t remove the memory: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function announce(event: MemoryChangedEvent): void {
  // Automatic memory saves quietly; only what an agent saved on request gets a receipt.
  if (event.status !== 'active' || event.origin !== 'explicit') return;
  if (isSelf(event.memoryId) || notified.has(event.memoryId)) return;
  notified.add(event.memoryId);
  if (notified.size > NOTIFIED_LIMIT) notified.delete(notified.values().next().value as string);
  const text = preview(event.body);
  // A correction replaced an older memory, which deleting it would not bring back.
  if (event.supersedesId) {
    toast(`Memory updated: ${text}`, { id: rememberedToastId(event.memoryId), duration: 10_000, ...reviewAction() });
    return;
  }
  toast(`Remembered: ${text}`, {
    id: rememberedToastId(event.memoryId),
    duration: 10_000,
    action: { label: 'Undo', onClick: () => { void undoRememberedMemory(event.memoryId); } },
  });
}

function receive(event: MemoryChangedEvent): void {
  for (const listener of [...changeListeners]) {
    try { listener(event); } catch { /* one view's failure must not stop the others */ }
  }
  if (event.action === 'deleted') {
    toast.dismiss(rememberedToastId(event.memoryId));
    return;
  }
  if (event.action !== 'created') return;
  if (creating > 0 && !isSelf(event.memoryId)) {
    held.push(event);
    holdTimer ??= setTimeout(flushHeld, HOLD_MAX_MS);
    return;
  }
  announce(event);
}

/** Called with every memory change the feed reports (Settings refreshes its list). Returns unsubscribe. */
export function onMemoryChanged(listener: (event: MemoryChangedEvent) => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

// ── the feed ───────────────────────────────────────────────────────────────

function startMemoryFeed(): void {
  if (feed || feedUnavailable) return;
  feed = createReconnectingFeed({
    baseMs: RECONNECT_MIN_MS,
    maxMs: RECONNECT_MAX_MS,
    healthyMs: STABLE_MS,
    isFatal: (error) => error instanceof SseHttpError && [401, 403, 404].includes(error.status),
    onFatal: () => { feedUnavailable = true; },
    open: ({ onOpen, onDisconnect }) => subscribeMemoryChanges({ onOpen, onEvent: receive, onDisconnect }),
  });
  feed.start();
}

function startFeed(): () => void {
  feedUsers += 1;
  if (feedUsers === 1) startMemoryFeed();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    feedUsers -= 1;
    if (feedUsers > 0) return;
    feed?.stop();
    feed = null;
  };
}

/**
 * Listen for memory changes while mounted (once the workspaces have loaded)
 * and show their notices. `onReview` opens Settings › Memory from a toast.
 */
export function useMemoryNotifications(onReview: () => void): void {
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  useEffect(() => {
    const handler = () => reviewRef.current();
    reviewHandler = handler;
    const stop = startFeed();
    return () => {
      stop();
      if (reviewHandler === handler) reviewHandler = null;
    };
  }, []);
}

// ── the one-time notice ────────────────────────────────────────────────────

const NOTICE_TOAST_ID = 'memory:notice';
const NOTICE_MS = 20_000;
// Read once per window; the backend keeps whether it was seen (noticeSeen).
let noticeRead = false;

/**
 * Once per owner, a notice that memory is on and learns from conversations:
 * on first run, and for someone whose explicit-only setting became on (the
 * backend says which, and whether it was seen). It waits until `ready`
 * (setup done, a workspace to work in), never moves focus, and counts as
 * seen once it closes or its Review is pressed. Memory off, or a backend
 * without the notice, shows nothing.
 */
export function useMemoryNotice(ready: boolean, onReview: () => void): void {
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  useEffect(() => {
    if (!ready || noticeRead) return;
    noticeRead = true;
    // Not tied to this mount: the notice belongs to the window, and seen is the backend's to keep.
    void fetchMemorySettings().then((settings) => {
      if (settings.noticeSeen !== false || settings.mode === 'off') return;
      let marked = false;
      const seen = () => {
        if (marked) return;
        marked = true;
        void markMemoryNoticeSeen().catch(() => {});
      };
      const moved = settings.migratedFromExplicit === true;
      toast(moved ? 'Memory now learns from your conversations' : 'Michi remembers what matters', {
        id: NOTICE_TOAST_ID,
        description: moved
          ? 'It used to save only what you asked it to remember. Now it also keeps useful details from your chats. Review it or turn it off in Settings › Memory.'
          : 'It keeps useful details from your chats, so you don’t have to repeat them. Review it or turn it off in Settings › Memory.',
        duration: NOTICE_MS,
        action: { label: 'Review', onClick: () => { seen(); reviewRef.current(); } },
        onDismiss: seen,
        onAutoClose: seen,
      });
    }, () => { noticeRead = false; });
  }, [ready]);
}

/**
 * Forget every notice and feed between test cases.
 * @testonly
 */
export function resetMemoryNotifications(): void {
  noticeRead = false;
  if (holdTimer !== null) clearTimeout(holdTimer);
  holdTimer = null;
  feed?.stop();
  feed = null;
  feedUsers = 0;
  feedUnavailable = false;
  selfIds.clear();
  creating = 0;
  held = [];
  notified.clear();
  reviewHandler = null;
  changeListeners.clear();
}
