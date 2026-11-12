import { subscribeBackground } from '../services/api';
import type { BackgroundDisconnect, SubscribeBackgroundOptions } from '../services/api';
import type { StreamHandlers } from '../services/chatStreamEvents';
import type { ScheduledJobRunEvent, ScheduledJobsChangedEvent, WorkspaceStructureChangedEvent } from 'michi-shared';
import { createReconnectingFeed } from '../services/api/sseFeed';

/**
 * One reconnecting SSE feed per ChatProvider. Unlike the retired pane
 * observer transport it has no membership list: turns from other clients and
 * self-initiated turns are
 * discovered by their chatId / turn_start envelope, including for closed
 * panes.
 */
export function createBackgroundTurnTransport(opts: {
  connectionId?: string;
  handlersForChat: (chatId: string, nodeId?: string) => StreamHandlers;
  cursorSnapshot?: () => Record<string, { turnId: string; seq: number }>;
  onReplayGap?: SubscribeBackgroundOptions['onReplayGap'];
  onScheduledJobRun?: (event: ScheduledJobRunEvent) => void;
  onScheduledJobsChanged?: (event: ScheduledJobsChangedEvent) => void;
  onWorkspaceStructureChanged?: (event: WorkspaceStructureChangedEvent) => void;
  /**
   * The feed opened again after an earlier one of this transport ended: the
   * backend may be another process, or another build, now. Called before any
   * of its frames (a replay gap among them) is delivered.
   */
  onReconnect?: () => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  random?: () => number;
}): { start(): void; stop(): void } {
  const base = opts.reconnectDelayMs ?? 500;
  let opened = false;
  const feed = createReconnectingFeed({
    baseMs: base,
    maxMs: opts.maxReconnectDelayMs ?? 10_000,
    healthyMs: Math.max(1_000, base * 4),
    random: opts.random,
    connectionId: opts.connectionId,
    // A refused feed (401/403/404) waits for the connection to come back.
    wakeAfterFatal: true,
    open: ({ onOpen, onDisconnect }) => subscribeBackground(opts.handlersForChat, {
      // Re-read on every attempt: the cursors move while the feed is down.
      cursors: opts.cursorSnapshot?.() ?? {},
      onReplayGap: opts.onReplayGap,
      onScheduledJobRun: opts.onScheduledJobRun,
      onScheduledJobsChanged: opts.onScheduledJobsChanged,
      onWorkspaceStructureChanged: opts.onWorkspaceStructureChanged,
      onOpen: () => {
        if (opened) opts.onReconnect?.();
        opened = true;
        onOpen();
      },
      onDisconnect: (result: BackgroundDisconnect) => onDisconnect(result.error, !result.retryable),
    }, opts.connectionId),
  });
  return {
    start() {
      // Focused ChatProvider tests intentionally mock only foreground APIs.
      // Treat an omitted background transport mock as disabled rather than
      // coupling unrelated reducer tests to this connection lifecycle.
      if (typeof subscribeBackground !== 'function') return;
      feed.start();
    },
    stop: () => feed.stop(),
  };
}
