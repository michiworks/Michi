/**
 * A conversation's approval requests, questions and finished replies while
 * no Michi window is open (DESIGN-v2 §5.2). With a window open the renderer
 * notifies them itself (chatStore.tsx); once the last window has been gone
 * CHAT_NOTICE_WINDOW_GRACE_MS, this module does it in the renderer's place:
 * it watches every turn chatHub broadcasts and puts a `chat` notice into the
 * Companion's notice outbox (delivery.ts enqueueCompanionNotice), which the
 * notifier in Electron main shows like any other (banner, hold,
 * acknowledgement) and which wakes a quit app (§5.1).
 *
 * - By the user's chat notification level (Settings › Notifications, the
 *   renderer's pref, PUT to COMPANION_CHAT_NOTIFICATION_LEVEL_PATH and kept
 *   in meta): `all` = approvals, questions and replies; `approval-only` =
 *   approvals and questions; `off` = none. Never the Companion's quiet
 *   hours, workdays, caps, notification level or on/off switch: a window
 *   open would not be held to them either, and closing it must not mean
 *   fewer notices.
 * - At most one notice per turn and kind. A reply counts only for a turn
 *   with a user message (one the user, or another agent, wrote).
 * - Every conversation the user can see, and V (titled with the agent's
 *   name, opening the panel); never a check-in (private: chatHub broadcasts
 *   none of its turns, and its node id is refused here too), a check-in's
 *   post or first-run narration (no user message; the Companion's own gate
 *   notifies posts), a scheduled run (its job notifies, desktopOwnsScheduledNotice),
 *   a background maintenance chat, a conversation in Trash or in a hidden
 *   system workspace other than V.
 * - What comes while the last window has been gone for less than the grace
 *   waits for the grace to end, then notifies if still no window is open and
 *   the request is still unanswered (or the turn has replied): closing the
 *   window must not lose it.
 * - An approval or question answered (or a turn that ended) before any
 *   notifier showed its notice withdraws the notice, so no replay brings back
 *   a request nobody waits on; so does a backend restart for every approval
 *   and question the stopped backend stored (its turns ended with it).
 * - V waiting on the user, or no longer, is a `companion_changed`
 *   (`conversation`): the tray's "<name> is waiting for you" follows it.
 * - One OS notification per event with the server's attention records
 *   (services/attention/attentionService.ts, `attention`), which a window
 *   raises once it is open: an event a window already raised is not notified
 *   here, and one notified here is claimed for the desktop notifier, so a
 *   window that opens later lists it without raising it again.
 */

import {
  CHAT_STREAM_EVENTS,
  DEFAULT_CHAT_NOTIFICATION_LEVEL,
  isChatNotificationLevel,
  isCheckinNodeId,
  isSystemWorkspaceSettings,
  type ChatNotificationLevel,
  type ChatStreamEvent,
  type CompanionTarget,
} from 'michi-shared';
import { currentAssistantNodeId } from '../../assistant/store';
import { agentNoticeTitle, type DesktopChatNotice } from '../attention/attentionService';
import { getDb } from '../db';
import { log } from '../logger';
import {
  companionEvents,
  enqueueCompanionNotice,
  noticeExcerpt,
  unrefTimer,
  withdrawChatRequestNotices,
  withdrawCompanionNotices,
  type ChatNoticeKind,
  type CompanionEventBus,
} from './delivery';
import { getCompanionSettings } from './settings';

/** How long the last window must have been gone: a window that reloads is back within it (DESIGN-v2 §9 risk 13). */
export const CHAT_NOTICE_WINDOW_GRACE_MS = 5_000;

/** Where the level is kept (`meta`): the renderer's pref, mirrored. */
export const CHAT_NOTIFICATION_LEVEL_META_KEY = 'companion:chat_notification_level';

/** The chat notification level the renderer last sent; DEFAULT_CHAT_NOTIFICATION_LEVEL before any has. */
export function getChatNotificationLevel(): ChatNotificationLevel {
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(CHAT_NOTIFICATION_LEVEL_META_KEY) as { value: string } | undefined;
  return isChatNotificationLevel(row?.value) ? row.value : DEFAULT_CHAT_NOTIFICATION_LEVEL;
}

/** The renderer's chat notification level (PUT /companion/chat-notification-level). True when it changed. */
export function setChatNotificationLevel(level: ChatNotificationLevel): boolean {
  if (!isChatNotificationLevel(level)) throw new Error('not a chat notification level');
  const stored = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(CHAT_NOTIFICATION_LEVEL_META_KEY) as { value: string } | undefined;
  if (stored?.value === level) return false;
  getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(CHAT_NOTIFICATION_LEVEL_META_KEY, level);
  return true;
}

