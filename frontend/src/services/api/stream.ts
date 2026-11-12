import {
  CHAT_STREAM_EVENTS,
  dispatchChatStreamEvent,
  parseChatStreamEvent,
} from '../chatStreamEvents';
import type { CancelRecoveryStatus, StreamHandlers } from '../chatStreamEvents';
import { startupMark } from '../startupTrace';
import { backendApiBase, LOCAL_BACKEND_CONNECTION_ID, nodeBackendApiBase } from '../../config/backendConnections';
import { isServerAttentionEvent, receiveServerAttentionFrame } from '../serverAttentionStore';
import { backendFetch } from './backendRequest';
import { SseHttpError, readSseStream } from './sseParser';
import { shouldRetryRequest } from './httpError';
import { fetchStream } from './streamTransport';
import { abortableDelay } from '../../utils/sleep';
import { metaAgentTurnContextFor } from './assistant';
import type {
  ChatStreamEnvelope,
  ChatStreamEvent,
  ChatStreamPayloads,
  MetaAgentChatTurnContext,
  ScheduledJobRunEvent,
  ScheduledJobsChangedEvent,
  SteerMessageOptions,
  WorkspaceStructureChangedEvent,
} from 'michi-shared';
import {
  isScheduledJobRunEvent,
  isScheduledJobsChangedEvent,
  isWorkspaceStructureChangedEvent,
  randomUuid,
  SCHEDULED_JOB_RUN_EVENT,
  SCHEDULED_JOBS_CHANGED_EVENT,
  WORKSPACE_STRUCTURE_CHANGED_EVENT,
} from 'michi-shared';

let cachedStreamProbeEnabled: boolean | null = null;

/**
 * The terminal `error` frame a turn ends with (StreamHandlers.onErrorPayload).
 * `code` is META_AGENT_GUARD_ERROR_CODE (`meta_agent_guard_failed`) when a
 * Meta agent run stopped on its restriction check; GET /api/meta-agent then
 * carries the details in `guard`.
 */
export type ChatStreamErrorPayload = ChatStreamPayloads['error'] & ChatStreamEnvelope;

function streamProbeEnabled(): boolean {
  if (cachedStreamProbeEnabled !== null) return cachedStreamProbeEnabled;
  if (typeof window === 'undefined') return false;
  try {
    cachedStreamProbeEnabled = window.localStorage.getItem('michi:stream-probe') === '1';
    return cachedStreamProbeEnabled;
  } catch {
    cachedStreamProbeEnabled = false;
    return false;
  }
}

