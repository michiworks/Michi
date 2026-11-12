import type { DurableChatCursor } from '../services/api';
import { backgroundReplayCursor, type BackgroundReplayGap } from './backgroundGapReconcile';
import type { ChatNodeState } from './chatTypes';

/**
 * Checks what a window shows against what SQLite applied, without the
 * background feed: when the window comes back to the foreground and when a
 * pane opens. A chat it is behind on reconciles through the replay-gap path,
 * so a feed that is down (or missed a turn) costs freshness, never the result.
 */
export interface BackgroundCatchUpActions {
  catchUpNodes(nodeIds: readonly string[]): void;
}

export interface BackgroundCatchUpDeps {
  connectionIds: () => readonly string[];
  /** The nodes of a backend connection a foreground check covers. */
  nodesFor: (connectionId: string) => readonly ChatNodeState[];
  /** Any node this window holds, wherever its pane opened. */
  node: (nodeId: string) => ChatNodeState | undefined;
  nodeConnection: (nodeId: string) => string | undefined;
  /** This window's own stream drives the node's turn: it is current by construction. */
  foregroundActive: (nodeId: string) => boolean;
  fetchCursors: (chatIds: string[], connectionId: string, signal: AbortSignal) => Promise<Record<string, DurableChatCursor> | null>;
  reconcile: (gap: BackgroundReplayGap) => Promise<unknown>;
  /** A node is checked at most this often. */
  minIntervalMs?: number;
  /** Requests within this window share one read. */
  coalesceMs?: number;
  now?: () => number;
}

/** Whether SQLite holds more of this chat than the window applied. */
export function behindDurable(node: ChatNodeState, durable: { turnId: string; seq: number }): boolean {
  const local = backgroundReplayCursor(node, false);
  // A turn's cursor reaches SQLite at its start, before any frame: a different
  // turn there is always a newer one.
  return !local || local.turnId !== durable.turnId || local.seq < durable.seq;
}

export function createBackgroundCatchUp(deps: BackgroundCatchUpDeps) {
  const minIntervalMs = deps.minIntervalMs ?? 5_000;
  const coalesceMs = deps.coalesceMs ?? 250;
  const now = deps.now ?? Date.now;
  const lastChecked = new Map<string, number>();
  const controller = new AbortController();
  let pendingAll = false;
  const pendingNodes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const due = (node: ChatNodeState, at: number): boolean => {
    if (deps.foregroundActive(node.nodeId)) return false;
    const last = lastChecked.get(node.nodeId);
    return last === undefined || at - last >= minIntervalMs;
  };

  const check = async (connectionId: string, nodes: readonly ChatNodeState[]): Promise<void> => {
    const at = now();
    const byChat = new Map<string, ChatNodeState>();
    for (const node of nodes) {
      if (!due(node, at)) continue;
      lastChecked.set(node.nodeId, at);
      byChat.set(node.chatId ?? node.nodeId, node);
    }
    if (byChat.size === 0) return;
    const durable = await deps.fetchCursors([...byChat.keys()], connectionId, controller.signal);
    if (!durable || controller.signal.aborted) return;
    for (const [chatId, cursor] of Object.entries(durable)) {
      const node = byChat.get(chatId);
      if (!node || node.nodeId !== cursor.nodeId || deps.foregroundActive(node.nodeId)) continue;
      if (!behindDurable(node, cursor)) continue;
      // The gap path dedupes per chat with a reconcile the feed may run too.
      void deps.reconcile({ chatId, nodeId: node.nodeId, turnId: cursor.turnId, seq: cursor.seq }).catch(() => {});
    }
  };

  const flush = (): void => {
    timer = null;
    const all = pendingAll;
    const nodeIds = [...pendingNodes];
    pendingAll = false;
    pendingNodes.clear();
    if (controller.signal.aborted) return;
    if (all) {
      for (const connectionId of deps.connectionIds()) void check(connectionId, deps.nodesFor(connectionId)).catch(() => {});
      return;
    }
    const byConnection = new Map<string, ChatNodeState[]>();
    for (const nodeId of nodeIds) {
      const connectionId = deps.nodeConnection(nodeId);
      const node = deps.node(nodeId);
      if (!connectionId || !node) continue;
      const list = byConnection.get(connectionId) ?? [];
      list.push(node);
      byConnection.set(connectionId, list);
    }
    for (const [connectionId, nodes] of byConnection) void check(connectionId, nodes).catch(() => {});
  };

  const schedule = (): void => {
    if (timer === null && !controller.signal.aborted) timer = setTimeout(flush, coalesceMs);
  };

  return {
    /** Every node `nodesFor` covers (the window came back to the foreground). */
    requestAll(): void {
      pendingAll = true;
      schedule();
    },
    /** These nodes (a pane opened). */
    request(nodeIds: readonly string[]): void {
      for (const nodeId of nodeIds) pendingNodes.add(nodeId);
      schedule();
    },
    dispose(): void {
      controller.abort();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