/** What a notice about a conversation needs to know of it. */
export interface ChatNoticeConversation {
  workspaceId: string;
  title: string | null;
  /** The user can see it: not in Trash, not a maintenance chat, not in a hidden system workspace. */
  visible: boolean;
}

/** The part of chatHub this reads: its window-scoped feed, foreground turns included (chatHub.subscribeBackground). */
export interface ChatNoticeHub {
  subscribeBackground(subscriber: {
    send(chatId: string, event: ChatStreamEvent, selfInitiated?: boolean): void;
    includeForeground?: boolean;
    close(): void;
  }): () => void;
}

/** The part of the attention service this reads and tells (attentionService.ts shownInWindow, shownByDesktop). */
export interface ChatNoticeAttention {
  shownInWindow(notice: DesktopChatNotice): boolean;
  shownByDesktop(notice: DesktopChatNotice): void;
}

export interface ChatNoticesDeps {
  hub: ChatNoticeHub;
  /** The server's attention records of the same events (server.ts: the attention service); none in tests that leave it out. */
  attention?: ChatNoticeAttention;
  /** Counts the windows (default: the process's companionEvents, which the routes feed). */
  bus?: CompanionEventBus;
  clock?: () => number;
  /** V, the agent's conversation (default currentAssistantNodeId). */
  conversationNodeId?: () => string | null;
  /** A conversation's workspace, title and visibility (default: from nodes and workspaces). */
  conversationOf?: (nodeId: string) => ChatNoticeConversation | null;
  /** The thread's current turn is a scheduled run (server.ts: the scheduled executor's isRunningOn). */
  isScheduledRun?: (nodeId: string) => boolean;
  /** The agent's name (default settings.displayName). */
  displayName?: () => string;
  /** The chat notification level (default getChatNotificationLevel). */
  level?: () => ChatNotificationLevel;
  windowGraceMs?: number;
  /** Runs `callback` after `delayMs`; the returned function cancels it (default: an unref'd setTimeout). */
  setTimer?: (callback: () => void, delayMs: number) => () => void;
}

interface TurnState {
  nodeId: string;
  /** The turn its frames name; null for frames that name none. */
  turnId: string | null;
  /** Notices about it may go out at all (decided at its start). */
  eligible: boolean;
  /** It is V's turn. */
  v: boolean;
  /** It has a user message: its end is a reply. */
  userRow: boolean;
  sent: Set<ChatNoticeKind>;
  /** Approval and question notices not withdrawn yet, by request. */
  pending: Map<string, string>;
  /** Requests not answered yet, by request, oldest first, with what their notice would say. */
  open: Map<string, { kind: Exclude<ChatNoticeKind, 'reply'>; detail: string; requestId: number }>;
  /** A notice that came in the window grace, waiting for it to end (one per kind): its cancel. */
  deferred: Map<ChatNoticeKind, () => void>;
  /** The turn ended (done or error): none of its requests waits any more. */
  ended: boolean;
  /** It waited on the user at some point (V: the tray was told). */
  waited: boolean;
  /** The reply so far, for the notice's excerpt (bounded). */
  answer: string;
}

/** Turns watched at once; the oldest goes first past it (a turn whose end this never saw). */
const MAX_TURNS = 500;
/** The answer kept for the excerpt: its first paragraph is all a notice shows. */
const MAX_ANSWER_CHARS = 2_000;
const BODY_MAX = 200;

function defaultConversationOf(nodeId: string): ChatNoticeConversation | null {
  const row = getDb().prepare(`SELECT n.workspace_id, n.title, n.deleted_at AS node_deleted, n.maintenance_job_id,
      w.settings, w.deleted_at AS workspace_deleted
    FROM nodes n JOIN workspaces w ON w.id = n.workspace_id WHERE n.id = ?`).get(nodeId) as {
      workspace_id: string; title: string | null; node_deleted: number | null; maintenance_job_id: string | null;
      settings: string | null; workspace_deleted: number | null;
    } | undefined;
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    title: row.title,
    visible: row.node_deleted === null && row.workspace_deleted === null && row.maintenance_job_id === null && !isSystemWorkspaceSettings(row.settings),
  };
}