function writeStreamProbe(row: Record<string, unknown>): void {
  if (!streamProbeEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(JSON.stringify({ type: 'stream_probe', source: 'renderer', ...row }));
}

export interface ExportRequestPayload {
  workspace: {
    name: string;
    cwd?: string;
    createdAt: number;
  };
  rootTitle: string;
  nodes: Array<{
    nodeId: string;
    parentNodeId?: string;
    title?: string;
    depth: number;
    messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  }>;
  cwd?: string;
  nodeIds?: string[];
}

/** GET /chats/:chatId/turns/:turnId: one turn's saved receipt, read once its
 * live replay is gone. `message` is the stored `messages` row; map it as
 * hydration does (chatHydration.mapMessageRow). */
export interface SavedTurn {
  turnId: string;
  assistantId: string;
  /** turns.status: active | completed | cancelled | error. */
  status: string;
  stopReason: string | null;
  completedAt: number | null;
  lastSeq: number;
  message: Record<string, unknown> | null;
}

/** The saved turn, or null when it is missing, foreign or unreadable. */
export async function getSavedTurn(chatId: string, turnId: string, signal?: AbortSignal): Promise<SavedTurn | null> {
  try {
    const res = await backendFetch(
      `${nodeBackendApiBase(chatId)}/chats/${encodeURIComponent(chatId)}/turns/${encodeURIComponent(turnId)}`,
      { signal },
    );
    if (!res.ok) return null;
    const body = await res.json() as Partial<SavedTurn> | null;
    if (!body || body.turnId !== turnId || typeof body.assistantId !== 'string' || typeof body.status !== 'string'
      || typeof body.lastSeq !== 'number') return null;
    return {
      turnId,
      assistantId: body.assistantId,
      status: body.status,
      stopReason: typeof body.stopReason === 'string' ? body.stopReason : null,
      completedAt: typeof body.completedAt === 'number' ? body.completedAt : null,
      lastSeq: body.lastSeq,
      message: body.message && typeof body.message === 'object' ? body.message : null,
    };
  } catch {
    return null;
  }
}

// Foreground requests own their complete replay lifecycle. Keep their IDs for
// this window's lifetime so a delayed/reconnected shared feed cannot replay a
// locally submitted (including cancelled) turn into the transcript a second time.
const locallyOwnedTurns = new Set<string>();
const ownedTurnKey = (nodeId: string, turnId: string) => JSON.stringify([nodeId, turnId]);

/**
 * Consume an SSE stream produced by the backend. Returns a cancel function
 * that aborts the fetch (also calls /cancel on the backend).
 */
export function streamMessage(
  nodeId: string,
  text: string,
  handlers: StreamHandlers,
  durable?: {
    /** Generated before POST so replay is possible before the first frame. */
    turnId?: string;
    displayText?: string;
    enableKiroSidecarTitle?: boolean;
    userMetadata?: {
      quotedText?: string;
      quoteSource?: import('../../lib/quoteSource').AnyQuoteSource;
      attachments?: Array<{ name: string; absPath: string }>;
      comments?: Array<Record<string, unknown>>;
    };
    /** Run this skill with the message (`text` is what the user wrote after the command, and may be empty). */
    skill?: import('michi-shared').SkillInvocationRequest;
  },
): () => void {
  stopCancellationObservation(nodeId);
  const controller = new AbortController();
  const probeEnabled = streamProbeEnabled();

  // ── Terminal-state safety net ──
  // The assistant node leaves `status: 'streaming'` only when a `done`/`error`
  // event reaches the reducer. If the connection ends or silently stalls
  // without one, we MUST still finalize the node — otherwise it stays pinned in
  // "streaming" forever (frozen, no spinner, Stop does nothing).
  const STREAM_SILENCE_TIMEOUT_MS = 30_000; // 3× the backend's 10s heartbeat
  let terminalSeen = false; // a done/error frame was dispatched to the reducer
  let settled = false;      // a synthetic terminal handler has fired
  let watchdogTimedOut = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // Do not wait for turn_start to learn this: a broken response can occur
  // after the server began the turn but before any SSE bytes reach us.
  // The server requires nodeId for a durable foreground turn. Preserve the
  // legacy no-node helper behavior used by a few lightweight callers/tests.
  const clientTurnId = nodeId ? (durable?.turnId ?? randomUuid()) : '';
  if (clientTurnId) locallyOwnedTurns.add(ownedTurnKey(nodeId, clientTurnId));
  let resumeTurnId = clientTurnId;
  let resumeSeq = -1;
  let resumeReplay: (() => void) | null = null;
  let cancelledByUser = false;
  let waitingForTurn = false;
  let sawFirstByte = false;
  const acceptEnvelope: NonNullable<StreamHandlers['onEnvelope']> = (envelope) => {
    if (cancelledByUser || handlers.onEnvelope?.(envelope) === false) return false;
    // Rejected frames must not retarget cancellation or advance the replay cursor.
    if (envelope.turnId && envelope.turnId !== resumeTurnId) {
      resumeTurnId = envelope.turnId;
      resumeSeq = -1;
    }
    if (typeof envelope.seq === 'number') resumeSeq = Math.max(resumeSeq, envelope.seq);
    return true;
  };
  const acceptedHandlers = { ...handlers, onEnvelope: undefined };
  // The live replay is gone. If the turn finished, its saved row is the
  // result; the handler applies it and ends the turn. Otherwise keep the error.
  let savedTurnRead: AbortController | null = null;
  const finishFromSavedTurn = (message: string, code: string) => {
    if (!handlers.onSavedTurn) {
      settleError(message, code);
      return;
    }
    const turnId = resumeTurnId;
    const read = new AbortController();
    savedTurnRead = read;
    // Bounded like inspectOriginalTurn: a hung read must not pin the turn streaming.
    const deadline = setTimeout(() => read.abort(), 10_000);
    void getSavedTurn(nodeId, turnId, read.signal).then((saved) => {
      clearTimeout(deadline);
      savedTurnRead = null;
      if (terminalSeen || cancelledByUser || settled) return;
      if (saved && handlers.onSavedTurn?.(saved)) {
        terminalSeen = true;
        return;
      }
      settleError(message, code);
    });
  };

  const resumeForeground = (): boolean => {
    if (!resumeTurnId || cancelledByUser || resumeReplay) return false;
    resumeReplay = reattachTurnReplay(nodeId, {
      turnId: resumeTurnId,
      nextSeq: () => resumeSeq + 1,
      handlers: {
        ...handlers,
        onEnvelope: acceptEnvelope,
        onDone: (...args) => { terminalSeen = true; handlers.onDone?.(...args); },
        onErrorPayload: handlers.onErrorPayload ? (data) => { terminalSeen = true; handlers.onErrorPayload?.(data); } : undefined,
        onError: (...args) => { terminalSeen = true; handlers.onError?.(...args); },
      },
      isCurrent: () => !terminalSeen && !cancelledByUser && !settled,
      // A message turn is never the backend's own; its outcome is unknown, never a reason to send it again.
      onBackgroundOwned: (message) => settleError(message, 'turn_outcome_unknown'),
      onReplayGone: finishFromSavedTurn,
      onUnavailable: settleError,
    });
    return true;
  };

  const clearWatchdog = () => {
    if (watchdog !== undefined) {
      clearTimeout(watchdog);
      watchdog = undefined;
    }
  };
  function settleError(message: string, code?: string): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    if (handlers.onErrorPayload) handlers.onErrorPayload({ message, ...(code ? { code } : {}), ...(resumeTurnId ? { turnId: resumeTurnId } : {}) });
    else if (code) handlers.onError?.(message, undefined, undefined, code);
    else handlers.onError?.(message);
  }
  function settleAborted(): void {
    if (settled || terminalSeen) return;
    settled = true;
    clearWatchdog();
    handlers.onAborted?.();
  }
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort(); // unstick a half-open reader.read() that never resolves
      if (!resumeTurnId) settleError('stream stalled — no data received');
    }, STREAM_SILENCE_TIMEOUT_MS);
  };

  (async () => {
    try {
      const payload: Record<string, unknown> = { text };
      if (clientTurnId) payload.turnId = clientTurnId;
      if (nodeId) payload.nodeId = nodeId;
      if (durable?.displayText !== undefined) payload.displayText = durable.displayText;
      if (durable?.enableKiroSidecarTitle !== undefined) {
        payload.enableKiroSidecarTitle = durable.enableKiroSidecarTitle;
      }
      if (durable?.userMetadata) payload.userMetadata = durable.userMetadata;
      if (durable?.skill) payload.skill = durable.skill;
      const metaAgentContext = nodeId ? metaAgentTurnContextFor(nodeId) : undefined;
      if (metaAgentContext) payload.metaAgentContext = metaAgentContext;
      const requestBody = JSON.stringify(payload);
      const startedAt = Date.now();
      startupMark('stream_request_start', { chatId: nodeId, nodeId, textLen: text.length });
      let res: Response;
      let busyAttempt = 0;
      for (;;) {
        controller.signal.throwIfAborted();
        waitingForTurn = false;
        res = await fetchStream(`${nodeBackendApiBase(nodeId)}/chats/${nodeId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: requestBody,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        if (res.ok && res.body) break;
        const body = await res.json().catch(() => null);
        // This response guarantees our turn never began. Keep the optimistic
        // message and its immutable payload/ID, then try when the owner is idle.
        // Finishing the previous turn is a normal handoff: keep it invisible.
        // Never retry ambiguous network failures or other kinds of conflict.
        if (res.status === 409 && body?.code === 'turn_active') {
          waitingForTurn = true;
          await abortableDelay(Math.min(2_000, 250 * (2 ** Math.min(busyAttempt++, 3))), controller.signal);
          continue;
        }
        const message = body && typeof body.error === 'string' ? body.error : `stream failed: ${res.status}`;
        // A gateway's 502/504 (the desktop proxy's included) may follow a write
        // that reached the backend, so it does not prove the turn never began.
        if (res.status === 502 || res.status === 504) throw new Error(message);
        throw Object.assign(new Error(message), { code: typeof body?.code === 'string' ? body.code : undefined, rejected: true });
      }
      sawFirstByte = true;
      startupMark('stream_response_headers', { chatId: nodeId, nodeId, status: res.status, durMs: Date.now() - startedAt });

      const reader = res.body.getReader();
      let sawFirstEvent = false;
      let sawFirstChunk = false;
      let chunkSeq = 0;
      let prevChunkAt = 0;

      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        if (cancelledByUser) return;
        const parsed = parseChatStreamEvent(evt, data);
        if (!parsed || acceptEnvelope(parsed.data) === false) return;
        if (!sawFirstEvent) {
          sawFirstEvent = true;
          startupMark('first_sse_event', { chatId: nodeId, nodeId, event: parsed.event, durMs: Date.now() - startedAt });
        }
        if (!sawFirstChunk && parsed.event === 'chunk') {
          sawFirstChunk = true;
          startupMark('first_sse_chunk', { chatId: nodeId, nodeId, durMs: Date.now() - startedAt });
        }
        if (probeEnabled && parsed.event === CHAT_STREAM_EVENTS.chunk) {
          const now = Date.now();
          chunkSeq += 1;
          writeStreamProbe({
            phase: 'sse_chunk',
            chatId: nodeId,
            nodeId,
            seq: chunkSeq,
            chars: parsed.data.text.length,
            bytes: new TextEncoder().encode(parsed.data.text).length,
            dtMs: prevChunkAt === 0 ? 0 : now - prevChunkAt,
            sinceStartMs: now - startedAt,
          });
          prevChunkAt = now;
        }
        if (
          parsed.event === CHAT_STREAM_EVENTS.done ||
          parsed.event === CHAT_STREAM_EVENTS.error
        ) {
          terminalSeen = true;
          clearWatchdog();
        }
        dispatchChatStreamEvent(parsed, acceptedHandlers);
      }, { onRead: () => armWatchdog(), shouldStop: () => cancelledByUser });
      // A foreground runner can outlive its first HTTP response. Reattach to
      // the same immutable turn/cursor rather than handing it to background
      // SSE (which intentionally never carries user turns).
      if (!terminalSeen && resumeForeground()) return;
      // Connection closed before we received a turn id, so no safe replay is
      // possible. Surface a terminal error rather than silently mixing feeds.
      settleError('stream closed before completion');
    } catch (err: any) {
      // Only attempt foreground resume if we received a successful HTTP
      // response (the turn was started on the backend). When the POST itself
      // fails (409 turn-already-active, 404, etc.) the turn was never started
      // and subscribing to it always 410s — surface the real error instead.
      if (!terminalSeen && !cancelledByUser && sawFirstByte && resumeForeground()) return;
      if (err?.name === 'AbortError') {
        // A user/navigation abort finalizes as aborted. A watchdog abort with
        // no stamped turn id cannot safely resume.
        if (watchdogTimedOut) settleError('stream stalled — no data received', clientTurnId ? 'turn_outcome_unknown' : undefined);
        else if (cancelledByUser) settleAborted();
        else settleError('The connection changed before the turn outcome could be confirmed.', clientTurnId ? 'turn_outcome_unknown' : undefined);
      } else {
        settleError(err?.message || String(err), err?.code ?? (!err?.rejected && clientTurnId ? 'turn_outcome_unknown' : undefined));
      }
    } finally {
      clearWatchdog();
    }
  })();

  return () => {
    if (cancelledByUser) return;
    cancelledByUser = true;
    settleAborted();
    clearWatchdog();
    controller.abort();
    resumeReplay?.();
    savedTurnRead?.abort();
    // Withdrawing a message that was explicitly rejected as busy must leave
    // the previous response running. There is no backend turn to cancel yet.
    if (waitingForTurn) return;
    if (handlers.onCancelRecovery && !terminalSeen) {
      cancelChatAndObserve(nodeId, resumeTurnId || clientTurnId, handlers.onCancelRecovery);
    } else {
      cancelChat(nodeId, resumeTurnId || clientTurnId).catch(() => {});
    }
  };
}

/**
 * Steers `text` into the chat's running turn. `metaAgentContext`: for the
 * agent's conversation V only (the backend refuses it elsewhere), what the
 * steered message carried when the user queued it, so its check-in or
 * collector references taint the running turn (§2.8 T4) as a send would.
 */
export async function steerChat(
  chatId: string,
  text: string,
  options?: SteerMessageOptions,
  metaAgentContext?: MetaAgentChatTurnContext | null,
): Promise<{ accepted: boolean; pending?: boolean; reason?: string; message?: ChatStreamPayloads['steer_accepted'] & ChatStreamEnvelope }> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      ...options,
      ...(metaAgentContext ? { metaAgentContext } : {}),
    }),
  });
  const body = await res.json().catch(() => ({ accepted: false }));
  const event = body.message ? parseChatStreamEvent('steer_accepted', JSON.stringify(body.message)) : null;
  return {
    accepted: body.accepted === true,
    pending: body.pending === true,
    reason: typeof body.reason === 'string' ? body.reason : undefined,
    message: event?.event === 'steer_accepted' ? event.data : undefined,
  };
}

/**
 * Ask the active session's runtime to compact its context. Runtime-agnostic:
 * Codex drives `thread/compact/start`, Kiro its ACP compact command. Returns
 * `started: false` (HTTP 409) when the active runtime cannot compact, which is
 * how the caller decides whether to fall back to another path.
 */
export async function compactChat(
  chatId: string,
  instructions?: string,
): Promise<{ started: boolean; detail?: string }> {
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(instructions ? { instructions } : {}),
    }),
  });
  const body = await res.json().catch(() => ({ started: false }));
  if (!res.ok && res.status !== 409) {
    throw new Error(typeof body.error === 'string' ? body.error : `Compaction request failed: ${res.status}`);
  }
  return {
    started: body.started === true,
    detail: typeof body.detail === 'string' ? body.detail : undefined,
  };
}

export async function cancelChat(chatId: string, turnId?: string, signal?: AbortSignal): Promise<void> {
  if (!turnId) throw new Error('A turn ID is required to cancel this chat');
  const res = await backendFetch(`${nodeBackendApiBase(chatId)}/chats/${chatId}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(turnId ? { turnId } : {}),
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Cancel request failed: ${res.status}`);
}

const cancellationObservers = new Map<string, {
  turnId?: string;
  stop: () => void;
  finish: (status: CancelRecoveryStatus) => void;
}>();
const CANCEL_OBSERVATION_TIMEOUT_MS = 30_000;

function cancellationKey(chatId: string): string {
  return `${nodeBackendApiBase(chatId)}/chats/${chatId}`;
}

function stopCancellationObservation(chatId: string): void {
  cancellationObservers.get(cancellationKey(chatId))?.stop();
}

/** The existing background feed is authoritative for runtime self-turns. */
export function settleCancellationObservation(chatId: string, turnId: string, status: CancelRecoveryStatus): void {
  const observer = cancellationObservers.get(cancellationKey(chatId));
  if (turnId && observer?.turnId === turnId) observer.finish(status);
}

/** Observe only the cancelled turn's outcome, never its output or interactions. */
export function cancelChatAndObserve(
  chatId: string,
  turnId: string | undefined,
  onStatus: (status: CancelRecoveryStatus) => void,
): () => void {
  stopCancellationObservation(chatId);
  const key = cancellationKey(chatId);
  const request = new AbortController();
  let stopped = false;
  let detach: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const pending = setTimeout(() => {
    if (!stopped) onStatus({ state: 'pending', detail: 'Waiting for cancellation to finish' });
  }, 1_000);
  const deadline = setTimeout(() => finish({
    state: 'error',
    detail: 'Cancellation could not be confirmed. Retry to check the original session.',
  }), CANCEL_OBSERVATION_TIMEOUT_MS);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(pending);
    clearTimeout(deadline);
    if (retry) clearTimeout(retry);
    request.abort();
    detach?.();
    if (cancellationObservers.get(key)?.stop === stop) cancellationObservers.delete(key);
  };
  const finish = (status: CancelRecoveryStatus) => {
    if (stopped) return;
    stop();
    onStatus(status);
  };
  const observe = () => {
    if (stopped) return;
    detach = subscribeChat(chatId, {
      onEnvelope: (envelope) => !stopped && (!envelope.turnId || envelope.turnId === turnId),
      onDone: (reason, _assistantId, _turnId, persisted) => finish(
        reason === 'error' || persisted === false
          ? { state: 'error', detail: 'Cancellation cleanup failed. Retry to check the original session.' }
          : { state: 'settled' },
      ),
      onError: (detail) => finish({ state: 'error', detail }),
    }, { turnId, seq: 0 }, {
      onDisconnect: ({ retryable, error }) => {
        if (stopped) return;
        detach = undefined;
        // A ring miss or a self-turn is not proof that cancellation completed.
        if (!retryable && !(error instanceof SseHttpError && error.status === 410)) {
          finish({ state: 'error', detail: 'Cancellation result unavailable. Retry to check the original session.' });
        } else {
          retry = setTimeout(observe, Math.min(5_000, 250 * (2 ** attempt++)));
        }
      },
    });
  };
  cancellationObservers.set(key, { turnId, stop, finish });
  void cancelChat(chatId, turnId, request.signal).then(() => {
    if (turnId) observe();
    else finish({ state: 'error', detail: 'Cancellation requested, but the original turn could not be identified. Retry to check the session.' });
  }, (error: unknown) => {
    finish({ state: 'error', detail: error instanceof Error ? error.message : 'Cancel request failed' });
  });
  return stop;
}

export interface ChatStreamDisconnect {
  retryable: boolean;
  error?: Error;
}

export function subscribeChat(
  chatId: string,
  handlers: StreamHandlers,
  from: { turnId?: string; seq?: number } = {},
  opts: {
    onOpen?: () => void;
    /** Read-only observer of accepted wire events, used to reconstruct one original turn. */
    onEvent?: (event: ChatStreamEvent) => void;
    onDisconnect?: (result: ChatStreamDisconnect) => void;
    onError?: (err: Error) => void;
  } = {},
): () => void {
  if (from.turnId) locallyOwnedTurns.add(ownedTurnKey(chatId, from.turnId));
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let watchdogTimedOut = false;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdogTimedOut = true;
      controller.abort();
    }, 30_000);
  };
  (async () => {
    let disconnect: ChatStreamDisconnect = { retryable: true };
    try {
      const query = new URLSearchParams();
      query.set('fromSeq', String(from.seq ?? 0));
      if (from.turnId) query.set('fromTurnId', from.turnId);
      const res = await fetchStream(`${nodeBackendApiBase(chatId)}/chats/${chatId}/stream?${query.toString()}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new SseHttpError(res.status, 'subscribe failed',
          typeof body?.code === 'string' ? body.code : undefined,
          typeof body?.error === 'string' ? body.error : undefined);
      }
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        const parsed = parseChatStreamEvent(evt, data);
        if (parsed) {
          opts.onEvent?.(parsed);
          dispatchChatStreamEvent(parsed, handlers);
        }
      }, { onRead: () => armWatchdog(), shouldStop: () => stopped });
    } catch (err) {
      const original = err instanceof Error ? err : new Error(String(err));
      const error = watchdogTimedOut ? new Error('turn replay stalled — no data received') : original;
      disconnect = { retryable: shouldRetryRequest(original), error };
      if (!stopped) opts.onError?.(error);
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}

/** Reattaching one turn to its replay: what the caller does when it ends other than by the turn's own terminal frame. */
export interface TurnReplayReattach {
  turnId: string;
  /** The first seq this window has not applied. */
  nextSeq: () => number;
  handlers: StreamHandlers;
  /** False once the turn no longer owns what this window shows: the replay then stops, and onStale runs. */
  isCurrent: () => boolean;
  onStale?: () => void;
  /** A runtime self-turn: the shared background feed delivers it. */
  onBackgroundOwned: (message: string) => void;
  /** The live replay is gone: the saved turn decides. */
  onReplayGone: (message: string, code: 'turn_replay_unavailable' | 'backend_restarted') => void;
  /** Any other refusal. The outcome is unknown: Retry inspects the turn, never sends its prompt again. */
  onUnavailable: (message: string, code: 'turn_outcome_unknown') => void;
}

/**
 * Reattach one current turn to its replay (fromSeq is inclusive),
 * reconnecting a dropped replay after 250 ms, doubling to 5 s, from 250 ms
 * again once a reconnect opens. Returns stop.
 */
export function reattachTurnReplay(chatId: string, options: TurnReplayReattach): () => void {
  let stopped = false;
  let detach: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(retry);
    detach?.();
  };
  const current = (): boolean => {
    if (options.isCurrent()) return true;
    stop();
    options.onStale?.();
    return false;
  };
  const connect = () => {
    detach = subscribeChat(chatId, options.handlers, { turnId: options.turnId, seq: options.nextSeq() }, {
      onOpen: () => { attempt = 0; },
      onDisconnect: ({ retryable, error }) => {
        detach = null;
        if (stopped || !current()) return;
        if (retryable) {
          retry = setTimeout(() => { if (current()) connect(); }, Math.min(5_000, 250 * (2 ** attempt++)));
          return;
        }
        stop();
        const refused = error instanceof SseHttpError ? error : undefined;
        const message = error?.message ?? 'turn replay unavailable';
        if (refused?.code === 'turn_background_owned') options.onBackgroundOwned(message);
        else if (refused && (refused.code === 'turn_replay_unavailable' || refused.code === 'backend_restarted' || (refused.status === 410 && !refused.code))) {
          options.onReplayGone(message, refused.code === 'backend_restarted' ? 'backend_restarted' : 'turn_replay_unavailable');
        } else options.onUnavailable(message, 'turn_outcome_unknown');
      },
    });
  };
  connect();
  return stop;
}

export interface BackgroundDisconnect {
  retryable: boolean;
  error?: Error;
}

export interface SubscribeBackgroundOptions {
  onOpen?: () => void;
  onDisconnect?: (result: BackgroundDisconnect) => void;
  onError?: (err: Error) => void;
  cursors?: Record<string, { turnId: string; seq: number }>;
  /**
   * Reconcile an evicted replay cursor before any later frame is delivered.
   * The parser awaits this callback, turning the control frame into a real
   * ordering barrier instead of racing a stale snapshot against live data.
   * It resolves the background cursor the snapshot installed, if it
   * installed one; the silence watchdog waits while it runs.
   */
  onReplayGap?: (
    gap: { chatId: string; nodeId?: string; turnId: string; seq: number },
    signal: AbortSignal,
  ) => void | ReplayGapInstall | undefined | Promise<void | ReplayGapInstall | undefined>;
  /**
   * A scheduled run started, finished or needs attention. Not awaited: the
   * thread it created is installed asynchronously and must not stall the feed.
   */
  onScheduledJobRun?: (event: ScheduledJobRunEvent) => void;
  /** A job was created, edited or deleted (another window or an agent tool). */
  onScheduledJobsChanged?: (event: ScheduledJobsChangedEvent) => void;
  /**
   * Workspaces, trees or threads changed (any window, a tool, a scheduled
   * run). The first frame of each subscription carries only the cursor. Not
   * awaited: the re-read it asks for must not stall chat events.
   */
  onWorkspaceStructureChanged?: (event: WorkspaceStructureChangedEvent) => void;
}