function oneLine(text: string, max = BODY_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export interface RunningChatNotices {
  stop(): void;
}

/** Watches chatHub's turns and notifies them while no window is open. stop() detaches it. */
export function startChatNotices(deps: ChatNoticesDeps): RunningChatNotices {
  const bus = deps.bus ?? companionEvents;
  const clock = deps.clock ?? Date.now;
  const conversationNodeId = deps.conversationNodeId ?? currentAssistantNodeId;
  const conversationOf = deps.conversationOf ?? defaultConversationOf;
  const isScheduledRun = deps.isScheduledRun ?? (() => false);
  const displayName = deps.displayName ?? (() => getCompanionSettings().displayName);
  const level = deps.level ?? getChatNotificationLevel;
  const graceMs = deps.windowGraceMs ?? CHAT_NOTICE_WINDOW_GRACE_MS;
  const setTimer = deps.setTimer ?? unrefTimer;
  const turns = new Map<string, TurnState>();
  /** Every deferred notice's cancel, so stop() leaves none behind. */
  const timers = new Set<() => void>();

  // What the backend before this one asked the user and never heard back on is gone with its turns (H-review #6).
  try {
    withdrawChatRequestNotices(clock());
  } catch (error) {
    log.warn('chat', 'stale chat notices not withdrawn', { err: error instanceof Error ? error.message : String(error) });
  }

  const vNodeId = (): string | null => {
    try {
      return conversationNodeId();
    } catch {
      return null;
    }
  };

  const track = (key: string, nodeId: string, turnId: string | null, start?: Extract<ChatStreamEvent, { event: 'turn_start' }>): TurnState => {
    const known = turns.get(key);
    if (known) return known;
    const v = nodeId === vNodeId();
    const conversation = v ? null : conversationOf(nodeId);
    const data = start?.data;
    const eligible = !isCheckinNodeId(nodeId)
      && !data?.assistantMetadata?.companionPost
      && !data?.userMetadata?.scheduledJobId
      && !isScheduledRun(nodeId)
      && (v || conversation?.visible === true);
    const state: TurnState = {
      nodeId,
      turnId,
      eligible,
      v,
      // A turn this never saw start (it started before the subscription) is not taken for one with a user message.
      userRow: data ? data.selfInitiated !== true || data.userText.length > 0 : false,
      sent: new Set(),
      pending: new Map(),
      open: new Map(),
      deferred: new Map(),
      ended: false,
      waited: false,
      answer: '',
    };
    turns.set(key, state);
    if (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value as string);
    return state;
  };

  const trayChanged = (state: TurnState) => {
    if (state.v) bus.emitChanged('conversation');
  };

  const withdraw = (state: TurnState, request?: string) => {
    const ids = request === undefined ? [...state.pending.values()] : [state.pending.get(request)].filter((id): id is string => !!id);
    if (request === undefined) state.pending.clear();
    else state.pending.delete(request);
    if (ids.length > 0) withdrawCompanionNotices(ids, clock());
  };

  const cancelDeferred = (state: TurnState, kind: ChatNoticeKind) => {
    const cancel = state.deferred.get(kind);
    if (!cancel) return;
    cancel();
    state.deferred.delete(kind);
    timers.delete(cancel);
  };

  /**
   * A notice that came while the last window had been gone for less than
   * the grace: it may only be reloading, so nothing goes out yet, but the
   * notice is not lost either (H-review #1: the user closed the window and
   * Michi asked two seconds later). One look again per kind once the grace
   * is up: a request still unanswered in a turn still running (its latest of
   * that kind), or the reply, notifies then by the same rules, once.
   */
  const defer = (state: TurnState, kind: ChatNoticeKind, delayMs: number, detail: string) => {
    if (state.deferred.has(kind)) return;
    const cancel = setTimer(() => {
      state.deferred.delete(kind);
      timers.delete(cancel);
      try {
        if (kind === 'reply') {
          notify(state, kind, detail);
          return;
        }
        if (state.ended) return;
        const latest = [...state.open].filter(([, open]) => open.kind === kind).at(-1);
        if (latest) notify(state, kind, latest[1].detail, latest[0], latest[1].requestId);
      } catch (error) {
        log.warn('chat', 'chat notice failed', { err: error instanceof Error ? error.message : String(error) });
      }
    }, Math.max(1, delayMs));
    state.deferred.set(kind, cancel);
    timers.add(cancel);
  };

  /** The attention service on the same event (`attention`): a read that fails counts as no window, better a duplicate than none. */
  const raisedInWindow = (event: DesktopChatNotice | null): boolean => {
    if (!event || !deps.attention) return false;
    try {
      return deps.attention.shownInWindow(event);
    } catch (error) {
      log.warn('chat', 'chat notice could not read attention', { err: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };

  const raisedHere = (event: DesktopChatNotice | null): void => {
    if (!event || !deps.attention) return;
    try {
      deps.attention.shownByDesktop(event);
    } catch (error) {
      log.warn('chat', 'chat notice could not tell attention', { err: error instanceof Error ? error.message : String(error) });
    }
  };

  const notify = (state: TurnState, kind: ChatNoticeKind, detail: string, request?: string, requestId?: number) => {
    if (!state.eligible || state.sent.has(kind)) return;
    const chosen = level();
    if (chosen === 'off' || (kind === 'reply' && chosen !== 'all')) return;
    // A window shows its own.
    if (bus.windowCount() > 0) return;
    // The last one went less than the grace ago: it may be reloading. Look again once the grace is up.
    const absentFor = bus.windowAbsentForMs();
    if (absentFor < graceMs) {
      defer(state, kind, graceMs - absentFor, detail);
      return;
    }
    const event: DesktopChatNotice | null = state.turnId === null ? null
      : { nodeId: state.nodeId, turnId: state.turnId, kind, ...(requestId !== undefined ? { requestId } : {}) };
    // A window that was still there raised it already.
    if (raisedInWindow(event)) return;
    let title: string;
    let body: string;
    let target: CompanionTarget;
    if (state.v) {
      title = agentNoticeTitle(displayName(), kind);
      body = detail || (kind === 'reply' ? 'Finished' : 'Open the conversation');
      target = { kind: 'companion', tab: 'chat' };
    } else {
      const conversation = conversationOf(state.nodeId);
      if (!conversation?.visible) return;
      title = conversation.title?.trim() || 'Conversation';
      body = kind === 'approval' ? `Needs your approval${detail ? `: ${detail}` : ''}`
        : kind === 'question' ? `Has a question${detail ? `: ${detail}` : ''}`
          : detail || 'Finished';
      target = { kind: 'node', workspaceId: conversation.workspaceId, nodeId: state.nodeId };
    }
    const notice = enqueueCompanionNotice({ title, body: oneLine(body), target, itemIds: [], channel: 'chat', chatKind: kind }, clock(), { bus });
    if (!notice) return;
    state.sent.add(kind);
    if (request !== undefined) state.pending.set(request, notice.id);
    raisedHere(event);
  };

  const handle = (chatId: string, event: ChatStreamEvent) => {
    const nodeId = event.data.nodeId ?? chatId;
    const turnId = event.data.turnId ?? null;
    const key = turnId ?? nodeId;
    switch (event.event) {
      case CHAT_STREAM_EVENTS.turnStart:
        turns.delete(key);
        track(key, nodeId, turnId, event);
        return;
      case CHAT_STREAM_EVENTS.chunk: {
        const state = turns.get(key);
        if (state?.eligible && state.userRow && state.answer.length < MAX_ANSWER_CHARS) state.answer += event.data.text;
        return;
      }
      case CHAT_STREAM_EVENTS.permissionRequest:
      case CHAT_STREAM_EVENTS.userInputRequest: {
        const state = track(key, nodeId, turnId);
        const approval = event.event === CHAT_STREAM_EVENTS.permissionRequest;
        const kind = approval ? 'approval' : 'question';
        const { requestId } = event.data;
        const request = `${approval ? 'permission' : 'input'}:${requestId}`;
        const detail = oneLine(approval ? event.data.title ?? '' : event.data.questions[0]?.question ?? '');
        state.open.delete(request);
        state.open.set(request, { kind, detail, requestId });
        state.waited = true;
        trayChanged(state);
        notify(state, kind, detail, request, requestId);
        return;
      }
      case CHAT_STREAM_EVENTS.permissionResolved:
      case CHAT_STREAM_EVENTS.userInputResolved: {
        const state = turns.get(key);
        if (!state) return;
        const approval = event.event === CHAT_STREAM_EVENTS.permissionResolved;
        const request = `${approval ? 'permission' : 'input'}:${event.data.requestId}`;
        const kind = approval ? 'approval' : 'question';
        state.open.delete(request);
        if (![...state.open.values()].some((open) => open.kind === kind)) cancelDeferred(state, kind);
        withdraw(state, request);
        trayChanged(state);
        return;
      }
      case CHAT_STREAM_EVENTS.done:
      case CHAT_STREAM_EVENTS.error: {
        const state = turns.get(key);
        if (!state) return;
        turns.delete(key);
        state.ended = true;
        state.open.clear();
        cancelDeferred(state, 'approval');
        cancelDeferred(state, 'question');
        withdraw(state);
        if (state.waited) trayChanged(state);
        const stop = event.event === CHAT_STREAM_EVENTS.done ? event.data.stopReason : undefined;
        // A reply the user stopped is no news; an error is not a reply.
        if (event.event === CHAT_STREAM_EVENTS.done && stop !== 'cancel' && stop !== 'cancelled' && state.userRow) {
          notify(state, 'reply', noticeExcerpt(state.answer));
        }
        return;
      }
      default:
        return;
    }
  };

  const unsubscribe = deps.hub.subscribeBackground({
    includeForeground: true,
    send: (chatId, event) => {
      try {
        handle(chatId, event);
      } catch (error) {
        // A notice is never worth breaking a turn's feed over.
        log.warn('chat', 'chat notice failed', { err: error instanceof Error ? error.message : String(error) });
      }
    },
    close: () => {},
  });
  return {
    stop: () => {
      unsubscribe();
      for (const cancel of timers) cancel();
      timers.clear();
      turns.clear();
    },
  };
}