/** The background cursor a replay-gap reconcile installed for the gap's chat. */
export interface ReplayGapInstall {
  turnId: string;
  seq: number;
}

const OBSERVER_SILENCE_TIMEOUT_MS = 30_000;

/**
 * What the rest of one subscription delivers for a chat whose replay gap
 * installed a snapshot. The server replays that chat from the gap's durable
 * cursor, and the snapshot, read later, can be past it:
 * - when the node's turn changed during the read, the gap's turn had ended
 *   and its body holds all of that turn: its replayed frames are dropped
 *   (the sequence gate would apply them, being another turn than the cursor);
 * - the sequence gate drops the installed turn's frames the body holds. A
 *   permission prompt is not part of a body, so those frames are delivered
 *   unsequenced instead, as the server's own recovery frames are: they leave
 *   the cursor alone, and their reducers set or clear the prompt by request id.
 */
function afterInstalledGap(
  event: ChatStreamEvent,
  installed: { gapTurnId: string; turnId: string; seq: number } | undefined,
): ChatStreamEvent | null {
  const { turnId, seq } = event.data;
  if (!installed || !turnId) return event;
  if (turnId === installed.gapTurnId && turnId !== installed.turnId) return null;
  if (turnId === installed.turnId && typeof seq === 'number' && seq <= installed.seq
    && (event.event === CHAT_STREAM_EVENTS.permissionRequest || event.event === CHAT_STREAM_EVENTS.permissionResolved)) {
    return { ...event, data: { ...event.data, seq: undefined } } as ChatStreamEvent;
  }
  return event;
}

/** The latest turn SQLite applied for a chat (POST /chats/background/cursors). */
export interface DurableChatCursor {
  turnId: string;
  seq: number;
  nodeId: string;
}

/**
 * What the backend applied for these chats, read without the background feed.
 * Chats it holds no turn for are absent; null when the read fails.
 */
export async function fetchBackgroundCursors(
  chatIds: string[],
  connectionId?: string,
  signal?: AbortSignal,
): Promise<Record<string, DurableChatCursor> | null> {
  try {
    const res = await backendFetch(`${backendApiBase(connectionId)}/chats/background/cursors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds }),
      signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as { cursors?: unknown } | null;
    const raw = body?.cursors;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: Record<string, DurableChatCursor> = {};
    for (const [chatId, value] of Object.entries(raw as Record<string, unknown>)) {
      const cursor = value as Partial<DurableChatCursor> | null;
      if (cursor && typeof cursor.turnId === 'string' && cursor.turnId && typeof cursor.seq === 'number'
        && typeof cursor.nodeId === 'string' && cursor.nodeId) {
        out[chatId] = { turnId: cursor.turnId, seq: cursor.seq, nodeId: cursor.nodeId };
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The window-lifetime feed carries self-turns and other windows’ foreground
 * turns. Locally owned foreground turns keep their direct /message lifecycle.
 */
export function subscribeBackground(
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers,
  opts: SubscribeBackgroundOptions = {},
  connectionId?: string,
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => controller.abort(), OBSERVER_SILENCE_TIMEOUT_MS);
  };
  // Chats whose replay gap installed a snapshot on this subscription.
  const installedGaps = new Map<string, { gapTurnId: string; turnId: string; seq: number }>();
  const deliver = (parsed: ChatStreamEvent) => {
    const chatId = parsed.data.chatId;
    if (!chatId) return;
    const event = afterInstalledGap(parsed, installedGaps.get(chatId));
    if (event) dispatchChatStreamEvent(event, handlersForChat(chatId, event.data.nodeId));
  };

  (async () => {
    let disconnect: BackgroundDisconnect = { retryable: true };
    try {
      const res = await fetchStream(`${backendApiBase(connectionId)}/chats/background/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursors: opts.cursors ?? {}, includeForeground: true }),
        signal: controller.signal,
      });
      if (!res.ok) throw new SseHttpError(res.status);
      if (!res.body) throw new Error('subscribe response has no body');
      opts.onOpen?.();
      const reader = res.body.getReader();
      armWatchdog();
      await readSseStream(reader, (evt, data) => {
        // Server-decided notifications (serverAttentionStore.ts); never awaited.
        if (isServerAttentionEvent(evt)) {
          receiveServerAttentionFrame(connectionId ?? LOCAL_BACKEND_CONNECTION_ID, evt, data);
          return;
        }
        if (evt === SCHEDULED_JOB_RUN_EVENT) {
          try {
            const event: unknown = JSON.parse(data);
            if (isScheduledJobRunEvent(event)) opts.onScheduledJobRun?.(event);
          } catch {
            // Malformed control frames are ignored like malformed events.
          }
          return;
        }
        if (evt === SCHEDULED_JOBS_CHANGED_EVENT) {
          try {
            const event: unknown = JSON.parse(data);
            if (isScheduledJobsChangedEvent(event)) opts.onScheduledJobsChanged?.(event);
          } catch {
            // Malformed control frames are ignored like malformed events.
          }
          return;
        }
        if (evt === WORKSPACE_STRUCTURE_CHANGED_EVENT) {
          try {
            const event: unknown = JSON.parse(data);
            if (isWorkspaceStructureChangedEvent(event)) opts.onWorkspaceStructureChanged?.(event);
          } catch {
            // Malformed control frames are ignored like malformed events.
          }
          return;
        }
        if (evt === 'background_sync_required') {
          let gap: Record<string, unknown> | null = null;
          try {
            gap = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // Malformed control frames are ignored like malformed events.
          }
          if (
            gap
            && typeof gap.chatId === 'string'
            && typeof gap.turnId === 'string'
            && typeof gap.seq === 'number'
            && opts.onReplayGap
          ) {
            const chatId = gap.chatId;
            const gapTurnId = gap.turnId;
            const settle = (installed: void | ReplayGapInstall | undefined) => {
              if (installed) installedGaps.set(chatId, { gapTurnId, turnId: installed.turnId, seq: installed.seq });
            };
            // No frame is read while the reconcile reads the backend: the
            // silence watchdog must not abort the feed, and with it the
            // reconcile's own signal, under it. Those reads carry their own
            // timeouts; the watchdog restarts once the barrier lifts.
            clearWatchdog();
            const rearm = () => { if (!stopped) armWatchdog(); };
            let result: ReturnType<NonNullable<SubscribeBackgroundOptions['onReplayGap']>>;
            try {
              result = opts.onReplayGap({
                chatId,
                nodeId: typeof gap.nodeId === 'string' ? gap.nodeId : undefined,
                turnId: gapTurnId,
                seq: gap.seq,
              }, controller.signal);
            } catch (error) {
              rearm();
              throw error;
            }
            if (!(result instanceof Promise)) {
              settle(result);
              rearm();
              return;
            }
            // Deliberately returned (awaited by readSseStream): reconciliation
            // failures must close this feed so the transport reconnects and
            // retries the same durable gap instead of silently moving on.
            return result.then(settle).finally(rearm);
          }
          return;
        }
        if (evt === 'foreground_event') {
          let event: { event?: unknown; data?: unknown };
          try { event = JSON.parse(data); } catch { return; }
          if (!event || typeof event.event !== 'string') return;
          const parsed = parseChatStreamEvent(event.event, JSON.stringify(event.data));
          if (!parsed?.data.chatId) return;
          const nodeId = parsed.data.nodeId ?? parsed.data.chatId;
          if (parsed.data.turnId && locallyOwnedTurns.has(ownedTurnKey(nodeId, parsed.data.turnId))) return;
          // Use the same identifier scoping and sequence gate as self-turns.
          deliver(parsed);
          return;
        }
        const parsed = parseChatStreamEvent(evt, data);
        if (parsed) deliver(parsed);
      }, { onRead: () => armWatchdog(), shouldStop: () => stopped });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      disconnect = { retryable: shouldRetryRequest(error), error };
      if (!stopped) {
        controller.abort();
        opts.onError?.(error);
      }
    } finally {
      clearWatchdog();
      if (!stopped) opts.onDisconnect?.(disconnect);
    }
  })();
  return () => {
    stopped = true;
    clearWatchdog();
    controller.abort();
  };
}
